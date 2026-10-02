import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { type Command, type EditorView, keymap } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

// 围栏代码块（``` 或 ~~~）里回车只会换行，没有结尾的 ``` 时后面整篇都算代码。
// 这里提供跳出代码块的办法（同 Typora）：
// - 输入 ```语言 后回车，自动补上结尾的 ```
// - 代码块里按 Ctrl+Enter，或在文末代码块的最后一行按 ↓，跳到代码块下面新的一行；缺结尾的 ``` 时顺便补上

const OPENING = /^(\s*)(`{3,}|~{3,})/;

function tree(state: EditorState) {
  // 代码块有没有结尾要看到它后面的内容，文档不长，直接解析完
  return ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
}

/** pos 所在的围栏代码块（含开头、结尾的 ``` 行） */
function fencedCodeAt(state: EditorState, pos: number): SyntaxNode | null {
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === "FencedCode") return n;
    }
  }
  return null;
}

function isClosed(state: EditorState, block: SyntaxNode): boolean {
  const marks = block.getChildren("CodeMark");
  return marks.length > 1 && state.doc.lineAt(marks[marks.length - 1].from).number > state.doc.lineAt(block.from).number;
}

/** 光标移到代码块下面新的一行，缺结尾的 ``` 时补上 */
function exitSpec(state: EditorState, block: SyntaxNode): TransactionSpec {
  const doc = state.doc;
  const openLine = doc.lineAt(block.from);
  const [, indent, fence] = OPENING.exec(openLine.text) ?? ["", "", "```"];
  const last = doc.lineAt(block.to);
  let from = last.to;
  let insert = "\n";
  if (!isClosed(state, block)) {
    // 最后一行是空行就把 ``` 写在那行，免得代码块末尾多一行空白
    if (last.number > openLine.number && !last.text.trim()) from = last.from;
    insert = from === last.from ? `${indent}${fence}\n` : `\n${indent}${fence}\n`;
  } else if (last.number < doc.lines && !doc.line(last.number + 1).text.trim()) {
    // 下面已经有空行：直接移过去
    return { selection: EditorSelection.cursor(doc.line(last.number + 1).from), scrollIntoView: true };
  }
  return {
    changes: { from, to: from === last.from ? last.to : from, insert },
    selection: EditorSelection.cursor(from + insert.length),
    scrollIntoView: true,
    userEvent: "input",
  };
}

/** Ctrl+Enter：光标在代码块里时跳出 */
export const exitCodeBlock: Command = (view) => {
  const { state } = view;
  if (state.readOnly || state.selection.ranges.length > 1) return false;
  const block = fencedCodeAt(state, state.selection.main.head);
  if (!block) return false;
  view.dispatch(exitSpec(state, block));
  return true;
};

/** 光标在文档最后一个视觉行上 */
function onLastRow(view: EditorView, pos: number): boolean {
  const here = view.coordsAtPos(pos);
  const end = view.coordsAtPos(view.state.doc.length);
  return !!here && !!end && Math.abs(here.bottom - end.bottom) < 2;
}

/** ↓：文末代码块的最后一行再往下，就跳出代码块 */
export const downOutOfCodeBlock: Command = (view) => {
  const { state } = view;
  const sel = state.selection.main;
  if (state.readOnly || state.selection.ranges.length > 1 || !sel.empty) return false;
  if (state.doc.lineAt(sel.head).number !== state.doc.lines || !onLastRow(view, sel.head)) return false;
  const block = fencedCodeAt(state, sel.head);
  if (!block) return false;
  view.dispatch(exitSpec(state, block));
  return true;
};

/** 回车：刚输入的 ```语言 没有结尾时，补上结尾并把光标放在中间 */
export const closeFenceOnEnter: Command = (view) => {
  const { state } = view;
  const sel = state.selection.main;
  if (state.readOnly || state.selection.ranges.length > 1 || !sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  // 反引号代码块的语言说明里不能有反引号
  const m = /^(\s*)(`{3,}(?!.*`)|~{3,}).*$/.exec(line.text);
  if (!m || sel.head !== line.to) return false;
  const block = fencedCodeAt(state, line.from + m[1].length + 1);
  if (!block || state.doc.lineAt(block.from).number !== line.number || isClosed(state, block)) return false;
  const [, indent, fence] = m;
  view.dispatch({
    changes: { from: sel.head, insert: `\n${indent}\n${indent}${fence}` },
    selection: EditorSelection.cursor(sel.head + 1 + indent.length),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
};

export const codeFenceKeymap = keymap.of([
  { key: "Enter", run: closeFenceOnEnter },
  { key: "Mod-Enter", run: exitCodeBlock },
  { key: "ArrowDown", run: downOutOfCodeBlock },
]);
