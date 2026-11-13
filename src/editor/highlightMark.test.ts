import { syntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { markdownSupport } from "./setup";
import { parsedState } from "./testState";

// 按 docs/requirements.md「待办内容 → 高亮」写的用例：哪些 ==…== 算高亮（解析成 Highlight 节点），高亮里是哪些字

/** 正文里每一段高亮里面的字（去掉两头的 ==） */
function highlights(doc: string): string[] {
  const state = parsedState({ doc, extensions: markdownSupport() });
  const out: string[] = [];
  syntaxTree(state).iterate({
    enter(n) {
      if (n.name !== "Highlight") return;
      const open = n.node.firstChild;
      const close = n.node.lastChild;
      expect(open?.name).toBe("HighlightMark");
      expect(close?.name).toBe("HighlightMark");
      out.push(state.sliceDoc(open!.to, close!.from));
    },
  });
  return out;
}

describe("==高亮==", () => {
  it("==…== 里的字高亮，一段里可以有几处", () => {
    expect(highlights("买==牛奶==和==面包==")).toEqual(["牛奶", "面包"]);
    expect(highlights("==整段高亮==")).toEqual(["整段高亮"]);
  });

  it("挨着全角标点、英文的也算", () => {
    expect(highlights("这是==（重点）==。")).toEqual(["（重点）"]);
    expect(highlights("a==b==c")).toEqual(["b"]);
  });

  it("开头的 == 后面、结尾的 == 前面是空白的不算", () => {
    expect(highlights("a == b == c")).toEqual([]);
    expect(highlights("== 甲==")).toEqual([]);
    expect(highlights("==甲 ==")).toEqual([]);
    // 结尾那个不算，前面那个照样等着配后面的
    expect(highlights("==甲 == 乙==")).toEqual(["甲 == 乙"]);
  });

  it("只有一边的 == 不算", () => {
    expect(highlights("if a==b {")).toEqual([]);
    expect(highlights("==没有结尾")).toEqual([]);
  });

  it("正好两个 = 才算，三个以上连着的不算", () => {
    expect(highlights("===甲===")).toEqual([]);
    expect(highlights("==甲===")).toEqual([]);
    expect(highlights("a === b")).toEqual([]);
  });

  it("\\== 转义了的、字符引用（&#61;）的 = 不算；转义的是 \\ 时后面的 == 照样算", () => {
    expect(highlights("\\==甲==")).toEqual([]);
    expect(highlights("&#61;=甲==")).toEqual([]);
    expect(highlights("\\\\==甲==")).toEqual(["甲"]);
  });

  it("结尾的 == 配前面最近的开头", () => {
    expect(highlights("==甲==乙==")).toEqual(["甲"]);
  });

  it("行内代码、代码块、链接地址里的不算", () => {
    expect(highlights("`==甲==`")).toEqual([]);
    expect(highlights("```\n==甲==\n```")).toEqual([]);
    expect(highlights("[链接](https://a.cn/?q==甲==)")).toEqual([]);
  });

  it("和加粗、斜体、删除线、链接套着用", () => {
    expect(highlights("**==甲==** ==**乙**== *==丙==* ~~==丁==~~ [==戊==](https://a.cn)")).toEqual([
      "甲",
      "**乙**",
      "丙",
      "丁",
      "戊",
    ]);
  });

  it("同一段里可以跨行，跨段的不算", () => {
    expect(highlights("==甲\n乙==")).toEqual(["甲\n乙"]);
    expect(highlights("==甲\n\n乙==")).toEqual([]);
  });

  it("标题、列表、引用、表格里也算", () => {
    expect(highlights("# ==标题==\n\n- ==列表==\n\n> ==引用==\n\n| ==表头== |\n| --- |\n| ==格子== |")).toEqual([
      "标题",
      "列表",
      "引用",
      "表头",
      "格子",
    ]);
  });

  it("文字下面一行的 == 是标题的下划线，不是高亮", () => {
    const state = parsedState({ doc: "标题\n==", extensions: markdownSupport() });
    expect(syntaxTree(state).topNode.firstChild?.name).toBe("SetextHeading1");
    expect(highlights("标题\n==")).toEqual([]);
  });
});
