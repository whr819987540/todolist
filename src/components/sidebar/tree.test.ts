import { describe, expect, it } from "vitest";
import type { ProjectNode, TodoSummary } from "../../types";
import { hiddenDoneProjects, isProjectDone } from "./tree";

// docs/requirements.md「隐藏已完成」：项目里有待办、而且全都完成了的才算全部完成，空项目不算；
// 右侧正在显示的项目照常显示；侧栏搜索时不隐藏

const todo = (id: string, done: boolean): TodoSummary => ({
  id,
  title: id,
  preview: "",
  done,
  createdAt: 0,
  updatedAt: 0,
  doneAt: done ? 1 : null,
  pinned: false,
  order: null,
});
const project = (name: string, ...done: boolean[]): ProjectNode => ({
  name,
  todos: done.map((d, i) => todo(`${name}-${i}`, d)),
});

describe("全部完成的项目", () => {
  it("有待办而且全都完成了才算", () => {
    expect(isProjectDone(project("p", true, true))).toBe(true);
    expect(isProjectDone(project("p", true, false))).toBe(false);
  });

  it("没有待办的项目（刚建的）不算", () => {
    expect(isProjectDone(project("p"))).toBe(false);
  });
});

describe("隐藏全部完成的项目时藏起哪些", () => {
  const projects = [project("全完成", true, true), project("没完成", true, false), project("空的"), project("也完成", true)];
  const names = (s: ReadonlySet<string>) => [...s].sort();

  it("只藏全部完成的，没完成的、空的照常显示", () => {
    expect(names(hiddenDoneProjects(projects, { hide: true, keyword: "" }))).toEqual(["也完成", "全完成"]);
  });

  it("没开这一项时什么都不藏", () => {
    expect(hiddenDoneProjects(projects, { hide: false, keyword: "" }).size).toBe(0);
  });

  it("右侧正在显示的项目（概览或其中的待办）照常显示", () => {
    expect(names(hiddenDoneProjects(projects, { hide: true, keyword: "", selProject: "全完成" }))).toEqual(["也完成"]);
  });

  it("侧栏搜索时不藏；只有空格不算在搜索", () => {
    expect(hiddenDoneProjects(projects, { hide: true, keyword: "完成" }).size).toBe(0);
    expect(hiddenDoneProjects(projects, { hide: true, keyword: "  " }).size).toBe(2);
  });

  it("里面有一条改回未完成：又显示出来", () => {
    const back = [project("全完成", true, false)];
    expect(hiddenDoneProjects(back, { hide: true, keyword: "" }).size).toBe(0);
  });
});
