import type { MenuProps } from "antd";
import { describe, expect, it, vi } from "vitest";
import type { TodoSummary, WorkspaceTree } from "../types";
import type { TodoAt } from "./DragMove";
import { type Actions, batchMenu, moveTargets, projectMenu, todoMenu, workspaceMenu } from "./menus";
import type { BatchActions } from "./workspaceActions";

// docs/requirements.md「右键工作区 / 项目 / 待办弹出操作菜单」：待办的「移动到」——只显示一个工作区时列出同一工作区的其他项目；
// 同时显示了几个工作区时，也列出其他选中工作区的项目，按工作区分组

const tree = (name: string, ...projects: string[]): WorkspaceTree => ({
  name,
  projects: projects.map((p) => ({ name: p, todos: [], order: null })),
  manualOrder: false,
});
const todo: TodoSummary = {
  id: "a",
  title: "买菜",
  preview: "",
  done: false,
  createdAt: 0,
  updatedAt: 0,
  doneAt: null,
  pinned: false,
  order: null,
  tags: [],
  priority: 0,
};

type Item = { key?: string; type?: string; label?: unknown; disabled?: boolean; children?: Item[] };
const moveItem = (menu: MenuProps) => (menu.items as Item[]).find((i) => i?.key === "move")!;
const labels = (items: Item[] | undefined) => (items ?? []).map((i) => i.label);

function actions() {
  return {
    moveTodo: vi.fn(),
    togglePinned: vi.fn(),
    exportTodo: vi.fn(),
    exportProject: vi.fn(),
    exportWorkspace: vi.fn(),
  } as unknown as Actions & {
    moveTodo: ReturnType<typeof vi.fn>;
    togglePinned: ReturnType<typeof vi.fn>;
    exportTodo: ReturnType<typeof vi.fn>;
    exportProject: ReturnType<typeof vi.fn>;
    exportWorkspace: ReturnType<typeof vi.fn>;
  };
}

function click(menu: MenuProps, key: string) {
  menu.onClick!({ key, keyPath: [key], domEvent: { stopPropagation() {} } } as never);
}

describe("可以移到的项目", () => {
  it("待办所在的工作区排第一，其余按侧栏里的顺序", () => {
    const trees = [tree("学习", "读书"), tree("工作", "需求", "测试"), tree("生活", "杂事")];
    expect(moveTargets(trees, "工作")).toEqual([
      { workspace: "工作", projects: ["需求", "测试"] },
      { workspace: "学习", projects: ["读书"] },
      { workspace: "生活", projects: ["杂事"] },
    ]);
  });
});

describe("待办右键菜单的「移动到」", () => {
  it("只显示一个工作区：直接列出同一工作区的其他项目，不分组", () => {
    const menu = todoMenu(actions(), "需求", todo, moveTargets([tree("工作", "需求", "测试", "上线")], "工作"));
    const move = moveItem(menu);
    expect(labels(move.children)).toEqual(["测试", "上线"]);
    expect(move.children!.every((c) => c.type !== "group")).toBe(true);
    expect(move.disabled).toBe(false);
  });

  it("同时显示几个工作区：按工作区分组，所在的工作区排第一并标上「当前」", () => {
    const trees = [tree("工作", "需求", "测试"), tree("生活", "杂事", "旅行")];
    const move = moveItem(todoMenu(actions(), "需求", todo, moveTargets(trees, "工作")));
    expect(move.children!.map((g) => [g.type, g.label, labels(g.children)])).toEqual([
      ["group", "工作（当前）", ["测试"]],
      ["group", "生活", ["杂事", "旅行"]],
    ]);
  });

  it("没有可移去的项目的工作区不列", () => {
    const trees = [tree("工作", "需求"), tree("生活"), tree("学习", "读书")];
    const move = moveItem(todoMenu(actions(), "需求", todo, moveTargets(trees, "工作")));
    expect(move.children!.map((g) => g.label)).toEqual(["学习"]);
  });

  it("哪里都不能移时「移动到」不可用", () => {
    const move = moveItem(todoMenu(actions(), "需求", todo, moveTargets([tree("工作", "需求"), tree("生活")], "工作")));
    expect(move.disabled).toBe(true);
    expect(move.children).toBeUndefined();
  });

  it("项目名里有特殊字符也能移", () => {
    const a = actions();
    const trees = [tree("工作", "需求", 'a:"b" / c'), tree("生活", "move:x")];
    const menu = todoMenu(a, "需求", todo, moveTargets(trees, "工作"));
    const [own, other] = moveItem(menu).children!;
    click(menu, own.children![0].key!);
    click(menu, other.children![0].key!);
    expect(a.moveTodo.mock.calls).toEqual([
      ["需求", todo, 'a:"b" / c', undefined],
      ["需求", todo, "move:x", "生活"],
    ]);
  });

  it("点了同一工作区的项目：移到这个工作区里；点了别的工作区的：带上目标工作区", () => {
    const a = actions();
    const trees = [tree("工作", "需求", "测试"), tree("生活", "杂事")];
    const menu = todoMenu(a, "需求", todo, moveTargets(trees, "工作"));
    const [own, other] = moveItem(menu).children!;
    click(menu, own.children![0].key!);
    click(menu, other.children![0].key!);
    expect(a.moveTodo.mock.calls).toEqual([
      ["需求", todo, "测试", undefined],
      ["需求", todo, "杂事", "生活"],
    ]);
  });
});

describe("待办右键菜单的「置顶」", () => {
  const item = (t: TodoSummary) => (todoMenu(actions(), "需求", t, []).items as Item[]).find((i) => i?.key === "pin")!;

  it("没置顶时是「置顶」，置顶了是「取消置顶」", () => {
    expect(item(todo).label).toBe("置顶");
    expect(item({ ...todo, pinned: true }).label).toBe("取消置顶");
  });

  it("点了交给 togglePinned", () => {
    const a = actions();
    click(todoMenu(a, "需求", todo, []), "pin");
    expect(a.togglePinned).toHaveBeenCalledWith("需求", todo);
  });
});

describe("待办右键菜单的「标签…」", () => {
  it("点了打开选标签的对话框", () => {
    const a = { editTags: vi.fn() } as unknown as Actions & { editTags: ReturnType<typeof vi.fn> };
    const menu = todoMenu(a, "需求", todo, []);
    expect((menu.items as Item[]).find((i) => i?.key === "tags")?.label).toBe("标签…");
    click(menu, "tags");
    expect(a.editTags).toHaveBeenCalledWith("需求", todo);
  });
});

describe("批量菜单的「添加标签」「移除标签」", () => {
  it("作用于选中的这些待办", () => {
    const items: TodoAt[] = [
      { workspace: "工作", project: "需求", todo },
      { workspace: "生活", project: "杂事", todo: { ...todo, id: "b" } },
    ];
    const b = { addTags: vi.fn(), removeTags: vi.fn() } as unknown as BatchActions & {
      addTags: ReturnType<typeof vi.fn>;
      removeTags: ReturnType<typeof vi.fn>;
    };
    const menu = batchMenu(items, [], b, () => {});
    expect(labels(menu.items as Item[])).toEqual(expect.arrayContaining(["添加标签…", "移除标签…"]));
    click(menu, "add-tags");
    click(menu, "remove-tags");
    expect(b.addTags).toHaveBeenCalledWith(items);
    expect(b.removeTags).toHaveBeenCalledWith(items);
  });
});

describe("待办右键菜单的「优先级」", () => {
  type PItem = Item & { extra?: unknown };
  const sub = (t: TodoSummary) => ((todoMenu(actions(), "需求", t, []).items as Item[]).find((i) => i?.key === "priority")!.children ?? []) as PItem[];

  it("子菜单从高到低列出四档，现在的那一档打勾", () => {
    const items = sub({ ...todo, priority: 2 });
    expect(items).toHaveLength(4);
    expect(items.map((i) => !!i.extra)).toEqual([false, true, false, false]);
    expect(sub(todo).map((i) => !!i.extra)).toEqual([false, false, false, true]);
  });

  it("点了交给 setPriority", () => {
    const a = { setPriority: vi.fn() } as unknown as Actions & { setPriority: ReturnType<typeof vi.fn> };
    const menu = todoMenu(a, "需求", todo, []);
    const [high, , , none] = (menu.items as Item[]).find((i) => i?.key === "priority")!.children!;
    click(menu, high.key!);
    click(menu, none.key!);
    expect(a.setPriority.mock.calls).toEqual([
      ["需求", todo, 3],
      ["需求", todo, 0],
    ]);
  });
});

describe("批量菜单的「设置优先级」", () => {
  it("作用于选中的这些待办", () => {
    const items: TodoAt[] = [{ workspace: "工作", project: "需求", todo }];
    const b = { setPriority: vi.fn() } as unknown as BatchActions & { setPriority: ReturnType<typeof vi.fn> };
    const menu = batchMenu(items, [], b, () => {});
    const low = (menu.items as Item[]).find((i) => i?.key === "priority")!.children![2];
    click(menu, low.key!);
    expect(b.setPriority).toHaveBeenCalledWith(items, 1);
  });
});

// docs/requirements.md「导出」：待办、项目（包括子项目）、工作区的菜单里「导出」→「导出为 HTML」「导出为 PDF」
describe("菜单里的「导出」", () => {
  const exportItem = (menu: MenuProps) => (menu.items as Item[]).find((i) => i?.key === "export")!;

  it("待办、项目、子项目、工作区的菜单里都有，子菜单是「导出为 HTML」「导出为 PDF」", () => {
    for (const menu of [
      todoMenu(actions(), "需求", todo, []),
      projectMenu(actions(), "需求", []),
      projectMenu(actions(), "需求/前端", []),
      workspaceMenu(actions()),
    ]) {
      const item = exportItem(menu);
      expect(item.label).toBe("导出");
      expect(labels(item.children)).toEqual(["导出为 HTML", "导出为 PDF"]);
    }
  });

  it("点了交给对应的导出：这条待办、这个项目、这个工作区", () => {
    const a = actions();
    const pick = (menu: MenuProps) => click(menu, exportItem(menu).children![0].key!);
    pick(todoMenu(a, "需求", todo, []));
    pick(projectMenu(a, "需求/前端", []));
    pick(workspaceMenu(a));
    expect(a.exportTodo).toHaveBeenCalledWith("需求", todo, "html");
    expect(a.exportProject).toHaveBeenCalledWith("需求/前端", "html");
    expect(a.exportWorkspace).toHaveBeenCalledWith("html");
    const menu = todoMenu(a, "需求", todo, []);
    click(menu, exportItem(menu).children![1].key!);
    expect(a.exportTodo).toHaveBeenLastCalledWith("需求", todo, "pdf");
  });
});
