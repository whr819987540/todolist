import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { INDENT, TASK } from "./listLayout";

// 两种模式共用的外观：行内语法高亮 + 标题 / 代码块 / 引用的整行样式。
// 颜色都取 theme.tsx 注入的 CSS 变量，深浅色自动跟随

/** 同一个节点带多个标签时（如链接里的 [ ]），后定义的规则优先，所以标记符号的灰色放在最后 */
const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "600" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--c-primary)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)" },
  { tag: t.quote, color: "var(--c-text-2)" },
  {
    tag: [t.processingInstruction, t.contentSeparator, t.labelName, t.string, t.escape, t.comment],
    color: "var(--c-text-3)",
  },
  { tag: [t.tagName, t.attributeName, t.attributeValue, t.angleBracket], color: "var(--c-text-3)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--c-text)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font)",
    fontSize: "var(--fs-editor)",
    lineHeight: "1.8",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "16px 0 24px",
    caretColor: "var(--c-text)",
    // 列表每一级缩进的宽度（同 Typora，约两个字）和任务框占的宽度（listLayout.ts）；按正文字号算，标题等放大的行也和同级对齐
    "--md-indent": `calc(var(--fs-editor) * ${INDENT})`,
    "--md-task": `calc(var(--fs-editor) * ${TASK})`,
    // 引用的竖线和它右边的空当
    "--md-quote-bar": "3px",
    "--md-quote-gap": "12px",
  },
  ".cm-line": { padding: "0" },
  // 列表的行（listLayout.ts 按行设这几个变量）：折行后和正文对齐（悬挂缩进）。引用的竖线在引用里面的那几级缩进左边
  ".cm-md-li": {
    marginLeft: "var(--md-li-margin, 0px)",
    paddingLeft: "var(--md-li-pad, 0px)",
    textIndent: "calc(-1 * var(--md-li-hang, 0px))",
  },
  ".cm-placeholder": { color: "var(--c-text-4)" },

  ".cm-md-h": { fontWeight: "600", lineHeight: "1.5" },
  ".cm-md-h1": { fontSize: "1.6em", paddingTop: "0.4em" },
  ".cm-md-h2": { fontSize: "1.4em", paddingTop: "0.35em" },
  ".cm-md-h3": { fontSize: "1.25em", paddingTop: "0.3em" },
  ".cm-md-h4": { fontSize: "1.1em", paddingTop: "0.25em" },
  ".cm-md-quote": {
    borderLeft: "var(--md-quote-bar) solid var(--c-border-strong)",
    paddingLeft: "calc(var(--md-quote-gap) + var(--md-li-pad, 0px))",
    color: "var(--c-text-2)",
  },
  // 内容从引用开始的列表项（"- > 引用"）第一行：引用竖线不画在行首，画在列表符号那一格后面（--md-li-qbar），
  // 和下面几行的竖线接上
  ".cm-md-li-qfirst": {
    borderLeft: "none",
    backgroundImage: "linear-gradient(var(--c-border-strong), var(--c-border-strong))",
    backgroundSize: "var(--md-quote-bar) 100%",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "var(--md-li-qbar, 0px) 0",
  },
  ".cm-md-codeblock": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.92em",
    backgroundColor: "var(--c-hover)",
    padding: "0 12px 0 calc(12px + var(--md-li-pad, 0px))",
  },
  ".cm-md-codeblock-begin": { borderTopLeftRadius: "6px", borderTopRightRadius: "6px" },
  ".cm-md-codeblock-end": { borderBottomLeftRadius: "6px", borderBottomRightRadius: "6px" },
  ".cm-md-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.92em",
    backgroundColor: "var(--c-hover)",
    borderRadius: "4px",
    padding: "1px 4px",
  },

  // 以下只在实时渲染模式出现（livePreview.ts）
  ".cm-md-link": { textDecoration: "underline", textUnderlineOffset: "3px" },
  ".cm-md-u": { textDecoration: "underline", textUnderlineOffset: "3px" },
  // 行首的列表符号、序号、任务框都在正文左边的那一格里（宽度由 livePreview.ts 按 listLayout.ts 设），靠右放（同 Typora），
  // 显示原文时也一样，正文不左右跳。格子里不用行上的悬挂缩进；字号总是正文字号（列表项是标题时也不跟着放大）
  ".cm-md-li-bullet": {
    display: "inline-block",
    paddingRight: "calc(var(--fs-editor) * 0.45)",
    boxSizing: "border-box",
    textAlign: "right",
    textIndent: "0",
    fontSize: "var(--fs-editor)",
    color: "var(--c-text-2)",
  },
  ".cm-md-li-num": {
    display: "inline-block",
    textAlign: "right",
    textIndent: "0",
    whiteSpace: "pre",
    fontSize: "var(--fs-editor)",
  },
  ".cm-md-li-numtext": { color: "var(--c-text-3)" },
  ".cm-md-li-mark": {
    display: "inline-block",
    textAlign: "right",
    textIndent: "0",
    whiteSpace: "pre",
    fontSize: "var(--fs-editor)",
  },
  // 原文里有任务框的（"- [X] "、有序任务的 "[X] "）比一格略宽，字距收紧一点放进去
  ".cm-md-li-mark-task": { letterSpacing: "-0.05em" },
  ".cm-md-li-taskmark": {
    display: "inline-block",
    minWidth: "var(--md-task)",
    textIndent: "0",
    whiteSpace: "pre",
    fontSize: "var(--fs-editor)",
    letterSpacing: "-0.05em",
  },
  // "- > 引用" 第一行的 >：占引用竖线和空当那么宽，显示出来时靠右（紧挨着文字）
  ".cm-md-li-qgap": {
    display: "inline-block",
    minWidth: "calc(var(--md-quote-bar) + var(--md-quote-gap))",
    textAlign: "right",
    textIndent: "0",
    whiteSpace: "pre",
    fontSize: "var(--fs-editor)",
  },
  // 同一行里第二个列表符号（如 "- - 甲"）
  ".cm-md-bullet": { display: "inline-block", width: "1.5em", textIndent: "0", color: "var(--c-text-2)" },
  // 任务框连同右边的空当一共 --md-task 宽；无序列表的任务框占列表符号那一格，左边补上
  ".cm-md-task": {
    width: "calc(var(--fs-editor) * 0.9)",
    height: "calc(var(--fs-editor) * 0.9)",
    margin: "0 calc(var(--fs-editor) * 0.6) 0 0",
    verticalAlign: "calc(var(--fs-editor) * -0.12)",
    cursor: "pointer",
    accentColor: "var(--c-primary)",
  },
  ".cm-md-task-slot": { marginLeft: "calc(var(--md-indent) - var(--md-task))" },
  ".cm-md-task-done": { color: "var(--c-text-3)", textDecoration: "line-through" },
  ".cm-md-hr": {
    display: "inline-block",
    width: "100%",
    verticalAlign: "middle",
    borderTop: "1px solid var(--c-border-strong)",
  },
});

const lineDecos = new Map<string, Decoration>();
const lineDeco = (cls: string) => {
  let d = lineDecos.get(cls);
  if (!d) lineDecos.set(cls, (d = Decoration.line({ class: cls })));
  return d;
};
const inlineCode = Decoration.mark({ class: "cm-md-code" });

function buildBlocks(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    // 给 [start, end] 覆盖的行加样式，只处理可见部分；first / last 标出块的首尾行
    const eachLine = (start: number, end: number, cls: (first: boolean, last: boolean) => string) => {
      const first = doc.lineAt(start).number;
      const last = doc.lineAt(end).number;
      const lo = Math.max(first, doc.lineAt(from).number);
      const hi = Math.min(last, doc.lineAt(to).number);
      for (let n = lo; n <= hi; n++) out.push(lineDeco(cls(n === first, n === last)).range(doc.line(n).from));
    };
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const heading = /^(ATX|Setext)Heading(\d)$/.exec(node.name);
        if (heading) {
          // Setext 标题（下一行是 === / ---）的下划线那行不放大
          const mark = heading[1] === "Setext" ? node.node.getChild("HeaderMark") : null;
          const end = mark ? Math.max(node.from, mark.from - 1) : node.to;
          eachLine(node.from, end, () => `cm-md-h cm-md-h${heading[2]}`);
          return;
        }
        switch (node.name) {
          case "FencedCode":
          case "CodeBlock":
            eachLine(node.from, node.to, (first, last) =>
              ["cm-md-codeblock", first && "cm-md-codeblock-begin", last && "cm-md-codeblock-end"]
                .filter(Boolean)
                .join(" "),
            );
            return false;
          case "Blockquote":
            eachLine(node.from, node.to, () => "cm-md-quote");
            return;
          case "InlineCode": {
            // 背景只铺在反引号之间
            const open = node.node.firstChild;
            const close = node.node.lastChild;
            if (open && close && close.from > open.to) out.push(inlineCode.range(open.to, close.from));
            return false;
          }
        }
      },
    });
  }
  return Decoration.set(out, true);
}

const blockStyles = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildBlocks(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildBlocks(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export const appearance: Extension = [theme, syntaxHighlighting(highlight), blockStyles];
