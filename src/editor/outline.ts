import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

// 大纲：正文里的标题（# 标题和下面画 === / --- 的标题，引用、列表里的也算），按语法树找，代码块里的 # 不算。
// 「正在看的位置」决定大纲里高亮哪个标题：光标在可见区域里时是光标处，否则是可见区域顶部

export interface OutlineItem {
  /** 1～6 */
  level: number;
  /** 去掉 #、加粗、链接地址等标记后的文字 */
  text: string;
  /** 标题所在行的开头 */
  pos: number;
}

/** 语法树里标题中不显示的部分：标题、加粗、行内代码、删除线、链接的标记，HTML 标签（如 <u>） */
const MARKS = new Set(["HeaderMark", "EmphasisMark", "CodeMark", "StrikethroughMark", "LinkMark", "HTMLTag", "LinkTitle", "LinkLabel"]);

/** 正文里的全部标题。正文很长、语法树还没解析完时最多等一小会儿，还没解析到的部分里的标题先不列 */
export function outlineItems(state: EditorState): OutlineItem[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  const items: OutlineItem[] = [];
  tree.iterate({
    enter(node) {
      const m = /^(ATX|Setext)Heading(\d)$/.exec(node.name);
      if (!m) return;
      const level = Number(m[2]);
      // 下面画线的标题只要文字那几行，不要 === / --- 那一行
      const end = m[1] === "Setext" ? state.doc.lineAt(node.to).from : node.to;
      const skip: [number, number][] = [];
      for (let c = node.node.firstChild; c; c = c.nextSibling) collectMarks(c, skip);
      let text = "";
      let at = node.from;
      for (const [from, to] of skip.sort((a, b) => a[0] - b[0])) {
        if (from >= end) break;
        if (from > at) text += state.sliceDoc(at, from);
        at = Math.max(at, to);
      }
      if (at < end) text += state.sliceDoc(at, end);
      text = text.replace(/\s+/g, " ").trim();
      if (text) items.push({ level, text, pos: state.doc.lineAt(node.from).from });
      return false;
    },
  });
  return items;
}

/** 找出 node 里不显示的标记（链接、图片的地址也不显示） */
function collectMarks(node: SyntaxNode, out: [number, number][]) {
  const inLink = node.parent?.name === "Link" || node.parent?.name === "Image";
  if (MARKS.has(node.name) || (node.name === "URL" && inLink)) {
    out.push([node.from, node.to]);
    return;
  }
  for (let c = node.firstChild; c; c = c.nextSibling) collectMarks(c, out);
}

/** pos 处在哪个标题下面：最后一个开头不晚于 pos 的标题；在第一个标题前面时是 -1 */
export function activeIndex(items: readonly OutlineItem[], pos: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].pos <= pos) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** 大纲里的缩进：最高一级标题不缩进，往下每级缩进一格 */
export function outlineDepth(items: readonly OutlineItem[], item: OutlineItem): number {
  const top = Math.min(...items.map((x) => x.level));
  return item.level - top;
}

/**
 * 报告正在看的位置：光标在可见区域里时是光标处，否则是可见区域顶部那一行。
 * 光标移动、正文改动、滚动之后在 CodeMirror 的测量阶段读布局，变了才报告
 */
export function trackReadingPos(onPos: (pos: number) => void): Extension {
  let last = -1;
  const request = {
    key: "readingPos",
    read(view: EditorView): number {
      const scroller = view.scrollDOM.getBoundingClientRect();
      const top = view.lineBlockAtHeight(scroller.top - view.documentTop + 1).from;
      const bottom = view.lineBlockAtHeight(scroller.bottom - view.documentTop - 1).to;
      const head = view.state.selection.main.head;
      return head >= top && head <= bottom ? head : top;
    },
    write(pos: number) {
      if (pos === last) return;
      last = pos;
      onPos(pos);
    },
  };
  return [
    EditorView.updateListener.of((u) => {
      if (u.selectionSet || u.docChanged || u.geometryChanged) u.view.requestMeasure(request);
    }),
    EditorView.domEventHandlers({
      scroll: (_e, view) => {
        view.requestMeasure(request);
      },
    }),
  ];
}

/** 跳到标题：光标放在标题那一行的末尾，标题滚到可见区域顶部 */
export function jumpToHeading(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length));
  view.dispatch({
    selection: { anchor: line.to },
    effects: EditorView.scrollIntoView(line.from, { y: "start" }),
    userEvent: "select",
  });
  view.focus();
}
