import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { caretStops } from "./listLayout";

// 实时渲染里光标不停在看不见、或看上去在别处的地方（listLayout.ts 的 caretStops）：
// 行首藏起来的缩进前面和里面都不停（停在后面，即列表符号前面），显示成一整块的 > 里面不停。
// 只管光标的移动和点击；删除照常一格一格地删，文本不改

/** pos 落在不能停的地方时挪到哪里：dir 是移动的方向（-1 往前，1 往后，0 点击这类看哪头近） */
export function caretTarget(state: EditorState, pos: number, dir: -1 | 0 | 1): number {
  const { zones, atoms } = caretStops(state, state.doc.lineAt(pos), syntaxTree(state));
  for (const z of zones) if (pos >= z.from && pos < z.to) return z.to;
  for (const a of atoms) {
    if (pos > a.from && pos < a.to) return dir < 0 ? a.from : dir > 0 ? a.to : pos - a.from <= a.to - pos ? a.from : a.to;
  }
  return pos;
}

/** 方向键、Home、点击、拖选落到不能停的地方时挪开 */
export const keepCaretVisible = EditorState.transactionFilter.of((tr) => {
  const event = tr.annotation(Transaction.userEvent);
  if (!tr.selection || tr.docChanged || (event !== "select" && event !== "select.pointer")) return tr;
  const state = tr.startState;
  let moved = false;
  const ranges = tr.selection.ranges.map((r, i) => {
    const old = (state.selection.ranges[i] ?? state.selection.main).head;
    const dir = event === "select.pointer" ? 0 : r.head < old ? -1 : r.head > old ? 1 : 0;
    const head = caretTarget(state, r.head, dir);
    const anchor = r.empty ? head : event === "select.pointer" ? caretTarget(state, r.anchor, 0) : r.anchor;
    if (head === r.head && anchor === r.anchor) return r;
    moved = true;
    return EditorSelection.range(anchor, head);
  });
  return moved ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex), sequential: true }] : tr;
});

/**
 * ←（Ctrl+← 同样）在行首藏起来的缩进后面、列表符号前面时：一下跳过缩进到上一行末尾（缩进前面在引用标记后面时，
 * 跳到引用标记前面），不停在缩进前面。extend：Shift 选择。不在这种地方时返回 false，照常移动
 */
export function leftOverIndent(view: EditorView, extend: boolean): boolean {
  const { state } = view;
  if (state.selection.ranges.length > 1) return false;
  const r = state.selection.main;
  if (!extend && !r.empty) return false;
  const line = state.doc.lineAt(r.head);
  const zone = caretStops(state, line, syntaxTree(state)).zones.find((z) => z.to === r.head);
  if (!zone) return false;
  let target = zone.from === line.from ? line.from - 1 : caretTarget(state, zone.from - 1, -1);
  if (target < 0) target = r.head;
  view.dispatch({
    selection: extend ? EditorSelection.range(r.anchor, target) : EditorSelection.cursor(target),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}
