import { describe, expect, it } from "vitest";
import {
  childPath,
  deepTodos,
  inProject,
  leafName,
  parentOf,
  projectLabel,
  reparent,
  sortProjects,
  subProjectsOf,
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
});
const project = (name: string, ...todos: TodoSummary[]): ProjectNode => ({ name, todos });

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
});
