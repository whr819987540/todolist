// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditPosition } from "./editor/position";

// 工作区 / 项目改名、待办移动、删除后，记住的东西跟着走（docs/requirements.md「后退 / 前进」「回到上次编辑位置」
// 「从首页进入工作区」「撤销记录」）。这里经由 workspaceState 真正用的入口测，不直接调 navHistory。

vi.mock("./api", () => ({
  api: {
    readUiState: vi.fn(async () => null),
    writeUiState: vi.fn(async () => {}),
  },
}));

type State = typeof import("./workspaceState");
type Nav = typeof import("./navHistory");
let state: State;
let nav: Nav;

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  state = await import("./workspaceState");
  nav = await import("./navHistory");
  await state.loadUiState();
});

/** 一路后退，返回经过的地方（不含当前这处） */
function backAll() {
  const out = [];
  for (let p = nav.go(-1); p !== undefined; p = nav.go(-1)) out.push(p);
  return out;
}

const position = (pos: number): EditPosition => ({
  cursor: { pos, before: "前面的文字", after: "后面的文字" },
  view: { pos: 0, before: "", after: "开头", top: 0 },
});

describe("后退 / 前进的记录跟着走", () => {
  beforeEach(() => {
    nav.visit(null);
    nav.visit({ workspace: "工作" });
    nav.visit({ workspace: "工作", project: "需求" });
    nav.visit({ workspace: "工作", project: "需求", todoId: "a" });
    nav.visit({ workspace: "生活" });
  });

  it("工作区改名", () => {
    state.renameWorkspaceState("工作", "公司");
    expect(backAll()).toEqual([
      { workspace: "公司", project: "需求", todoId: "a" },
      { workspace: "公司", project: "需求" },
      { workspace: "公司" },
      null,
    ]);
  });

  it("项目改名", () => {
    state.renameProjectState("工作", "需求", "需求池");
    expect(backAll()).toEqual([
      { workspace: "工作", project: "需求池", todoId: "a" },
      { workspace: "工作", project: "需求池" },
      { workspace: "工作" },
      null,
    ]);
  });

  it("项目移到别的工作区", () => {
    state.moveProjectState("工作", "需求", "生活", "需求");
    expect(backAll()).toEqual([
      { workspace: "生活", project: "需求", todoId: "a" },
      { workspace: "生活", project: "需求" },
      { workspace: "工作" },
      null,
    ]);
  });

  it("父项目改名，子项目里的跟着；名字开头相同的别的项目不动", () => {
    nav.visit({ workspace: "工作", project: "需求/前端", todoId: "b" });
    nav.visit({ workspace: "工作", project: "需求二" });
    state.renameProjectState("工作", "需求", "开发");
    expect(backAll().slice(0, 4)).toEqual([
      { workspace: "工作", project: "开发/前端", todoId: "b" },
      { workspace: "生活" },
      { workspace: "工作", project: "开发", todoId: "a" },
      { workspace: "工作", project: "开发" },
    ]);
  });

  it("中间一级改名：下面各级的跟着，名字开头相同的旁边的不动", () => {
    nav.visit({ workspace: "工作", project: "需求/前端/组件/按钮", todoId: "c" });
    nav.visit({ workspace: "工作", project: "需求/前端二/组件" });
    state.renameProjectState("工作", "需求/前端", "需求/界面");
    expect(backAll().slice(0, 2)).toEqual([
      { workspace: "工作", project: "需求/界面/组件/按钮", todoId: "c" },
      { workspace: "生活" },
    ]);
  });

  it("删除中间一级：下面各级的都不再回去", () => {
    nav.visit({ workspace: "工作", project: "需求/前端/组件/按钮", todoId: "c" });
    nav.visit({ workspace: "工作", project: "需求/前端二/组件" });
    nav.visit({ workspace: "工作", project: "需求/前端/组件" });
    state.forgetProjectState("工作", "需求/前端");
    // 正看着的删了，退到前一处「需求/前端二/组件」；再往后没有「需求/前端」下面的
    expect(backAll()).toEqual([
      { workspace: "生活" },
      { workspace: "工作", project: "需求", todoId: "a" },
      { workspace: "工作", project: "需求" },
      { workspace: "工作" },
      null,
    ]);
  });

  it("项目放进别的项目成为子项目、子项目移出来", () => {
    state.moveProjectState("工作", "需求", "工作", "日常/需求");
    expect(backAll()).toEqual([
      { workspace: "工作", project: "日常/需求", todoId: "a" },
      { workspace: "工作", project: "日常/需求" },
      { workspace: "工作" },
      null,
    ]);
    // 现在在最前面（首页），往前看
    state.moveProjectState("工作", "日常/需求", "生活", "需求");
    expect(nav.go(1)).toEqual({ workspace: "工作" });
    expect(nav.go(1)).toEqual({ workspace: "生活", project: "需求" });
    expect(nav.go(1)).toEqual({ workspace: "生活", project: "需求", todoId: "a" });
  });

  it("待办移到别的项目（id 因为重名变了）", () => {
    state.moveTodoState("工作", "需求", "a", ["生活", "杂事", "a-2"]);
    expect(backAll()[0]).toEqual({ workspace: "生活", project: "杂事", todoId: "a-2" });
  });

  it("删除父项目后，其中子项目里的也不再回去", () => {
    nav.visit({ workspace: "工作", project: "需求/前端", todoId: "b" });
    state.forgetProjectState("工作", "需求");
    expect(backAll()).toEqual([{ workspace: "工作" }, null]);
  });

  it("删除的不再回去", () => {
    state.forgetTodoState("工作", "需求", "a");
    expect(backAll()).toEqual([{ workspace: "工作", project: "需求" }, { workspace: "工作" }, null]);
  });

  it("工作区删除后，其中的各处都不再回去", () => {
    state.forgetWorkspaceState("工作");
    expect(backAll()).toEqual([null]);
  });
});

describe("编辑位置、编辑模式、撤销记录跟着走", () => {
  it("项目改名后，编辑位置和编辑模式跟到新名字下", () => {
    state.writeEditPosition("工作", "需求", "a", position(5));
    state.writeEditorMode("工作", "需求", "a", "source");
    state.renameProjectState("工作", "需求", "需求池");
    expect(state.readEditPosition("工作", "需求池", "a")?.cursor.pos).toBe(5);
    expect(state.readEditPosition("工作", "需求", "a")).toBeNull();
    expect(state.readEditorMode("工作", "需求池", "a")).toBe("source");
    expect(state.readEditorMode("工作", "需求", "a")).toBe("live");
  });

  it("待办移动后，编辑位置跟过去", () => {
    state.writeEditPosition("工作", "需求", "a", position(7));
    state.moveTodoState("工作", "需求", "a", ["生活", "杂事", "a"]);
    expect(state.readEditPosition("生活", "杂事", "a")?.cursor.pos).toBe(7);
  });

  it("撤销记录跟着改名走；正文在外部被改过时作废", () => {
    state.keepUndo("工作", "需求", "a", { doc: "正文", history: { done: [] } });
    state.renameWorkspaceState("工作", "公司");
    expect(state.takeUndo("工作", "需求", "a", "正文")).toBeNull();
    expect(state.takeUndo("公司", "需求", "a", "正文")).toEqual({ done: [] });
    state.keepUndo("公司", "需求", "a", { doc: "正文", history: { done: [] } });
    expect(state.takeUndo("公司", "需求", "a", "外部改过的正文")).toBeNull();
  });
});

describe("各工作区上次打开的待办", () => {
  it("工作区改名后跟着走", () => {
    state.writeLastTodo("工作", "需求", "a");
    state.renameWorkspaceState("工作", "公司");
    expect(state.readLastTodo("公司")).toEqual({ project: "需求", todoId: "a" });
    expect(state.readLastTodo("工作")).toBeNull();
  });

  it("待办移到同一工作区的别的项目：跟着走", () => {
    state.writeLastTodo("工作", "需求", "a");
    state.moveTodoState("工作", "需求", "a", ["工作", "杂事", "a"]);
    expect(state.readLastTodo("工作")).toEqual({ project: "杂事", todoId: "a" });
  });

  it("待办移到别的工作区：不再算原工作区的", () => {
    state.writeLastTodo("工作", "需求", "a");
    state.moveTodoState("工作", "需求", "a", ["生活", "杂事", "a"]);
    expect(state.readLastTodo("工作")).toBeNull();
  });
});

describe("右侧标签页里打开着的待办", () => {
  const tab = (workspace: string, project: string, todoId: string) => ({ workspace, project, todoId });
  const ids = () => state.readOpenTodos().map((t) => `${t.workspace}/${t.project}/${t.todoId}${t.preview ? "（预览）" : ""}`);

  it("显示一条待办时放进预览标签，固定下来后再显示别的待办另开一个预览标签", () => {
    state.showTodoTab(tab("工作", "需求", "a"));
    state.keepTodoTab(tab("工作", "需求", "a"));
    state.showTodoTab(tab("工作", "需求", "b"));
    state.showTodoTab(tab("工作", "需求", "c"));
    expect(ids()).toEqual(["工作/需求/a", "工作/需求/c（预览）"]);
  });

  it("变了时通知订阅者；没变时读到的是同一个数组", () => {
    let calls = 0;
    const off = state.subscribeOpenTodos(() => calls++);
    state.keepTodoTab(tab("工作", "需求", "a"));
    const before = state.readOpenTodos();
    state.keepTodoTab(tab("工作", "需求", "a"));
    expect(calls).toBe(1);
    expect(state.readOpenTodos()).toBe(before);
    off();
  });

  it("项目改名、待办移到别的工作区后跟着走，删除后关掉", () => {
    state.keepTodoTab(tab("工作", "需求", "a"));
    state.keepTodoTab(tab("工作", "需求", "b"));
    state.keepTodoTab(tab("工作", "日常", "c"));
    state.renameProjectState("工作", "需求", "需求池");
    state.moveTodoState("工作", "需求池", "b", ["生活", "杂事", "b"]);
    state.forgetProjectState("工作", "日常");
    expect(ids()).toEqual(["工作/需求池/a", "生活/杂事/b"]);
    state.forgetWorkspaceState("生活");
    expect(ids()).toEqual(["工作/需求池/a"]);
  });

  it("记在 .state.json，下次打开软件还在（预览标签也还是预览）", async () => {
    const { api } = await import("./api");
    state.keepTodoTab(tab("工作", "需求", "a"));
    state.showTodoTab(tab("工作", "需求", "b"));
    // 隐藏到托盘、退出前立即写盘
    await (await import("./hooks")).flushAll();
    const calls = vi.mocked(api.writeUiState).mock.calls;
    const written = calls[calls.length - 1]?.[0];
    expect(JSON.parse(written!).openTodos).toEqual([
      { workspace: "工作", project: "需求", todoId: "a" },
      { workspace: "工作", project: "需求", todoId: "b", preview: true },
    ]);

    vi.resetModules();
    vi.mocked(api.readUiState).mockResolvedValueOnce(written!);
    const again: State = await import("./workspaceState");
    await again.loadUiState();
    expect(again.readOpenTodos().map((t) => [t.todoId, t.preview])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("文件里手改坏的、重复的项去掉", async () => {
    const { api } = await import("./api");
    vi.resetModules();
    vi.mocked(api.readUiState).mockResolvedValueOnce(
      JSON.stringify({
        openTodos: [
          { workspace: "工作", project: "需求", todoId: "a" },
          { workspace: "工作", project: "需求" },
          "乱写的",
          { workspace: "工作", project: "需求", todoId: "a", preview: true },
        ],
      }),
    );
    const again: State = await import("./workspaceState");
    await again.loadUiState();
    expect(again.readOpenTodos()).toEqual([{ workspace: "工作", project: "需求", todoId: "a", preview: false }]);
  });

  it("刷新后关掉已经不在了的待办的标签，别的工作区的不动", () => {
    state.keepTodoTab(tab("工作", "需求", "a"));
    state.keepTodoTab(tab("工作", "需求", "gone"));
    state.keepTodoTab(tab("生活", "杂事", "gone"));
    state.pruneTodoTabs("工作", (_project, id) => id !== "gone");
    expect(ids()).toEqual(["工作/需求/a", "生活/杂事/gone"]);
  });
});

describe("各工作区的隐藏已完成", () => {
  it("隐藏全部完成的项目默认不隐藏，以前设过「隐藏已完成」的工作区也是", () => {
    localStorage.setItem("listOptions:工作", JSON.stringify({ sortKey: "title", hideDone: true }));
    expect(state.readListOptions("工作")).toEqual({ sortKey: "title", hideDone: true, hideDoneProjects: false });
    expect(state.readListOptions("生活").hideDoneProjects).toBe(false);
  });

  it("每个工作区各自记住", () => {
    localStorage.setItem("listOptions:工作", JSON.stringify({ sortKey: "created", hideDone: false, hideDoneProjects: true }));
    expect(state.readListOptions("工作").hideDoneProjects).toBe(true);
    expect(state.readListOptions("生活").hideDoneProjects).toBe(false);
  });

  it("工作区改名后跟过去", () => {
    localStorage.setItem("listOptions:工作", JSON.stringify({ sortKey: "created", hideDone: false, hideDoneProjects: true }));
    state.renameWorkspaceState("工作", "公司");
    expect(state.readListOptions("公司").hideDoneProjects).toBe(true);
  });
});
