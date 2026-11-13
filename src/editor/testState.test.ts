import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { markdownSupport } from "./setup";
import { makeState, parsedState, stringify } from "./testState";

// 单元测试拿到的语法树要是整篇解析完的（testState.ts 的 parsedState）：CodeMirror 建 state 时只解析开头一段，
// 按 syntaxTree 算的结果（列表排版、表格、图片、光标停在哪里）在长的正文、慢的机器上就不对

const LONG = Array.from({ length: 1000 }, (_, i) => `- [ ] 第 ${i} 项 **加粗** 和 [链接](https://a.com)`).join("\n");

/** 最后一行的任务框在语法树里认不认得出 */
const lastTask = (state: EditorState) => syntaxTree(state).resolveInner(state.doc.line(state.doc.lines).from + 2, 1).name;

describe("测试用的 state 整篇解析完", () => {
  it("直接建的 state 只解析了开头一段，长的正文末尾认不出（所以测试里都用 parsedState）", () => {
    const raw = EditorState.create({ doc: LONG, extensions: markdownSupport() });
    expect(syntaxTree(raw).length).toBeLessThan(LONG.length);
    expect(lastTask(raw)).not.toBe("TaskMarker");
  });

  it("parsedState、makeState 建的解析到了末尾，最后一项也认得出是任务", () => {
    for (const state of [parsedState({ doc: LONG, extensions: markdownSupport() }), makeState(`${LONG}|`)]) {
      expect(syntaxTree(state).length).toBe(state.doc.length);
      expect(lastTask(state)).toBe("TaskMarker");
    }
  });

  it("正文、光标和选区照原样", () => {
    expect(stringify(makeState("- 甲\n- «乙»"))).toBe("- 甲\n- «乙»");
    expect(stringify(makeState(`${LONG}|`))).toBe(`${LONG}|`);
  });
});
