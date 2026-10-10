// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dirOf, exportCounts, exportedText, exportGroups, exportTitle, readExportDir, rememberExportDir } from "./exporting";
import type { ProjectNode, TodoSummary } from "./types";

// docs/requirements.md「导出」：导出项目时父项目自己的待办在前，子项目各一章在后（按名字排，同侧栏）；导出工作区时
// 每个顶层项目一章，子项目跟在它后面；待办的顺序同侧栏（排序方式、置顶的在前、已完成的沉底），侧栏里隐藏的已完成也交给
// Rust 端（导不导看「包含已完成的待办」）。默认目录是上次导出到的目录，只记在本机

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
const project = (name: string, todos: TodoSummary[] = []): ProjectNode => ({ name, todos, order: null });

describe("导出哪些待办、什么顺序", () => {
  const old = todo({ id: "旧", createdAt: 1 });
  const fresh = todo({ id: "新", createdAt: 3 });
  const pinned = todo({ id: "置顶", createdAt: 0, pinned: true });
  const done = todo({ id: "完成", createdAt: 9, done: true });
  // 加载出来的顺序是乱的
  const projects = [
    project("需求/后端", [todo({ id: "后端" })]),
    project("日常", [todo({ id: "日常" })]),
    project("需求", [done, old, fresh, pinned]),
    project("需求池", [todo({ id: "需求池" })]),
    project("需求/前端", [todo({ id: "前端" })]),
  ];

  it("导出项目：父项目自己的在前，子项目按名字（拼音）跟在后面；别的项目（名字开头一样的也是）不算", () => {
    const groups = exportGroups(projects, "需求", "created");
    expect(groups.map((g) => g.project)).toEqual(["需求", "需求/后端", "需求/前端"]);
  });

  it("项目里的待办同侧栏：置顶的在前、已完成的沉底，其余按排序方式；已完成的也列上", () => {
    expect(exportGroups(projects, "需求", "created")[0].ids).toEqual(["置顶", "新", "旧", "完成"]);
    const manual = [project("需求", [todo({ id: "甲", order: 1 }), todo({ id: "乙", order: 0 }), todo({ id: "新建的", createdAt: 5 })])];
    expect(exportGroups(manual, "需求", "manual")[0].ids).toEqual(["新建的", "乙", "甲"]);
  });

  it("导出子项目：只有它自己", () => {
    expect(exportGroups(projects, "需求/前端", "created")).toEqual([{ project: "需求/前端", ids: ["前端"] }]);
  });

  it("导出工作区：顶层项目按名字，每个后面跟着它的子项目", () => {
    expect(exportGroups(projects, undefined, "created").map((g) => g.project)).toEqual([
      "日常",
      "需求",
      "需求/后端",
      "需求/前端",
      "需求池",
    ]);
  });

  it("确认框里的数目：范围里一共几条、已完成几条（含子项目里的）", () => {
    expect(exportCounts(projects, exportGroups(projects, "需求", "created"))).toEqual({ total: 6, done: 1 });
    expect(exportCounts(projects, exportGroups(projects, undefined, "created"))).toEqual({ total: 8, done: 1 });
  });
});

describe("导出的文字", () => {
  it("确认框的标题写明导出的是什么", () => {
    expect(exportTitle("html", "工作", "需求")).toBe("导出项目「需求」为 HTML");
    expect(exportTitle("html", "工作", "需求/前端")).toBe("导出子项目「需求 / 前端」为 HTML");
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
