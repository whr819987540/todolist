import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { caretTarget, keepCaretVisible, leftOverIndent } from "./listCaret";
import { makeState, parse, stringify, TestView } from "./testState";

// docs/requirements.md「实时渲染里的列表」：行首的缩进空格不显示，光标不停在看不见、或看上去在别处的地方——
// 不停在藏起来的缩进前面和里面（在那里打字会把列表项拆坏），方向键一下跳过；删除照常一格一格地删。记号：| 光标

/** 用户的一次移动（方向键、Home、点击等）把光标挪到 to 之后，光标实际停在哪里 */
const moveTo = (marked: string, to: string, userEvent = "select") => {
  const state = makeState(marked, [keepCaretVisible]);
  const { selection } = parse(to);
  return stringify(state.update({ selection, userEvent }).state);
};

describe("光标不停在藏起来的缩进里", () => {
  it("落在缩进前面或里面（Home 再按一次、往右走进来、点在缩进的地方）时停到列表符号前面", () => {
    expect(moveTo("- 甲\n  - 乙|", "- 甲\n|  - 乙")).toBe("- 甲\n  |- 乙");
    expect(moveTo("- 甲|\n  - 乙", "- 甲\n | - 乙")).toBe("- 甲\n  |- 乙");
    expect(moveTo("- 甲\n  - 乙|", "- 甲\n | - 乙", "select.pointer")).toBe("- 甲\n  |- 乙");
  });

  it("续行的缩进也一样：停到文字前面", () => {
    expect(moveTo("- 甲\n  续行|", "- 甲\n|  续行")).toBe("- 甲\n  |续行");
  });

  it("查找选中、程序设的光标不管；不在列表里的行不管", () => {
    expect(moveTo("- 甲\n  - 乙|", "- 甲\n|  - 乙", "select.search")).toBe("- 甲\n|  - 乙");
    expect(moveTo("段落|\n  缩进的段落", "段落\n|  缩进的段落")).toBe("段落\n|  缩进的段落");
  });

  it("拖选的两头都挪开", () => {
    const state = makeState("- 甲\n  - 乙", [keepCaretVisible]);
    const sel = state.update({ selection: EditorSelection.single(5, 0), userEvent: "select.pointer" }).state.selection.main;
    expect([sel.anchor, sel.head]).toEqual([6, 0]);
  });

  it("caretTarget：内容从引用开始的列表项，> 里面不停，按移动方向跳到一头", () => {
    const state = makeState("- > 引用");
    expect(caretTarget(state, 3, -1)).toBe(2);
    expect(caretTarget(state, 3, 1)).toBe(4);
  });
});

describe("← 跳过藏起来的缩进", () => {
  const left = (marked: string, extend = false) => {
    const view = new TestView(makeState(marked, [keepCaretVisible]));
    const handled = leftOverIndent(view.asView, extend);
    return { handled, text: stringify(view.state) };
  };

  it("在下一级列表项的符号前面按 ←：直接到上一行末尾", () => {
    expect(left("- 甲\n  |- 乙")).toEqual({ handled: true, text: "- 甲|\n  - 乙" });
    expect(left("- 甲\n    |续行")).toEqual({ handled: true, text: "- 甲|\n    续行" });
  });

  it("Shift+← 往前选", () => {
    expect(left("- 甲\n  |- 乙", true).text).toBe("- 甲»\n  «- 乙");
  });

  it("别的地方照常移动（交给默认的 ←）", () => {
    expect(left("- 甲\n  - |乙").handled).toBe(false);
    expect(left("- |甲").handled).toBe(false);
    expect(left("|- 甲").handled).toBe(false);
  });
});
