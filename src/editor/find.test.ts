import { search, SearchQuery } from "@codemirror/search";
import { describe, expect, it } from "vitest";
import { firstMatchFrom, initialQuery, MAX_COUNT, matchInfo, matchLabel, selectedText } from "./find";
import { makeState } from "./testState";

// docs/requirements.md「正文里查找」：Ctrl+F 在正文里查找，显示第几个 / 共几个；有选中的文字时查它，
// 否则接着用上一次的查找内容；输入时跳到离光标最近的结果

/** 和编辑器里一样带上搜索状态 */
const withSearch = (marked: string) => makeState(marked, [search()]);

const q = (search: string, extra: Partial<ConstructorParameters<typeof SearchQuery>[0]> = {}) =>
  new SearchQuery({ search, ...extra });

describe("匹配个数和第几个", () => {
  it("选中的正好是一个匹配时，显示它是第几个", () => {
    const state = makeState("周报、«周报»、月报、周报");
    const info = matchInfo(state, q("周报"));
    expect(info).toEqual({ total: 3, current: 2, capped: false });
    expect(matchLabel(q("周报"), info)).toBe("2/3");
  });

  it("光标不在匹配上时只显示共几个", () => {
    const state = makeState("|周报、周报");
    const info = matchInfo(state, q("周报"));
    expect(info.current).toBe(0);
    expect(matchLabel(q("周报"), info)).toBe("共 2 个");
  });

  it("默认不区分大小写，可以选区分大小写、全字匹配", () => {
    const state = makeState("Todo todo TODO todolist");
    expect(matchInfo(state, q("todo")).total).toBe(4);
    expect(matchInfo(state, q("todo", { caseSensitive: true })).total).toBe(2);
    expect(matchInfo(state, q("todo", { wholeWord: true })).total).toBe(3);
  });

  it("正则表达式；写错了提示正则有误", () => {
    const state = makeState("2026-10-02 和 2025-01-01");
    expect(matchInfo(state, q("\\d{4}-\\d\\d", { regexp: true })).total).toBe(2);
    const bad = q("(", { regexp: true });
    expect(matchInfo(state, bad).total).toBe(0);
    expect(matchLabel(bad, matchInfo(state, bad))).toBe("正则有误");
  });

  it("没有匹配时显示无结果，查找内容为空时什么都不显示", () => {
    const state = makeState("周报");
    expect(matchLabel(q("月报"), matchInfo(state, q("月报")))).toBe("无结果");
    expect(matchLabel(q(""), matchInfo(state, q("")))).toBe("");
  });

  it("按原样查：反斜杠、\\n 不转义（Windows 路径也能查到）", () => {
    const state = makeState("文件在 C:\\new\\temp 里");
    expect(matchInfo(state, q("C:\\new\\temp", { literal: true })).total).toBe(1);
    // 不按原样查时 \n 会被当成换行，找不到
    expect(matchInfo(state, q("C:\\new\\temp")).total).toBe(0);
  });

  it("太多时数到上限为止；全部替换前要数清楚时可以不设上限", () => {
    expect(matchInfo(makeState("a".repeat(MAX_COUNT + 50)), q("a"), Infinity).total).toBe(MAX_COUNT + 50);
  });

  it("太多时数到上限为止", () => {
    const state = makeState("a".repeat(MAX_COUNT + 50));
    const info = matchInfo(state, q("a"));
    expect(info).toMatchObject({ total: MAX_COUNT, capped: true });
    expect(matchLabel(q("a"), info)).toBe(`共 ${MAX_COUNT}+ 个`);
  });
});

describe("打开查找框时查什么", () => {
  it("选中了一行里的文字时查它", () => {
    const state = withSearch("今天写«周报»");
    expect(selectedText(state)).toBe("周报");
    expect(initialQuery(state, q("月报")).search).toBe("周报");
  });

  it("没选中文字时接着用上一次查的（在别的待办里查过的也算）", () => {
    expect(initialQuery(withSearch("|周报"), q("月报", { caseSensitive: true }))).toMatchObject({
      search: "月报",
      caseSensitive: true,
    });
    expect(initialQuery(withSearch("|周报"), null).search).toBe("");
  });

  it("编辑器刚打开时选区是多行的（恢复的编辑位置），也不拿它当查找内容", () => {
    const state = withSearch("«第一行\n第二行»");
    expect(initialQuery(state, null).search).toBe("");
  });

  it("选中了多行或很长的文字时不拿来查", () => {
    expect(selectedText(makeState("«第一行\n第二行»"))).toBe("");
    expect(selectedText(makeState(`«${"字".repeat(101)}»`))).toBe("");
    expect(initialQuery(withSearch("«第一行\n第二行»"), q("月报")).search).toBe("月报");
  });

  it("拿选中的文字查时按普通文字查，不当成正则", () => {
    const state = withSearch("价格是«(1+2)»元");
    expect(initialQuery(state, q("x", { regexp: true }))).toMatchObject({ search: "(1+2)", regexp: false, literal: true });
  });

  it("选中文字时保留上次的替换内容", () => {
    expect(initialQuery(withSearch("把«周报»改掉"), q("x", { replace: "月报" })).replace).toBe("月报");
  });
});

describe("输入时跳到哪个结果", () => {
  const state = makeState("周报1 月报 周报2 月报 周报3");

  it("从打开查找框时的光标往后找第一个", () => {
    const at = state.doc.toString().indexOf("月报");
    const m = firstMatchFrom(state, q("周报"), at);
    expect(state.sliceDoc(m!.from, m!.to + 1)).toBe("周报2");
  });

  it("后面没有了就从头找", () => {
    const at = state.doc.toString().indexOf("周报3") + 1;
    const m = firstMatchFrom(state, q("周报"), at);
    expect(m!.from).toBe(0);
  });

  it("没有匹配、条件无效时返回 null", () => {
    expect(firstMatchFrom(state, q("年报"), 0)).toBeNull();
    expect(firstMatchFrom(state, q("("), 0)).toBeNull();
    expect(firstMatchFrom(state, q("(", { regexp: true }), 0)).toBeNull();
  });
});
