import { tags as t } from "@lezer/highlight";
import type { DelimiterType, MarkdownConfig } from "@lezer/markdown";

// ==高亮==（同 Typora、Obsidian）：不是 GFM 的语法，@lezer/markdown 里没有，照它的删除线 ~~…~~ 写成一个扩展，
// 解析出 Highlight 节点，两头的 == 是 HighlightMark。怎样算高亮：
// - 正好两个 =，三个以上连着的 = 不算（=== 也是 Setext 标题的下划线）
// - 开头的 == 后面紧挨着字，结尾的 == 前面紧挨着字；后面（前面）是空白或行尾（行首）的不算，a == b 这样的比较不会被当成高亮。
//   不照 ~~ 那样看两边的标点：中文里 ==（甲）== 这种挨着全角标点的很常见，按标点的规则反而认不出
// - 结尾的 == 配前面最近的、还没配上的开头；行内代码、链接地址、HTML 标签里的 == 先被解析成别的，不算

const HighlightDelim: DelimiterType = { resolve: "Highlight", mark: "HighlightMark" };

const EQ = 61; // "="
const blank = (s: string) => /\s|^$/.test(s);

export const Highlight: MarkdownConfig = {
  defineNodes: [{ name: "Highlight" }, { name: "HighlightMark", style: t.processingInstruction }],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== EQ || cx.char(pos + 1) !== EQ || cx.char(pos + 2) === EQ || cx.char(pos - 1) === EQ) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !blank(after), !blank(before));
      },
      after: "Emphasis",
    },
  ],
};
