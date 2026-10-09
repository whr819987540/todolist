import { describe, expect, it } from "vitest";
import type { ProjectNode, TodoSummary } from "../../types";
import { hiddenDoneProjects, isProjectDone, type Lingering, lingeringAfter, NO_LINGERING } from "./tree";

// docs/requirements.md「隐藏已完成」：项目里有待办、而且全都完成了的才算全部完成，空项目不算；
// 右侧正在显示的项目照常显示，切到别处后再显示一会儿才藏起来（这期间切回来就接着显示）；侧栏搜索时不隐藏

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

  it("侧栏搜索时不藏", () => {
    expect(hiddenDoneProjects(projects, { hide: true, keyword: "完成" }).size).toBe(0);
  });

  it("里面有一条改回未完成：又显示出来", () => {
    const back = [project("全完成", true, false)];
    expect(hiddenDoneProjects(back, { hide: true, keyword: "" }).size).toBe(0);
  });

  it("刚切走、还在再显示一会儿的项目照常显示", () => {
    const lingering = new Set(["全完成"]);
    expect(names(hiddenDoneProjects(projects, { hide: true, keyword: "", selProject: "也完成", lingering }))).toEqual([]);
    expect(names(hiddenDoneProjects(projects, { hide: true, keyword: "", lingering }))).toEqual(["也完成"]);
  });
});

describe("切到别处后再显示一会儿的项目", () => {
  const all = () => true;
  const todoIn = (workspace: string, project: string, todoId = "x") => ({ workspace, project, todoId });
  const list = (l: Lingering) => [...l].map(([ws, s]) => [ws, [...s].sort()]);

  it("离开会被藏起来的项目（打开着其中的待办、看着它的概览）：它再显示一会儿", () => {
    expect(list(lingeringAfter(NO_LINGERING, todoIn("工作", "P"), todoIn("工作", "Q"), all))).toEqual([["工作", ["P"]]]);
    expect(list(lingeringAfter(NO_LINGERING, { workspace: "工作", project: "P" }, todoIn("工作", "Q"), all))).toEqual([
      ["工作", ["P"]],
    ]);
  });

  it("切到工作区概览、别的工作区里也算离开", () => {
    expect(list(lingeringAfter(NO_LINGERING, todoIn("工作", "P"), { workspace: "工作" }, all))).toEqual([["工作", ["P"]]]);
    expect(list(lingeringAfter(NO_LINGERING, todoIn("工作", "P"), todoIn("生活", "P"), all))).toEqual([["工作", ["P"]]]);
  });

  it("在同一项目里换一条待办、换到它的概览：没有离开", () => {
    expect(lingeringAfter(NO_LINGERING, todoIn("工作", "P", "a"), todoIn("工作", "P", "b"), all).size).toBe(0);
    expect(lingeringAfter(NO_LINGERING, todoIn("工作", "P"), { workspace: "工作", project: "P" }, all).size).toBe(0);
  });

  it("从工作区概览切走：没有离开哪个项目", () => {
    expect(lingeringAfter(NO_LINGERING, { workspace: "工作" }, todoIn("工作", "Q"), all).size).toBe(0);
  });

  it("不会被藏起来的项目（没开这一项、没全部完成、在搜索）不必再显示", () => {
    expect(lingeringAfter(NO_LINGERING, todoIn("工作", "P"), todoIn("工作", "Q"), () => false).size).toBe(0);
    const onlyP = (_ws: string, p: string) => p === "P";
    const once = lingeringAfter(NO_LINGERING, todoIn("工作", "P"), todoIn("工作", "Q"), onlyP);
    expect(list(lingeringAfter(once, todoIn("工作", "Q"), todoIn("工作", "R"), onlyP))).toEqual([["工作", ["P"]]]);
  });

  it("这期间切回它：不再算刚离开（它正显示着，照常显示）", () => {
    const p = lingeringAfter(NO_LINGERING, todoIn("工作", "P"), todoIn("工作", "Q"), all);
    // Q 没全部完成，切走时不必留
    const notQ = (_ws: string, x: string) => x !== "Q";
    expect(lingeringAfter(p, todoIn("工作", "Q"), todoIn("工作", "P", "y"), notQ).size).toBe(0);
    expect(lingeringAfter(p, todoIn("工作", "Q"), { workspace: "工作", project: "P" }, notQ).size).toBe(0);
  });

  it("这期间又离开另一个全部完成的项目：两个都还显示着", () => {
    const p = lingeringAfter(NO_LINGERING, todoIn("工作", "P"), todoIn("工作", "P2"), all);
    expect(list(lingeringAfter(p, todoIn("工作", "P2"), todoIn("工作", "Q"), all))).toEqual([["工作", ["P", "P2"]]]);
    const other = lingeringAfter(p, todoIn("工作", "P2"), todoIn("生活", "R"), all);
    expect(list(other)).toEqual([["工作", ["P", "P2"]]]);
  });

  it("没有变化时原样返回，别的工作区沿用原来的集合（侧栏里这些工作区不必重新渲染）", () => {
    const p = lingeringAfter(NO_LINGERING, todoIn("工作", "P"), todoIn("工作", "Q"), all);
    expect(lingeringAfter(p, todoIn("工作", "Q", "a"), todoIn("工作", "Q", "b"), all)).toBe(p);
    const toR = lingeringAfter(NO_LINGERING, todoIn("工作", "P"), todoIn("生活", "R"), all);
    const toS = lingeringAfter(toR, todoIn("生活", "R"), todoIn("生活", "S"), all);
    expect(list(toS)).toEqual([
      ["工作", ["P"]],
      ["生活", ["R"]],
    ]);
    expect(toS.get("工作")).toBe(toR.get("工作"));
  });
});
