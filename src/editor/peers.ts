import { historyField, historyKeymap, isolateHistory, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import {
  Annotation,
  type ChangeSet,
  type EditorState,
  type Extension,
  type StateCommand,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, type KeyBinding } from "@codemirror/view";
import type { UndoSnapshot } from "../workspaceState";

// 同一条待办在分屏的两边都开着时，两个编辑器（CodeMirror 的 EditorView）显示同一份正文：一边改了，改动马上同步到另一边
// （同 CodeMirror 的 split view 示例）。撤销记录只有一份，在最早打开的那个编辑器里；别的编辑器里按 Ctrl+Z / Ctrl+Y
// 转给它，在哪一边撤销都撤销最近的修改（不论是在哪一边改的）。最早的那个关掉时，撤销记录交给留下的那个。
// 光标、选区、滚动、查找框、编辑模式各个编辑器各自的。只有一个编辑器时什么都不多做

/** 从另一个编辑器同步过来的改动：不再转出去，也不算这个编辑器里的修改（存盘、输入法组合由改的那一边管） */
export const syncAnnotation = Annotation.define<boolean>();

/** 用到的编辑器的部分（EditorView 都有）；单元测试用只有 EditorState 的假编辑器 */
export interface PeerView {
  readonly state: EditorState;
  update(trs: readonly Transaction[]): void;
  dispatch(tr: Transaction): void;
  dispatch(...specs: TransactionSpec[]): void;
}

export interface PeerHooks {
  /** 有撤销记录的那个编辑器关掉了，撤销记录交给这一个：history 是 historyField 序列化后的样子 */
  promote(history: unknown): void;
}

/**
 * 撤销 / 重做的按键：CodeMirror 的 historyKeymap，再加上 Ctrl+Shift+Z 重做（编辑快捷键里列着的固定按键）。Windows 上
 * historyKeymap 没有 Ctrl+Shift+Z，交给浏览器自己的重做，而用 CodeMirror 撤销过之后浏览器自己的重做并不会触发
 */
export const historyKeys: readonly KeyBinding[] = [
  ...historyKeymap,
  { key: "Mod-Shift-z", run: redo, preventDefault: true },
];

/** 现在的正文和撤销记录；没有可以撤销、重做的修改（或没有撤销记录）时是 null */
export function undoSnapshot(state: EditorState): UndoSnapshot | null {
  if (!undoDepth(state) && !redoDepth(state)) return null;
  const { doc, history } = state.toJSON({ history: historyField });
  return { doc, history };
}

/** 同步过去的改动带上原来的这些标注：撤销记录照样按输入、删除等分组 */
function syncSpec(tr: Transaction): TransactionSpec {
  const annotations: Annotation<unknown>[] = [syncAnnotation.of(true)];
  const userEvent = tr.annotation(Transaction.userEvent);
  if (userEvent) annotations.push(Transaction.userEvent.of(userEvent));
  const addToHistory = tr.annotation(Transaction.addToHistory);
  if (addToHistory !== undefined) annotations.push(Transaction.addToHistory.of(addToHistory));
  const isolate = tr.annotation(isolateHistory);
  if (isolate) annotations.push(isolateHistory.of(isolate));
  return { changes: tr.changes, annotations };
}

/** 一条待办打开着的编辑器 */
export class DocPeers<V extends PeerView = PeerView> {
  private views: { view: V; hooks: PeerHooks }[] = [];

  get size() {
    return this.views.length;
  }

  /** 有撤销记录的那个（最早打开的）；没有打开着的编辑器时为 null */
  get primary(): V | null {
    return this.views[0]?.view ?? null;
  }

  /** 现在的正文（包括输入法组合中的）；没有打开着的编辑器时为 null */
  doc(): string | null {
    return this.primary?.state.doc.toString() ?? null;
  }

  /** 新建的编辑器：第一个要带撤销记录（history()），之后的不带、撤销 / 重做转给第一个（见 sharedHistory） */
  attach(view: V, hooks: PeerHooks) {
    this.views.push({ view, hooks });
  }

  /**
   * 编辑器关掉了。关掉的是有撤销记录的那个、还有别的开着时，撤销记录（history() 取）交给下一个，返回 true
   * （关掉的这个不用再留撤销记录）
   */
  detach(view: V, history: () => unknown): boolean {
    const i = this.views.findIndex((x) => x.view === view);
    if (i < 0) return false;
    this.views.splice(i, 1);
    if (i !== 0 || !this.views.length) return false;
    this.views[0].hooks.promote(history());
    return true;
  }

  /** 编辑器的 dispatchTransactions：先更新它自己，再把正文的改动同步给别的编辑器 */
  dispatch(trs: readonly Transaction[], view: V) {
    view.update(trs);
    if (this.views.length < 2) return;
    for (const tr of trs) {
      if (tr.changes.empty || tr.annotation(syncAnnotation)) continue;
      const spec = syncSpec(tr);
      for (const x of this.views) if (x.view !== view) x.view.dispatch(spec);
    }
  }

  /**
   * 没有撤销记录的编辑器里撤销 / 重做：在有撤销记录的那个里执行（改动照常同步过来），这一边的光标放到改动的地方。
   * 没有可撤销的、自己就是有撤销记录的那个时返回 false
   */
  run(view: V, command: StateCommand): boolean {
    const main = this.primary;
    if (!main || main === view) return false;
    const done: { changes: ChangeSet | null } = { changes: null };
    const ok = command({
      state: main.state,
      dispatch: (tr) => {
        done.changes = tr.changes;
        main.dispatch(tr);
      },
    });
    if (!ok || !done.changes) return ok;
    let pos = -1;
    done.changes.iterChangedRanges((_fromA, _toA, _fromB, toB) => {
      if (pos < 0) pos = toB;
    });
    if (pos >= 0 && pos <= view.state.doc.length)
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: "select" });
    return true;
  }

  /**
   * 浏览器自己的撤销 / 重做（beforeinput 的 historyUndo / historyRedo：Windows 上的 Ctrl+Shift+Z、右键菜单里的「撤销」
   * 「重做」等）：同 history() 那样拦下来，不让浏览器在正文里自己撤销（那样改动会被当成输入存盘），转给有撤销记录的编辑器。
   * 不是这两种时返回 false
   */
  beforeInput(view: V, inputType: string): boolean {
    const command = inputType === "historyUndo" ? undo : inputType === "historyRedo" ? redo : null;
    if (!command) return false;
    this.run(view, command);
    return true;
  }

  /**
   * 没有撤销记录的编辑器用的：撤销 / 重做的按键（同 historyKeys 的撤销、重做）和浏览器自己的撤销 / 重做（beforeInput），
   * 都转给有撤销记录的编辑器
   */
  sharedHistory(): { keys: KeyBinding[]; extension: Extension } {
    return {
      keys: historyKeys
        .filter((b) => b.run === undo || b.run === redo)
        .map((b) => ({ ...b, run: (v) => this.run(v as unknown as V, b.run === undo ? undo : redo) })),
      extension: EditorView.domEventHandlers({
        beforeinput: (e, view) => {
          if (!this.beforeInput(view as unknown as V, e.inputType)) return false;
          e.preventDefault();
          return true;
        },
      }),
    };
  }
}
