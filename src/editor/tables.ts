import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  type SelectionRange,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { ImageWidget } from "./images";
import { linkOpener, linkTarget } from "./links";

// 实时渲染时的 GFM 表格（docs/requirements.md「待办内容 → 表格」）：光标（选区）不在表格里时，整个表格换成渲染后的
// <table>（表头加粗、按分隔行对齐，单元格里的加粗、斜体、行内代码、链接、图片也渲染），在表格里时显示原文。
// 换掉的是好几行（块级的替换），CodeMirror 只许从 StateField 里给，所以不在 livePreview.ts 的 ViewPlugin 里；
// 字段里看不到编辑器有没有焦点、鼠标是不是按着，由下面的事件告诉它。只改显示，正文原样不动

/** 列的对齐：分隔行里的 :--- 左对齐、:---: 居中、---: 右对齐，--- 不指定 */
export type Align = "left" | "center" | "right" | null;

/** 单元格里的内容：按语法树拆成这些，渲染成 DOM */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "br" }
  | { kind: "strong" | "em" | "del"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; url: string; children: Inline[] }
  | { kind: "image"; src: string; alt: string };

export interface TableCell {
  content: Inline[];
  /** 单击这一格时光标放在哪里（相对表格开头）：格子里文字的末尾，空的格子在两个 | 中间 */
  cursor: number;
}

export interface TableModel {
  align: Align[];
  header: TableCell[];
  /** 内容行，每行的格子数和表头一样：少的补上空格子（光标放在行尾），多的不要（同 GFM） */
  rows: TableCell[][];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** &amp;、&#123;、&#x1F600; 这类字符引用；认不出的照原样 */
function entity(raw: string): string {
  const m = /^&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z]+));$/.exec(raw);
  const code = m?.[1] ? parseInt(m[1], 10) : m?.[2] ? parseInt(m[2], 16) : NaN;
  if (code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
  return (m?.[3] && ENTITIES[m[3]]) || raw;
}

/** 节点 parent 里 [from, to] 这一段的内容：子节点按语法渲染，中间的是文字 */
function inlines(state: EditorState, parent: SyntaxNode, from = parent.from, to = parent.to): Inline[] {
  const out: Inline[] = [];
  /** 挨着的文字合成一段 */
  const push = (item: Inline) => {
    const last = out[out.length - 1];
    if (item.kind === "text" && last?.kind === "text") last.text += item.text;
    else if (item.kind !== "text" || item.text) out.push(item);
  };
  let pos = from;
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c.to <= from || c.from >= to) continue;
    push({ kind: "text", text: state.sliceDoc(pos, Math.max(pos, c.from)) });
    for (const item of inline(state, c)) push(item);
    pos = c.to;
  }
  push({ kind: "text", text: state.sliceDoc(pos, Math.max(pos, to)) });
  return out;
}

/** 一个行内节点渲染成什么 */
function inline(state: EditorState, n: SyntaxNode): Inline[] {
  const raw = (): Inline[] => [{ kind: "text", text: state.sliceDoc(n.from, n.to) }];
  /** 去掉首尾的标记（**、~~、` 等）之后的范围 */
  const inner = (): [number, number] => {
    const first = n.firstChild;
    const last = n.lastChild;
    const from = first && first.from === n.from && first.name.endsWith("Mark") ? first.to : n.from;
    const to = last && last !== first && last.to === n.to && last.name.endsWith("Mark") ? last.from : n.to;
    return [from, Math.max(from, to)];
  };
  switch (n.name) {
    case "StrongEmphasis":
    case "Emphasis":
    case "Strikethrough": {
      const kind = n.name === "StrongEmphasis" ? "strong" : n.name === "Emphasis" ? "em" : "del";
      return [{ kind, children: inlines(state, n, ...inner()) }];
    }
    case "InlineCode": {
      const [from, to] = inner();
      return [{ kind: "code", text: state.sliceDoc(from, to) }];
    }
    case "Link": {
      const [open, close] = n.getChildren("LinkMark");
      if (!open || !close) return raw();
      return [{ kind: "link", url: linkTarget(state, n) ?? "", children: inlines(state, n, open.to, close.from) }];
    }
    case "Image": {
      const [open, close] = n.getChildren("LinkMark");
      const alt = open && close ? state.sliceDoc(open.to, close.from) : "";
      return [{ kind: "image", src: linkTarget(state, n) ?? "", alt }];
    }
    case "Autolink":
    case "URL": {
      const url = linkTarget(state, n) ?? state.sliceDoc(n.from, n.to);
      const shown = url.replace(/^<(.*)>$/, "$1");
      return [{ kind: "link", url: shown, children: [{ kind: "text", text: shown }] }];
    }
    case "Escape":
      return [{ kind: "text", text: state.sliceDoc(n.from + 1, n.to) }];
    case "Entity":
      return [{ kind: "text", text: entity(state.sliceDoc(n.from, n.to)) }];
    case "HTMLTag":
      return /^<br\s*\/?>$/i.test(state.sliceDoc(n.from, n.to)) ? [{ kind: "br" }] : raw();
    default:
      return raw();
  }
}

/**
 * 一行（表头或内容行）的格子：按 | 分开，行首、行尾的 | 可有可无（同 GFM：第一个 | 前面、最后一个 | 后面是空白时
 * 不算一格）。base 是表格开头的位置
 */
function rowCells(state: EditorState, row: SyntaxNode, base: number): TableCell[] {
  const pipes = row.getChildren("TableDelimiter");
  const cells = row.getChildren("TableCell");
  const out: TableCell[] = [];
  for (let i = 0; i <= pipes.length; i++) {
    const from = i === 0 ? row.from : pipes[i - 1].to;
    const to = i === pipes.length ? row.to : pipes[i].from;
    const node = cells.find((c) => c.from >= from && c.to <= to);
    // 行首的 | 前面、行尾的 | 后面什么都没有
    if (!node && pipes.length && (i === 0 || i === pipes.length)) continue;
    if (node) {
      out.push({ content: inlines(state, node), cursor: node.to - base });
    } else {
      // 空的格子：光标放在两个 | 中间（有空格时放在第一个空格后面）
      const gap = state.sliceDoc(from, to);
      out.push({ content: [], cursor: from + (gap.length >= 2 && gap[0] === " " ? 1 : 0) - base });
    }
  }
  return out;
}

/** 分隔行（| :--- | :---: | ---: |）里各列的对齐 */
function alignments(text: string): Align[] {
  const parts = text.trim().split("|").map((p) => p.trim());
  if (parts[0] === "") parts.shift();
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts.map((p) => {
    const left = p.startsWith(":");
    const right = p.endsWith(":") && p.length > 1;
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
}

/** 表格（语法树里的 Table 节点）的内容；from 是它第一行的行首 */
export function tableModel(state: EditorState, table: SyntaxNode, from: number): TableModel {
  const headRow = table.getChild("TableHeader");
  const header = headRow ? rowCells(state, headRow, from) : [];
  let align: Align[] = [];
  const rows: TableCell[][] = [];
  for (let c = table.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableDelimiter") align = alignments(state.sliceDoc(c.from, c.to));
    if (c.name !== "TableRow") continue;
    const cells = rowCells(state, c, from).slice(0, header.length);
    while (cells.length < header.length) cells.push({ content: [], cursor: c.to - from });
    rows.push(cells);
  }
  return { align: header.map((_, i) => align[i] ?? null), header, rows };
}

/** 正文里能渲染的表格（不在列表、引用里的）：从第一行的行首到最后一行的行尾 */
export interface TableBlock {
  from: number;
  to: number;
  model: TableModel;
}

export function tableBlocks(state: EditorState): TableBlock[] {
  const out: TableBlock[] = [];
  const { doc } = state;
  for (let n = syntaxTree(state).topNode.firstChild; n; n = n.nextSibling) {
    if (n.name !== "Table") continue;
    const from = doc.lineAt(n.from).from;
    out.push({ from, to: doc.lineAt(n.to).to, model: tableModel(state, n, from) });
  }
  return out;
}

/** 选区碰到 [from, to]（含两端）；没有焦点（sel 是 null）时都不算碰到 */
const touched = (t: TableBlock, sel: readonly SelectionRange[] | null) =>
  !!sel?.some((r) => r.from <= t.to && r.to >= t.from);

/** 这些表格里哪些显示成渲染后的表格：选区碰到的显示原文 */
export const renderedTables = (tables: readonly TableBlock[], sel: readonly SelectionRange[] | null) =>
  tables.filter((t) => !touched(t, sel));

/** 单元格里的内容渲染成 DOM */
function renderInlines(view: EditorView, items: readonly Inline[], parent: HTMLElement) {
  for (const it of items) {
    switch (it.kind) {
      case "text":
        parent.append(it.text);
        break;
      case "br":
        parent.append(document.createElement("br"));
        break;
      case "strong":
      case "em":
      case "del": {
        const el = document.createElement(it.kind);
        renderInlines(view, it.children, el);
        parent.append(el);
        break;
      }
      case "code": {
        const el = document.createElement("code");
        el.className = "cm-md-code";
        el.textContent = it.text;
        parent.append(el);
        break;
      }
      case "link": {
        const el = document.createElement("a");
        el.className = "cm-md-link";
        el.dataset.url = it.url;
        el.title = it.url ? `${it.url}\nCtrl + 单击打开` : "Ctrl + 单击打开";
        renderInlines(view, it.children, el);
        parent.append(el);
        break;
      }
      case "image":
        parent.append(new ImageWidget(it.src, it.alt).toDOM(view));
        break;
    }
  }
}

class TableWidget extends WidgetType {
  constructor(
    /** 表格的原文：一样时不重新画 */
    readonly source: string,
    readonly model: TableModel,
  ) {
    super();
  }

  eq(other: TableWidget) {
    return other.source === this.source;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const { align, header, rows } = this.model;
    const row = (cells: readonly TableCell[], tag: "th" | "td") => {
      const tr = document.createElement("tr");
      cells.forEach((cell, i) => {
        const el = document.createElement(tag);
        if (align[i]) el.style.textAlign = align[i];
        el.dataset.at = String(cell.cursor);
        renderInlines(view, cell.content, el);
        tr.append(el);
      });
      return tr;
    };
    const head = document.createElement("thead");
    head.append(row(header, "th"));
    const body = document.createElement("tbody");
    for (const r of rows) body.append(row(r, "td"));
    table.append(head, body);
    wrap.append(table);
    // 单击格子：光标放进那一格的原文里（表格随即显示原文）；按住 Ctrl 单击链接时打开它。点在滚动条上照常滚动
    wrap.addEventListener("mousedown", (e) => {
      const target = e.target as HTMLElement;
      const cell = target.closest<HTMLElement>("td, th");
      if (e.button !== 0 || !cell) return;
      e.preventDefault();
      const url = target.closest<HTMLElement>("a[data-url]")?.dataset.url;
      if (e.ctrlKey && url) {
        view.state.facet(linkOpener)?.(url);
        return;
      }
      const pos = Math.min(view.posAtDOM(wrap) + Number(cell.dataset.at), view.state.doc.length);
      view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
      view.focus();
    });
    return wrap;
  }

  // 鼠标在表格上的事件自己处理，编辑器不管（不在这里放光标、不开始拖选）
  ignoreEvent() {
    return true;
  }
}

/** 编辑器有没有焦点、鼠标是不是正按着拖选：字段里看不到，经这两个效果告诉它 */
const setFocused = StateEffect.define<boolean>();
const setDragging = StateEffect.define<boolean>();

interface TablesState {
  tables: TableBlock[];
  focused: boolean;
  dragging: boolean;
  /** 渲染了哪些表格（开头的位置），没变时不重建 */
  shown: string;
  decorations: DecorationSet;
}

function decorate(state: EditorState, tables: TableBlock[], focused: boolean): Pick<TablesState, "shown" | "decorations"> {
  const shown = renderedTables(tables, focused ? state.selection.ranges : null);
  const ranges: Range<Decoration>[] = shown.map((t) =>
    Decoration.replace({ widget: new TableWidget(state.sliceDoc(t.from, t.to), t.model), block: true }).range(t.from, t.to),
  );
  return { shown: shown.map((t) => t.from).join(","), decorations: Decoration.set(ranges) };
}

const tablesField = StateField.define<TablesState>({
  create(state) {
    const tables = tableBlocks(state);
    return { tables, focused: false, dragging: false, ...decorate(state, tables, false) };
  },
  update(value, tr) {
    let { focused, dragging } = value;
    for (const e of tr.effects) {
      if (e.is(setFocused)) focused = e.value;
      if (e.is(setDragging)) dragging = e.value;
    }
    const reparsed = tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state);
    // 按着鼠标拖选时先不切换原文 / 渲染，免得表格在鼠标下面变来变去；松开后再切换
    if (dragging && !reparsed) return { ...value, focused, dragging };
    const tables = reparsed ? tableBlocks(tr.state) : value.tables;
    const next = decorate(tr.state, tables, focused);
    if (!reparsed && next.shown === value.shown) return { ...value, tables, focused, dragging };
    return { tables, focused, dragging, ...next };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

/** 告诉字段编辑器现在有没有焦点（建好时问一次，之后跟着焦点变）、鼠标是不是按着 */
const tableEvents: Extension = [
  EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
  ViewPlugin.define((view) => {
    // 刚建好（或刚切到实时渲染）时不能在这里同步 dispatch
    const timer = setTimeout(() => view.dispatch({ effects: setFocused.of(view.hasFocus) }));
    return { destroy: () => clearTimeout(timer) };
  }),
  EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button !== 0) return false;
      view.dispatch({ effects: setDragging.of(true) });
      const up = () => {
        window.removeEventListener("mouseup", up, true);
        setTimeout(() => view.dom.isConnected && view.dispatch({ effects: setDragging.of(false) }));
      };
      window.addEventListener("mouseup", up, true);
      return false;
    },
  }),
];

/** 实时渲染时的表格（setup.ts 只在实时渲染模式下放进去） */
export const tablePreview: Extension = [tablesField, tableEvents];
