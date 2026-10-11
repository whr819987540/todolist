import { describe, expect, it } from "vitest";
import { matchTodo, searchSnippet, tagHit, tagQuery, textKeyword } from "./search";
import type { TodoSummary } from "./types";

// docs/requirements.md 侧栏 / 首页搜索：匹配标题和正文全文、待办的标签；命中在正文里时显示关键字附近的一段。
// 「待办的标签」：关键字也匹配标签名（包含，不区分大小写），命中的标签高亮；#标签名 只按标签找（名字一样，
// 不区分大小写），只输入 # 时列出有标签的待办

const todo = (title: string, preview: string, tags: string[] = []): TodoSummary => ({
  id: "1",
  title,
  preview,
  done: false,
  createdAt: 0,
  updatedAt: 0,
  doneAt: null,
  pinned: false,
  order: null,
  tags,
  priority: 0,
});

describe("搜索匹配（matchTodo）", () => {
  it("标题和正文开头，不分大小写", () => {
    const t = todo("Weekly Report", "整理会议纪要");
    expect(matchTodo(t, "weekly")).toBe(true);
    expect(matchTodo(t, "纪要")).toBe(true);
    expect(matchTodo(t, "预算")).toBe(false);
    expect(matchTodo(t, "")).toBe(true);
  });

  it("标签名里有关键字也算", () => {
    const t = todo("周报", "", ["等回复", "Work"]);
    expect(matchTodo(t, "回复")).toBe(true);
    expect(matchTodo(t, "WORK")).toBe(true);
    expect(matchTodo(t, "工作")).toBe(false);
  });

  it("#标签名：只看标签，名字要一样（不区分大小写）", () => {
    const t = todo("等回复的邮件", "等回复", ["Work", "等回复"]);
    expect(matchTodo(t, "#work")).toBe(true);
    expect(matchTodo(t, " # 等回复 ")).toBe(true);
    expect(matchTodo(t, "＃等回复")).toBe(true);
    // 只是包含不算
    expect(matchTodo(t, "#回复")).toBe(false);
    // 标题、正文里有也不算
    expect(matchTodo(todo("等回复的邮件", "等回复"), "#等回复")).toBe(false);
  });

  it("只输入 # 时列出有标签的待办", () => {
    expect(matchTodo(todo("a", "", ["x"]), "#")).toBe(true);
    expect(matchTodo(todo("a", ""), "#")).toBe(false);
  });
});

describe("只按标签找", () => {
  it("# 开头的关键字是按标签找，# 后面的是标签名", () => {
    expect(tagQuery("#等回复")).toBe("等回复");
    expect(tagQuery("  ##  Work ")).toBe("Work");
    expect(tagQuery("#")).toBe("");
    expect(tagQuery("C#")).toBeNull();
    expect(tagQuery("等回复")).toBeNull();
  });

  it("这时标题、正文片段不高亮", () => {
    expect(textKeyword("#等回复")).toBe("");
    expect(textKeyword(" 周报 ")).toBe("周报");
    expect(searchSnippet(todo("标题", "正文里有 #等回复"), "#等回复", "…#等回复…")).toBeNull();
  });
});

describe("命中的标签高亮", () => {
  it("名字里有关键字的高亮", () => {
    expect(tagHit("等回复", "回复")).toBe(true);
    expect(tagHit("Work", "wor")).toBe(true);
    expect(tagHit("工作", "回复")).toBe(false);
    expect(tagHit("工作", "")).toBe(false);
  });

  it("#标签名 时只有一样的那个高亮", () => {
    expect(tagHit("Work", "#work")).toBe(true);
    expect(tagHit("Workflow", "#work")).toBe(false);
    expect(tagHit("Work", "#")).toBe(false);
  });
});

describe("搜索结果里显示的正文片段", () => {
  it("标题里已经有关键字时不显示", () => {
    expect(searchSnippet(todo("整理周报", "周报正文"), "周报", "…周报…")).toBeNull();
    expect(searchSnippet(todo("Weekly Report", ""), "report", undefined)).toBeNull();
  });

  it("没有标题、正文开头（左侧显示的就是它）里有关键字时不显示", () => {
    expect(searchSnippet(todo("", "今天写周报"), "周报", "今天写周报")).toBeNull();
  });

  it("命中在正文里：用全文搜索找到的那一段", () => {
    expect(searchSnippet(todo("会议", "开头"), "支付", "…对一下支付接口…")).toBe("…对一下支付接口…");
  });

  it("全文搜索还没查完时，先在正文开头里找", () => {
    const preview = `${"铺垫".repeat(20)}关键字在这里`;
    const snip = searchSnippet(todo("标题", preview), "关键字", undefined);
    expect(snip?.startsWith("…")).toBe(true);
    expect(snip).toContain("关键字在这里");
    expect(searchSnippet(todo("标题", "开头没有"), "关键字", undefined)).toBeNull();
  });

  it("关键字前后的空白不算", () => {
    expect(searchSnippet(todo("整理周报", ""), "  周报 ", undefined)).toBeNull();
    expect(searchSnippet(todo("标题", "x"), "   ", "片段")).toBeNull();
  });
});
