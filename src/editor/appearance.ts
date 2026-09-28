import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

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
  ".cm-content": { padding: "16px 0 24px", caretColor: "var(--c-text)" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--c-text-4)" },

  ".cm-md-h": { fontWeight: "600", lineHeight: "1.5" },
  ".cm-md-h1": { fontSize: "1.6em", paddingTop: "0.4em" },
  ".cm-md-h2": { fontSize: "1.4em", paddingTop: "0.35em" },
  ".cm-md-h3": { fontSize: "1.25em", paddingTop: "0.3em" },
  ".cm-md-h4": { fontSize: "1.1em", paddingTop: "0.25em" },
  ".cm-md-quote": {
    borderLeft: "3px solid var(--c-border-strong)",
    paddingLeft: "12px",
    color: "var(--c-text-2)",
  },
  ".cm-md-codeblock": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.92em",
    backgroundColor: "var(--c-hover)",
    padding: "0 12px",
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
  // 列表符号和任务框占同样的宽度，文字对齐
  ".cm-md-bullet": { display: "inline-block", width: "1.5em", color: "var(--c-text-2)" },
  ".cm-md-task": {
    width: "0.95em",
    height: "0.95em",
    margin: "0 0.55em 0 0",
    verticalAlign: "-0.1em",
    cursor: "pointer",
    accentColor: "var(--c-primary)",
  },
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
