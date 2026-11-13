import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState, Line } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

// 没选中文字时 Ctrl+C 复制光标所在的整行（CodeMirror 自带的行为）；列表项、任务、标题的行只复制后面的文字，
// 不带行首的列表符号 / 序号、任务框、标题的 #。按语法树认，代码块里的 "- "、"# " 不算。
// 只接管要去掉标记的复制：别的（选中了文字、普通的段落和引用）照旧交给 CodeMirror；剪切也照旧整行带着标记剪掉

/** 行首可以去掉的标记；只有引用标记 > 的行不算（普通的引用照原样复制） */
const LEADING = new Set(["QuoteMark", "ListMark", "TaskMarker", "HeaderMark"]);

/** # 标题的 #（标题下面画的 === / --- 也是 HeaderMark，不算） */
const atxMark = (n: SyntaxNode) => n.name === "HeaderMark" && !!n.parent?.name.startsWith("ATXHeading");

/**
 * 复制 line 这一行时得到的文字：列表项、任务、标题的行去掉行首的引用标记、列表符号 / 序号、任务框、标题的 #
 * 和它们后面的空白（标题末尾的 # 也去掉）；别的行返回 null（照原样复制整行）
 */
export function strippedLine(state: EditorState, line: Line): string | null {
  const tree = ensureSyntaxTree(state, line.to, 50) ?? syntaxTree(state);
  const { text } = line;
  let start = 0;
  let strip = false;
  for (;;) {
    while (start < text.length && (text[start] === " " || text[start] === "\t")) start++;
    if (start >= text.length) break;
    const node = tree.resolveInner(line.from + start, 1);
    if (node.from !== line.from + start || !LEADING.has(node.name)) break;
    if (node.name === "HeaderMark" && !atxMark(node)) break;
    if (node.name !== "QuoteMark") strip = true;
    start = node.to - line.from;
  }
  if (!strip) return null;
  let end = text.length;
  const last = tree.resolveInner(line.to, -1);
  if (atxMark(last) && last.from - line.from >= start) end = last.from - line.from;
  const out = text.slice(start, end);
  return end < text.length ? out.trimEnd() : out;
}

/**
 * 没选中文字时 Ctrl+C 复制的文字：各个光标所在的行（同一行只算一次），用换行连起来，
 * 列表项、任务、标题的行按 strippedLine 去掉标记。选中了文字、或者没有哪一行要去掉标记时返回 null（交给 CodeMirror）
 */
export function lineCopyText(state: EditorState): string | null {
  if (state.selection.ranges.some((r) => !r.empty)) return null;
  const parts: string[] = [];
  let stripped = false;
  let upto = -1;
  for (const r of state.selection.ranges) {
    const line = state.doc.lineAt(r.head);
    if (line.number <= upto) continue;
    upto = line.number;
    const s = strippedLine(state, line);
    if (s !== null) stripped = true;
    parts.push(s ?? line.text);
  }
  return stripped ? parts.join(state.lineBreak) : null;
}

/** 复制时去掉列表项、任务、标题行首的标记（先于 CodeMirror 自带的复制） */
export const lineCopy = EditorView.domEventHandlers({
  copy(e, view) {
    const data = e.clipboardData;
    if (!data) return false;
    const text = lineCopyText(view.state);
    if (text === null) return false;
    e.preventDefault();
    data.clearData();
    data.setData("text/plain", text);
    return true;
  },
});
