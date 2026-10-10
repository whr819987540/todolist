import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { sourcePrefix } from "./listLayout";

// 源码模式里的列表：显示原样的空格和符号，每一级缩进的宽度不变，只让一项折行后折下来的行对齐到第一行的正文开头
// （列表符号、任务框后面；续行对齐到它自己的文字开头）。行首这一段（空格、>、列表符号、[ ]）有多宽，
// 用 canvas 按这一行的字体（正文的，代码块里是等宽的）量出来，以 em 计：调字号不用重新量，标题、代码这类字号不同的行也对

let ctx: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/** text 按 font 排出来有几个 em 宽；量不了（没有 canvas）时为 null */
function widthEm(font: string, text: string): number | null {
  if (ctx === undefined) ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  const key = `${font}\n${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    ctx.font = `100px ${font}`;
    w = ctx.measureText(text).width / 100;
    widths.set(key, w);
  }
  return w;
}

/** 制表符按编辑器的制表位换成空格（canvas 把制表符量成一个空格） */
function expandTabs(text: string, tabSize: number) {
  let out = "";
  for (const ch of text) out += ch === "\t" ? " ".repeat(tabSize - (out.length % tabSize)) : ch;
  return out;
}

const lineDecos = new Map<string, Decoration>();

/** 正文和代码的字体 */
interface Fonts {
  text: string;
  code: string;
}

function build(view: EditorView, fonts: Fonts): DecorationSet {
  const { state } = view;
  const tree = syntaxTree(state);
  const out: Range<Decoration>[] = [];
  let last = 0;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (line.number <= last) continue;
      last = line.number;
      const prefix = sourcePrefix(state, line, tree);
      if (!prefix) continue;
      const w = widthEm(prefix.code ? fonts.code : fonts.text, expandTabs(prefix.text, state.tabSize));
      if (!w) continue;
      const style = `--md-li-pad: ${w.toFixed(3)}em; --md-li-hang: ${w.toFixed(3)}em`;
      let d = lineDecos.get(style);
      if (!d) lineDecos.set(style, (d = Decoration.line({ class: "cm-md-li", attributes: { style } })));
      out.push(d.range(line.from));
    }
  }
  return Decoration.set(out);
}

export const sourceIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /** 正文和代码的字体：编辑器刚建、还没放进页面时取不到，放进去以后第一次量尺寸时再取 */
    font: Fonts | null = null;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    build(view: EditorView) {
      if (!this.font && view.dom.isConnected) {
        const text = getComputedStyle(view.contentDOM).fontFamily;
        const code = getComputedStyle(view.contentDOM).getPropertyValue("--font-mono").trim();
        if (text) this.font = { text, code: code || "monospace" };
      }
      return this.font ? build(view, this.font) : Decoration.none;
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        (u.geometryChanged && !this.font)
      ) {
        this.decorations = this.build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
