import { history, historyField } from "@codemirror/commands";
import { type ChangeSpec, EditorSelection, EditorState, Transaction } from "@codemirror/state";

// 撤销记录接到软件自己改过的正文上：移动、另存为新待办后待办换了 id，正文里图片的链接跟着改了（Rust 端 store.rs 的
// relink_assets），这时留着的撤销记录（workspaceState.ts 的 UndoSnapshot）和磁盘上的正文对不上。改动只在几行里
// （行数不变），按行找出改了的地方当成一次不进撤销记录的修改，撤销记录跟着这次修改挪位置

/** 把 from 改成 to 的修改：逐行比，每个不一样的行去掉相同的开头、结尾后算一处；行数不一样时返回 null */
export function lineChanges(from: string, to: string): ChangeSpec[] | null {
  const a = from.split("\n");
  const b = to.split("\n");
  if (a.length !== b.length) return null;
  const changes: ChangeSpec[] = [];
  let pos = 0;
  a.forEach((line, i) => {
    const next = b[i];
    if (line !== next) {
      let start = 0;
      while (start < line.length && start < next.length && line[start] === next[start]) start++;
      let end = 0;
      while (end < line.length - start && end < next.length - start && line[line.length - 1 - end] === next[next.length - 1 - end]) end++;
      changes.push({ from: pos + start, to: pos + line.length - end, insert: next.slice(start, next.length - end) });
    }
    pos += line.length + 1;
  });
  return changes;
}

/**
 * 正文 doc 的撤销记录（CodeMirror history 序列化后的样子）接到改过的正文 next 上，返回新的撤销记录；
 * 接不上（行数变了、撤销记录认不出）时返回 null
 */
export function rebaseHistory(doc: string, saved: unknown, next: string): unknown {
  const changes = lineChanges(doc, next);
  if (!changes) return null;
  try {
    const state = EditorState.fromJSON(
      { doc, selection: EditorSelection.single(0).toJSON(), history: saved },
      { extensions: history() },
      { history: historyField },
    );
    const tr = state.update({ changes, annotations: Transaction.addToHistory.of(false) });
    if (tr.state.doc.toString() !== next) return null;
    return tr.state.toJSON({ history: historyField }).history;
  } catch {
    return null;
  }
}
