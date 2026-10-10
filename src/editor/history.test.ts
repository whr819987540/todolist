import { history, historyField, undo } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { lineChanges, rebaseHistory } from "./history";
import { TestView } from "./testState";

// docs/requirements.md「待办内容 → 图片 → 跟着待办走」：移动、另存为新待办后换了 id，正文里图片的链接被软件改了，
// 撤销记录接着用——撤销的还是用户自己的修改，软件改的链接留着

/** 打开着的待办：正文 doc 上做了一处用户的修改，返回改完的正文和撤销记录 */
function edited(doc: string, change: { from: number; insert: string }) {
  const state = EditorState.create({ doc, extensions: history() });
  const next = state.update({ changes: change, userEvent: "input" }).state;
  return { doc: next.doc.toString(), history: next.toJSON({ history: historyField }).history };
}

describe("撤销记录接到改了链接的正文上", () => {
  it("撤销的还是自己打的字，改过的链接不变", () => {
    const before = "# 周报\n![图](.assets/A/a.png)\n结尾";
    const mine = edited(before, { from: 4, insert: "（第 40 周）" });
    const relinked = mine.doc.replace(".assets/A/", ".assets/A-2/");
    const rebased = rebaseHistory(mine.doc, mine.history, relinked);
    expect(rebased).not.toBeNull();
    const state = EditorState.fromJSON(
      { doc: relinked, selection: EditorSelection.single(0).toJSON(), history: rebased },
      { extensions: history() },
      { history: historyField },
    );
    const view = new TestView(state);
    undo(view.asView);
    expect(view.state.doc.toString()).toBe("# 周报\n![图](.assets/A-2/a.png)\n结尾");
  });

  it("行数对不上、撤销记录认不出时接不上", () => {
    const mine = edited("a\nb", { from: 0, insert: "x" });
    expect(rebaseHistory(mine.doc, mine.history, "xa\nb\nc")).toBeNull();
    expect(rebaseHistory(mine.doc, { 认不出: true }, "ya\nb")).toBeNull();
  });

  it("按行找出改了的地方，只改不一样的那一段", () => {
    expect(lineChanges("一\n![](.assets/A/a.png)\n三", "一\n![](.assets/B/a.png)\n三")).toEqual([
      { from: 14, to: 15, insert: "B" },
    ]);
    expect(lineChanges("同样", "同样")).toEqual([]);
    expect(lineChanges("a", "a\nb")).toBeNull();
  });
});
