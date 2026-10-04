import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, type Panel, runScopeHandlers, type ViewUpdate } from "@codemirror/view";

// 正文里的查找 / 替换：Ctrl+F 打开查找框（由 WorkspaceView 转给正在编辑的待办），Ctrl+H 同时展开替换。
// 用 @codemirror/search 的搜索状态、匹配高亮和查找 / 替换命令，查找框自己实现：中文界面、显示第几个 / 共几个、
// 输入时直接跳到离光标最近的结果。查找框在编辑器顶部，不随正文滚动

/** 数匹配个数时最多数到这么多，再多显示「999+」 */
export const MAX_COUNT = 999;

/** 一次查找的结果：共几个，选中的是第几个（从 1 起；选中的不是匹配项时为 0） */
export interface MatchInfo {
  total: number;
  current: number;
  /** 超过 MAX_COUNT 个，没数完 */
  capped: boolean;
}

/** 现在的查找条件在正文里的匹配个数（最多数到 limit 个）、选中的是第几个；查找条件为空或正则写错时 total 为 0 */
export function matchInfo(state: EditorState, query: SearchQuery = getSearchQuery(state), limit = MAX_COUNT): MatchInfo {
  const info: MatchInfo = { total: 0, current: 0, capped: false };
  if (!query.valid) return info;
  const { from, to } = state.selection.main;
  const cursor = query.getCursor(state);
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    if (info.total >= limit) {
      info.capped = true;
      break;
    }
    info.total++;
    if (r.value.from === from && r.value.to === to) info.current = info.total;
  }
  return info;
}

/** 「3/12」「无结果」；条件为空时不显示 */
export function matchLabel(query: SearchQuery, info: MatchInfo): string {
  if (!query.search) return "";
  if (!query.valid) return "正则有误";
  if (!info.total) return "无结果";
  const total = info.capped ? `${MAX_COUNT}+` : String(info.total);
  return info.current ? `${info.current}/${total}` : `共 ${total} 个`;
}

/** 选中的文字适合拿来查找时（不为空、在一行里、不太长）返回它 */
export function selectedText(state: EditorState): string {
  const { from, to, empty } = state.selection.main;
  if (empty || to - from > 100) return "";
  const text = state.sliceDoc(from, to);
  return text.includes("\n") ? "" : text;
}

/** 上一次的查找条件：切换到别的待办后再打开查找框，接着用 */
let lastQuery: SearchQuery | null = null;

/**
 * 打开查找框时的条件：有选中的文字时查它，否则接着用最近一次查过的（在哪条待办里查的都算）。
 * 不用编辑器里原有的条件：编辑器刚创建时它取自当时的选区（恢复的编辑位置），不是用户查过的
 */
export function initialQuery(state: EditorState, last: SearchQuery | null): SearchQuery {
  const base = last ?? new SearchQuery({ search: "", literal: true });
  const text = selectedText(state);
  if (!text) return base;
  return new SearchQuery({
    search: text,
    caseSensitive: base.caseSensitive,
    literal: true,
    regexp: false,
    wholeWord: base.wholeWord,
    replace: base.replace,
  });
}

/** 输入查找内容时跳到从 from 往后（到末尾后从头）的第一个匹配；没有匹配返回 null */
export function firstMatchFrom(state: EditorState, query: SearchQuery, from: number): { from: number; to: number } | null {
  if (!query.valid) return null;
  const after = query.getCursor(state, from).next();
  if (!after.done) return after.value;
  const wrapped = query.getCursor(state, 0, from).next();
  return wrapped.done ? null : wrapped.value;
}

const panels = new WeakMap<EditorView, FindPanel>();

const ICONS = {
  // 展开 / 收起替换
  toggle: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  prev: '<svg viewBox="0 0 16 16"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  next: '<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  close:
    '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

function iconButton(icon: string, title: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", { type: "button", class: `cm-find-btn ${cls}`.trim(), title, "aria-label": title });
  b.innerHTML = icon;
  b.addEventListener("mousedown", (e) => e.preventDefault()); // 不抢走输入框的焦点
  b.addEventListener("click", onClick);
  return b;
}

/** 查找框：第一行查找，第二行替换（Ctrl+H 或点左边的箭头展开；只读时没有） */
class FindPanel implements Panel {
  dom: HTMLElement;
  top = true;
  private query: SearchQuery;
  private searchField: HTMLInputElement;
  private replaceField: HTMLInputElement;
  private count: HTMLElement;
  private replaceRow: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private options: { key: "caseSensitive" | "wholeWord" | "regexp"; btn: HTMLButtonElement }[];
  /** 输入查找内容时从这里往后找第一个匹配：打开查找框时光标（选区开头）的位置，之后在正文里移动过光标的按移动后的 */
  private origin: number;
  private replacing = false;

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.origin = view.state.selection.main.from;
    this.searchField = el("input", {
      class: "cm-find-input",
      placeholder: "查找",
      "aria-label": "查找",
      "main-field": "true",
      spellcheck: "false",
    });
    this.replaceField = el("input", {
      class: "cm-find-input",
      placeholder: "替换为",
      "aria-label": "替换为",
      spellcheck: "false",
    });
    for (const field of [this.searchField, this.replaceField]) {
      // 输入法组合中（拼音还没上屏）不查，上屏后再查
      field.addEventListener("input", (e) => !(e as InputEvent).isComposing && this.commit());
      field.addEventListener("compositionend", () => this.commit());
      field.addEventListener("keydown", (e) => this.keydown(e));
    }
    this.count = el("span", { class: "cm-find-count" });
    const option = (key: "caseSensitive" | "wholeWord" | "regexp", label: string, title: string) => {
      const btn = el("button", { type: "button", class: "cm-find-btn cm-find-opt", title, "aria-label": title }, [label]);
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        btn.classList.toggle("active");
        this.commit();
      });
      return { key, btn };
    };
    this.options = [
      option("caseSensitive", "Aa", "区分大小写"),
      option("wholeWord", "ab", "全字匹配"),
      option("regexp", ".*", "使用正则表达式"),
    ];
    this.toggleBtn = iconButton(ICONS.toggle, "显示替换（Ctrl+H）", () => this.showReplace(!this.replacing), "cm-find-toggle");
    const replaceBtn = el("button", { type: "button", class: "cm-find-text-btn", title: "替换当前这个（Enter）" }, ["替换"]);
    replaceBtn.addEventListener("click", () => replaceNext(this.view));
    const replaceAllBtn = el("button", { type: "button", class: "cm-find-text-btn" }, ["全部替换"]);
    replaceAllBtn.addEventListener("click", () => this.replaceAll());
    this.replaceRow = el("div", { class: "cm-find-row cm-find-replace" }, [this.replaceField, replaceBtn, replaceAllBtn]);
    this.dom = el("div", { class: "cm-find" }, [
      el("div", { class: "cm-find-row" }, [
        this.toggleBtn,
        this.searchField,
        this.count,
        ...this.options.map((o) => o.btn),
        iconButton(ICONS.prev, "上一个（Shift+Enter）", () => findPrevious(this.view)),
        iconButton(ICONS.next, "下一个（Enter）", () => findNext(this.view)),
        iconButton(ICONS.close, "关闭（Esc）", () => closeSearchPanel(this.view)),
      ]),
      this.replaceRow,
    ]);
    this.setQuery(this.query);
    this.showReplace(false);
    this.refresh(view.state);
    panels.set(view, this);
  }

  mount() {
    this.searchField.select();
  }

  destroy() {
    panels.delete(this.view);
  }

  update(update: ViewUpdate) {
    let refresh = update.docChanged || update.selectionSet;
    for (const tr of update.transactions) {
      // 在正文里移动了光标：之后输入查找内容时从新的位置往后找
      if (tr.selection && !tr.isUserEvent("select.search")) this.origin = tr.selection.main.from;
      for (const e of tr.effects)
        if (e.is(setSearchQuery) && !e.value.eq(this.query)) {
          this.setQuery(e.value);
          refresh = true;
        }
    }
    if (update.state.readOnly !== update.startState.readOnly) this.showReplace(this.replacing);
    if (refresh) this.refresh(update.state);
  }

  /** 展开 / 收起替换；只读时总是收起 */
  showReplace(on: boolean) {
    const readOnly = this.view.state.readOnly;
    this.replacing = on && !readOnly;
    this.replaceRow.hidden = !this.replacing;
    this.toggleBtn.hidden = readOnly;
    this.toggleBtn.classList.toggle("open", this.replacing);
    this.toggleBtn.title = this.replacing ? "隐藏替换" : "显示替换（Ctrl+H）";
  }

  /** Ctrl+H：展开替换；已经填了查找内容时聚焦「替换为」，否则先填查找内容 */
  focusReplace() {
    this.showReplace(true);
    if (!this.replacing || !this.searchField.value) this.focusSearch();
    else this.replaceField.select();
  }

  focusSearch() {
    this.searchField.focus();
    this.searchField.select();
  }

  private setQuery(q: SearchQuery) {
    this.query = q;
    this.searchField.value = q.search;
    this.replaceField.value = q.replace;
    for (const o of this.options) {
      o.btn.classList.toggle("active", q[o.key]);
      o.btn.setAttribute("aria-pressed", String(q[o.key]));
    }
  }

  private refresh(state: EditorState) {
    const info = matchInfo(state, this.query);
    this.count.textContent = matchLabel(this.query, info);
    this.count.classList.toggle("none", !!this.query.search && !info.total);
  }

  /** 按输入框和选项更新查找条件；查找内容变了时跳到离打开查找框时的光标最近的匹配 */
  private commit() {
    const active = (key: string) => this.options.find((o) => o.key === key)!.btn.classList.contains("active");
    // literal：按原样查，不把 \n、\t 当成换行、制表符（路径里的反斜杠也能查）；要查换行用正则
    const query = new SearchQuery({
      search: this.searchField.value,
      literal: true,
      caseSensitive: active("caseSensitive"),
      wholeWord: active("wholeWord"),
      regexp: active("regexp"),
      replace: this.replaceField.value,
    });
    for (const o of this.options) o.btn.setAttribute("aria-pressed", String(query[o.key]));
    if (query.eq(this.query)) return;
    const searchChanged =
      query.search !== this.query.search ||
      query.caseSensitive !== this.query.caseSensitive ||
      query.wholeWord !== this.query.wholeWord ||
      query.regexp !== this.query.regexp;
    this.query = query;
    lastQuery = query;
    const match = searchChanged ? firstMatchFrom(this.view.state, query, this.origin) : null;
    this.view.dispatch({
      effects: [
        setSearchQuery.of(query),
        ...(match ? [EditorView.scrollIntoView(match.from, { y: "nearest", yMargin: 80 })] : []),
      ],
      ...(match && { selection: EditorSelection.single(match.from, match.to), userEvent: "select.search" }),
    });
    this.refresh(this.view.state);
  }

  private replaceAll() {
    const before = matchInfo(this.view.state, this.query, Infinity).total;
    if (!replaceAll(this.view)) return;
    this.count.textContent = `已替换 ${before} 处`;
    this.count.classList.remove("none");
  }

  private keydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    // F3 / Shift+F3、Esc 等和编辑器里一样
    if (runScopeHandlers(this.view, e, "search-panel")) {
      e.preventDefault();
      return;
    }
    if (e.key !== "Enter" || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    if (e.target === this.replaceField) replaceNext(this.view);
    else (e.shiftKey ? findPrevious : findNext)(this.view);
  }
}

/** 查找框和匹配高亮的样式，颜色取 theme.tsx 注入的 CSS 变量；字号固定，不跟着正文字号变 */
const findTheme = EditorView.theme({
  ".cm-panels": { backgroundColor: "transparent", color: "inherit" },
  ".cm-panels.cm-panels-top": { borderBottom: "none" },
  ".cm-find": {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "10px 0",
    borderBottom: "1px dashed var(--c-border)",
    fontFamily: "var(--font)",
    fontSize: "13px",
  },
  ".cm-find-row": { display: "flex", alignItems: "center", gap: "4px" },
  ".cm-find-row[hidden]": { display: "none" },
  // 和查找框对齐（左边是展开替换的箭头）
  ".cm-find-replace": { paddingLeft: "30px" },
  ".cm-find-input": {
    flex: "0 1 280px",
    minWidth: "120px",
    height: "28px",
    padding: "0 8px",
    border: "1px solid var(--c-border-strong)",
    borderRadius: "6px",
    backgroundColor: "var(--c-bg)",
    color: "var(--c-text)",
    font: "inherit",
    outline: "none",
  },
  ".cm-find-input:focus": { borderColor: "var(--c-primary)", boxShadow: "0 0 0 2px var(--c-primary-bg)" },
  ".cm-find-btn": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "26px",
    height: "26px",
    padding: "0",
    border: "none",
    borderRadius: "4px",
    backgroundColor: "transparent",
    color: "var(--c-text-2)",
    cursor: "pointer",
  },
  ".cm-find-btn[hidden]": { display: "none" },
  ".cm-find-btn svg": { width: "16px", height: "16px" },
  ".cm-find-btn:hover": { backgroundColor: "var(--c-hover)", color: "var(--c-text)" },
  ".cm-find-opt": { fontFamily: "var(--font-mono)", fontSize: "12px" },
  ".cm-find-opt.active, .cm-find-opt.active:hover": {
    backgroundColor: "var(--c-primary-bg)",
    color: "var(--c-primary)",
  },
  ".cm-find-toggle svg": { transition: "transform 0.15s" },
  ".cm-find-toggle.open svg": { transform: "rotate(90deg)" },
  ".cm-find-count": {
    minWidth: "64px",
    padding: "0 4px",
    fontSize: "12px",
    color: "var(--c-text-3)",
    whiteSpace: "nowrap",
  },
  ".cm-find-count.none": { color: "var(--c-error)" },
  ".cm-find-text-btn": {
    height: "28px",
    padding: "0 12px",
    border: "1px solid var(--c-border-strong)",
    borderRadius: "6px",
    backgroundColor: "var(--c-bg)",
    color: "var(--c-text)",
    font: "inherit",
    cursor: "pointer",
  },
  ".cm-find-text-btn:hover": { borderColor: "var(--c-primary)", color: "var(--c-primary)" },
  ".cm-searchMatch": { backgroundColor: "var(--c-highlight)", borderRadius: "2px" },
  // 选中的那个匹配：深浅色下都用橙色底、黑字
  ".cm-searchMatch-selected, .cm-searchMatch-selected .cm-searchMatch": {
    backgroundColor: "#ff9c3a",
    color: "#000",
  },
});

/**
 * F3 / Shift+F3：找下一个 / 上一个。查找框没开着时先按 Ctrl+F 的规则打开（选中的文字，或最近一次查过的），
 * 焦点留在正文里
 */
const step = (forward: boolean) => (view: EditorView) => {
  if (!searchPanelOpen(view.state)) {
    const hadFocus = view.hasFocus;
    openFind(view);
    if (hadFocus) view.focus();
  }
  return (forward ? findNext : findPrevious)(view);
};

/** 编辑器里的查找：搜索状态、匹配高亮、查找框；F3 / Shift+F3 找下一个 / 上一个，Esc 关闭查找框 */
export function findExtensions(): Extension {
  return [
    search({
      top: true,
      literal: true,
      createPanel: (view) => new FindPanel(view),
      scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: "nearest", yMargin: 80 }),
    }),
    keymap.of([
      { key: "F3", run: step(true), shift: step(false), scope: "editor search-panel", preventDefault: true },
      { key: "Escape", run: closeSearchPanel, scope: "editor search-panel" },
    ]),
    findTheme,
  ];
}

/** 打开查找框并聚焦查找内容（replace 为 true 时展开替换并聚焦「替换为」）；已经打开时重新选中输入框里的文字 */
export function openFind(view: EditorView, replace = false): boolean {
  if (!searchPanelOpen(view.state)) {
    const query = initialQuery(view.state, lastQuery);
    // 先打开再设条件：openSearchPanel 打开时会按选区另设一个条件（多行的选区也拿来查，还丢掉替换内容）
    openSearchPanel(view);
    if (!query.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(query) });
    if (query.search) lastQuery = query;
  } else {
    const text = selectedText(view.state);
    const cur = getSearchQuery(view.state);
    if (text && text !== cur.search) view.dispatch({ effects: setSearchQuery.of(initialQuery(view.state, lastQuery)) });
  }
  const panel = panels.get(view);
  if (!panel) return false;
  if (replace) panel.focusReplace();
  else panel.focusSearch();
  return true;
}

/**
 * 换掉编辑器的整个状态（外部修改后重新加载正文，view.setState）时查找框会关掉：run 之后按原来的条件重新打开，
 * 焦点放回原来的地方
 */
export function keepFindOpen(view: EditorView, run: () => void) {
  const open = searchPanelOpen(view.state);
  const query = getSearchQuery(view.state);
  const prev = document.activeElement as HTMLElement | null;
  run();
  if (!open) return;
  openSearchPanel(view);
  view.dispatch({ effects: setSearchQuery.of(query) });
  if (prev?.isConnected && prev !== document.activeElement) prev.focus({ preventScroll: true });
}
