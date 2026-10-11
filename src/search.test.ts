// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { type ContentHits, hitKey, searchSnippet, useContentSearch } from "./search";
import type { SearchHit, TodoSummary } from "./types";

vi.mock("./api", () => ({ api: { searchTodos: vi.fn() } }));

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

// docs/requirements.md「搜索」：全文搜索在 Rust 端查，输入停下片刻再查，查完之前先列出标题和正文开头匹配的
// （这时 useContentSearch 给 null）；数据刷新、保存后重新查

/** Rust 端看到的正文：「工作区/项目/待办 id」→ 正文 */
let bodies: Record<string, string>;
let hits: ContentHits | null;

function Probe(p: { workspaces: string[] | null; keyword: string; version: number }) {
  const value = useContentSearch(p.workspaces, p.keyword, p.version);
  useEffect(() => {
    hits = value;
  });
  return null;
}

let root: Root;
/** 搜索框里是 keyword；version 是数据的版本（保存、刷新后加一） */
const show = (keyword: string, version = 1, workspaces: string[] | null = ["工作"]) =>
  act(() => root.render(createElement(Probe, { workspaces, keyword, version })));
/** 等 Rust 端查完 */
const settle = () => act(() => vi.advanceTimersByTimeAsync(2000));
/** 这个工作区里正文命中的待办；null 是还没查（全文没查完，或者没在这个工作区里查过） */
const found = (ws = "工作") => {
  const m = hits?.get(ws);
  return m ? [...m.keys()] : null;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  bodies = { "工作/需求/B": "开头\n新加的火龙果" };
  vi.mocked(api.searchTodos).mockReset();
  vi.mocked(api.searchTodos).mockImplementation(async (list, kw) =>
    Object.entries(bodies).flatMap(([key, body]): SearchHit[] => {
      const [workspace, project, id] = key.split("/");
      const ok = (!list || list.includes(workspace)) && body.toLowerCase().includes(kw.toLowerCase());
      return ok ? [{ workspace, project, id, snippet: body }] : [];
    }),
  );
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("正文全文搜索", () => {
  it("查完之前没有结果（先只按标题和正文开头匹配），查完列出正文里有关键字的", async () => {
    await show("火龙果");
    expect(hits).toBeNull();
    await settle();
    expect(found()).toEqual([hitKey("需求", "B")]);
    expect(api.searchTodos).toHaveBeenLastCalledWith(["工作"], "火龙果");
  });

  it("保存后按新的正文重新查", async () => {
    await show("火龙果");
    await settle();
    bodies["工作/需求/B"] = "开头\n新加的榴莲";
    await show("火龙果", 2);
    await settle();
    expect(found()).toEqual([]);
  });

  it("换了关键字：旧的结果立刻作废，查完才有新的", async () => {
    await show("火龙果");
    await settle();
    await show("开头");
    expect(hits).toBeNull();
    await settle();
    expect(found()).toEqual([hitKey("需求", "B")]);
  });

  it("清空搜索、保存后再搜原来的关键字：查完之前不先显示上次查到的", async () => {
    await show("火龙果");
    await settle();
    expect(found()).toEqual([hitKey("需求", "B")]);
    await show("");
    bodies["工作/需求/B"] = "开头\n新加的榴莲";
    await show("", 2);
    await show("火龙果", 2);
    expect(hits).toBeNull();
    await settle();
    expect(found()).toEqual([]);
  });

  it("搜索时新选中一个工作区：查完之前它算还没查（原来那个的结果留着），查完也列出它里面命中的", async () => {
    bodies["生活/杂事/E"] = "买菜\n顺便买火龙果";
    await show("火龙果", 1, ["工作"]);
    await settle();
    await show("火龙果", 1, ["工作", "生活"]);
    expect(found("工作")).toEqual([hitKey("需求", "B")]);
    expect(found("生活")).toBeNull();
    await settle();
    expect(found("生活")).toEqual([hitKey("杂事", "E")]);
  });

  it("查过、没有命中的工作区也列上，和还没查的分得开", async () => {
    await show("火龙果", 1, ["工作", "生活"]);
    await settle();
    expect(found("生活")).toEqual([]);
    expect(found("学习")).toBeNull();
  });

  it("查不了正文时当作正文里没有，不一直「正在搜索」", async () => {
    vi.mocked(api.searchTodos).mockRejectedValue("读不了");
    await show("火龙果");
    await settle();
    expect(found()).toEqual([]);
  });
});
