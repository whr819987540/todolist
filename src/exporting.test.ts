// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countsText, dirOf, exportCounts, exportedText, exportGroups, exportTitle, readExportDir, rememberExportDir } from "./exporting";
import type { ExportGroup, ProjectNode, TodoSummary } from "./types";

// docs/requirements.md「导出」：导出项目时项目自己的待办在前，各级子项目依次作为下一级的章（每一层按侧栏的顺序：按名称，
// 或手动排序时按调整过的）；导出工作区时每个顶层项目一章，子项目一层层在它下面；待办的顺序同侧栏（排序方式、置顶的在前、
// 已完成的沉底），侧栏里隐藏的已完成也交给 Rust 端（导不导看「包含已完成的待办」）。默认目录是上次导出到的目录，只记在本机

vi.mock("./api", () => ({ api: {} }));

beforeEach(() => {
  localStorage.clear();
});

let seq = 0;
const todo = (p: Partial<TodoSummary> = {}): TodoSummary => ({
  id: `T${++seq}`,
  title: "",
  preview: "",
  done: false,
  createdAt: 0,
  updatedAt: 0,
  doneAt: null,
  pinned: false,
  order: null,
  tags: [],
  priority: 0,
  ...p,
});
const project = (name: string, todos: TodoSummary[] = [], order: number | null = null): ProjectNode => ({ name, todos, order });

/** 项目树写成「路径（各级子项目）」，看得出层级和每一层的顺序 */
const shape = (groups: readonly ExportGroup[]): unknown[] =>
  groups.map((g) => (g.children.length ? { [g.project]: shape(g.children) } : g.project));

describe("导出哪些待办、什么顺序", () => {
  const old = todo({ id: "旧", createdAt: 1 });
  const fresh = todo({ id: "新", createdAt: 3 });
  const pinned = todo({ id: "置顶", createdAt: 0, pinned: true });
  const done = todo({ id: "完成", createdAt: 9, done: true });
  // 加载出来的顺序是乱的
  const projects = [
    project("需求/后端", [todo({ id: "后端" })]),
    project("日常", [todo({ id: "日常" })]),
    project("需求/前端/组件", [todo({ id: "组件" })]),
    project("需求", [done, old, fresh, pinned]),
    project("需求池", [todo({ id: "需求池" })]),
    project("需求/前端", [todo({ id: "前端" })]),
    project("需求/前端/组件/按钮", [todo({ id: "按钮", done: true })]),
  ];

  it("导出项目：是这一个项目，各级子项目一层层挂在下面、每层按名字（拼音）；别的项目（名字开头一样的也是）不算", () => {
    expect(shape(exportGroups(projects, "需求", "created"))).toEqual([
      { 需求: ["需求/后端", { "需求/前端": [{ "需求/前端/组件": ["需求/前端/组件/按钮"] }] }] },
    ]);
  });

  it("每个项目自己的待办同侧栏：置顶的在前、已完成的沉底，其余按排序方式；已完成的也列上", () => {
    const [root] = exportGroups(projects, "需求", "created");
    expect(root.ids).toEqual(["置顶", "新", "旧", "完成"]);
    expect(root.children[1].children[0].children[0].ids).toEqual(["按钮"]);
    const manual = [project("需求", [todo({ id: "甲", order: 1 }), todo({ id: "乙", order: 0 }), todo({ id: "新建的", createdAt: 5 })])];
    expect(exportGroups(manual, "需求", "manual")[0].ids).toEqual(["新建的", "乙", "甲"]);
  });

  it("导出深层的子项目：它自己和它下面的，上面的父项目不算", () => {
    expect(shape(exportGroups(projects, "需求/前端", "created"))).toEqual([
      { "需求/前端": [{ "需求/前端/组件": ["需求/前端/组件/按钮"] }] },
    ]);
    expect(exportGroups(projects, "需求/前端/组件/按钮", "created")).toEqual([
      { project: "需求/前端/组件/按钮", ids: ["按钮"], children: [] },
    ]);
  });

  it("导出工作区：顶层项目按名字，各级子项目一层层在它下面", () => {
    expect(shape(exportGroups(projects, undefined, "created"))).toEqual([
      "日常",
      { 需求: ["需求/后端", { "需求/前端": [{ "需求/前端/组件": ["需求/前端/组件/按钮"] }] }] },
      "需求池",
    ]);
  });

  // docs/requirements.md「项目的顺序」：工作区手动排序时每一层（多深的都算）按调整过的顺序，没排过的排在后面、彼此按名字
  it("工作区手动排序时：每一层都按调整过的顺序，没排过的在后面；按名称时记着的顺序不算", () => {
    const ordered = [
      project("日常", [], 1),
      project("需求", [], 0),
      project("需求/后端", [], null),
      project("需求/前端", [], 0),
      project("需求/测试", [], 1),
      project("需求/前端/样式", [], 1),
      project("需求/前端/组件", [], 0),
      project("新建的", [], null),
    ];
    expect(shape(exportGroups(ordered, undefined, "created", true))).toEqual([
      { 需求: [{ "需求/前端": ["需求/前端/组件", "需求/前端/样式"] }, "需求/测试", "需求/后端"] },
      "日常",
      "新建的",
    ]);
    expect(shape(exportGroups(ordered, "需求/前端", "created", true))).toEqual([
      { "需求/前端": ["需求/前端/组件", "需求/前端/样式"] },
    ]);
    expect(shape(exportGroups(ordered, undefined, "created", false))).toEqual([
      "日常",
      "新建的",
      { 需求: ["需求/测试", "需求/后端", { "需求/前端": ["需求/前端/样式", "需求/前端/组件"] }] },
    ]);
  });

  it("确认框里的数目：范围里一共几条、已完成几条，连同各级子项目", () => {
    expect(exportCounts(projects, "需求")).toEqual({ total: 8, done: 2 });
    expect(exportCounts(projects, "需求/前端")).toEqual({ total: 3, done: 1 });
    expect(exportCounts(projects)).toEqual({ total: 10, done: 2 });
    expect(countsText(projects, "需求")).toBe("一共 8 条待办（含各级子项目里的），其中已完成 2 条。");
    // 没有子项目的项目、工作区不写「含各级子项目」
    expect(countsText(projects, "需求/后端")).toBe("一共 1 条待办，其中已完成 0 条。");
    expect(countsText(projects)).toBe("一共 10 条待办，其中已完成 2 条。");
  });
});

describe("导出的文字", () => {
  it("确认框的标题写明导出的是什么；层级多的子项目中间折叠", () => {
    expect(exportTitle("html", "工作", "需求")).toBe("导出项目「需求」为 HTML");
    expect(exportTitle("html", "工作", "需求/前端")).toBe("导出子项目「需求 / 前端」为 HTML");
    expect(exportTitle("html", "工作", "需求/前端/组件/按钮/图标")).toBe("导出子项目「需求 / … / 按钮 / 图标」为 HTML");
    expect(exportTitle("html", "工作")).toBe("导出工作区「工作」为 HTML");
  });

  it("导出完的提示写明完整路径和几条", () => {
    expect(exportedText({ path: "C:\\Users\\a\\Documents\\需求.html", count: 3 })).toBe(
      "已导出 3 条待办到 C:\\Users\\a\\Documents\\需求.html",
    );
  });
});

describe("上次导出到的目录", () => {
  it("取导出的文件所在的文件夹", () => {
    expect(dirOf("C:\\Users\\a\\Documents\\需求.html")).toBe("C:\\Users\\a\\Documents");
    expect(dirOf("D:/导出/周报.html")).toBe("D:/导出");
    expect(dirOf("周报.html")).toBeNull();
  });

  it("导出成功后记在本机，下次从这里打开；还没导出过时没有", () => {
    expect(readExportDir()).toBeNull();
    rememberExportDir("D:\\导出\\周报.html");
    expect(readExportDir()).toBe("D:\\导出");
    rememberExportDir("周报.html");
    expect(readExportDir()).toBe("D:\\导出");
  });
});
