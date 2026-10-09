import type { EditorView } from "@codemirror/view";
import { api, errMsg } from "../api";
import { DocPeers, undoSnapshot } from "../editor/peers";
import type { EditPosition } from "../editor/position";
import type { EditorMode } from "../editor/setup";
import { emitAppEvent, registerFlusher } from "../hooks";
import { type Leftover, leaveProblem, type LeaveProblem, type ProjectAt, rescueAsNew, rescueNotice } from "../rescue";
import type { QuickTarget, TextEncoding, TodoDetail, TodoSummary } from "../types";
import { displayTitle, myVersionTitle } from "../utils";
import {
  keepUndo,
  readEditorMode,
  readEditPosition,
  takeUndo,
  type UndoSnapshot,
  writeEditorMode,
  writeEditPosition,
} from "../workspaceState";

// 一条打开着的待办的正文和标题、保存、外部修改冲突。分屏时两边可以开着同一条待办（两个 TodoEditor），它们共用这一个会话：
// 正文、标题只有一份，只有这里存盘（一个定时器、一个保存队列、一处冲突），不会两边各存一次、互相覆盖；两个编辑器之间
// 正文的同步和共用的撤销记录见 editor/peers.ts。最后一个 TodoEditor 关掉时（离开这条待办）存盘，存不上的另存为新待办，
// 之后这个会话就不用了

export type SaveStatus = "saved" | "dirty" | "saving" | "error";

/** 界面要显示的（useSyncExternalStore 订阅） */
export interface SessionState {
  loading: boolean;
  loadError: string;
  /** 没存好（未保存、正在保存、保存失败）时标签上显示圆点 */
  status: SaveStatus;
  /** 外部修改冲突，要弹出对话框 */
  conflict: boolean;
  encoding: TextEncoding;
  path: string;
  /** 标题框里的字（包括输入法组合中的） */
  title: string;
  /** 弹冲突对话框、处理窗口焦点的那个 TodoEditor（最早打开的） */
  lead: string | null;
}

/** 开着这条待办的一个 TodoEditor（分屏时一边一个）交给会话的 */
export interface SessionMember {
  readonly id: string;
  onSummary(s: TodoSummary): void;
  /** 现在显示的摘要（离开时另存的提示里写原来那条的标题） */
  summary(): TodoSummary;
  /** 打开后第一次修改了标题或正文（预览标签据此固定下来） */
  onEdit(): void;
  saveOptions(): { autoSave: boolean; saveDelaySecs: number };
  error(text: string): void;
  /** App 级的提示，这个 TodoEditor 卸载后也能用：离开时另存为新待办的结果 */
  notice(type: "warning" | "error", text: string, seconds: number): void;
  /** 快速记录存到的项目：离开时存不上、原来的项目也不在了时另存到这里 */
  quickTarget(): QuickTarget | undefined;
  /** 立即记下这个编辑器现在的编辑位置 */
  savePosition(): void;
  /** 正文从磁盘读出来了（第一个打开这条待办的才有；之后打开的直接用现在的） */
  loaded(doc: string): void;
  /** 标题框有焦点（正在编辑标题） */
  titleFocused(): boolean;
  /** 正文改了（在哪个编辑器里改的都算）：过一会儿更新字数、大纲 */
  contentChanged(): void;
  /** 换成了磁盘上的正文（外部改过后重新加载）：编辑器换内容，光标尽量留在原处 */
  reset(doc: string): void;
}

const sessions = new Map<string, TodoSession>();

/** 这条待办的会话：开着的就用它（分屏的另一边开着同一条待办时），没有时新建；title 是新建时标题框里的 */
export function todoSession(workspace: string, project: string, id: string, title: string): TodoSession {
  const key = JSON.stringify([workspace, project, id]);
  let s = sessions.get(key);
  if (!s) {
    s = new TodoSession(workspace, project, id, title);
    sessions.set(key, s);
  }
  return s;
}

export class TodoSession {
  /** 打开着这条待办的编辑器，正文在它们之间同步 */
  readonly peers = new DocPeers<EditorView>();
  readonly key: string;
  private content = "";
  private savedContent = "";
  private title: string;
  private savedTitle: string;
  private mtime: number | null = null;
  private loaded = false;
  private loading = false;
  private loadToken = 0;
  /** 待办已被删除 / 移走：不再保存 */
  detached = false;
  /** 存盘、核对磁盘时发现外部改过，等用户在冲突对话框里选；这期间不再存 */
  private conflicted = false;
  /** 最近一次存盘失败的原因（离开时另存的提示里说明） */
  private saveError = "";
  /** 正在离开（都关掉了、从托盘退出）：存盘失败不单独提示，和另存的结果一起说 */
  private leaving = false;
  /** 定时保存：从第一处未保存的修改开始倒计时 */
  private timer = 0;
  /** 这次倒计时从什么时候算起（第一处未保存的修改的时间），没在倒计时时是 0 */
  private dirtyAt = 0;
  private chain: Promise<void> = Promise.resolve();
  /** 最近一个 TodoEditor 打开后修改过标题或正文 */
  private edited = false;
  private members: SessionMember[] = [];
  /** 都关掉之后最后一次存盘时也要报告新的摘要、报错 */
  private last: SessionMember | null = null;
  private unregister: (() => void) | null = null;
  private disposed = false;
  private listeners = new Set<() => void>();
  private state: SessionState;

  constructor(
    readonly workspace: string,
    readonly project: string,
    readonly id: string,
    title: string,
  ) {
    this.key = JSON.stringify([workspace, project, id]);
    this.title = this.savedTitle = title;
    this.state = {
      loading: true,
      loadError: "",
      status: "saved",
      conflict: false,
      encoding: "UTF-8",
      path: "",
      title,
      lead: null,
    };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getState = () => this.state;

  private set(patch: Partial<SessionState>) {
    const keys = Object.keys(patch) as (keyof SessionState)[];
    if (keys.every((k) => this.state[k] === patch[k])) return;
    this.state = { ...this.state, ...patch };
    for (const fn of [...this.listeners]) fn();
  }

  private get lead(): SessionMember | null {
    return this.members[0] ?? this.last;
  }

  /** 存着的正文（上屏了的修改都在里面）；编辑器开着时以编辑器里的为准（DocPeers.doc），这里给刚加载完、还没建编辑器时用 */
  currentDoc = () => this.content;

  /** 一个 TodoEditor 打开了这条待办：第一个打开时从磁盘读正文 */
  attach(m: SessionMember) {
    if (this.disposed) this.revive();
    this.members.push(m);
    this.last = m;
    this.edited = false;
    // 从托盘退出前存盘时存不上的另存为新待办；隐藏到托盘时只是存盘
    this.unregister ??= registerFlusher((quitting) => (quitting ? this.leave(true) : this.flush()), true);
    this.set({ lead: this.members[0].id });
    if (!this.loaded && !this.loading) this.load();
  }

  /**
   * 一个 TodoEditor 关掉了（切走、关标签等）：先存盘。都关掉了（没有哪一边还开着这条待办：切换待办、关标签、返回首页等）
   * 是离开这条待办，存不上的另存为新待办（leave）；之后这个会话就不用了
   */
  detach(m: SessionMember) {
    this.members = this.members.filter((x) => x !== m);
    this.set({ lead: this.members[0]?.id ?? null });
    if (this.members.length) {
      this.flush();
      return;
    }
    this.leave(false).then(() => {
      if (!this.members.length) this.dispose();
    });
  }

  private dispose() {
    this.disposed = true;
    this.loadToken++;
    this.stopTimer();
    this.unregister?.();
    this.unregister = null;
    if (sessions.get(this.key) === this) sessions.delete(this.key);
  }

  /** 关掉后又打开（开发时 StrictMode 把组件挂上、卸下、再挂上）：从头再读一次 */
  private revive() {
    this.disposed = false;
    this.loaded = this.loading = this.detached = this.conflicted = this.leaving = false;
    this.saveError = "";
    this.content = this.savedContent = "";
    this.mtime = null;
    this.set({ loading: true, loadError: "", status: "saved", conflict: false });
    if (!sessions.has(this.key)) sessions.set(this.key, this);
  }

  private load() {
    const token = ++this.loadToken;
    this.loading = true;
    this.set({ loading: true, loadError: "" });
    api.readTodo(this.workspace, this.project, this.id).then(
      (d) => {
        if (token !== this.loadToken) return;
        this.loading = false;
        this.content = this.savedContent = d.content;
        this.mtime = d.mtime;
        this.loaded = true;
        for (const m of this.members) m.loaded(d.content);
        this.set({ loading: false, encoding: d.encoding, path: d.path });
        this.lead?.onSummary(d.summary);
      },
      (e) => {
        if (token !== this.loadToken) return;
        this.loading = false;
        this.set({ loading: false, loadError: errMsg(e) });
      },
    );
  }

  private isDirty = () => this.content !== this.savedContent || this.title !== this.savedTitle;

  private noteEdit() {
    if (this.edited) return;
    this.edited = true;
    this.lead?.onEdit();
  }

  private stopTimer() {
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.dirtyAt = 0;
  }

  /** 现在的定时保存间隔（ms）：auto save 开着时按设置，关着时 1 小时兜底 */
  private saveDelayMs() {
    const o = this.lead?.saveOptions();
    return (o?.autoSave ? o.saveDelaySecs : FALLBACK_SAVE_SECS) * 1000;
  }

  /**
   * 有未保存的修改时开始倒计时，从第一处未保存的修改算起；倒计时中继续修改不往后推，最多隔这么久就存一次。
   * 已经在倒计时（或已经超时、正等着保存）时不重复开始
   */
  private schedule() {
    if (this.timer || this.detached || this.disposed || !this.isDirty()) return;
    this.dirtyAt ||= Date.now();
    this.timer = window.setTimeout(
      () => {
        this.timer = 0;
        this.flush();
      },
      Math.max(0, this.dirtyAt + this.saveDelayMs() - Date.now()),
    );
  }

  /** 开关 auto save、改了定时保存的间隔：按新的间隔重新安排，仍从第一处未保存的修改算起（已经超时的立即保存） */
  reschedule() {
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.schedule();
  }

  /** 更新保存状态；有未保存的修改时按需开始定时保存 */
  private refreshStatus() {
    const dirty = this.isDirty();
    this.set({ status: dirty ? "dirty" : "saved" });
    if (dirty) this.schedule();
    else this.stopTimer();
  }

  private enqueue(job: () => Promise<void>) {
    this.chain = this.chain.then(job, job);
    return this.chain;
  }

  /** 存正文；返回是否存好了（没有要存的也算），有冲突、保存失败时为 false */
  saveContent(force = false): Promise<boolean> {
    let ok = true;
    const job = this.enqueue(async () => {
      if (!this.loaded || this.detached) return;
      if (this.conflicted && !force) {
        ok = false;
        return;
      }
      const text = this.content;
      if (text === this.savedContent && !force) return;
      this.set({ status: "saving" });
      try {
        const r = await api.saveTodoContent(this.workspace, this.project, this.id, text, this.mtime, force);
        if (!r.saved) {
          ok = false;
          this.conflicted = true;
          this.set({ conflict: true, status: "dirty" });
          return;
        }
        this.savedContent = text;
        this.mtime = r.mtime;
        this.conflicted = false;
        this.set({ encoding: "UTF-8" });
        this.lead?.onSummary(r.summary);
        this.refreshStatus();
      } catch (e) {
        ok = false;
        this.saveError = errMsg(e);
        this.set({ status: "error" });
        if (!this.leaving) this.lead?.error(`保存失败：${this.saveError}`);
      }
    });
    return job.then(() => ok);
  }

  /** 存标题；返回是否存好了（没有要存的也算） */
  saveTitle(): Promise<boolean> {
    let ok = true;
    const job = this.enqueue(async () => {
      if (this.detached) return;
      const t = this.title;
      if (t === this.savedTitle) return;
      try {
        const r = await api.setTodoTitle(this.workspace, this.project, this.id, t);
        this.savedTitle = t;
        this.lead?.onSummary(r);
        this.refreshStatus();
      } catch (e) {
        ok = false;
        this.saveError = errMsg(e);
        this.set({ status: "error" });
        if (!this.leaving) this.lead?.error(`保存标题失败：${this.saveError}`);
      }
    });
    return job.then(() => ok);
  }

  /** 立即存标题和正文（先记下各编辑器的编辑位置），返回是否都存好了 */
  flush = async (): Promise<boolean> => {
    this.stopTimer();
    for (const m of this.members) m.savePosition();
    const title = this.saveTitle();
    const content = this.saveContent();
    return (await title) && (await content);
  };

  /** 编辑器里的正文改了（输入法组合中的不算，上屏后才报告） */
  setContent(text: string) {
    this.content = text;
    this.noteEdit();
    this.refreshStatus();
    for (const m of this.members) m.contentChanged();
  }

  /** 标题框里打字；composing：输入法组合中（拼音还没上屏），这时只更新输入框，不算修改 */
  setTitle(text: string, composing = false) {
    this.set({ title: text });
    if (composing) return;
    this.title = text;
    this.noteEdit();
    this.refreshStatus();
  }

  /** 标题在别处被改（例如刷新）且这里没有在编辑标题时，同步过来 */
  syncTitle(title: string) {
    if (this.title !== this.savedTitle || this.title === title || this.members.some((m) => m.titleFocused())) return;
    this.title = this.savedTitle = title;
    this.set({ title });
  }

  /** 换成磁盘上的正文（外部改过后重新加载）：各编辑器都换 */
  private applyDiskContent(d: TodoDetail) {
    this.content = this.savedContent = d.content;
    this.mtime = d.mtime;
    this.set({ encoding: d.encoding });
    this.refreshStatus();
    for (const m of this.members) m.reset(d.content);
  }

  /**
   * 窗口失去焦点时 auto save 开着就存盘；重新获得焦点时核对磁盘（文件可能被外部程序改过，见 checkDisk）。
   * 只由最早打开的 TodoEditor 调用：两边开着同一条待办时只存一次、只核对一次
   */
  windowFocus(focused: boolean) {
    if (!focused) {
      if (this.lead?.saveOptions().autoSave) this.flush();
      return;
    }
    this.checkDisk();
  }

  /**
   * 核对磁盘上的正文（窗口重新获得焦点时，文件可能在外部被改过）。外部改过时：这里没有未保存的修改就重新加载；
   * 有的话立即弹出冲突对话框让用户选，不动正在编辑的内容（不等到存盘、离开这条待办时才发现，那时没法再问）。
   * 外部的正文和这里打开时的一样（只是修改时间变了，如网盘同步时重写了一遍）、或者和这里改成的一样时不算冲突，
   * 也不重新加载（光标、撤销记录都不动）。排在保存后面做：刚存完、新的修改时间还没记下时不会当成外部改的
   */
  checkDisk(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.loaded || this.detached || this.conflicted || this.disposed) return;
      let d: TodoDetail;
      try {
        d = await api.readTodo(this.workspace, this.project, this.id);
      } catch {
        return; // 文件被删等情况由外层刷新处理（之后都关掉时存不上，另存为新待办）
      }
      if (d.mtime === this.mtime || this.detached || this.conflicted) return;
      if (d.content === this.savedContent || d.content === this.content) {
        // 内容没变（只是重写了一遍）、或者改成了和这里一样的：只记下新的修改时间和编码，编辑器的内容不换
        this.mtime = d.mtime;
        this.savedContent = d.content;
        this.set({ encoding: d.encoding });
        this.refreshStatus();
      } else if (this.content === this.savedContent) {
        this.applyDiskContent(d);
      } else {
        this.conflicted = true;
        this.set({ conflict: true });
        return;
      }
      this.lead?.onSummary(d.summary);
    });
  }

  /**
   * 冲突时选了「放弃我的修改，重新加载」（keepMine 为 false）或「用我的内容覆盖」。也排在保存后面做：
   * 做的时候离开这条待办（都关掉、退出），离开时看到的已经是选完的样子，不会再另存一份
   */
  async resolveConflict(keepMine: boolean) {
    this.set({ conflict: false });
    if (keepMine) {
      await this.saveContent(true);
      return;
    }
    await this.enqueue(async () => {
      try {
        const d = await api.readTodo(this.workspace, this.project, this.id);
        this.conflicted = false;
        this.applyDiskContent(d);
        this.lead?.onSummary(d.summary);
      } catch (e) {
        this.lead?.error(errMsg(e));
      }
    });
  }

  /** 现在的正文和撤销记录（撤销记录在最早打开的编辑器里） */
  snapshot(): UndoSnapshot | null {
    const v = this.peers.primary;
    return v ? undoSnapshot(v.state) : null;
  }

  /** 另存成的新待办（at 里的 newId）接着原来的地方编辑：编辑位置、撤销记录和编辑模式跟过去 */
  private carryTo(
    at: ProjectAt,
    newId: string,
    position: EditPosition | null,
    snap: UndoSnapshot | null,
    mode: EditorMode,
  ) {
    if (position) writeEditPosition(at.workspace, at.project, newId, position);
    if (snap) keepUndo(at.workspace, at.project, newId, snap);
    writeEditorMode(at.workspace, at.project, newId, mode);
  }

  /**
   * 冲突时「另存为新待办」，两份都保留：这里的正文连同标题（加上「（我的版本）」）存成同一项目里的一条新待办，
   * 这一条重新加载外部的版本。新的那条的正文和这里一模一样，编辑位置（position，点了对话框的那一边的）、撤销记录、
   * 编辑模式跟过去。返回新建的那条（外层打开它），失败时为 null。排在保存后面做（同 resolveConflict）
   */
  async saveAsNew(
    position: EditPosition | null,
    mode: EditorMode,
  ): Promise<{ created: TodoSummary; title: string } | null> {
    this.set({ conflict: false });
    const mine = this.content;
    const newTitle = myVersionTitle(this.title, mine);
    const snap = this.snapshot();
    let result: { created: TodoSummary; title: string } | null = null;
    await this.enqueue(async () => {
      let created: TodoSummary;
      try {
        created = await api.createTodo(this.workspace, this.project, newTitle, mine);
      } catch (e) {
        this.lead?.error(`另存为新待办失败：${errMsg(e)}`);
        this.set({ conflict: true });
        return;
      }
      this.carryTo({ workspace: this.workspace, project: this.project }, created.id, position, snap, mode);
      try {
        const d = await api.readTodo(this.workspace, this.project, this.id);
        this.conflicted = false;
        this.applyDiskContent(d);
        this.lead?.onSummary(d.summary);
      } catch {
        // 这一条在外部被删了等：由外层刷新处理。这里的内容已经在新的那条里了，不再往这一条存（离开时也不再另存）
        this.detached = true;
      }
      result = { created, title: newTitle };
    });
    return result;
  }

  /**
   * 离开这条待办时存盘：都关掉了（没有哪一边还开着它：切换待办、关标签、返回首页等），或者从托盘退出（quitting）。
   * 这时存不上的（正文在外部被改过、正显示着冲突对话框，待办或项目在外部被删了等）没法再让用户选，自动另存为新待办，
   * 两份都保留（rescue）。排在保存后面做，连着离开两次也只另存一份。返回是否都存好了（另存好了也算）
   */
  private async leave(quitting: boolean): Promise<boolean> {
    this.leaving = true;
    this.saveError = "";
    await this.flush();
    let ok = true;
    await this.enqueue(async () => {
      const problem = leaveProblem({
        unsaved: this.isDirty(),
        detached: this.detached,
        conflict: this.conflicted,
        error: this.saveError,
      });
      if (problem) ok = await this.rescue(problem, quitting);
    });
    this.leaving = false;
    return ok;
  }

  /**
   * 离开时存不上的修改另存为新待办（见 leave）：这里的正文连同标题（加上「（我的版本）」）存成同一项目里的一条新待办，
   * 原来的项目也不在了时存到快速记录存到的项目；提示新待办的标题，左侧列表刷新出它，编辑位置、撤销记录和编辑模式跟过去。
   * 另存也失败时提示，都关掉了的把正文复制到剪贴板。返回是否另存好了
   */
  private async rescue(problem: LeaveProblem, quitting: boolean): Promise<boolean> {
    const m = this.lead;
    if (!m) return false;
    const content = this.content;
    const here: ProjectAt = { workspace: this.workspace, project: this.project };
    const original = displayTitle(m.summary()).text;
    const r = await rescueAsNew(api.createTodo, here, m.quickTarget(), myVersionTitle(this.title, content), content);
    // 还开着：从托盘退出时（问用户时可能选了不退出），或者都关掉后马上又打开了
    const open = quitting || this.members.length > 0;
    if (!r.ok) {
      // 还开着的，内容在编辑区里；都关掉了的只能放进剪贴板
      let leftover: Leftover = "editor";
      if (!open) {
        const copied = await navigator.clipboard.writeText(content).then(
          () => true,
          () => false,
        );
        leftover = copied ? "clipboard" : "lost";
      }
      m.notice("error", rescueNotice(problem, original, here, r, leftover), 15);
      return false;
    }
    // 撤销记录在最早打开的编辑器里；都关掉了的，编辑器销毁时已经按原来的位置留下了，取出来给新的那条
    let snap = this.snapshot();
    if (!snap) {
      const history = takeUndo(this.workspace, this.project, this.id, content);
      snap = history ? { doc: content, history } : null;
    }
    const position = readEditPosition(this.workspace, this.project, this.id);
    this.carryTo(r.at, r.todo.id, position, snap, readEditorMode(this.workspace, this.project, this.id));
    if (!open || !problem.conflict) {
      // 之后不再往这一条存：内容已经在新的那条里了，这一条（还开着时）由外层刷新后关掉
      this.detached = true;
    } else {
      // 还开着：这一条换成外部的版本，没退出（问用户时选了不退出）也不会再另存一份
      try {
        const d = await api.readTodo(this.workspace, this.project, this.id);
        this.conflicted = false;
        this.set({ conflict: false });
        this.applyDiskContent(d);
        m.onSummary(d.summary);
      } catch {
        this.detached = true;
      }
    }
    m.notice("warning", rescueNotice(problem, original, here, r), 10);
    // 编辑器可能都已经卸载了，经事件让外层（工作区视图或首页）刷新，列出新的那条
    emitAppEvent("data-changed");
    return true;
  }

  /** 待办已被删除 / 移走：之后不再保存。撤销记录先按原来的位置留下，由 workspaceState 跟到新位置 */
  detachTodo() {
    const snap = this.snapshot();
    if (snap) keepUndo(this.workspace, this.project, this.id, snap);
    this.detached = true;
    this.stopTimer();
  }
}

/**
 * auto save 关闭时的兜底（秒）：有未保存的修改，从第一处开始满 1 小时也自动保存一次，
 * 免得程序在托盘里挂好几天、改了的内容一直只在内存里。auto save 开着时按设置的间隔（不超过 1 小时）
 */
export const FALLBACK_SAVE_SECS = 3600;
