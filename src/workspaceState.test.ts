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
    state.moveProjectState("工作", "需求", "生活");
    expect(backAll()).toEqual([
      { workspace: "生活", project: "需求", todoId: "a" },
      { workspace: "生活", project: "需求" },
      { workspace: "工作" },
      null,
    ]);
  });

  it("待办移到别的项目（id 因为重名变了）", () => {
    state.moveTodoState("工作", "需求", "a", ["生活", "杂事", "a-2"]);
    expect(backAll()[0]).toEqual({ workspace: "生活", project: "杂事", todoId: "a-2" });
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
