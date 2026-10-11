import { describe, expect, it } from "vitest";
import {
  childPath,
  deepTodos,
  inProject,
  leafName,
  parentOf,
  projectMoveProblem,
  projectLabel,
  reparent,
  sortProjects,
  subProjectsOf,
  topProjects,
} from "./projects";
import type { ProjectNode, TodoSummary } from "./types";

// docs/requirements.md「基础」：项目下可以建子项目，只有一层；子项目是项目文件夹里的子文件夹，路径写成「父项目/子项目」。
// 「工作区界面 → 子项目」：侧栏里子项目列在父项目下面，按名字排；显示路径的地方写成「父项目 / 子项目」；
// 父项目改名后子项目跟着；父项目的统计包括子项目里的待办

const todo = (id: string, done = false): TodoSummary => ({
  id,
  title: id,
  preview: "",
  done,
  createdAt: 0,
  updatedAt: 0,
  doneAt: null,
  pinned: false,
  order: null,
  tags: [],
  priority: 0,
});
const project = (name: string, ...todos: TodoSummary[]): ProjectNode => ({ name, todos, order: null });

describe("项目路径", () => {
  it("子项目的路径是「父项目/子项目」，顶层项目就是名字", () => {
    expect(childPath("需求", "前端")).toBe("需求/前端");
    expect(parentOf("需求/前端")).toBe("需求");
    expect(parentOf("需求")).toBeUndefined();
    expect(leafName("需求/前端")).toBe("前端");
    expect(leafName("需求")).toBe("需求");
  });

  it("显示成「父项目 / 子项目」", () => {
    expect(projectLabel("需求/前端")).toBe("需求 / 前端");
    expect(projectLabel("需求")).toBe("需求");
  });

  it("项目本身和它的子项目算在项目里，名字开头相同的别的项目不算", () => {
    expect(inProject("需求", "需求")).toBe(true);
    expect(inProject("需求/前端", "需求")).toBe(true);
    expect(inProject("需求二", "需求")).toBe(false);
    expect(inProject("需求", "需求/前端")).toBe(false);
  });

  it("父项目改名、移动后，它和子项目的路径跟着变，别的项目不变", () => {
    expect(reparent("需求", "需求", "开发")).toBe("开发");
    expect(reparent("需求/前端", "需求", "开发")).toBe("开发/前端");
    expect(reparent("需求/前端", "需求/前端", "前端")).toBe("前端");
    expect(reparent("日常", "日常", "需求/日常")).toBe("需求/日常");
    expect(reparent("需求二", "需求", "开发")).toBe("需求二");
  });
});

describe("子项目", () => {
  const list = [project("需求"), project("需求/后端"), project("日常"), project("需求/前端"), project("日常/杂项")];

  it("每个顶层项目后面跟着它的子项目，都按名字排", () => {
    expect(sortProjects(list).map((p) => p.name)).toEqual(["日常", "日常/杂项", "需求", "需求/后端", "需求/前端"]);
  });

  it("列出一个项目的子项目", () => {
    expect(subProjectsOf(list, "需求").map((p) => p.name)).toEqual(["需求/后端", "需求/前端"]);
    expect(subProjectsOf(list, "需求/前端")).toEqual([]);
  });

  it("父项目的待办包括子项目里的，子项目只有自己的", () => {
    const ps = [project("需求", todo("a")), project("需求/前端", todo("b"), todo("c")), project("需求二", todo("d"))];
    expect(deepTodos(ps, "需求").map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(deepTodos(ps, "需求/前端").map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("工作区的项目数只算顶层项目（子项目不另算）", () => {
    expect(topProjects(list).map((p) => p.name)).toEqual(["需求", "日常"]);
  });
});

// 「项目的顺序」：按名称时各层按名字排；手动排序时各层（顶层、父项目里）排过的按位置，没排过的排在后面、彼此按名字；
// 子项目总跟在父项目后面
describe("项目的顺序", () => {
  const at = (name: string, order: number | null = null): ProjectNode => ({ name, todos: [], order });
  const list = [
    at("需求", 1),
    at("需求/后端"),
    at("需求/前端", 0),
    at("需求/测试", 1),
    at("日常", 0),
    at("杂项"),
    at("备忘"),
    at("日常/零散", 5),
  ];
  const names = (manual: boolean) => sortProjects(list, manual).map((p) => p.name);

  it("按名称时不看记下的位置", () => {
    expect(names(false)).toEqual(["备忘", "日常", "日常/零散", "需求", "需求/测试", "需求/后端", "需求/前端", "杂项"]);
  });

  it("手动排序：排过的按位置，没排过的排在后面、彼此按名字；子项目跟在父项目后面，各父项目里各排各的", () => {
    expect(names(true)).toEqual(["日常", "日常/零散", "需求", "需求/前端", "需求/测试", "需求/后端", "备忘", "杂项"]);
  });

  it("位置只在同一层里比，不连续也行", () => {
    const l = [at("乙", 7), at("甲", 3), at("甲/x", 9), at("甲/y", 2), at("乙/z", 0)];
    expect(sortProjects(l, true).map((p) => p.name)).toEqual(["甲", "甲/y", "甲/x", "乙", "乙/z"]);
  });

  it("没排过的父项目的子项目也照样跟着它", () => {
    const l = [at("乙/b", 0), at("乙"), at("甲", 0), at("乙/a", 1)];
    expect(sortProjects(l, true).map((p) => p.name)).toEqual(["甲", "乙", "乙/b", "乙/a"]);
  });
});

// 「拖动移动项目」「右键项目『移动到』」：项目可以放进别的顶层项目成为子项目，子项目可以移到顶层，都可以跨工作区；
// 只有一层子项目，有子项目的项目不能放进别的项目；那里已有同名的（不分大小写）不能放
describe("项目能不能移到那里", () => {
  const work = [project("需求"), project("需求/前端"), project("日常"), project("杂项"), project("杂项/前端")];
  const life = [project("购物"), project("购物/日常"), project("旅行")];
  const problem = (p: string, parent: string | undefined, to = work) =>
    projectMoveProblem({ project: p, from: work, to, sameWorkspace: to === work, parent })?.code ?? null;

  it("顶层项目放进同一工作区的别的项目，成为子项目", () => {
    expect(problem("日常", "需求")).toBeNull();
  });

  it("子项目移到顶层、放进别的项目", () => {
    expect(problem("需求/前端", undefined, life)).toBeNull();
    expect(problem("需求/前端", "旅行", life)).toBeNull();
  });

  it("放进它自己、放进子项目不行", () => {
    expect(problem("日常", "日常")).toBe("self");
    expect(problem("日常", "需求/前端")).toBe("nested");
  });

  it("已经在那里：顶层项目移到自己工作区的顶层、子项目放进它的父项目", () => {
    expect(problem("日常", undefined)).toBe("here");
    expect(problem("需求/前端", "需求")).toBe("here");
  });

  it("有子项目的项目不能放进别的项目，可以移到别的工作区的顶层", () => {
    expect(problem("需求", "日常")).toBe("hasSubs");
    expect(problem("需求", "旅行", life)).toBe("hasSubs");
    expect(problem("需求", undefined, life)).toBeNull();
  });

  it("那里已有同名的（不分大小写）不能放", () => {
    expect(problem("需求/前端", "杂项")).toBe("taken");
    expect(problem("日常", "购物", life)).toBe("taken");
    expect(problem("杂项/前端", undefined, [project("前端")])).toBe("taken");
    expect(projectMoveProblem({ project: "abc", from: [project("abc")], to: [project("ABC")], sameWorkspace: false })?.code).toBe(
      "taken",
    );
  });
});
