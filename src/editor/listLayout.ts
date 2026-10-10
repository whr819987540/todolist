import { syntaxTree } from "@codemirror/language";
import type { EditorState, Line } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";

// 列表的排版（同 Typora）：每一级列表缩进固定的宽度，列表符号 / 序号 / 任务框放在正文左边的一格里，
// 一项太长自动折行时，折下来的行和第一行的正文开头对齐（悬挂缩进）；列表项里的续行、第二段、代码块对齐到正文。
// 这里只按语法树算出每一行缩进多宽、哪些空白要藏起来、光标不能停在哪里，实时渲染（livePreview.ts）据此加装饰，
// 源码模式（sourceIndent.ts）只用它找出文字从哪里开始。都只改显示，不改文本

/** 排版用的宽度，以编辑区正文字号的 em 计（appearance.ts 用同样的数定 CSS 变量） */
export const INDENT = 2; // 一级缩进（同 Typora，约两个字）
export const TASK = 1.5; // 任务框连同右边的空当
/** 估计序号的宽度：每位数字、". " 各算多宽。宁宽勿窄：序号靠右放，多出来的空在左边看不出 */
const DIGIT = 0.65;
const NUMBER_GAP = 0.6;

export interface TextRange {
  from: number;
  to: number;
}

/** 列表项第一行的列表符号 */
export interface ListMarker {
  /** 列表符号（- * + 或 1. 1)） */
  from: number;
  to: number;
  ordered: boolean;
  /** 任务框 [ ] / [x]（from–to 是方括号）和这一项的整段文字（做完的划掉） */
  task: { from: number; to: number; checked: boolean; textTo: number } | null;
  /** 正文开头：列表符号（和任务框）后面的空格之后 */
  contentFrom: number;
  /** 嵌在几层无序列表里（0 起），决定符号的样子 */
  bulletLevel: number;
  /** 放列表符号 / 序号的那一格有多宽（em）：一级缩进；有序列表里有三位数以上的序号时，整个列表一起加宽到放得下 */
  slot: number;
  /** 这一项整段划掉了，列表符号 / 序号连同后面的空当也画上删除线（见 struckThrough） */
  struck: boolean;
}

export interface ListLine {
  /** 行首要藏起来的缩进（引用标记 > 后面的那一个空格归引用，不在这里） */
  hidden: TextRange[];
  /** 列表项第一行开头的列表符号，外层在前：同一行里套着子项（如 "- - 甲"）时不止一个；其他行为空 */
  markers: ListMarker[];
  /** 文字从哪里开始：第一行是正文开头，其他行是行首的空白和引用标记之后 */
  textFrom: number;
  /** 左边距（em）：引用外面的那几级，引用的竖线、代码块的底色跟着往右移 */
  margin: number;
  /** 引用竖线右边、第一行的列表符号（其他行是文字）前面的缩进（em）：引用里面的那几级 */
  inner: number;
  /** 第一行开头那几格一共多宽（em）：列表符号 / 序号，有序任务再加上任务框；其他行为 0 */
  hang: number;
  /** 其他行多缩进的宽度（em）：有序任务的正文从任务框后面开始，这一项的续行、第二段、代码块也对齐到那里 */
  extra: number;
  /** 列表项的内容从引用开始（"- > 引用"）：这个 > 连同后面的空格。第一行的引用竖线画在列表符号那一格后面 */
  quoteMark: TextRange | null;
  /** 这一行在代码块里（用等宽字体排） */
  code: boolean;
}

/** 里面的空白原样有意义的块：只藏列表本身的缩进，多出来的留着 */
const LITERAL = new Set(["FencedCode", "CodeBlock", "HTMLBlock"]);

/** CommonMark 的列：制表符跳到下一个 4 的倍数 */
function columnAt(text: string, index: number): number {
  let col = 0;
  for (let i = 0; i < index; i++) col = text[i] === "\t" ? col + 4 - (col % 4) : col + 1;
  return col;
}

/** 列表符号后面正文开始的位置（不含任务框）：符号后面 1–4 格空白；没有正文或空了 5 格以上时算一格 */
function afterMark(state: EditorState, mark: SyntaxNode): number {
  const line = state.doc.lineAt(mark.from);
  const at = mark.to - line.from;
  const space = /^[ \t]*/.exec(line.text.slice(at))![0];
  const width = columnAt(line.text, at + space.length) - columnAt(line.text, at);
  const gap = space.length && width <= 4 && at + space.length < line.text.length ? space.length : Math.min(space.length, 1);
  return mark.to + gap;
}

/** 列表项正文所在的列：续行缩进到这里才算这一项的 */
function contentCol(state: EditorState, item: SyntaxNode): number {
  const mark = item.getChild("ListMark");
  const line = state.doc.lineAt(item.from);
  return columnAt(line.text, (mark ? afterMark(state, mark) : item.from + 2) - line.from);
}

/** 各个有序列表里序号最多几位（同一棵语法树里按列表的位置记下，不用每行都数一遍） */
const digitCache = new WeakMap<Tree, Map<number, number>>();

/** 列表项所在的列表那一格多宽（em） */
function slotOf(item: SyntaxNode, tree: Tree): number {
  const list = item.parent;
  if (list?.name !== "OrderedList") return INDENT;
  let cache = digitCache.get(tree);
  if (!cache) digitCache.set(tree, (cache = new Map()));
  let digits = cache.get(list.from);
  if (digits === undefined) {
    digits = 0;
    for (let c = list.firstChild; c; c = c.nextSibling) {
      const mark = c.name === "ListItem" ? c.getChild("ListMark") : null;
      if (mark) digits = Math.max(digits, mark.to - mark.from - 1);
    }
    cache.set(list.from, digits);
  }
  return Math.max(INDENT, digits * DIGIT + NUMBER_GAP);
}

/**
 * 列表项开头的那一段整段划掉了：这一段里不是空白的字都在 ~~…~~ 里（几段 ~~…~~ 之间只隔着空白也算；
 * 续行行首的引用标记 > 不算），列表符号就一起划掉，看上去像 ~~9. 甲~~。只划掉一部分、~~…~~ 外面还有别的字
 * （包括 *、[ ] 这类标记）的不算；开头不是段落的（标题、代码块等）和任务列表的项不算（任务框是控件，不画删除线）。
 * 只看开头这一段：后面的段落、子项划没划掉不管
 */
function struckThrough(state: EditorState, mark: SyntaxNode): boolean {
  const para = mark.nextSibling;
  if (para?.name !== "Paragraph") return false;
  // 划掉的范围和引用标记：嵌在别的格式里的 ~~…~~ 外面总还有那个格式的标记，只看直接的子节点就够了
  const covered: TextRange[] = [];
  let struck = false;
  for (let c = para.firstChild; c; c = c.nextSibling) {
    if (c.name === "Strikethrough") struck = true;
    if (c.name === "Strikethrough" || c.name === "QuoteMark") covered.push({ from: c.from, to: c.to });
  }
  if (!struck) return false;
  const text = state.sliceDoc(para.from, para.to);
  let at = 0;
  for (const c of covered) {
    if (/\S/.test(text.slice(at, c.from - para.from))) return false;
    at = c.to - para.from;
  }
  return !/\S/.test(text.slice(at));
}

function markerOf(state: EditorState, item: SyntaxNode, tree: Tree): ListMarker | null {
  const mark = item.getChild("ListMark");
  if (!mark) return null;
  const ordered = item.parent?.name === "OrderedList";
  const taskNode = mark.nextSibling?.name === "Task" ? mark.nextSibling : null;
  const box = taskNode?.firstChild?.name === "TaskMarker" ? taskNode.firstChild : null;
  let contentFrom = afterMark(state, mark);
  let task: ListMarker["task"] = null;
  if (taskNode && box && box.from === contentFrom) {
    contentFrom = box.to + (state.sliceDoc(box.to, box.to + 1) === " " ? 1 : 0);
    task = { from: box.from, to: box.to, checked: /x/i.test(state.sliceDoc(box.from, box.to)), textTo: taskNode.to };
  }
  let bulletLevel = 0;
  for (let p = item.parent?.parent; p; p = p.parent) if (p.name === "BulletList") bulletLevel++;
  const struck = !task && struckThrough(state, mark);
  return { from: mark.from, to: mark.to, ordered, task, contentFrom, bulletLevel, slot: slotOf(item, tree), struck };
}

/** 列表项的正文紧接着从 types 这种块开始（同一行）时返回这个块 */
function startsWith(state: EditorState, item: SyntaxNode, types: string[]): SyntaxNode | null {
  const mark = item.getChild("ListMark");
  const next = mark?.nextSibling;
  return mark && next && types.includes(next.name) && next.from === afterMark(state, mark) ? next : null;
}

/**
 * line 在列表里时它的排版，不在列表里（包括没缩进到列表正文的懒续行）时为 null。
 * 懒续行（前一行的段落接着写、没缩进）按它自己的缩进放：缩进到哪一级列表的正文就对齐到那一级，一点没缩进的不动
 */
export function listLine(state: EditorState, line: Line, tree: Tree = syntaxTree(state)): ListLine | null {
  const { text } = line;
  // 行首的空白和引用标记之后
  const s = /^[ \t>]*/.exec(text)![0].length;
  const blank = s === text.length;
  const node = tree.resolveInner(line.from + s, 1);

  // 外层到里层的列表项和引用
  let chain: SyntaxNode[] = [];
  let literal = false;
  let code = false;
  for (let n: SyntaxNode | null = node; n; n = n.parent) {
    if (n.name === "ListItem" || n.name === "Blockquote") chain.unshift(n);
    else if (LITERAL.has(n.name)) literal = true;
    if (n.name === "FencedCode" || n.name === "CodeBlock") code = true;
  }
  const items = chain.filter((n) => n.name === "ListItem");
  let own: SyntaxNode | undefined = items[items.length - 1];
  if (!own) return null;
  // 列表项多缩进了几格时 ListItem 从缩进里开始，按列表符号的位置认第一行
  const first = !blank && own.getChild("ListMark")?.from === line.from + s;
  if (!first && !blank) {
    // 懒续行：缩进不到这一项的正文，算外面那一级的（都不到就不算列表里的）
    const col = columnAt(text, s);
    for (let i = items.length - 1; i >= 0 && contentCol(state, items[i]) > col; i--) own = items[i - 1];
    if (!own) return null;
  }
  chain = chain.slice(0, chain.indexOf(own) + 1);

  // 要藏的缩进：行首到正文之间的空白；代码块这类只藏到列表正文的那一列（制表符跨过那一列时不藏，留给代码）
  const limit = literal && !first ? contentCol(state, own) : Infinity;
  const hidden: TextRange[] = [];
  let start = -1;
  const flush = (i: number) => {
    if (start >= 0 && i > start) hidden.push({ from: line.from + start, to: line.from + i });
    start = -1;
  };
  for (let i = 0; i < s; i++) {
    const ch = text[i];
    if (ch === ">" || (ch === " " && text[i - 1] === ">") || columnAt(text, i + 1) > limit) {
      flush(i);
    } else if (start < 0) {
      start = i;
    }
  }
  flush(s);

  // 第一行：这一项的列表符号，和同一行里紧接着套在里面的子项的
  const markers: ListMarker[] = [];
  let innermost = own;
  if (first) {
    for (let item: SyntaxNode | null = own; item; ) {
      const m = markerOf(state, item, tree);
      if (!m) break;
      markers.push(m);
      innermost = item;
      const sub: SyntaxNode | null = m.task ? null : startsWith(state, item, ["BulletList", "OrderedList"]);
      item = sub?.getChild("ListItem") ?? null;
    }
  }

  // 每一级的宽度：引用外面的算左边距，里面的算在引用竖线右边；第一行自己这一级是放列表符号的那一格（悬挂）
  const quote = chain.findIndex((n) => n.name === "Blockquote");
  let margin = 0;
  let inner = 0;
  chain.forEach((n, i) => {
    if (n.name !== "ListItem" || (first && n === own)) return;
    if (quote >= 0 && i > quote) inner += slotOf(n, tree);
    else margin += slotOf(n, tree);
  });
  const last = markers[markers.length - 1];
  let hang = markers.reduce((w, m) => w + m.slot, 0);
  if (last?.ordered && last.task) hang += TASK;
  const ownTask = !first && !!startsWith(state, own, ["Task"]);
  const extra = ownTask && own.parent?.name === "OrderedList" ? TASK : 0;

  // 内容从引用开始的列表项（不在别的引用里时）：第一行的 > 放在列表符号那一格后面
  let quoteMark: TextRange | null = null;
  const quoted = first && quote < 0 ? startsWith(state, innermost, ["Blockquote"]) : null;
  const qm = quoted?.firstChild?.name === "QuoteMark" ? quoted.firstChild : null;
  if (qm) quoteMark = { from: qm.from, to: qm.to + (state.sliceDoc(qm.to, qm.to + 1) === " " ? 1 : 0) };

  const textFrom = quoteMark ? quoteMark.to : last ? last.contentFrom : line.from + s;
  return { hidden, markers, textFrom, margin, inner, hang, extra, quoteMark, code };
}

/**
 * 源码模式里这一行折行后对齐到哪里：行首这一段（空格、>、列表符号、任务框）的原文，和这一行是不是代码
 * （代码用等宽字体排，要按等宽字体量）。不在列表里、没有这一段或后面没有字时为 null
 */
export function sourcePrefix(state: EditorState, line: Line, tree: Tree = syntaxTree(state)): { text: string; code: boolean } | null {
  const l = listLine(state, line, tree);
  if (!l || l.textFrom <= line.from || l.textFrom >= line.to) return null;
  return { text: state.sliceDoc(line.from, l.textFrom), code: l.code };
}

const em = (n: number, extra = "") =>
  n || extra ? `calc(var(--fs-editor) * ${Math.round(n * 1000) / 1000}${extra})` : "0px";

/**
 * 实时渲染里这一行的悬挂缩进，写成 CSS 变量（appearance.ts 的 .cm-md-li、.cm-md-quote、.cm-md-li-qfirst 用）。
 * 内容从引用开始的第一行还要让出引用竖线和它后面的空当（--md-quote-bar、--md-quote-gap），竖线画在 --md-li-qbar 处；
 * --md-li-inner 是引用里面的那几级，显示原文的 > 要越过它们放到引用竖线旁边
 */
export function listLineStyle(l: ListLine): string {
  const bar = l.quoteMark ? " + var(--md-quote-bar)" : "";
  const vars = [
    `--md-li-margin: ${em(l.margin)}`,
    `--md-li-inner: ${em(l.inner)}`,
    `--md-li-pad: ${em(l.inner + l.hang + l.extra, bar)}`,
    `--md-li-hang: ${em(l.hang, l.quoteMark ? `${bar} + var(--md-quote-gap)` : "")}`,
  ];
  if (l.quoteMark) vars.push(`--md-li-qbar: ${em(l.inner + l.hang)}`);
  return vars.join("; ");
}

/** 列表符号的各部分在实时渲染里怎么显示 */
export type MarkerPart = {
  /**
   * bullet：换成符号；number：序号（照原文的数字）；raw：显示原文，仍占那一格；box：复选框；
   * rawBox：有序任务的 [ ] 原文，占任务框那么宽；hide：藏起来；done：做完的任务的文字（划掉、变灰）
   */
  kind: "bullet" | "number" | "raw" | "box" | "rawBox" | "hide" | "done";
  from: number;
  to: number;
};

/**
 * 光标（选区）碰到列表符号时显示原文，否则显示成符号 / 序号 / 复选框。touches(from, to)：选区碰到 [from, to]（含两端）。
 * 无序列表碰到符号（任务碰到符号到任务框）时整个显示原文；有序列表的序号、任务框各管各的。
 * 序号也换成不能编辑的一块（看上去和原文一样）：紧挨着正文的是原文的话，在正文开头用输入法打字，拼音会跑进序号那一格
 */
export function markerParts(m: ListMarker, touches: (from: number, to: number) => boolean): MarkerPart[] {
  const { task } = m;
  const parts: MarkerPart[] = [];
  if (m.ordered) {
    parts.push({ kind: touches(m.from, m.to) ? "raw" : "number", from: m.from, to: task ? task.from : m.contentFrom });
    if (!task) return parts;
    if (touches(task.from, task.to)) {
      parts.push({ kind: "rawBox", from: task.from, to: m.contentFrom });
      return parts;
    }
    parts.push({ kind: "box", from: task.from, to: m.contentFrom });
  } else if (touches(m.from, task ? task.to : m.to)) {
    if (m.contentFrom > m.from) parts.push({ kind: "raw", from: m.from, to: m.contentFrom });
    return parts;
  } else if (task) {
    parts.push({ kind: "hide", from: m.from, to: task.from }, { kind: "box", from: task.from, to: m.contentFrom });
  } else {
    parts.push({ kind: "bullet", from: m.from, to: m.contentFrom });
    return parts;
  }
  if (task.checked && task.textTo > m.contentFrom) parts.push({ kind: "done", from: m.contentFrom, to: task.textTo });
  return parts;
}

/** 行首的引用标记 > 在实时渲染里怎么放 */
export interface QuoteGroup {
  /** 这几个 > 连同它们后面的空格 */
  from: number;
  to: number;
  /** 有几个 > */
  count: number;
  /**
   * gutter：行首连着的几个（>> 和 > > 都算），显示原文时放在引用竖线右边的空当里，空当按个数加宽；
   * inner：列表项里的引用（在藏起来的列表缩进后面），显示原文时挂在左边列表缩进的空白里
   */
  kind: "gutter" | "inner";
}

/** 行首的 >，按中间隔没隔着藏起来的列表缩进分成几组；hidden 是这一行藏起来的缩进（listLine 的） */
export function quoteGroups(state: EditorState, line: Line, tree: Tree, hidden: readonly TextRange[]): QuoteGroup[] {
  const s = /^[ \t>]*/.exec(line.text)![0].length;
  if (!line.text.slice(0, s).includes(">")) return [];
  const groups: QuoteGroup[] = [];
  tree.iterate({
    from: line.from,
    to: line.from + s,
    enter: (n) => {
      if (n.name !== "QuoteMark" || n.from >= line.from + s) return;
      const to = n.to + (state.sliceDoc(n.to, n.to + 1) === " " ? 1 : 0);
      const last = groups[groups.length - 1];
      if (last && !hidden.some((h) => h.from >= last.to && h.to <= n.from)) {
        last.to = to;
        last.count++;
      } else {
        groups.push({ from: n.from, to, count: 1, kind: groups.length ? "inner" : "gutter" });
      }
    },
  });
  return groups;
}

/**
 * 实时渲染里光标不能停的地方。zones：行首藏起来的缩进，[from, to) 都不停（停在缩进前面看上去和后面一样，
 * 在那里打字会把列表项拆坏）；atoms：显示成一整块的 >，(from, to) 里面不停
 */
export function caretStops(state: EditorState, line: Line, tree: Tree = syntaxTree(state)) {
  const l = listLine(state, line, tree);
  const hidden = l?.hidden ?? [];
  const atoms: TextRange[] = quoteGroups(state, line, tree, hidden);
  if (l?.quoteMark) atoms.push(l.quoteMark);
  return { zones: hidden, atoms };
}
