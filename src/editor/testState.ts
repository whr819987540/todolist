// 编辑命令单元测试用的工具（只给 *.test.ts 用）：在 Node 里直接构造 EditorState，不需要 DOM。
// 文本里用记号表示光标和选区：| 是光标；« 是选区的 anchor（不动的一端），» 是 head（光标所在的一端），
// 写成 «abc» 是正向选区，»abc« 是反向选区

import { EditorSelection, EditorState, type Extension, Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { markdownSupport } from "./setup";

const CURSOR = "|";
const ANCHOR = "«";
const HEAD = "»";

/** 去掉记号，得到正文和选区 */
export function parse(marked: string): { doc: string; selection: EditorSelection } {
  let doc = "";
  let anchor = -1;
  let head = -1;
  for (const ch of marked) {
    if (ch === CURSOR) anchor = head = doc.length;
    else if (ch === ANCHOR) anchor = doc.length;
    else if (ch === HEAD) head = doc.length;
    else doc += ch;
  }
  if (anchor < 0 && head < 0) anchor = head = 0;
  if (anchor < 0 || head < 0) throw new Error(`选区缺了一端：${marked}`);
  return { doc, selection: EditorSelection.single(anchor, head) };
}

/** 正文连同光标 / 选区的记号 */
export function stringify(state: EditorState): string {
  const { anchor, head } = state.selection.main;
  const doc = state.doc.toString();
  if (anchor === head) return doc.slice(0, head) + CURSOR + doc.slice(head);
  const marks = [
    { pos: anchor, mark: ANCHOR },
    { pos: head, mark: HEAD },
  ].sort((a, b) => b.pos - a.pos);
  let out = doc;
  for (const { pos, mark } of marks) out = out.slice(0, pos) + mark + out.slice(pos);
  return out;
}

/** 和编辑器一样的 Markdown 解析（setup.ts 的 markdownSupport） */
export function makeState(marked: string, extensions: Extension[] = []): EditorState {
  const { doc, selection } = parse(marked);
  return EditorState.create({ doc, selection, extensions: [markdownSupport(), extensions] });
}

/**
 * 只有 state 和 dispatch 的「编辑器」：编辑命令只用到这两个。
 * coordsAtPos 给 ↓ 跳出代码块用：每一行算一个视觉行（测试里没有自动换行）
 */
export class TestView {
  constructor(public state: EditorState) {}

  // 箭头函数：CodeMirror 自带的命令会把 dispatch 解构出来单独调用
  dispatch = (...specs: (Transaction | TransactionSpec)[]) => {
    const [first] = specs;
    const tr = first instanceof Transaction ? first : this.state.update(...(specs as TransactionSpec[]));
    this.state = tr.state;
  };

  coordsAtPos(pos: number) {
    const line = this.state.doc.lineAt(pos).number;
    return { top: line * 20, bottom: line * 20 + 20, left: 0, right: 0 };
  }

  get asView(): EditorView {
    return this as unknown as EditorView;
  }
}

/** 在带记号的文本上执行命令，返回命令的返回值和执行后带记号的文本 */
export function exec(
  marked: string,
  command: (view: EditorView) => boolean,
  extensions: Extension[] = [],
): { handled: boolean; text: string } {
  const view = new TestView(makeState(marked, extensions));
  const handled = command(view.asView);
  return { handled, text: stringify(view.state) };
}

/** 执行命令后带记号的文本 */
export const apply = (marked: string, command: (view: EditorView) => boolean, extensions: Extension[] = []) =>
  exec(marked, command, extensions).text;

/** 只读的编辑器 */
export const readOnly = EditorState.readOnly.of(true);
