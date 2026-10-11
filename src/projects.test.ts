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
  levelNames,
  parentOf,
  projectMoveProblem,
  projectLabel,
  reorderedNames,
  reparent,
  shortPlaceLabel,
  shortProjectLabel,
  sortProjects,
  subProjectsOf,
  topProjects,
  withProjectOrder,
} from "./projects";
import type { ProjectNode, TodoSummary, WorkspaceTree } from "./types";

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

  it("工作区的项目数只算顶层项目（各级子项目都不另算）", () => {
    expect(topProjects(list).map((p) => p.name)).toEqual(["需求", "日常"]);
    const deep = [...list, project("需求/前端/组件"), project("需求/前端/组件/按钮"), project("需求二")];
    expect(topProjects(deep).map((p) => p.name)).toEqual(["需求", "日常", "需求二"]);
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

// 「项目的顺序」：按名称时各层按名字排；手动排序时各层（顶层、哪一级的父项目里）排过的按位置，没排过的排在后面、
// 彼此按名字；子项目总跟在父项目后面
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

  it("层数不限：每一级的子项目在它的父项目里按位置，整枝跟着父项目", () => {
    const l = [
      at("A", 1),
      at("A/B", 0),
      at("A/B/甲"),
      at("A/B/乙", 1),
      at("A/B/丙", 0),
      at("A/B/丙/深", 0),
      at("A/C"),
      at("Z", 0),
      at("Z/Y"),
      at("Z/X"),
    ];
    expect(sortProjects(l, true).map((p) => p.name)).toEqual([
      "Z",
      "Z/X",
      "Z/Y",
      "A",
      "A/B",
      "A/B/丙",
      "A/B/丙/深",
      "A/B/乙",
      "A/B/甲",
      "A/C",
    ]);
    // 按名称：各层都按名字
    expect(sortProjects(l).map((p) => p.name)).toEqual([
      "A",
      "A/B",
      "A/B/丙",
      "A/B/丙/深",
      "A/B/甲",
      "A/B/乙",
      "A/C",
      "Z",
      "Z/X",
      "Z/Y",
    ]);
  });
});

// 「拖动移动项目」：拖到项目（哪一级的都行）的上沿 / 下沿放在它前面 / 后面，放到的是它所在的那一层；藏起来的项目也算在
// 那一层里。「项目的顺序」：调整后那个工作区改成手动排序；本来按名称排的，别的各层（多深的都算）留着的旧顺序不再用
describe("拖动调整项目的顺序", () => {
  const level = ["甲", "乙", "丙", "丁"];

  it("一层的项目：顶层或哪一级的项目里的下一级子项目，按现在的顺序", () => {
    const ps = [{ name: "乙" }, { name: "乙/b" }, { name: "乙/b/y" }, { name: "乙/b/x" }, { name: "乙/a" }, { name: "甲" }, { name: "甲/c" }];
    expect(levelNames(ps, undefined)).toEqual(["乙", "甲"]);
    expect(levelNames(ps, "乙")).toEqual(["b", "a"]);
    expect(levelNames(ps, "乙/b")).toEqual(["y", "x"]);
    expect(levelNames(ps, "丙")).toEqual([]);
  });

  it("同一层里挪到目标的前面 / 后面", () => {
    expect(reorderedNames(level, "甲", "丙", "before")).toEqual(["乙", "甲", "丙", "丁"]);
    expect(reorderedNames(level, "甲", "丙", "after")).toEqual(["乙", "丙", "甲", "丁"]);
    expect(reorderedNames(level, "丁", "甲", "before")).toEqual(["丁", "甲", "乙", "丙"]);
    expect(reorderedNames(level, "乙", "丁", "after")).toEqual(["甲", "丙", "丁", "乙"]);
  });

  it("放回原处、放在自己旁边、目标不在了时不变", () => {
    expect(reorderedNames(level, "乙", "丙", "before")).toEqual(level);
    expect(reorderedNames(level, "乙", "甲", "after")).toEqual(level);
    expect(reorderedNames(level, "乙", "乙", "after")).toEqual(level);
    expect(reorderedNames(level, "甲", "戊", "before")).toEqual(level);
  });

  it("从别处移过来的插进去", () => {
    expect(reorderedNames(level, "戊", "乙", "after")).toEqual(["甲", "乙", "戊", "丙", "丁"]);
    expect(reorderedNames([], "戊", "乙", "after")).toEqual([]);
  });

  const at = (name: string, order: number | null = null): ProjectNode => ({ name, todos: [], order });
  const work = (manualOrder: boolean): WorkspaceTree => ({
    name: "工作",
    manualOrder,
    projects: [at("需求", 0), at("需求/前端", 1), at("需求/后端", 0), at("日常", 1), at("日常/杂项", 0), at("零散")],
  });
  const shown = (t: WorkspaceTree) => sortProjects(t.projects, t.manualOrder).map((p) => `${p.name}:${p.order}`);

  it("记下一层的顺序：改成手动排序，这一层按给的顺序（不分大小写），没给的没排过；别的层不动", () => {
    const t = withProjectOrder(work(true), undefined, ["零散", "需求"]);
    expect(t.manualOrder).toBe(true);
    expect(shown(t)).toEqual(["零散:0", "需求:1", "需求/后端:0", "需求/前端:1", "日常:null", "日常/杂项:0"]);
    const sub = withProjectOrder(work(true), "需求", ["前端", "后端"]);
    expect(shown(sub)).toEqual(["需求:0", "需求/前端:0", "需求/后端:1", "日常:1", "日常/杂项:0", "零散:null"]);
  });

  it("本来按名称排的：别的层留着的旧顺序不再用，和调整前看到的一样按名字", () => {
    const t = withProjectOrder(work(false), "需求", ["后端", "前端"]);
    expect(t.manualOrder).toBe(true);
    // 中文按拼音：零散、日常、需求
    expect(shown(t)).toEqual(["零散:null", "日常:null", "日常/杂项:null", "需求:null", "需求/后端:0", "需求/前端:1"]);
  });

  it("深处的一层也一样；本来按名称排的，别的各层（多深的都算）的旧顺序不再用", () => {
    const deep: WorkspaceTree = {
      name: "工作",
      manualOrder: true,
      projects: [at("A", 0), at("A/B", 0), at("A/B/甲", 1), at("A/B/乙", 0), at("A/B/乙/深", 0), at("A/C", 1), at("Z", 1)],
    };
    const t = withProjectOrder(deep, "A/B", ["甲", "乙"]);
    expect(shown(t)).toEqual(["A:0", "A/B:0", "A/B/甲:0", "A/B/乙:1", "A/B/乙/深:0", "A/C:1", "Z:1"]);
    const byName = withProjectOrder({ ...deep, manualOrder: false }, "A/B", ["甲", "乙"]);
    expect(byName.manualOrder).toBe(true);
    expect(shown(byName)).toEqual(["A:null", "A/B:null", "A/B/甲:0", "A/B/乙:1", "A/B/乙/深:null", "A/C:null", "Z:null"]);
  });

  it("位置没变的项目还是原来的对象（侧栏的行不必重新渲染）", () => {
    const before = work(true);
    const after = withProjectOrder(before, undefined, ["日常", "需求", "零散"]);
    expect(after.projects[1]).toBe(before.projects[1]);
    expect(after.projects[4]).toBe(before.projects[4]);
    expect(after.projects[3]).not.toBe(before.projects[3]);
    expect(after.projects[3].order).toBe(0);
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
