// 界面状态：
// - 记在数据目录 .state.json 里、跟着数据走的：侧栏选中显示的工作区、上次停在哪里、每个工作区上次打开的待办、
//   右侧标签页里打开着的待办、各待办的编辑位置和编辑模式；
// - 只记在本机 localStorage 里的：每个工作区的折叠状态、排序和隐藏已完成；
// - 只在这次运行期间记在内存里的：各待办的撤销记录。
// 工作区在首页改名 / 删除时也要跟着更新（后退、前进的记录也在这时一起更新），所以放在这里供首页和工作区视图共用。

import { api } from "./api";
import type { Selection } from "./components/sidebar/tree";
import type { EditPosition, TextAnchor } from "./editor/position";
import type { EditorMode } from "./editor/setup";
import { registerFlusher } from "./hooks";
import { mapPlaces } from "./navHistory";
import { closeTabs, mapTabs, moveTab, type OpenTodo, openTab, type TodoRef } from "./tabs";
import type { SortKey } from "./types";

/** .state.json 里各项的名字 */
const OPEN_KEY = "openWorkspaces";
const LAST_VIEW_KEY = "lastView";
const LAST_TODOS_KEY = "lastTodos";
const TABS_KEY = "openTodos";
const POSITIONS_KEY = "editPositions";
const MODES_KEY = "editorModes";
/** 以前记在 localStorage 里的几项（用的也是这些名字），第一次启动时搬进 .state.json */
const FILE_KEYS = [OPEN_KEY, LAST_VIEW_KEY, LAST_TODOS_KEY, POSITIONS_KEY];
/** 按待办记的几项：工作区 / 项目改名、待办移动后跟着走 */
const PER_TODO_KEYS = [POSITIONS_KEY, MODES_KEY];

/** 按待办记的每一项（编辑位置、编辑模式）最多记这么多条待办，超出时忘掉最久没动过的 */
const MAX_PER_TODO = 300;

/** 编辑模式以前不分待办，只有一个，记在 localStorage 的这里；现在是没切换过的待办用的模式 */
const LEGACY_MODE_KEY = "editorMode";

/** .state.json 改动后多久写盘（ms），从第一处没写盘的改动算起；隐藏到托盘、退出前立即写 */
const SAVE_DELAY = 5000;

export const collapsedKey = (ws: string) => `collapsed:${ws}`;
export const listOptionsKey = (ws: string) => `listOptions:${ws}`;

/** 按工作区分别存的 localStorage 键，工作区改名、删除时跟着改 */
const PER_WORKSPACE_KEYS = [collapsedKey, listOptionsKey];

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略 */
  }
}

function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

/** 一个工作区在左侧列表（和项目概览）里的排序、是否隐藏已完成的待办、是否隐藏全部完成的项目 */
export interface ListOptions {
  sortKey: SortKey;
  hideDone: boolean;
  hideDoneProjects: boolean;
}

const isSortKey = (v: unknown): v is SortKey => v === "created" || v === "updated" || v === "title" || v === "manual";

/**
 * 这个工作区的排序和隐藏已完成。还没单独设置过的，沿用以前不分工作区时的设置（localStorage 的 sortKey / hideDone），
 * 那也没有就按创建时间排序、显示已完成；隐藏全部完成的项目是后来加的，默认不隐藏
 */
export function readListOptions(ws: string): ListOptions {
  const own = readJson<Partial<Record<keyof ListOptions, unknown>> | null>(listOptionsKey(ws), null);
  const sortKey = own?.sortKey ?? readJson<unknown>("sortKey", null);
  const hideDone = own?.hideDone ?? readJson<unknown>("hideDone", null);
  return {
    sortKey: isSortKey(sortKey) ? sortKey : "created",
    hideDone: hideDone === true,
    hideDoneProjects: own?.hideDoneProjects === true,
  };
}

// ----- 数据目录 .state.json 里的：换电脑、重装系统后还在，数据目录用网盘同步时一起同步 -----

/** 文件内容。各项在读的时候核对格式（文件可能被手改过，或者是别的版本写的），认不出的项原样留着 */
let saved: Record<string, unknown> = {};
/** 读文件出错（不是还没有这个文件）时，这次运行不写，免得把文件里原有的覆盖掉 */
let writable = true;
let dirty = false;
let timer = 0;
let writing: Promise<boolean> = Promise.resolve(true);
let loading: Promise<void> | null = null;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 启动时读一次，重复调用也只读一次；还没有这个文件时，把以前记在 localStorage 里的搬过去 */
export function loadUiState(): Promise<void> {
  loading ??= (async () => {
    let text: string | null;
    try {
      text = await api.readUiState();
    } catch {
      writable = false;
      return;
    }
    if (text != null) {
      try {
        const v: unknown = JSON.parse(text);
        if (isObject(v)) saved = v;
      } catch {
        /* 内容坏了：从头记，下次写盘时覆盖 */
      }
      return;
    }
    for (const key of FILE_KEYS) {
      const v = readJson<unknown>(key, undefined);
      if (v !== undefined) saved[key] = v;
    }
    if (!Object.keys(saved).length) return;
    dirty = true;
    if (await saveUiState()) for (const key of FILE_KEYS) remove(key);
  })();
  return loading;
}

/** 有没写盘的改动时立即写，返回是否写成功 */
function saveUiState(): Promise<boolean> {
  window.clearTimeout(timer);
  timer = 0;
  if (!writable) return Promise.resolve(false);
  if (!dirty) return writing;
  dirty = false;
  const data = JSON.stringify(saved);
  writing = writing
    .then(() => api.writeUiState(data))
    .then(
      () => true,
      () => {
        dirty = true; // 下次再试
        return false;
      },
    );
  return writing;
}

function writeSaved(key: string, value: unknown) {
  if (JSON.stringify(saved[key]) === JSON.stringify(value)) return;
  saved = { ...saved, [key]: value };
  dirty = true;
  if (!timer) timer = window.setTimeout(saveUiState, SAVE_DELAY);
}

// 隐藏到托盘、退出前写盘。flushAll 依次调用各个 flusher，正在编辑的待办在它的 flusher 里同步记下编辑位置，
// 等这一轮调用完（下一个微任务）再写，免得漏掉
registerFlusher(async () => {
  await Promise.resolve();
  await saveUiState();
});

/** 上次在侧栏选中的工作区，下次进入时恢复 */
export function readOpenWorkspaces(): string[] {
  const v = saved[OPEN_KEY];
  return Array.isArray(v) ? v.filter((ws): ws is string => typeof ws === "string" && !!ws) : [];
}
export const writeOpenWorkspaces = (list: string[]) => writeSaved(OPEN_KEY, list);

/** 上次停在哪里：null 是首页，否则是工作区里右侧显示的内容。设置里选了开屏「回到上次的位置」时用 */
export function readLastView(): Selection | null {
  const v = saved[LAST_VIEW_KEY];
  if (!isObject(v) || typeof v.workspace !== "string") return null;
  const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
  return { workspace: v.workspace, project: str(v.project), todoId: str(v.todoId) };
}
export const writeLastView = (sel: Selection | null) => writeSaved(LAST_VIEW_KEY, sel);

/** 各工作区上次打开的待办：工作区 → [项目, 待办 id] */
type LastTodos = Record<string, [project: string, id: string]>;

function readLastTodos(): LastTodos {
  const all = saved[LAST_TODOS_KEY];
  return isObject(all) ? (all as LastTodos) : {};
}

/** 这个工作区上次打开的待办，从首页进入工作区时直接打开它 */
export function readLastTodo(workspace: string): Omit<Selection, "workspace"> | null {
  const v = readLastTodos()[workspace];
  if (!Array.isArray(v) || typeof v[0] !== "string" || typeof v[1] !== "string" || !v[0] || !v[1]) return null;
  return { project: v[0], todoId: v[1] };
}

export function writeLastTodo(workspace: string, project: string, id: string) {
  const all = readLastTodos();
  const v = all[workspace];
  if (v?.[0] === project && v[1] === id) return;
  writeSaved(LAST_TODOS_KEY, { ...all, [workspace]: [project, id] });
}

// ----- 右侧标签页里打开着的待办（tabs.ts），按标签的顺序；下次打开软件还在 -----

/** 上次读出的标签：.state.json 里这一项没变时返回同一个数组（useSyncExternalStore 要求） */
let tabsRead: { raw: unknown; list: readonly OpenTodo[] } = { raw: undefined, list: [] };
const tabListeners = new Set<() => void>();
/** 正显示着的那个标签（新开的标签放在它后面）；只在这次运行期间记 */
let activeTab: TodoRef | null = null;
/** 改名、移动、删除（mapTodoState），标签变了，每次加一 */
let generation = 0;

const nonEmpty = (x: unknown): x is string => typeof x === "string" && !!x;

/** 打开着的待办；认不出、重复的项去掉 */
export function readOpenTodos(): readonly OpenTodo[] {
  const raw = saved[TABS_KEY];
  if (raw === tabsRead.raw) return tabsRead.list;
  const list: OpenTodo[] = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    if (!isObject(v) || !nonEmpty(v.workspace) || !nonEmpty(v.project) || !nonEmpty(v.todoId)) continue;
    const t = { workspace: v.workspace, project: v.project, todoId: v.todoId, preview: v.preview === true };
    if (!list.some((x) => x.workspace === t.workspace && x.project === t.project && x.todoId === t.todoId)) list.push(t);
  }
  tabsRead = { raw, list };
  return list;
}

/** 标签变了时回调，返回取消订阅的函数 */
export function subscribeOpenTodos(fn: () => void): () => void {
  tabListeners.add(fn);
  return () => {
    tabListeners.delete(fn);
  };
}

function writeOpenTodos(list: readonly OpenTodo[]) {
  if (list === readOpenTodos()) return;
  generation++;
  // 预览标签才写 preview，固定的省掉
  writeSaved(
    TABS_KEY,
    list.map(({ workspace, project, todoId, preview }) => ({ workspace, project, todoId, ...(preview && { preview }) })),
  );
  for (const fn of [...tabListeners]) fn();
}

/** 右侧显示了这条待办：还没有标签的放进预览标签，已经有的不动；记下它是正显示着的标签 */
export function showTodoTab(todo: TodoRef) {
  writeOpenTodos(openTab(readOpenTodos(), todo, false, activeTab));
  activeTab = todo;
}

/** 这条待办的标签固定下来（新建的、修改过的、双击打开的）；还没有标签的新开一个 */
export function keepTodoTab(todo: TodoRef) {
  writeOpenTodos(openTab(readOpenTodos(), todo, true, activeTab));
}

export const closeTodoTabs = (closing: readonly TodoRef[]) => writeOpenTodos(closeTabs(readOpenTodos(), closing));

/** 拖动标签：moving 挪到 target 的前面 / 后面 */
export const moveTodoTab = (moving: TodoRef, target: TodoRef, place: "before" | "after") =>
  writeOpenTodos(moveTab(readOpenTodos(), moving, target, place));

/**
 * 读数据之前记下 stateGeneration()，读完时变了的话，读到的可能还是改名、移动之前的样子，或者不含刚新建、开了标签的待办，
 * 不能据此关掉标签
 */
export const stateGeneration = () => generation;

/** 工作区刷新后，关掉其中已经不在了的待办（在外部被删除等）的标签 */
export function pruneTodoTabs(workspace: string, exists: (project: string, id: string) => boolean) {
  const list = readOpenTodos();
  writeOpenTodos(closeTabs(list, list.filter((t) => t.workspace === workspace && !exists(t.project, t.todoId))));
}

// ----- 各待办的编辑位置、编辑模式：按 [工作区, 项目, 待办 id] 记，最近记的排在最后 -----

/** 按待办记的东西用的键；后退、前进的记录里只到工作区 / 项目一级的，后面是空串 */
export type TodoKey = [workspace: string, project: string, id: string];

const todoKey = (...k: TodoKey) => JSON.stringify(k);

/** .state.json 里按待办记的一项：todoKey → 值 */
function readPerTodo(name: string): Record<string, unknown> {
  const all = saved[name];
  return isObject(all) ? all : {};
}

/** 记下一条待办的值（删了再加，排到最后；超出上限时从最前面、最久没动过的删）；value 为 undefined 时删掉 */
function writePerTodo(name: string, key: string, value: unknown) {
  const all = { ...readPerTodo(name) };
  delete all[key];
  if (value !== undefined) all[key] = value;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, keys.length - MAX_PER_TODO)) delete all[k];
  writeSaved(name, all);
}

function isAnchor(a: unknown): a is TextAnchor {
  const x = a as Partial<TextAnchor> | null;
  return typeof x?.pos === "number" && typeof x.before === "string" && typeof x.after === "string";
}

function isPosition(p: unknown): p is EditPosition {
  const x = p as Partial<EditPosition> | null;
  return (
    isAnchor(x?.cursor) &&
    (x.anchor === undefined || isAnchor(x.anchor)) &&
    isAnchor(x.view) &&
    typeof x.view.top === "number"
  );
}

/** 上次在这条待办里的编辑位置（光标、选区和滚动） */
export function readEditPosition(workspace: string, project: string, id: string): EditPosition | null {
  const p = readPerTodo(POSITIONS_KEY)[todoKey(workspace, project, id)];
  return isPosition(p) ? p : null;
}

export const writeEditPosition = (workspace: string, project: string, id: string, p: EditPosition) =>
  writePerTodo(POSITIONS_KEY, todoKey(workspace, project, id), p);

const isMode = (m: unknown): m is EditorMode => m === "live" || m === "source";

/** 没切换过的待办用的编辑模式：实时渲染；以前不分待办时选了源码模式的，沿用源码模式 */
function defaultMode(): EditorMode {
  const legacy = readJson<unknown>(LEGACY_MODE_KEY, null);
  return isMode(legacy) ? legacy : "live";
}

/** 这条待办的编辑模式（实时渲染 / 源码模式） */
export function readEditorMode(workspace: string, project: string, id: string): EditorMode {
  const m = readPerTodo(MODES_KEY)[todoKey(workspace, project, id)];
  return isMode(m) ? m : defaultMode();
}

/** 只记和默认不一样的，切回默认模式时删掉 */
export const writeEditorMode = (workspace: string, project: string, id: string, mode: EditorMode) =>
  writePerTodo(MODES_KEY, todoKey(workspace, project, id), mode === defaultMode() ? undefined : mode);

// ----- 各待办的撤销记录：只在这次运行期间记在内存里，切到别的待办再切回来时接着用 -----

/** 一条待办的撤销记录（CodeMirror 的 history 序列化后的样子），连同当时的正文 */
export interface UndoSnapshot {
  doc: string;
  history: unknown;
}

/** 最多给这么多条待办留撤销记录，超出时忘掉最久没打开的 */
const MAX_UNDOS = 50;

/** 按 todoKey 记，最近留的排在最后 */
const undos = new Map<string, UndoSnapshot>();

export function keepUndo(workspace: string, project: string, id: string, snap: UndoSnapshot) {
  const key = todoKey(workspace, project, id);
  undos.delete(key);
  undos.set(key, snap);
  for (const k of [...undos.keys()].slice(0, undos.size - MAX_UNDOS)) undos.delete(k);
}

/** 取出这条待办留着的撤销记录；正文和留下时不一样（在外部被改过）的作废，返回 null */
export function takeUndo(workspace: string, project: string, id: string, doc: string): unknown {
  const key = todoKey(workspace, project, id);
  const snap = undos.get(key);
  undos.delete(key);
  return snap?.doc === doc ? snap.history : null;
}

/**
 * 改名、移动、删除之后，记住的编辑位置、编辑模式、各工作区上次打开的待办、标签、撤销记录和后退、前进的记录跟过去；
 * fn 返回 null 的删掉
 */
function mapTodoState(fn: (key: TodoKey) => TodoKey | null) {
  generation++;
  const move = (k: string) => {
    try {
      const to = fn(JSON.parse(k) as TodoKey);
      return to && todoKey(...to);
    } catch {
      return null; // 认不出的键删掉
    }
  };
  for (const name of PER_TODO_KEYS) {
    const next: Record<string, unknown> = {};
    let changed = false;
    for (const [k, v] of Object.entries(readPerTodo(name))) {
      const nk = move(k);
      if (nk !== k) changed = true;
      if (nk) next[nk] = v;
    }
    if (changed) writeSaved(name, next);
  }
  const lastBefore = readLastTodos();
  const last: LastTodos = {};
  for (const [ws, v] of Object.entries(lastBefore)) {
    // 工作区本身改名后跟过去；待办（或它所在的项目）移到了别的工作区的，不再是这个工作区上次打开的
    const self = fn([ws, "", ""]);
    const to = Array.isArray(v) ? fn([ws, v[0], v[1]]) : null;
    if (self && to && to[0] === self[0]) last[to[0]] = [to[1], to[2]];
  }
  writeSaved(LAST_TODOS_KEY, last);
  writeOpenTodos(mapTabs(readOpenTodos(), fn));
  if (activeTab) {
    const to = fn([activeTab.workspace, activeTab.project, activeTab.todoId]);
    activeTab = to && { workspace: to[0], project: to[1], todoId: to[2] };
  }
  for (const [k, snap] of [...undos]) {
    const nk = move(k);
    if (nk === k) continue;
    undos.delete(k);
    if (nk) undos.set(nk, snap);
  }
  mapPlaces(fn);
}

export const renameProjectState = (ws: string, from: string, to: string) =>
  mapTodoState(([w, p, id]) => [w, w === ws && p === from ? to : p, id]);

/** 项目移到另一个工作区（项目名不变） */
export const moveProjectState = (ws: string, project: string, target: string) =>
  mapTodoState(([w, p, id]) => [w === ws && p === project ? target : w, p, id]);

export const forgetProjectState = (ws: string, project: string) =>
  mapTodoState((k) => (k[0] === ws && k[1] === project ? null : k));

/** 待办移到另一个项目（可以在别的工作区里），id 可能因为重名而变 */
export const moveTodoState = (ws: string, project: string, id: string, to: TodoKey) =>
  mapTodoState((k) => (k[0] === ws && k[1] === project && k[2] === id ? to : k));

export const forgetTodoState = (ws: string, project: string, id: string) =>
  mapTodoState((k) => (k[0] === ws && k[1] === project && k[2] === id ? null : k));

/** 工作区改名后，记住的选中、折叠状态、排序和隐藏已完成、上次打开的待办、编辑位置和撤销记录跟过去 */
export function renameWorkspaceState(from: string, to: string) {
  for (const key of PER_WORKSPACE_KEYS) {
    const v = readJson<unknown>(key(from), null);
    if (v == null) continue;
    writeJson(key(to), v);
    remove(key(from));
  }
  writeOpenWorkspaces(readOpenWorkspaces().map((ws) => (ws === from ? to : ws)));
  mapTodoState(([w, p, id]) => [w === from ? to : w, p, id]);
}

/** 工作区删除后不再记住它，免得以后新建同名工作区时沿用 */
export function forgetWorkspaceState(name: string) {
  for (const key of PER_WORKSPACE_KEYS) remove(key(name));
  writeOpenWorkspaces(readOpenWorkspaces().filter((ws) => ws !== name));
  mapTodoState((k) => (k[0] === name ? null : k));
}
