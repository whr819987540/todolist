import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  childPath,
  compactPath,
  deepCounts,
  deepTodos,
  depthOf,
  descendantsOf,
  inProject,
  leafName,
  parentOf,
  projectMoveProblem,
  projectLabel,
  reparent,
  shortPlaceLabel,
  shortProjectLabel,
  sortProjects,
  subProjectsOf,
} from "./projects";
import type { ProjectNode, TodoSummary } from "./types";

// docs/requirements.md「基础」：项目下可以建子项目，子项目里还能再建，层数不限；子项目是项目文件夹里的子文件夹，
// 路径写成「父项目/子项目/…」。「工作区界面 → 子项目」：侧栏里子项目列在父项目下面，同一级的按名字排；显示路径的地方
// 写成「父项目 / 子项目 / …」；父项目改名后下面各级跟着；项目的统计包括各级子项目里的待办

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

  it("多级的：父项目是除了最后一级的整段路径，各级父项目从顶层往下", () => {
    expect(parentOf("需求/前端/组件/按钮")).toBe("需求/前端/组件");
    expect(leafName("需求/前端/组件/按钮")).toBe("按钮");
    expect(ancestorsOf("需求/前端/组件/按钮")).toEqual(["需求", "需求/前端", "需求/前端/组件"]);
    expect(ancestorsOf("需求")).toEqual([]);
    expect([depthOf("需求"), depthOf("需求/前端"), depthOf("需求/前端/组件/按钮")]).toEqual([0, 1, 3]);
    expect(childPath("需求/前端", "组件")).toBe("需求/前端/组件");
    expect(projectLabel("需求/前端/组件/按钮")).toBe("需求 / 前端 / 组件 / 按钮");
  });

  it("项目本身和它的子项目算在项目里，名字开头相同的别的项目不算", () => {
    expect(inProject("需求", "需求")).toBe(true);
    expect(inProject("需求/前端", "需求")).toBe(true);
    expect(inProject("需求二", "需求")).toBe(false);
    expect(inProject("需求", "需求/前端")).toBe(false);
    expect(inProject("需求/前端/组件/按钮", "需求")).toBe(true);
    expect(inProject("需求/前端/组件", "需求/前端")).toBe(true);
    expect(inProject("需求/前端二/组件", "需求/前端")).toBe(false);
  });

  it("父项目改名、移动后，它和子项目的路径跟着变，别的项目不变", () => {
    expect(reparent("需求", "需求", "开发")).toBe("开发");
    expect(reparent("需求/前端", "需求", "开发")).toBe("开发/前端");
    expect(reparent("需求/前端", "需求/前端", "前端")).toBe("前端");
    expect(reparent("日常", "日常", "需求/日常")).toBe("需求/日常");
    expect(reparent("需求二", "需求", "开发")).toBe("需求二");
    // 中间一级改名、移走，下面各级跟着
    expect(reparent("需求/前端/组件/按钮", "需求/前端", "需求/界面")).toBe("需求/界面/组件/按钮");
    expect(reparent("需求/前端/组件", "需求/前端", "日常/杂项/前端")).toBe("日常/杂项/前端/组件");
    expect(reparent("需求/前端二/组件", "需求/前端", "x")).toBe("需求/前端二/组件");
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

// 「显示项目路径的地方」：路径太长时要有合理的截断——地方小、不能悬停看完整路径的地方（提示、拖动的说明、菜单）中间折叠成「…」
describe("路径太长时中间折叠", () => {
  it("4 级以内照常写全", () => {
    expect(shortProjectLabel("需求")).toBe("需求");
    expect(shortProjectLabel("需求/前端/组件/按钮")).toBe("需求 / 前端 / 组件 / 按钮");
  });

  it("再多就留下第一级和最后两级，中间折叠成「…」", () => {
    expect(shortProjectLabel("需求/前端/组件/按钮/图标")).toBe("需求 / … / 按钮 / 图标");
    expect(shortProjectLabel("a/b/c/d/e/f/g/h")).toBe("a / … / g / h");
  });

  it("带工作区的：留下工作区、顶层项目和最后两级", () => {
    expect(shortPlaceLabel("工作", "需求/前端/组件")).toBe("工作 / 需求 / 前端 / 组件");
    expect(shortPlaceLabel("工作", "需求/前端/组件/按钮")).toBe("工作 / 需求 / 前端 / 组件 / 按钮");
    expect(shortPlaceLabel("工作", "需求/前端/组件/按钮/图标")).toBe("工作 / 需求 / … / 按钮 / 图标");
    expect(compactPath(["a", "b", "c", "d"], 1, 1)).toBe("a / … / d");
  });
});

describe("多级子项目", () => {
  const list = [
    project("需求/前端/组件"),
    project("日常"),
    project("需求"),
    project("需求/后端"),
    project("需求/前端"),
    project("需求/前端/组件/按钮"),
    project("需求/前端/页面"),
    project("需求10"),
    project("需求2"),
  ];

  it("同资源管理器的树：每个项目后面跟着它的各级子项目，列完一个项目的再列下一个，同一级的按名字排", () => {
    expect(sortProjects(list).map((p) => p.name)).toEqual([
      "日常",
      "需求",
      "需求/后端",
      "需求/前端",
      "需求/前端/页面",
      "需求/前端/组件",
      "需求/前端/组件/按钮",
      "需求2",
      "需求10",
    ]);
  });

  it("下一级的子项目和各级子项目", () => {
    expect(subProjectsOf(list, "需求").map((p) => p.name).sort()).toEqual(["需求/前端", "需求/后端"].sort());
    expect(subProjectsOf(list, "需求/前端").map((p) => p.name).sort()).toEqual(["需求/前端/组件", "需求/前端/页面"].sort());
    expect(descendantsOf(list, "需求/前端").map((p) => p.name).sort()).toEqual(
      ["需求/前端/组件", "需求/前端/组件/按钮", "需求/前端/页面"].sort(),
    );
    expect(descendantsOf(list, "需求2")).toEqual([]);
  });

  it("项目的待办数包括各级子项目里的，名字开头相同的别的项目不算", () => {
    const ps = [
      project("需求", todo("a", true)),
      project("需求/前端", todo("b")),
      project("需求/前端/组件", todo("c", true), todo("d")),
      project("需求/前端/组件/按钮", todo("e")),
      project("需求二", todo("f")),
    ];
    expect(deepTodos(ps, "需求/前端").map((t) => t.id)).toEqual(["b", "c", "d", "e"]);
    const counts = deepCounts(ps);
    expect(counts.get("需求")).toEqual({ total: 5, undone: 3 });
    expect(counts.get("需求/前端")).toEqual({ total: 4, undone: 3 });
    expect(counts.get("需求/前端/组件")).toEqual({ total: 3, undone: 2 });
    expect(counts.get("需求/前端/组件/按钮")).toEqual({ total: 1, undone: 1 });
    expect(counts.get("需求二")).toEqual({ total: 1, undone: 1 });
    expect(deepCounts([project("空的"), project("空的/子")]).get("空的")).toEqual({ total: 0, undone: 0 });
  });
});

// 「拖动移动项目」「右键项目『移动到』」：项目可以放进别的任何项目（包括各级子项目）成为它的子项目，子项目可以移到顶层，
// 都可以跨工作区，有子项目的也行；不能放进它自己或它自己的子项目里；已经在那里的不算；那里已有同名的（不分大小写）不能放
describe("项目能不能移到那里", () => {
  const work = [
    project("需求"),
    project("需求/前端"),
    project("需求/前端/组件"),
    project("日常"),
    project("杂项"),
    project("杂项/前端"),
    project("杂项/前端/组件"),
  ];
  const life = [project("购物"), project("购物/日常"), project("购物/日常/零食"), project("旅行")];
  const problem = (p: string, parent: string | undefined, to = work) =>
    projectMoveProblem({ project: p, to, sameWorkspace: to === work, parent })?.code ?? null;

  it("顶层项目放进同一工作区的别的项目、别的项目的子项目、孙项目里", () => {
    expect(problem("日常", "需求")).toBeNull();
    expect(problem("日常", "需求/前端")).toBeNull();
    expect(problem("日常", "需求/前端/组件")).toBeNull();
  });

  it("有子项目的项目也能放进别的项目（连同下面各级），也能移到别的工作区", () => {
    expect(problem("需求", "日常")).toBeNull();
    expect(problem("需求", "杂项/前端/组件")).toBeNull();
    expect(problem("需求", "旅行", life)).toBeNull();
    expect(problem("需求", "购物/日常/零食", life)).toBeNull();
    expect(problem("需求", undefined, life)).toBeNull();
  });

  it("深处的子项目移到顶层、放进别的项目（别的工作区的也行）、往上移一级", () => {
    expect(problem("需求/前端/组件", undefined)).toBeNull();
    expect(problem("需求/前端/组件", "需求")).toBeNull();
    expect(problem("需求/前端/组件", "旅行", life)).toBeNull();
    expect(problem("需求/前端", "日常")).toBeNull();
  });

  it("不能放进它自己、它自己的子项目或孙项目里", () => {
    expect(problem("日常", "日常")).toBe("self");
    expect(problem("需求", "需求/前端")).toBe("self");
    expect(problem("需求", "需求/前端/组件")).toBe("self");
    expect(problem("需求/前端", "需求/前端/组件")).toBe("self");
    // 名字开头相同的别的项目不算它自己里面
    const withTwin = [...work, project("杂项二")];
    expect(projectMoveProblem({ project: "杂项", to: withTwin, sameWorkspace: true, parent: "杂项二" })).toBeNull();
    // 别的工作区里同名的项目不是它自己
    expect(problem("需求", "需求", [project("需求")])).toBeNull();
    expect(problem("需求", "需求/x", [project("需求"), project("需求/x")])).toBeNull();
  });

  it("已经在那里：顶层项目移到自己工作区的顶层、子项目放进它现在的父项目", () => {
    expect(problem("日常", undefined)).toBe("here");
    expect(problem("需求/前端", "需求")).toBe("here");
    expect(problem("需求/前端/组件", "需求/前端")).toBe("here");
  });

  it("那里已有同名的（不分大小写）不能放", () => {
    expect(problem("需求/前端", "杂项")).toBe("taken");
    expect(problem("需求/前端/组件", "杂项/前端")).toBe("taken");
    expect(problem("日常", "购物", life)).toBe("taken");
    expect(problem("杂项/前端", undefined, [project("前端")])).toBe("taken");
    expect(projectMoveProblem({ project: "abc", to: [project("ABC")], sameWorkspace: false })?.code).toBe("taken");
    expect(projectMoveProblem({ project: "x/abc", to: [project("p"), project("p/q"), project("p/q/Abc")], sameWorkspace: false, parent: "p/q" })?.code).toBe("taken");
  });
});
