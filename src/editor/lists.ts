import { indentLess, indentMore } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { ChangeSpec, EditorState } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { selectedLines } from "./formatting";

// 列表缩进（同 Typora）：光标（选区）在列表项里时，Tab / Ctrl+] 把这一项连同它的子项缩进成上一项的子项，
// Shift+Tab / Ctrl+[ 提到上一级；有序列表跟着重新编号。不在列表里时 Tab 仍是插入两个空格

function fullTree(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
}

/** 行首的引用标记 */
const QUOTE = /^(?:[ \t]*>[ \t]?)*/;

const quoteLength = (text: string) => QUOTE.exec(text)![0].length;

/** 行里引用标记之后第一个非空白字符的位置；空行返回 null */
function contentStart(text: string): number | null {
  const q = quoteLength(text);
  const m = /\S/.exec(text.slice(q));
  return m ? q + m.index : null;
}

/** pos 所在的列表项；在列表项里的代码块中时返回 null（那里 Tab 用来缩进代码） */
function itemAt(tree: Tree, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock") return null;
    if (n.name === "ListItem") return n;
  }
  return null;
}

function siblingItem(item: SyntaxNode, dir: 1 | -1): SyntaxNode | null {
  let s = dir > 0 ? item.nextSibling : item.prevSibling;
  while (s && s.name !== "ListItem") s = dir > 0 ? s.nextSibling : s.prevSibling;
  return s;
}

/** 列表符号所在的列（从行首算，含引用标记） */
function markCol(state: EditorState, item: SyntaxNode): number {
  const from = item.getChild("ListMark")?.from ?? item.from;
  return from - state.doc.lineAt(from).from;
}

/** 子项的列表符号要对齐到的列：列表符号后面正文开始的地方 */
function contentCol(state: EditorState, item: SyntaxNode): number {
  const mark = item.getChild("ListMark");
  if (!mark) return markCol(state, item) + 2;
  const line = state.doc.lineAt(mark.from);
  const after = line.text.slice(mark.to - line.from);
  const spaces = /^ */.exec(after)![0].length;
  // 符号后面空了 5 格以上时正文算缩进代码，子项只要比符号多一格
  const gap = spaces >= 1 && spaces <= 4 && after.length > spaces ? spaces : 1;
  return mark.to - line.from + gap;
}

/** 有序列表项的序号 */
function itemNumber(state: EditorState, item: SyntaxNode) {
  const mark = item.getChild("ListMark");
  if (!mark) return null;
  const value = parseInt(state.sliceDoc(mark.from, mark.to - 1), 10);
  return Number.isNaN(value) ? null : { from: mark.from, to: mark.to - 1, value };
}

/**
 * 有序列表从 item 起重新编号：item 接在前一项后面（它是第一项时为 1），后面原本连续编号的各项跟着改；
 * 碰到不连续的（如全写成 1.）就停下，不动别处的写法
 */
function renumberFrom(state: EditorState, item: SyntaxNode, out: Map<number, ChangeSpec>) {
  if (item.parent?.name !== "OrderedList") return;
  const prev = siblingItem(item, -1);
  let next = prev ? (itemNumber(state, prev)?.value ?? 0) + 1 : 1;
  let old: number | null = null;
  for (let n: SyntaxNode | null = item; n; n = siblingItem(n, 1)) {
    const num = itemNumber(state, n);
    if (!num || (old !== null && num.value !== old + 1)) break;
    old = num.value;
    if (num.value !== next) out.set(num.from, { from: num.from, to: num.to, insert: String(next) });
    next++;
  }
}

/**
 * 缩进（dir = 1）/ 提到上一级（dir = -1）选中的列表项，子项跟着一起移；列表的第一项不能再缩进，最外层不能再提。
 * 光标不在列表项里时返回 false
 */
export function indentListItems(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const { doc } = state;
  const tree = fullTree(state);
  const found: SyntaxNode[] = [];
  for (const line of selectedLines(state)) {
    const col = contentStart(line.text);
    const item = col == null ? null : itemAt(tree, line.from + col);
    if (item && !found.some((f) => f.from === item.from)) found.push(item);
  }
  if (!found.length) return false;
  if (state.readOnly) return true;

  // 只移最外层的，子项跟着父项走
  const isFound = (n: SyntaxNode) => found.some((f) => f.from === n.from && f.to === n.to);
  const tops = found
    .filter((it) => {
      for (let p = it.parent; p; p = p.parent) if (p.name === "ListItem" && isFound(p)) return false;
      return true;
    })
    .sort((a, b) => a.from - b.from);
  const first = tops[0];
  const last = tops[tops.length - 1];

  let target: number;
  if (dir > 0) {
    const prev = siblingItem(first, -1);
    if (!prev) return true;
    target = contentCol(state, prev);
  } else {
    const parent = first.parent?.parent;
    target = parent?.name === "ListItem" ? markCol(state, parent) : quoteLength(doc.lineAt(first.from).text);
  }
  const delta = target - markCol(state, first);
  if (delta === 0 || (delta > 0) !== (dir > 0)) return true;

  const changes: ChangeSpec[] = [];
  for (let n = doc.lineAt(first.from).number; n <= doc.lineAt(last.to).number; n++) {
    const line = doc.line(n);
    if (contentStart(line.text) == null) continue;
    const at = line.from + quoteLength(line.text);
    if (delta > 0) {
      changes.push({ from: at, insert: " ".repeat(delta) });
    } else {
      const remove = Math.min(/^ */.exec(doc.sliceString(at, line.to))![0].length, -delta);
      if (remove) changes.push({ from: at, to: at + remove });
    }
  }
  const moved = state.changes(changes);

  // 有序列表重新编号：移过去的那几项接在新位置的前一项后面；原来跟在它们后面的，接在原来的前一项后面
  const after = state.update({ changes: moved }).state;
  const afterTree = fullTree(after);
  const renumber = new Map<number, ChangeSpec>();
  // 原来后面那项和移走的不是连续编号（如全写成 1.）时不管它
  const following = siblingItem(last, 1);
  const lastNum = itemNumber(state, last);
  const next = following && lastNum && itemNumber(state, following)?.value === lastNum.value + 1 ? following : null;
  for (const item of [first, next]) {
    const mark = item?.getChild("ListMark");
    const now = mark && itemAt(afterTree, moved.mapPos(mark.from, 1));
    if (now) renumberFrom(after, now, renumber);
  }
  const all = moved.compose(after.changes([...renumber.values()]));
  view.dispatch({
    changes: all,
    selection: state.selection.map(all, 1),
    scrollIntoView: true,
    userEvent: dir > 0 ? "indent.more" : "indent.less",
  });
  return true;
}

/** Tab 插入两个空格；选中多行时整体缩进。只读时什么也不做，但同样不让焦点跳出编辑器 */
export const insertTab: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return true;
  if (state.selection.ranges.some((r) => !r.empty)) return indentMore(view);
  view.dispatch(state.update(state.replaceSelection("  "), { scrollIntoView: true, userEvent: "input" }));
  return true;
};

/** Tab / Ctrl+]：在列表里缩进列表项；不在列表里时 Tab 插入两个空格，Ctrl+] 缩进所在的行 */
export const indent = (view: EditorView, key: string) =>
  indentListItems(view, 1) || (key === "Tab" ? insertTab(view) : view.state.readOnly || indentMore(view));

/** Shift+Tab / Ctrl+[：在列表里把列表项提到上一级；不在列表里时减少所在行的缩进 */
export const outdent = (view: EditorView) => indentListItems(view, -1) || view.state.readOnly || indentLess(view);
