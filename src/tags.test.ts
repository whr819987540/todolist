import { describe, expect, it } from "vitest";
import { addTags, allTodos, cleanTag, countTags, hasTag, removeTags, suggestTags, TAG_COLORS, tagColor, visibleTags } from "./tags";
import type { TodoSummary, WorkspaceTree } from "./types";

// docs/requirements.md「待办的标签」：标签名去掉首尾空白和开头的 #，不能为空、不超过 20 个字、不能有逗号和换行；
// 同一条待办里不区分大小写地去重，保留先加的写法。输入时从侧栏里显示的工作区用过的标签里联想（包含输入的字，
// 用得多的在前，已经有的不列）；颜色按名字（不分大小写）固定；放不下时显示前几个加「+N」

const todo = (tags: string[]): TodoSummary => ({
  id: "1",
  title: "",
  preview: "",
  done: false,
  createdAt: 0,
  updatedAt: 0,
  doneAt: null,
  pinned: false,
  order: null,
  tags,
  priority: 0,
});
const tree = (name: string, ...tagsOfTodos: string[][]): WorkspaceTree => ({
  name,
  projects: [{ name: "p", todos: tagsOfTodos.map(todo), order: null }],
  manualOrder: false,
});

describe("标签名的规则", () => {
  it("去掉首尾空白和开头的 #（全角的也算）", () => {
    expect(cleanTag("  工作 ")).toEqual({ tag: "工作" });
    expect(cleanTag("#等回复")).toEqual({ tag: "等回复" });
    expect(cleanTag("＃ 等回复")).toEqual({ tag: "等回复" });
    expect(cleanTag("C#")).toEqual({ tag: "C#" });
  });

  it("不能为空、不超过 20 个字", () => {
    expect(cleanTag("   ")).toHaveProperty("error");
    expect(cleanTag("#")).toHaveProperty("error");
    expect(cleanTag("字".repeat(20))).toEqual({ tag: "字".repeat(20) });
    expect(cleanTag("字".repeat(21))).toHaveProperty("error");
  });

  it("不能有逗号和换行", () => {
    for (const bad of ["a,b", "a，b", "第一行\n第二行", "a\tb"]) expect(cleanTag(bad)).toHaveProperty("error");
  });
});

describe("加上、去掉标签", () => {
  it("已经有的（不区分大小写）不再加，保留先加的写法，加上的排在后面", () => {
    expect(addTags(["work"], ["Work", "工作", "工作"])).toEqual(["work", "工作"]);
  });

  it("什么都没加时还是原来的数组", () => {
    const tags = ["工作"];
    expect(addTags(tags, ["工作"])).toBe(tags);
  });

  it("去掉时不区分大小写", () => {
    expect(removeTags(["Work", "工作"], ["work"])).toEqual(["工作"]);
    const tags = ["工作"];
    expect(removeTags(tags, ["没有的"])).toBe(tags);
  });

  it("有没有这个标签不区分大小写", () => {
    expect(hasTag(["Work"], "WORK")).toBe(true);
    expect(hasTag(["Work"], "Wor")).toBe(false);
  });
});

describe("用过的标签", () => {
  it("几个工作区里的合起来数，有它的待办多的在前，一样多的按名字排", () => {
    const counts = countTags(allTodos([tree("工作", ["b", "a"], ["a"], ["c"]), tree("生活", ["c", "a"])]));
    expect(counts).toEqual([
      { name: "a", count: 3 },
      { name: "c", count: 2 },
      { name: "b", count: 1 },
    ]);
  });

  it("不区分大小写地合起来，显示用得最多的写法", () => {
    expect(countTags(allTodos([tree("w", ["Work"], ["work"], ["work"])]))).toEqual([{ name: "work", count: 3 }]);
  });

  it("联想：包含输入的字（不区分大小写，# 不算），用得多的在前，已经有的不列", () => {
    const all = [
      { name: "工作", count: 5 },
      { name: "Workflow", count: 3 },
      { name: "work", count: 2 },
      { name: "生活", count: 1 },
    ];
    expect(suggestTags(all, "WOR", [])).toEqual(["Workflow", "work"]);
    expect(suggestTags(all, "#wor", ["WORK"])).toEqual(["Workflow"]);
    // 还没输入时是最常用的
    expect(suggestTags(all, "", ["工作"], 2)).toEqual(["Workflow", "work"]);
  });
});

describe("标签的颜色", () => {
  it("同名（不分大小写）的是同一个颜色，在范围里", () => {
    expect(tagColor("Work")).toBe(tagColor("work"));
    for (const t of ["工作", "等回复", "a", "很长很长的标签名字"]) {
      expect(tagColor(t)).toBeGreaterThanOrEqual(0);
      expect(tagColor(t)).toBeLessThan(TAG_COLORS);
    }
  });

  it("不同的标签不总是同一个颜色", () => {
    const colors = new Set(["工作", "生活", "学习", "等回复", "急", "周报", "会议", "采购"].map(tagColor));
    expect(colors.size).toBeGreaterThan(2);
  });
});

describe("放不下时", () => {
  it("显示前几个，其余的数目", () => {
    expect(visibleTags(["a", "b", "c"], 2)).toEqual({ shown: ["a", "b"], rest: 1 });
    expect(visibleTags(["a", "b"], 2)).toEqual({ shown: ["a", "b"], rest: 0 });
  });
});
