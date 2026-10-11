import { describe, expect, it } from "vitest";
import { NO_FILTER, type TodoFilter } from "../../filter";
import type { ProjectNode, TodoSummary, WorkspaceTree } from "../../types";
import {
  anyVisibleProjectOpen,
  type Collapsed,
  hiddenByFilter,
  hiddenDoneProjects,
  isProjectDone,
  type Lingering,
  lingeringAfter,
  NO_LINGERING,
  unionHidden,
  WS_KEY,
} from "./tree";

// docs/requirements.md「隐藏已完成」：项目里有待办、而且全都完成了的才算全部完成，空项目不算；
// 右侧正在显示的项目照常显示，切到别处后再显示一会儿才藏起来（这期间切回来就接着显示）；侧栏搜索时不隐藏；
// 侧栏顶部的「全部折叠 / 全部展开」不算藏起来的项目，也不算折叠着的工作区里的项目（都看不见）。
// 「子项目」：父项目自己和子项目里的待办合起来看，都完成了才算全部完成，连同子项目一起藏；父项目没全部完成时，
// 全部完成的子项目单独藏；右侧显示着子项目时它的父项目也照常显示；折叠着的父项目里的子项目看不见，「全部折叠」不算它

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
  tags: [],
  priority: 0,
});
const project = (name: string, ...done: boolean[]): ProjectNode => ({
  name,
  todos: done.map((d, i) => todo(`${name}-${i}`, d)),
  order: null,
});

describe("全部完成的项目", () => {
  it("有待办而且全都完成了才算", () => {
    expect(isProjectDone([project("p", true, true)], "p")).toBe(true);
    expect(isProjectDone([project("p", true, false)], "p")).toBe(false);
  });

  it("没有待办的项目（刚建的）不算", () => {
    expect(isProjectDone([project("p")], "p")).toBe(false);
  });

  it("父项目连同子项目里的待办一起看，子项目只看自己的", () => {
    expect(isProjectDone([project("p", true), project("p/a", true)], "p")).toBe(true);
    expect(isProjectDone([project("p", true), project("p/a", false)], "p")).toBe(false);
    expect(isProjectDone([project("p", false), project("p/a", true)], "p/a")).toBe(true);
    // 父项目自己没有待办，子项目里的都完成了
    expect(isProjectDone([project("p"), project("p/a", true)], "p")).toBe(true);
    // 名字开头相同的别的项目不算子项目
    expect(isProjectDone([project("p", true), project("p2", false)], "p")).toBe(true);
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

describe("有子项目时藏起哪些", () => {
  const names = (s: ReadonlySet<string>) => [...s].sort();
  const hide = (projects: ProjectNode[], o: { selProject?: string; lingering?: ReadonlySet<string> } = {}) =>
    names(hiddenDoneProjects(projects, { hide: true, keyword: "", ...o }));

  it("父项目和子项目都完成了：父项目连同子项目一起藏，只算一个", () => {
    expect(hide([project("p", true), project("p/a", true), project("p/b", true)])).toEqual(["p"]);
  });

  it("父项目还没全部完成：全部完成的子项目单独藏", () => {
    expect(hide([project("p", false), project("p/a", true), project("p/b", false)])).toEqual(["p/a"]);
    expect(hide([project("p", true), project("p/a", true), project("p/b", false)])).toEqual(["p/a"]);
  });

  it("右侧显示着子项目（或其中的待办）：它和父项目照常显示，别的全部完成的子项目照样藏", () => {
    const ps = [project("p", true), project("p/a", true), project("p/b", true)];
    expect(hide(ps, { selProject: "p/a" })).toEqual(["p/b"]);
    expect(hide(ps, { lingering: new Set(["p/a"]) })).toEqual(["p/b"]);
  });

  it("右侧显示着父项目：父项目照常显示，其中全部完成的子项目藏", () => {
    expect(hide([project("p", true), project("p/a", true)], { selProject: "p" })).toEqual(["p/a"]);
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

describe("「全部折叠 / 全部展开」看哪些项目", () => {
  const work: WorkspaceTree = {
    name: "工作",
    projects: [project("全完成", true, true), project("没完成", true, false), project("空的")],
    manualOrder: false,
  };
  const life: WorkspaceTree = { name: "生活", projects: [project("杂事", false)], manualOrder: false };
  /** 各工作区里折叠了哪些项目，没写的展开着（藏起来的全部完成的项目默认就是展开着的） */
  const folded =
    (m: Record<string, string[]>) =>
    (ws: string): Collapsed =>
      Object.fromEntries((m[ws] ?? []).map((p) => [p, true]));
  /** 开着隐藏全部完成的项目时藏起来的，和侧栏的树一样算 */
  const hiding =
    (o: { selProject?: string; lingering?: ReadonlySet<string>; keyword?: string } = {}) =>
    (t: WorkspaceTree) =>
      hiddenDoneProjects(t.projects, { hide: true, keyword: "", ...o });
  const othersFolded = folded({ 工作: ["没完成", "空的"] });

  it("看得见的项目有展开着的：全部折叠", () => {
    expect(anyVisibleProjectOpen([work], folded({ 工作: ["全完成", "空的"] }), hiding())).toBe(true);
  });

  it("看得见的都折叠着：全部展开，藏起来的全部完成的项目展开着也不算", () => {
    expect(anyVisibleProjectOpen([work], othersFolded, hiding())).toBe(false);
  });

  it("右侧正在显示的、切走后还在再显示一会儿的全部完成的项目看得见，算", () => {
    expect(anyVisibleProjectOpen([work], othersFolded, hiding({ selProject: "全完成" }))).toBe(true);
    expect(anyVisibleProjectOpen([work], othersFolded, hiding({ lingering: new Set(["全完成"]) }))).toBe(true);
  });

  it("没开隐藏全部完成的项目、侧栏搜索时什么都不藏，都算", () => {
    const off = (t: WorkspaceTree) => hiddenDoneProjects(t.projects, { hide: false, keyword: "" });
    expect(anyVisibleProjectOpen([work], othersFolded, off)).toBe(true);
    expect(anyVisibleProjectOpen([work], othersFolded, hiding({ keyword: "完成" }))).toBe(true);
  });

  it("折叠着的工作区里的项目看不见，展开着也不算", () => {
    const wsFolded = (ws: string): Collapsed => (ws === "工作" ? { [WS_KEY]: true } : { 杂事: true });
    expect(anyVisibleProjectOpen([work], wsFolded, hiding())).toBe(false);
    expect(anyVisibleProjectOpen([work, life], wsFolded, hiding())).toBe(false);
    const lifeOpen = (ws: string): Collapsed => (ws === "工作" ? { [WS_KEY]: true } : {});
    expect(anyVisibleProjectOpen([work, life], lifeOpen, hiding())).toBe(true);
  });

  it("父项目折叠着：其中的子项目看不见，展开着也不算", () => {
    const ws: WorkspaceTree = { name: "工作", projects: [project("p", false), project("p/a", false)], manualOrder: false };
    expect(anyVisibleProjectOpen([ws], folded({ 工作: ["p"] }), hiding())).toBe(false);
    expect(anyVisibleProjectOpen([ws], folded({ 工作: ["p/a"] }), hiding())).toBe(true);
    expect(anyVisibleProjectOpen([ws], folded({ 工作: ["p", "p/a"] }), hiding())).toBe(false);
  });

  it("单独藏起来的子项目展开着也不算", () => {
    const ws: WorkspaceTree = { name: "工作", projects: [project("p", false), project("p/a", true)], manualOrder: false };
    expect(anyVisibleProjectOpen([ws], folded({ 工作: ["p"] }), hiding())).toBe(false);
    expect(anyVisibleProjectOpen([ws], folded({}), hiding())).toBe(true);
    const parentDone: WorkspaceTree = {
      name: "工作",
      projects: [project("p", true), project("p/a", true), project("q")],
      manualOrder: false,
    };
    expect(anyVisibleProjectOpen([parentDone], folded({ 工作: ["q"] }), hiding())).toBe(false);
  });

  it("选中了多个工作区：哪个工作区里有看得见的项目展开着都是全部折叠，都折叠着才是全部展开", () => {
    const workAll = folded({ 工作: ["全完成", "没完成", "空的"] });
    expect(anyVisibleProjectOpen([work, life], workAll, hiding())).toBe(true);
    expect(anyVisibleProjectOpen([work, life], folded({ 工作: ["没完成", "空的"], 生活: ["杂事"] }), hiding())).toBe(false);
  });
});

// docs/requirements.md「筛选」：没有符合筛选的待办的项目（父项目连同子项目一起看）不显示；右侧正在显示的、刚切走的照常显示；
// 隐藏已完成的待办时，只有已完成的待办符合的项目也不显示
describe("筛选时筛掉哪些项目", () => {
  const tagged = (name: string, ...todos: [string, boolean?][]): ProjectNode => ({
    name,
    todos: todos.map(([tag, done = false], i) => ({ ...todo(`${name}-${i}`, done), tags: tag ? [tag] : [] })),
    order: null,
  });
  const work: TodoFilter = { ...NO_FILTER, tags: ["工作"] };
  const names = (s: ReadonlySet<string>) => [...s].sort();
  const hide = (projects: ProjectNode[], o: { hideDone?: boolean; selProject?: string; lingering?: ReadonlySet<string> } = {}) =>
    names(hiddenByFilter(projects, { filter: work, hideDone: false, ...o }));

  it("没开筛选时什么都不筛", () => {
    expect(hiddenByFilter([tagged("p", ["急"])], { filter: NO_FILTER, hideDone: false }).size).toBe(0);
  });

  it("没有符合的待办的项目筛掉，空项目也筛掉", () => {
    expect(hide([tagged("有", ["工作"], ["急"]), tagged("没有", ["急"]), tagged("空的")])).toEqual(["没有", "空的"]);
  });

  it("隐藏已完成的待办时，只有已完成的符合的项目也筛掉", () => {
    const ps = [tagged("p", ["工作", true], ["急"])];
    expect(hide(ps)).toEqual([]);
    expect(hide(ps, { hideDone: true })).toEqual(["p"]);
  });

  it("父项目连同子项目一起看：子项目里有符合的，父项目照常显示，没有符合的子项目单独筛掉", () => {
    expect(hide([tagged("p", ["急"]), tagged("p/a", ["工作"]), tagged("p/b", ["急"])])).toEqual(["p/b"]);
    // 都没有：父项目连同子项目一起筛掉，只算一个
    expect(hide([tagged("p", ["急"]), tagged("p/a")])).toEqual(["p"]);
  });

  it("右侧正在显示的、刚切走的照常显示；显示的是子项目时它的父项目也显示", () => {
    const ps = [tagged("p", ["急"]), tagged("p/a"), tagged("q")];
    expect(hide(ps, { selProject: "p/a" })).toEqual(["q"]);
    expect(hide(ps, { lingering: new Set(["q"]) })).toEqual(["p"]);
  });

  it("和隐藏全部完成的项目合起来", () => {
    const done = new Set(["a"]);
    const filtered = new Set(["b"]);
    expect([...unionHidden(done, filtered)].sort()).toEqual(["a", "b"]);
    const none = new Set<string>();
    expect(unionHidden(none, filtered)).toBe(filtered);
    expect(unionHidden(done, none)).toBe(done);
  });
});
