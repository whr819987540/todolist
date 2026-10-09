// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodoSummary } from "../types";

// docs/requirements.md「待办内容 → 感知外部修改」「右侧分屏 → 两边开着同一条待办」：窗口获得焦点时核对磁盘，有没保存的
// 修改、外部又改过时立即弹出冲突对话框（两边开着同一条待办时只弹一个）；外部只是重写了一遍、内容没变的不算冲突。
// 离开这条待办（两边都关掉了；只关掉一边不算）、从托盘退出时存不上的自动另存为新待办，两份都保留

const sum = (id: string, title = id): TodoSummary => ({
  id,
  title,
  preview: "",
  done: false,
  createdAt: 0,
  updatedAt: 0,
  doneAt: null,
  pinned: false,
  order: null,
});

// 假的数据目录：只有一条待办「工作 / 需求 / A」的正文
const disk = vi.hoisted(() => ({ content: "", mtime: 1, exists: true }));
const mocked = vi.hoisted(() => ({
  api: {
    readTodo: vi.fn(),
    saveTodoContent: vi.fn(),
    setTodoTitle: vi.fn(),
    createTodo: vi.fn(),
    readUiState: vi.fn(async () => "{}"),
    writeUiState: vi.fn(async () => {}),
  },
}));
vi.mock("../api", () => ({ api: mocked.api, errMsg: (e: unknown) => String(e) }));

const { todoSession } = await import("./todoSession");
type TodoSession = ReturnType<typeof todoSession>;
type Member = ReturnType<typeof member>;
const { flushBeforeQuit } = await import("../hooks");
const { api } = mocked;

/** 外部程序改了正文（修改时间跟着变） */
function writeOutside(content: string) {
  disk.content = content;
  disk.mtime += 1;
}

beforeEach(() => {
  disk.content = "原来的\n";
  disk.mtime = 1;
  disk.exists = true;
  api.readTodo.mockImplementation(async () => {
    if (!disk.exists) throw "待办不存在，可能已被删除或移动";
    return { content: disk.content, mtime: disk.mtime, encoding: "UTF-8", path: "A.md", summary: sum("A") };
  });
  api.saveTodoContent.mockImplementation(async (_w, _p, _id, text: string, base: number | null, force: boolean) => {
    if (!disk.exists) throw "待办不存在，可能已被删除或移动";
    if (!force && base !== disk.mtime) return { saved: false, mtime: disk.mtime, summary: sum("A") };
    disk.content = text;
    disk.mtime += 1;
    return { saved: true, mtime: disk.mtime, summary: sum("A") };
  });
  api.setTodoTitle.mockImplementation(async (_w, _p, id: string, title: string) => sum(id, title));
  api.createTodo.mockImplementation(async (_w, _p, title: string) => sum("新的", title));
});

/** 还开着的：每个用例做完都关掉，免得从托盘退出的用例里还有上一个用例的会话 */
const live: { s: TodoSession; m: Member }[] = [];

/** 关掉开着这条待办的一个编辑器 */
function close(s: TodoSession, m: Member) {
  const i = live.findIndex((x) => x.s === s && x.m === m);
  if (i >= 0) live.splice(i, 1);
  s.detach(m);
}

afterEach(async () => {
  for (const { s, m } of live.splice(0)) s.detach(m);
  await settle();
  vi.clearAllMocks();
});

let seq = 0;
/** 开着这条待办的一个编辑器（分屏时一边一个） */
function member() {
  const id = `m${++seq}`;
  return {
    id,
    onSummary: vi.fn(),
    summary: () => sum("A"),
    onEdit: vi.fn(),
    saveOptions: () => ({ autoSave: false, saveDelaySecs: 180 }),
    error: vi.fn(),
    notice: vi.fn(),
    quickTarget: () => ({ workspace: "收件箱", project: "快速记录" }),
    savePosition: vi.fn(),
    loaded: vi.fn(),
    titleFocused: () => false,
    contentChanged: vi.fn(),
    reset: vi.fn(),
  };
}

/** 等保存、核对排着的都做完 */
const settle = () => new Promise((r) => setTimeout(r, 20));

/** 打开「工作 / 需求 / A」（每个用例一个新的项目名，免得用到上一个用例的会话） */
async function open(...members: Member[]) {
  const s = todoSession("工作", `需求${++seq}`, "A", "A");
  for (const m of members) {
    s.attach(m);
    live.push({ s, m });
  }
  await settle();
  return s;
}

describe("窗口获得焦点时核对磁盘", () => {
  it("没有未保存的修改：重新加载外部改过的正文", async () => {
    const m = member();
    const s = await open(m);
    writeOutside("外部改的\n");
    s.windowFocus(true);
    await settle();
    expect(m.reset).toHaveBeenCalledWith("外部改的\n");
    expect(s.getState().conflict).toBe(false);
  });

  it("有未保存的修改、外部改过：立即报冲突，正在编辑的内容不动", async () => {
    const m = member();
    const s = await open(m);
    s.setContent("原来的\n我加的\n");
    writeOutside("外部改的\n");
    s.windowFocus(true);
    await settle();
    expect(s.getState().conflict).toBe(true);
    expect(m.reset).not.toHaveBeenCalled();
    expect(s.currentDoc()).toBe("原来的\n我加的\n");
  });

  it("有未保存的修改、外部只是把同样的内容重写了一遍或改成了和这里一样的：不算冲突", async () => {
    const m = member();
    const s = await open(m);
    s.setContent("原来的\n我加的\n");
    writeOutside("原来的\n");
    s.windowFocus(true);
    await settle();
    expect(s.getState().conflict).toBe(false);
    expect(m.reset).not.toHaveBeenCalled();
    // 改成了和这里一样的：也不再算没保存
    writeOutside("原来的\n我加的\n");
    s.windowFocus(true);
    await settle();
    expect(s.getState()).toMatchObject({ conflict: false, status: "saved" });
    // 之后照常保存，不会因为修改时间变了当成冲突
    s.setContent("原来的\n我加的\n又加的\n");
    expect(await s.flush()).toBe(true);
    expect(disk.content).toBe("原来的\n我加的\n又加的\n");
  });

  it("没有未保存的修改、外部只是把同样的内容重写了一遍：不重新加载（光标、撤销记录都不动），之后照常保存", async () => {
    const m = member();
    const s = await open(m);
    writeOutside("原来的\n");
    s.windowFocus(true);
    await settle();
    expect(m.reset).not.toHaveBeenCalled();
    expect(s.getState()).toMatchObject({ conflict: false, status: "saved" });
    s.setContent("原来的\n后来加的\n");
    expect(await s.flush()).toBe(true);
    expect(disk.content).toBe("原来的\n后来加的\n");
  });
});

describe("离开时存不上的另存为新待办", () => {
  it("都存好了：不另存", async () => {
    const m = member();
    const s = await open(m);
    s.setContent("改过的\n");
    close(s, m);
    await settle();
    expect(disk.content).toBe("改过的\n");
    expect(api.createTodo).not.toHaveBeenCalled();
  });

  it("正显示着冲突对话框时离开：另存为同一项目里的「（我的版本）」，提示新待办的标题，原来那条不再往里存", async () => {
    const m = member();
    const s = await open(m);
    s.setContent("我改的\n");
    writeOutside("外部改的\n");
    s.windowFocus(true);
    await settle();
    close(s, m);
    await settle();
    expect(api.createTodo).toHaveBeenCalledWith("工作", s.project, "A（我的版本）", "我改的\n", false);
    expect(disk.content).toBe("外部改的\n");
    expect(m.notice).toHaveBeenCalledWith("warning", expect.stringContaining("「A（我的版本）」"), expect.any(Number));
  });

  it("分屏两边开着同一条待办：只关掉一边不算离开，不另存，冲突对话框留给另一边；两边都关掉了才另存", async () => {
    const left = member();
    const right = member();
    const s = await open(left, right);
    s.setContent("我改的\n");
    writeOutside("外部改的\n");
    s.windowFocus(true);
    await settle();
    expect(s.getState()).toMatchObject({ conflict: true, lead: left.id });
    close(s, left);
    await settle();
    expect(api.createTodo).not.toHaveBeenCalled();
    expect(s.getState()).toMatchObject({ conflict: true, lead: right.id });
    close(s, right);
    await settle();
    expect(api.createTodo).toHaveBeenCalledTimes(1);
    expect(api.createTodo).toHaveBeenCalledWith("工作", s.project, "A（我的版本）", "我改的\n", false);
  });

  it("待办在外部被删了：另存，提示里说明没能保存的原因，不再单独弹「保存失败」", async () => {
    const m = member();
    const s = await open(m);
    s.setContent("我改的\n");
    disk.exists = false;
    close(s, m);
    await settle();
    expect(api.createTodo).toHaveBeenCalledTimes(1);
    expect(m.error).not.toHaveBeenCalled();
    expect(m.notice).toHaveBeenCalledWith("warning", expect.stringContaining("没能保存"), expect.any(Number));
  });

  it("原来的项目也不在了：存到快速记录存到的项目（不在时新建）", async () => {
    const m = member();
    const s = await open(m);
    s.setContent("我改的\n");
    disk.exists = false;
    api.createTodo.mockImplementation(async (w: string, _p, title: string, _c, createProject: boolean) => {
      if (w === "工作" || !createProject) throw "项目不存在";
      return sum("新的", title);
    });
    close(s, m);
    await settle();
    expect(api.createTodo).toHaveBeenLastCalledWith("收件箱", "快速记录", "A（我的版本）", "我改的\n", true);
    expect(m.notice).toHaveBeenCalledWith("warning", expect.stringContaining("「收件箱 / 快速记录」"), expect.any(Number));
  });

  it("从托盘退出时正显示着冲突对话框：另存后这一条换成外部的版本，算存好了（可以退出）", async () => {
    const m = member();
    const s = await open(m);
    s.setContent("我改的\n");
    writeOutside("外部改的\n");
    s.windowFocus(true);
    await settle();
    expect(await flushBeforeQuit()).toBe("saved");
    expect(api.createTodo).toHaveBeenCalledTimes(1);
    expect(m.reset).toHaveBeenCalledWith("外部改的\n");
    expect(s.getState().conflict).toBe(false);
    // 没退出（问用户时选了不退出）再退一次，也不会再另存一份
    expect(await flushBeforeQuit()).toBe("saved");
    expect(api.createTodo).toHaveBeenCalledTimes(1);
    close(s, m);
    await settle();
  });

  it("从托盘退出时另存也失败：不算存好（不退出），修改还在编辑区里", async () => {
    const m = member();
    const s = await open(m);
    s.setContent("我改的\n");
    disk.exists = false;
    api.createTodo.mockImplementation(async () => {
      throw "拒绝访问";
    });
    expect(await flushBeforeQuit()).toBe("failed");
    expect(s.currentDoc()).toBe("我改的\n");
    expect(m.notice).toHaveBeenCalledWith("error", expect.stringContaining("还在编辑区里"), expect.any(Number));
    disk.exists = true;
    api.createTodo.mockImplementation(async (_w, _p, title: string) => sum("新的", title));
    close(s, m);
    await settle();
  });
});
