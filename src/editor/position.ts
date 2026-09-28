import type { Extension, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** 正文里的一个位置（字符偏移），连同它前后的一段原文：正文在外部被改过时按原文找回 */
export interface TextAnchor {
  pos: number;
  before: string;
  after: string;
}

/** 编辑位置：光标，以及编辑区滚动到了哪里 */
export interface EditPosition {
  cursor: TextAnchor;
  /** 可见区域顶部的那一行，top 是这一行离可见区域顶部的距离（px，一般 ≤ 0） */
  view: TextAnchor & { top: number };
}

/** 前后各记多少个字符 */
const CONTEXT = 32;
/** 只拿一侧（或两侧都截短）的原文去找时，至少要这么长，太短容易对到别处 */
const MIN_CONTEXT = 8;

export function capturePosition(view: EditorView): EditPosition {
  const { doc } = view.state;
  const anchor = (pos: number): TextAnchor => ({
    pos,
    before: doc.sliceString(Math.max(0, pos - CONTEXT), pos),
    after: doc.sliceString(pos, Math.min(doc.length, pos + CONTEXT)),
  });
  const scroller = view.scrollDOM.getBoundingClientRect();
  const content = view.contentDOM.getBoundingClientRect();
  // 可见区域顶部那一行（长段落折成多行时是其中的那一行）的开头
  const top = view.posAtCoords({ x: content.left + 1, y: Math.max(scroller.top, content.top) + 1 }, false);
  const lineTop = view.coordsAtPos(top)?.top ?? scroller.top;
  return {
    cursor: anchor(view.state.selection.main.head),
    view: { ...anchor(top), top: Math.round(lineTop - scroller.top) },
  };
}

/**
 * 在（可能被外部改过的）正文里找回一个位置：原处前后的原文没变就还在原处；变了就找这段原文现在在哪，
 * 有多处时取离原位置最近的——先找两侧都对得上的，再把两侧截短、只用一侧。都找不到（外部大改过）返回 null
 */
export function locateAnchor(doc: string, a: TextAnchor): number | null {
  const { pos, before, after } = a;
  if (pos >= before.length && pos <= doc.length && doc.startsWith(before, pos - before.length) && doc.startsWith(after, pos))
    return pos;
  // [要找的原文, 位置在其中的偏移]
  const tries: [string, number][] = [];
  for (const n of [CONTEXT, CONTEXT / 2]) {
    const b = before.slice(-n);
    const f = after.slice(0, n);
    if (b.length + f.length >= MIN_CONTEXT) tries.push([b + f, b.length]);
  }
  if (before.length >= MIN_CONTEXT) tries.push([before, before.length]);
  if (after.length >= MIN_CONTEXT) tries.push([after, 0]);
  for (const [text, offset] of tries) {
    const at = nearest(doc, text, pos - offset);
    if (at != null) return at + offset;
  }
  return null;
}

/** text 在 doc 里离 near 最近的一处 */
function nearest(doc: string, text: string, near: number): number | null {
  let best: number | null = null;
  for (let i = doc.indexOf(text); i >= 0; i = doc.indexOf(text, i + 1)) {
    if (best == null || Math.abs(i - near) < Math.abs(best - near)) best = i;
    else if (i > near) break;
  }
  return best;
}

/**
 * 在新的正文里找回编辑位置：光标放回原来那段文字处，编辑区滚动到原来看到的地方（那里找不到时把光标滚到中间）。
 * 光标找不到（外部大改过）时回到开头：光标在最前面，scroll 为 null 表示滚到顶
 */
export function restorePosition(doc: string, p: EditPosition): { head: number; scroll: StateEffect<unknown> | null } {
  const head = locateAnchor(doc, p.cursor);
  if (head == null) return { head: 0, scroll: null };
  const top = locateAnchor(doc, p.view);
  return {
    head,
    scroll:
      top == null
        ? EditorView.scrollIntoView(head, { y: "center" })
        : EditorView.scrollIntoView(top, { y: "start", yMargin: p.view.top }),
  };
}

/** 光标移动、正文改动、滚动之后报告新的编辑位置；布局在 CodeMirror 的测量阶段读，不额外触发重排 */
export function trackPosition(onPosition: (p: EditPosition) => void): Extension {
  const request = { key: "editPosition", read: capturePosition, write: onPosition };
  return [
    EditorView.updateListener.of((u) => {
      if (u.selectionSet || u.docChanged) u.view.requestMeasure(request);
    }),
    EditorView.domEventHandlers({
      scroll: (_e, view) => {
        view.requestMeasure(request);
      },
    }),
  ];
}
