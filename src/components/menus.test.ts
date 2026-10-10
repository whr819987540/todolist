import type { MenuProps } from "antd";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TodoSummary, WorkspaceTree } from "../types";
import { type Actions, moveTargets, todoMenu } from "./menus";

// docs/requirements.md「右键工作区 / 项目 / 待办弹出操作菜单」：待办的「移动到」——只显示一个工作区时列出同一工作区的其他项目；
// 同时显示了几个工作区时，也列出其他选中工作区的项目，按工作区分组。「子项目」：「移动到」里的项目写成「父项目 / 子项目 / …」，
// 看得出层级；路径太长时中间折叠成「…」，悬停看完整路径

const tree = (name: string, ...projects: string[]): WorkspaceTree => ({
  name,
  projects: projects.map((p) => ({ name: p, todos: [] })),
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
};

type Item = { key?: string; type?: string; label?: unknown; disabled?: boolean; children?: Item[] };
const moveItem = (menu: MenuProps) => (menu.items as Item[]).find((i) => i?.key === "move")!;
/** 菜单项上悬停看到的完整路径（写成路径的项目是带 title 的元素），别的是文字本身 */
const full = (label: unknown) => (isValidElement(label) ? (label as ReactElement<{ title: string }>).props.title : label);
/** 菜单项上显示出来的文字 */
const shown = (label: unknown) =>
  isValidElement(label) ? renderToStaticMarkup(label).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"') : label;
const labels = (items: Item[] | undefined) => (items ?? []).map((i) => full(i.label));

function actions() {
  return { moveTodo: vi.fn(), togglePinned: vi.fn() } as unknown as Actions & {
    moveTodo: ReturnType<typeof vi.fn>;
    togglePinned: ReturnType<typeof vi.fn>;
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

describe("「移动到」里的子项目", () => {
  it("写成路径，看得出在哪一级", () => {
    const trees = [tree("工作", "需求", "需求/前端", "需求/前端/组件", "日常")];
    const move = moveItem(todoMenu(actions(), "日常", todo, moveTargets(trees, "工作")));
    expect(labels(move.children)).toEqual(["需求", "需求 / 前端", "需求 / 前端 / 组件"]);
    expect(move.children!.map((c) => shown(c.label))).toEqual(["需求", "需求 / 前端", "需求 / 前端 / 组件"]);
  });

  it("层级多时中间折叠成「…」，悬停看完整路径；点了照样移到那里", () => {
    const deep = "需求/前端/组件/按钮/图标";
    const a = actions();
    const menu = todoMenu(a, "日常", todo, moveTargets([tree("工作", "日常", deep)], "工作"));
    const [item] = moveItem(menu).children!;
    expect(shown(item.label)).toBe("需求 / … / 按钮 / 图标");
    expect(full(item.label)).toBe("需求 / 前端 / 组件 / 按钮 / 图标");
    click(menu, item.key!);
    expect(a.moveTodo.mock.calls).toEqual([["日常", todo, deep, undefined]]);
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
