import { describe, expect, it } from "vitest";
import { searchSnippet } from "./search";
import type { TodoSummary } from "./types";

// docs/requirements.md 侧栏 / 首页搜索：匹配标题和正文全文；命中在正文里时显示关键字附近的一段

const todo = (title: string, preview: string): TodoSummary => ({
  id: "1",
  title,
  preview,
  done: false,
  createdAt: 0,
  updatedAt: 0,
  doneAt: null,
  pinned: false,
  order: null,
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
