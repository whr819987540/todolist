import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  type ChangeSet,
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type Line,
  type SelectionRange,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";

// 编辑快捷键的命令（按键见 editShortcuts.ts）。和 Typora 一样按原文加减 Markdown 标记，
// 只动选中的部分，别处的写法原样不动；实时渲染和源码模式下都能用。
// 返回 true 表示按键已处理（只读、在代码块里等做不了的情况也算，免得落到 CodeMirror 自带的同名按键上）

function tree(state: EditorState, upto: number): Tree {
  return ensureSyntaxTree(state, upto, 50) ?? syntaxTree(state);
}

/** pos 处由内向外的语法节点，两侧都看；同一个节点只给一次 */
function* around(state: EditorState, pos: number): Generator<SyntaxNode> {
  const seen = new Set<string>();
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = tree(state, pos).resolveInner(pos, side); n; n = n.parent) {
      const id = `${n.name}:${n.from}:${n.to}`;
      if (seen.has(id)) continue;
      seen.add(id);
      yield n;
    }
  }
}

/** 包住 [from, to] 的 name 节点；光标（from == to）要在节点里面，碰到两端不算 */
function enclosing(state: EditorState, from: number, to: number, name: string): SyntaxNode | null {
  for (const n of around(state, from)) {
    if (n.name !== name) continue;
    if (from === to ? n.from < from && to < n.to : n.from <= from && to <= n.to) return n;
  }
  return null;
}

function inCodeBlock(state: EditorState, pos: number): boolean {
  for (const n of around(state, pos)) if (n.name === "FencedCode" || n.name === "CodeBlock") return true;
  return false;
}

/** 要删掉的一段原文 */
type Span = { from: number; to: number };

/** 做不了修改的时候：只读，或（段落、格式命令）光标在代码块里 */
const blocked = (state: EditorState) => state.readOnly || inCodeBlock(state, state.selection.main.head);

/** 把选区映射到改动之后，两端尽量留在插入的标记里面（光标不会跑到新加的 ** 外面） */
function mapInside(r: SelectionRange, set: ChangeSet): SelectionRange {
  const from = set.mapPos(r.from, 1);
  const to = Math.max(from, set.mapPos(r.to, -1));
  return r.anchor <= r.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
}

/** 把选区映射到改动之后：贴着选区两端插入的标记算进选区（从行首选起时连同新加的 > 一起选中），光标放在插入的标记后面 */
function mapAround(r: SelectionRange, set: ChangeSet): SelectionRange {
  if (r.empty) return EditorSelection.cursor(set.mapPos(r.head, 1));
  const from = set.mapPos(r.from, -1);
  const to = set.mapPos(r.to, 1);
  return r.anchor <= r.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
}

/** 按位置排序，去掉重复、重叠的 */
function uniqueSpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const c of [...spans].sort((x, y) => x.from - y.from)) {
    if (!out.length || c.from >= out[out.length - 1].to) out.push(c);
  }
  return out;
}

/** 段落命令：改的是行首的块标记 */
function dispatchChanges(view: EditorView, changes: ChangeSpec[]) {
  const { state } = view;
  const set = state.changes(changes);
  view.dispatch({
    changes: set,
    selection: EditorSelection.create(
      state.selection.ranges.map((r) => mapAround(r, set)),
      state.selection.mainIndex,
    ),
    scrollIntoView: true,
    userEvent: "input",
  });
}

/** 选区覆盖的各行，按顺序、不重复；选区结束在某行行首时不算那一行 */
export function selectedLines(state: EditorState): Line[] {
  const { doc } = state;
  const lines: Line[] = [];
  let last = 0;
  for (const r of state.selection.ranges) {
    const end = r.to > r.from && doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to;
    for (let n = Math.max(doc.lineAt(r.from).number, last + 1); n <= doc.lineAt(end).number; n++) {
      lines.push(doc.line(n));
      last = n;
    }
  }
  return lines;
}

/** 行首的块标记：引用 >、缩进、列表符号（及任务框）、标题 #，各部分都可以没有 */
const PREFIX = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:([-+*]|\d{1,9}[.)])([ \t]+|$)(\[[ xX]\](?:[ \t]+|$))?)?(#{1,6}(?:[ \t]+|$))?/;

interface Prefix {
  quote: string;
  indent: string;
  /** 列表符号连同后面的空格，如 "- "、"1. " */
  marker: string;
  ordered: boolean;
  task: string;
  heading: string;
  /** 块标记到哪里为止 */
  length: number;
}

function prefix(text: string): Prefix {
  const m = PREFIX.exec(text)!;
  return {
    quote: m[1],
    indent: m[2],
    marker: m[3] ? m[3] + m[4] : "",
    ordered: !!m[3] && /\d/.test(m[3]),
    task: m[5] ?? "",
    heading: m[6] ?? "",
    length: m[0].length,
  };
}

// ---- 行内格式 ----

type InlineStyle = "bold" | "italic" | "strike" | "code" | "underline";

const STYLES: Record<InlineStyle, { node: string | null; open: string; close: string }> = {
  bold: { node: "StrongEmphasis", open: "**", close: "**" },
  italic: { node: "Emphasis", open: "*", close: "*" },
  strike: { node: "Strikethrough", open: "~~", close: "~~" },
  code: { node: "InlineCode", open: "`", close: "`" },
  // Markdown 没有下划线，Typora 用 HTML 标签
  underline: { node: null, open: "<u>", close: "</u>" },
};

/** 节点首尾的标记（**、~~、` 等），删掉它们就去掉了这个格式 */
function edgeMarks(node: SyntaxNode): Span[] {
  const out: Span[] = [];
  const first = node.firstChild;
  const last = node.lastChild;
  if (first && first.from === node.from && first.name.endsWith("Mark")) out.push({ from: first.from, to: first.to });
  if (last && last !== first && last.to === node.to && last.name.endsWith("Mark")) {
    out.push({ from: last.from, to: last.to });
  }
  return out;
}

/** 同一行里包住 [from, to] 的 <u>…</u> 的两个标签 */
function underlineAround(state: EditorState, from: number, to: number): Span[] | null {
  const line = state.doc.lineAt(from);
  if (to > line.to) return null;
  const text = line.text.toLowerCase();
  const a = from - line.from;
  const b = to - line.from;
  // 选中的正好是 <u>…</u>
  if (b - a >= 7 && text.startsWith("<u>", a) && text.slice(0, b).endsWith("</u>")) {
    return [
      { from, to: from + 3 },
      { from: to - 4, to },
    ];
  }
  if (a < 3) return null;
  const open = text.lastIndexOf("<u>", a - 3);
  if (open < 0 || text.slice(open + 3, a).includes("</u>")) return null;
  const close = text.indexOf("</u>", b);
  if (close < 0 || text.slice(b, close).includes("<u>")) return null;
  return [
    { from: line.from + open, to: line.from + open + 3 },
    { from: line.from + close, to: line.from + close + 4 },
  ];
}

/** [from, to] 在各行上的部分，去掉两头的空白；从行首选起时跳过引用、列表、标题这些块标记 */
function segments(state: EditorState, from: number, to: number): [number, number][] {
  const { doc } = state;
  const out: [number, number][] = [];
  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
    const line = doc.line(n);
    let a = Math.max(from, line.from + prefix(line.text).length);
    let b = Math.min(to, line.to);
    const text = doc.sliceString(a, b);
    a += text.length - text.trimStart().length;
    b -= text.length - text.trimEnd().length;
    if (b > a) out.push([a, b]);
  }
  return out;
}

/**
 * 加上 / 去掉行内格式（同 Typora 的 Ctrl+B 等）：选中的文字（跨行时每行分别看）都已经是这种格式时去掉它，
 * 否则给还不是的加上；光标在这种格式里时去掉它，不在时插入一对标记，光标放在中间
 */
export function toggleInline(view: EditorView, name: InlineStyle): boolean {
  const { state } = view;
  if (blocked(state)) return true;
  const style = STYLES[name];
  /** 包住 [a, b] 的这种格式的标记 */
  const marksAround = (a: number, b: number): Span[] | null => {
    if (!style.node) return underlineAround(state, a, b);
    const node = enclosing(state, a, b, style.node);
    return node ? edgeMarks(node) : null;
  };
  const spec = state.changeByRange((range) => {
    if (range.empty) {
      const marks = marksAround(range.from, range.to);
      if (marks?.length) {
        const set = state.changes(marks);
        return { changes: set, range: mapInside(range, set) };
      }
      return {
        changes: { from: range.from, insert: style.open + style.close },
        range: EditorSelection.cursor(range.from + style.open.length),
      };
    }
    const segs = segments(state, range.from, range.to);
    const found = segs.map(([a, b]) => marksAround(a, b));
    const changes: ChangeSpec[] =
      segs.length && found.every((m) => m?.length)
        ? uniqueSpans(found.flatMap((m) => m ?? []))
        : segs.flatMap(([a, b], i) =>
            found[i]?.length ? [] : [{ from: a, insert: style.open }, { from: b, insert: style.close }],
          );
    const set = state.changes(changes);
    // 从行首（块标记之前）选起的，两端都放在标记外面，整段选中
    const outside = segs.length > 0 && range.from < segs[0][0];
    return { changes: set, range: outside ? mapAround(range, set) : mapInside(range, set) };
  });
  view.dispatch(state.update(spec, { scrollIntoView: true, userEvent: "input" }));
  return true;
}

const URL_TEXT = /^(?:https?:\/\/|mailto:)\S+$/i;

/**
 * 超链接：光标在链接里时去掉链接、只留文字；选中网址时变成 [网址](网址) 并选中前面的文字以便改写；
 * 选中其他文字时变成 [文字]()，光标放在括号里填地址；没有选中时插入 []()
 */
export const toggleLink = (view: EditorView): boolean => {
  const { state } = view;
  if (blocked(state)) return true;
  const spec = state.changeByRange((range) => {
    const link = enclosing(state, range.from, range.to, "Link");
    const [open, close] = link?.getChildren("LinkMark") ?? [];
    if (link && open && close) {
      const set = state.changes([
        { from: open.from, to: open.to },
        { from: close.from, to: link.to },
      ]);
      return { changes: set, range: mapInside(range, set) };
    }
    if (range.empty) {
      return { changes: { from: range.from, insert: "[]()" }, range: EditorSelection.cursor(range.from + 1) };
    }
    const text = state.sliceDoc(range.from, range.to);
    if (URL_TEXT.test(text)) {
      return {
        changes: [
          { from: range.from, insert: "[" },
          { from: range.to, insert: `](${text})` },
        ],
        range: EditorSelection.range(range.from + 1, range.to + 1),
      };
    }
    return {
      changes: [
        { from: range.from, insert: "[" },
        { from: range.to, insert: "]()" },
      ],
      range: EditorSelection.cursor(range.to + 3),
    };
  });
  view.dispatch(state.update(spec, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

/** 清除格式时去掉的 HTML 标签 */
const FORMAT_TAG = /^<\/?(?:u|b|i|em|strong|s|del|strike|ins|mark|sub|sup|small|big|font|span)\b[^>]*>$/i;

/** 去掉 node 这层格式要删的标记；不是格式的返回空 */
function formatMarks(state: EditorState, node: SyntaxNode): Span[] {
  switch (node.name) {
    case "Emphasis":
    case "StrongEmphasis":
    case "Strikethrough":
    case "InlineCode":
    case "Autolink":
      return edgeMarks(node);
    case "Link": {
      // 留下 [ ] 里的文字
      const [open, close] = node.getChildren("LinkMark");
      return open && close
        ? [
            { from: open.from, to: open.to },
            { from: close.from, to: node.to },
          ]
        : [];
    }
    case "HTMLTag":
      return FORMAT_TAG.test(state.sliceDoc(node.from, node.to)) ? [{ from: node.from, to: node.to }] : [];
    default:
      return [];
  }
}

/** 清除格式：去掉选中部分碰到的加粗、斜体、删除线、行内代码、链接和 <u> 等标签；没有选中时去掉光标所在的格式 */
export const clearFormat = (view: EditorView): boolean => {
  const { state } = view;
  if (blocked(state)) return true;
  const spec = state.changeByRange((range) => {
    const found: Span[] = [];
    if (range.empty) {
      for (const n of around(state, range.head)) {
        if (n.from < range.head && range.head < n.to) found.push(...formatMarks(state, n));
      }
    } else {
      tree(state, range.to).iterate({
        from: range.from,
        to: range.to,
        enter: (ref) => {
          if (ref.name === "FencedCode" || ref.name === "CodeBlock") return false;
          if (ref.to > range.from && ref.from < range.to) found.push(...formatMarks(state, ref.node));
          if (ref.name === "InlineCode" || ref.name === "HTMLTag") return false;
        },
      });
    }
    found.push(...(underlineAround(state, range.from, range.to) ?? []));
    // 同一处可能找到两次（<u> 标签）
    const set = state.changes(uniqueSpans(found));
    return { changes: set, range: mapInside(range, set) };
  });
  view.dispatch(state.update(spec, { scrollIntoView: true, userEvent: "delete" }));
  return true;
};

// ---- 段落 ----

/** 把选中各行的标题级别换成 pick 给的（0 是正文），标题标记写在引用、列表符号之后 */
function changeHeadings(view: EditorView, pick: (level: number, levels: number[]) => number): boolean {
  const { state } = view;
  if (blocked(state)) return true;
  let lines = selectedLines(state);
  if (lines.length > 1) lines = lines.filter((l) => l.text.trim());
  const parsed = lines.map((line) => ({ line, p: prefix(line.text) }));
  const levels = parsed.map(({ p }) => p.heading.trim().length);
  const changes: ChangeSpec[] = [];
  parsed.forEach(({ line, p }, i) => {
    const next = pick(levels[i], levels);
    if (next === levels[i]) return;
    const from = line.from + p.quote.length + p.indent.length + p.marker.length + p.task.length;
    changes.push({ from, to: from + p.heading.length, insert: next ? `${"#".repeat(next)} ` : "" });
  });
  dispatchChanges(view, changes);
  return true;
}

/** Ctrl+1~6：变成对应级别的标题；已经都是这一级时变回正文 */
export const setHeading = (view: EditorView, level: number) =>
  changeHeadings(view, (_cur, levels) => (levels.every((l) => l === level) ? 0 : level));

/** Ctrl+0：变回正文 */
export const setParagraph = (view: EditorView) => changeHeadings(view, () => 0);

/** Ctrl+=：提升一级（正文 → 标题 6 → … → 标题 1） */
export const headingUp = (view: EditorView) => changeHeadings(view, (l) => (l === 0 ? 6 : Math.max(1, l - 1)));

/** Ctrl+-：降低一级（标题 1 → … → 标题 6 → 正文） */
export const headingDown = (view: EditorView) => changeHeadings(view, (l) => (l === 0 || l === 6 ? 0 : l + 1));

const QUOTED = /^([ \t]{0,3})>[ \t]?/;

/** 引用：选中的各行都已是引用时去掉一层 >，否则每行加一层 */
export const toggleQuote = (view: EditorView): boolean => {
  const { state } = view;
  if (blocked(state)) return true;
  const lines = selectedLines(state);
  const filled = lines.filter((l) => l.text.trim());
  const changes: ChangeSpec[] = [];
  if (filled.length && filled.every((l) => QUOTED.test(l.text))) {
    for (const l of lines) {
      const m = QUOTED.exec(l.text);
      if (m) changes.push({ from: l.from + m[1].length, to: l.from + m[0].length });
    }
  } else {
    for (const l of lines) changes.push({ from: l.from, insert: l.text.trim() || lines.length === 1 ? "> " : ">" });
  }
  dispatchChanges(view, changes);
  return true;
};

/**
 * 有序 / 无序列表：选中的各行都已是这种列表时去掉列表符号（连同任务框），变回正文；
 * 否则换成这种列表（任务框保留），有序列表从 1 编号，紧接在同级有序列表后面时接着它编号
 */
export function toggleList(view: EditorView, ordered: boolean): boolean {
  const { state } = view;
  if (blocked(state)) return true;
  let lines = selectedLines(state);
  if (lines.length > 1) lines = lines.filter((l) => l.text.trim());
  const parsed = lines.map((line) => ({ line, p: prefix(line.text) }));
  const changes: ChangeSpec[] = [];
  const markerFrom = (line: Line, p: Prefix) => line.from + p.quote.length + p.indent.length;
  if (parsed.length && parsed.every(({ p }) => p.marker && p.ordered === ordered)) {
    for (const { line, p } of parsed) {
      const from = markerFrom(line, p);
      changes.push({ from, to: from + p.marker.length + p.task.length });
    }
  } else {
    let n = 1;
    const first = parsed[0];
    if (ordered && first && first.line.number > 1) {
      const above = prefix(state.doc.line(first.line.number - 1).text);
      const num = parseInt(above.marker, 10);
      if (above.ordered && above.quote === first.p.quote && above.indent === first.p.indent) n = num + 1;
    }
    for (const { line, p } of parsed) {
      const from = markerFrom(line, p);
      changes.push({ from, to: from + p.marker.length, insert: ordered ? `${n++}. ` : "- " });
    }
  }
  dispatchChanges(view, changes);
  return true;
}

/** 光标所在的围栏代码块 */
function fencedCodeAt(state: EditorState, pos: number): SyntaxNode | null {
  for (const n of around(state, pos)) if (n.name === "FencedCode") return n;
  return null;
}

/**
 * 代码块：光标在代码块里时去掉上下的 ``` 两行、留下代码；否则用 ``` 把选中的各行包起来，
 * 空行上直接变成一个空代码块，光标放在里面
 */
export const toggleCodeBlock = (view: EditorView): boolean => {
  const { state } = view;
  if (state.readOnly) return true;
  const { doc } = state;
  const block = fencedCodeAt(state, state.selection.main.head);
  if (block) {
    const open = doc.lineAt(block.from);
    const marks = block.getChildren("CodeMark");
    const closeLine = marks.length > 1 ? doc.lineAt(marks[marks.length - 1].from) : null;
    const close = closeLine && closeLine.number > open.number ? closeLine : null;
    const changes: ChangeSpec[] =
      close && close.number === open.number + 1
        ? [{ from: open.from, to: close.to }]
        : [
            { from: open.from, to: Math.min(open.to + 1, doc.length) },
            ...(close ? [{ from: close.from - 1, to: close.to }] : []),
          ];
    dispatchChanges(view, changes);
    return true;
  }
  const main = state.selection.main;
  const first = doc.lineAt(main.from);
  const last = doc.lineAt(main.to > main.from && doc.lineAt(main.to).from === main.to ? main.to - 1 : main.to);
  const indent = /^[ \t]*/.exec(first.text)![0];
  if (first.number === last.number && !first.text.trim()) {
    const insert = `${indent}\`\`\`\n${indent}\n${indent}\`\`\``;
    view.dispatch({
      changes: { from: first.from, to: first.to, insert },
      selection: EditorSelection.cursor(first.from + indent.length * 2 + 4),
      scrollIntoView: true,
      userEvent: "input",
    });
    return true;
  }
  const set = state.changes([
    { from: first.from, insert: `${indent}\`\`\`\n` },
    { from: last.to, insert: `\n${indent}\`\`\`` },
  ]);
  view.dispatch({
    changes: set,
    selection: EditorSelection.create([mapInside(main, set)]),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
};

// ---- 选择与删除 ----

let segmenter: Intl.Segmenter | null = null;

/** pos 处的词：中文按词典分词（同双击选词），光标在两个词中间时取前面那个 */
function wordAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  const col = pos - line.from;
  segmenter ??= new Intl.Segmenter("zh-CN", { granularity: "word" });
  let at: Intl.SegmentData | null = null;
  let before: Intl.SegmentData | null = null;
  for (const s of segmenter.segment(line.text)) {
    if (s.index > col) break;
    const end = s.index + s.segment.length;
    if (col < end) at = s;
    else if (end === col) before = s;
  }
  const pick = at?.isWordLike ? at : before?.isWordLike ? before : (at ?? before);
  return pick ? { from: line.from + pick.index, to: line.from + pick.index + pick.segment.length } : null;
}

/** 选中光标所在的词；已经选中了文字时不变 */
export const selectWord = (view: EditorView): boolean => {
  const { state } = view;
  const ranges = state.selection.ranges.map((r) => {
    const w = r.empty ? wordAt(state, r.head) : null;
    return w ? EditorSelection.range(w.from, w.to) : r;
  });
  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
};

/** 删除光标所在的词；选中了文字时删除选中的 */
export const deleteWord = (view: EditorView): boolean => {
  const { state } = view;
  if (state.readOnly) return true;
  const spec = state.changeByRange((r) => {
    const w = r.empty ? wordAt(state, r.head) : r;
    if (!w || w.from === w.to) return { range: r };
    return { changes: { from: w.from, to: w.to }, range: EditorSelection.cursor(w.from) };
  });
  view.dispatch(state.update(spec, { scrollIntoView: true, userEvent: "delete" }));
  return true;
};

/** 选中光标所在的行（不含换行）；已经选中整行时再往下多选一行 */
export const selectLine = (view: EditorView): boolean => {
  const { state } = view;
  const { doc } = state;
  const ranges = state.selection.ranges.map((r) => {
    const first = doc.lineAt(r.from);
    const last = doc.lineAt(r.to);
    const whole = r.from === first.from && r.to === last.to && (!r.empty || !first.length);
    const end = whole && last.number < doc.lines ? doc.line(last.number + 1) : last;
    return EditorSelection.range(first.from, end.to);
  });
  view.dispatch({
    selection: EditorSelection.create(ranges, state.selection.mainIndex),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
};
