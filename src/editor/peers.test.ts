import { history, historyField, redo, undo } from "@codemirror/commands";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { DocPeers, historyKeys, type PeerView, syncAnnotation, undoSnapshot } from "./peers";

// docs/requirements.md「右侧分屏」：两边开着同一条待办时正文只有一份，一边改了另一边马上跟着变；撤销记录共用一份，
// 在哪一边按 Ctrl+Z 都撤销最近的修改；光标、选区各边各自的。最早打开的那一边关掉后，留下的那一边接着能撤销

/** 只有 EditorState 的编辑器，照 EditorView 的样子把事务交给 DocPeers */
class FakeView implements PeerView {
  state: EditorState;
  constructor(
    private peers: DocPeers<FakeView>,
    doc: string,
    withHistory: boolean,
  ) {
    this.state = EditorState.create({ doc, extensions: withHistory ? [history()] : [] });
    peers.attach(this, {
      promote: (h) => {
        const json = { doc: this.state.doc.toString(), selection: this.state.selection.toJSON(), history: h };
        this.state = EditorState.fromJSON(json, { extensions: [history()] }, { history: historyField });
      },
    });
  }
  update(trs: readonly Transaction[]) {
    this.state = trs[trs.length - 1].state;
  }
  // 同 EditorView：dispatch 绑定在实例上，可以单独拿出来用（撤销命令就是这样调用的）
  dispatch = (...args: [Transaction] | TransactionSpec[]) => {
    const tr = args[0] instanceof Transaction ? args[0] : this.state.update(...(args as TransactionSpec[]));
    this.peers.dispatch([tr], this);
  };
  /** 打字：光标处插入 text（同 CodeMirror 输入时的 userEvent） */
  type(text: string, at = this.state.selection.main.head) {
    this.dispatch({
      changes: { from: at, insert: text },
      selection: { anchor: at + text.length },
      userEvent: "input.type",
    });
  }
  get doc() {
    return this.state.doc.toString();
  }
  get head() {
    return this.state.selection.main.head;
  }
}

function pair(doc = "第一行\n第二行") {
  const peers = new DocPeers<FakeView>();
  const a = new FakeView(peers, doc, true);
  const b = new FakeView(peers, peers.doc()!, false);
  return { peers, a, b };
}

/** 隔开两次修改：撤销记录里各算一步（不和前一次输入合并） */
const separate = (v: FakeView) => v.dispatch({ annotations: Transaction.time.of(Date.now() + 10_000) });

describe("两个编辑器开着同一条待办", () => {
  it("一边改了，另一边马上跟着变", () => {
    const { a, b } = pair();
    a.type("甲", 0);
    expect(b.doc).toBe("甲第一行\n第二行");
    b.type("乙", b.state.doc.length);
    expect(a.doc).toBe("甲第一行\n第二行乙");
  });

  it("光标、选区各边各自的：只同步正文，另一边的光标跟着改动挪位置", () => {
    const { a, b } = pair("abc");
    b.dispatch({ selection: { anchor: 3 } });
    a.dispatch({ selection: { anchor: 1 } });
    expect(b.head).toBe(3);
    a.type("X", 0);
    expect(a.head).toBe(1);
    expect(b.head).toBe(4);
  });

  it("同步过来的改动标着 syncAnnotation，不再转回去", () => {
    const { a, b } = pair("abc");
    let seen: Transaction | null = null;
    const update = b.update.bind(b);
    b.update = (trs) => {
      seen = trs[0];
      update(trs);
    };
    a.type("X", 0);
    expect(seen!.annotation(syncAnnotation)).toBe(true);
    expect(a.doc).toBe("Xabc");
  });

  it("在没有撤销记录的一边按 Ctrl+Z：撤销最近的修改（另一边改的也算），两边都撤回去，这一边的光标到改动处", () => {
    const { peers, a, b } = pair("abc");
    a.type("1", 3);
    separate(a);
    b.type("2", 0);
    expect(peers.run(b, undo)).toBe(true);
    expect([a.doc, b.doc]).toEqual(["abc1", "abc1"]);
    expect(b.head).toBe(0);
    expect(peers.run(b, undo)).toBe(true);
    expect([a.doc, b.doc]).toEqual(["abc", "abc"]);
    expect(peers.run(b, redo)).toBe(true);
    expect(b.doc).toBe("abc1");
  });

  it("在有撤销记录的一边撤销，另一边改的也撤回去", () => {
    const { a, b } = pair("abc");
    b.type("2", 0);
    undo(a);
    expect([a.doc, b.doc]).toEqual(["abc", "abc"]);
  });

  it("没有撤销记录的一边里浏览器自己的撤销 / 重做（Windows 上的 Ctrl+Shift+Z、右键菜单）：同样转给有撤销记录的一边", () => {
    const { peers, a, b } = pair("abc");
    b.type("2", 0);
    expect(peers.beforeInput(b, "historyUndo")).toBe(true);
    expect([a.doc, b.doc]).toEqual(["abc", "abc"]);
    expect(peers.beforeInput(b, "historyRedo")).toBe(true);
    expect([a.doc, b.doc]).toEqual(["2abc", "2abc"]);
    // 别的输入不管，交给编辑器照常处理
    expect(peers.beforeInput(b, "insertText")).toBe(false);
  });

  it("Ctrl+Shift+Z 重做：两边的按键里都有（Windows 上 CodeMirror 自带的按键里没有它）", () => {
    const { peers } = pair("abc");
    const redoKey = (keys: readonly { key?: string; run?: unknown }[]) => keys.some((b) => b.key === "Mod-Shift-z");
    expect(redoKey(historyKeys)).toBe(true);
    expect(redoKey(peers.sharedHistory().keys)).toBe(true);
  });

  it("没有能撤销的：什么都不做", () => {
    const { peers, a, b } = pair("abc");
    expect(peers.run(b, undo)).toBe(false);
    expect(peers.run(a, undo)).toBe(false);
  });

  it("有撤销记录的一边关掉了：撤销记录交给留下的那一边，接着能撤销", () => {
    const { peers, a, b } = pair("abc");
    a.type("1", 3);
    expect(peers.detach(a, () => a.state.toJSON({ history: historyField }).history)).toBe(true);
    expect(peers.primary).toBe(b);
    undo(b);
    expect(b.doc).toBe("abc");
    // 留下的这个关掉时自己留撤销记录
    expect(peers.detach(b, () => null)).toBe(false);
    expect(peers.size).toBe(0);
  });

  it("没有撤销记录的一边关掉：不影响另一边", () => {
    const { peers, a, b } = pair("abc");
    a.type("1", 3);
    expect(peers.detach(b, () => null)).toBe(false);
    a.type("2");
    expect(a.doc).toBe("abc12");
    expect(undoSnapshot(a.state)).not.toBeNull();
  });

  it("新打开的编辑器拿现在的正文（包括没存盘的修改）", () => {
    const peers = new DocPeers<FakeView>();
    expect(peers.doc()).toBeNull();
    const a = new FakeView(peers, "原文", true);
    a.type("改", 2);
    expect(peers.doc()).toBe("原文改");
  });
});

describe("撤销记录的快照", () => {
  it("没有可以撤销、重做的修改时是 null", () => {
    expect(undoSnapshot(EditorState.create({ doc: "x", extensions: [history()] }))).toBeNull();
    expect(undoSnapshot(EditorState.create({ doc: "x" }))).toBeNull();
  });
});
