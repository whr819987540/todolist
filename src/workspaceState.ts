// 记在 localStorage 里的界面状态：侧栏选中显示的工作区、每个工作区的折叠状态、上次停在哪里、各待办的编辑位置；
// 以及只在这次运行期间记在内存里的各待办的撤销记录。
// 工作区在首页改名 / 删除时也要跟着更新，所以放在这里供首页和工作区视图共用。

import type { Selection } from "./components/Sidebar";
import type { EditPosition, TextAnchor } from "./editor/position";

const OPEN_KEY = "openWorkspaces";
const LAST_VIEW_KEY = "lastView";
const POSITIONS_KEY = "editPositions";

/** 最多记住这么多条待办的编辑位置，超出时忘掉最久没动过的 */
const MAX_POSITIONS = 300;

export const collapsedKey = (ws: string) => `collapsed:${ws}`;

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

/** 上次在侧栏选中的工作区，下次进入时恢复 */
export const readOpenWorkspaces = () => readJson<string[]>(OPEN_KEY, []);
export const writeOpenWorkspaces = (list: string[]) => writeJson(OPEN_KEY, list);

/** 上次停在哪里：null 是首页，否则是工作区里右侧显示的内容。设置里选了开屏「回到上次的位置」时用 */
export function readLastView(): Selection | null {
  const v = readJson<Partial<Record<keyof Selection, unknown>> | null>(LAST_VIEW_KEY, null);
  if (typeof v?.workspace !== "string") return null;
  const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
  return { workspace: v.workspace, project: str(v.project), todoId: str(v.todoId) };
}
export const writeLastView = (sel: Selection | null) => writeJson(LAST_VIEW_KEY, sel);

// ----- 各待办的编辑位置：按 [工作区, 项目, 待办 id] 记，最近记的排在最后 -----

type TodoKey = [workspace: string, project: string, id: string];
type Positions = Record<string, EditPosition>;

const todoKey = (...k: TodoKey) => JSON.stringify(k);

function readPositions(): Positions {
  const all = readJson<unknown>(POSITIONS_KEY, {});
  return all && typeof all === "object" && !Array.isArray(all) ? (all as Positions) : {};
}

function isAnchor(a: unknown): a is TextAnchor {
  const x = a as Partial<TextAnchor> | null;
  return typeof x?.pos === "number" && typeof x.before === "string" && typeof x.after === "string";
}

function isPosition(p: unknown): p is EditPosition {
  const x = p as Partial<EditPosition> | null;
  return isAnchor(x?.cursor) && isAnchor(x.view) && typeof x.view.top === "number";
}

/** 上次在这条待办里的编辑位置（光标和滚动） */
export function readEditPosition(workspace: string, project: string, id: string): EditPosition | null {
  const p = readPositions()[todoKey(workspace, project, id)];
  return isPosition(p) ? p : null;
}

export function writeEditPosition(workspace: string, project: string, id: string, p: EditPosition) {
  const all = readPositions();
  const key = todoKey(workspace, project, id);
  // 删了再加，排到最后；超出上限时从最前面（最久没动过的）删
  delete all[key];
  all[key] = p;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, keys.length - MAX_POSITIONS)) delete all[k];
  writeJson(POSITIONS_KEY, all);
}

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

/** 改名、移动、删除之后，记住的编辑位置和撤销记录跟过去；fn 返回 null 的删掉 */
function mapTodoState(fn: (key: TodoKey) => TodoKey | null) {
  const move = (k: string) => {
    try {
      const to = fn(JSON.parse(k) as TodoKey);
      return to && todoKey(...to);
    } catch {
      return null; // 认不出的键删掉
    }
  };
  const all = readPositions();
  const next: Positions = {};
  let changed = false;
  for (const [k, p] of Object.entries(all)) {
    const nk = move(k);
    if (nk !== k) changed = true;
    if (nk) next[nk] = p;
  }
  if (changed) writeJson(POSITIONS_KEY, next);
  for (const [k, snap] of [...undos]) {
    const nk = move(k);
    if (nk === k) continue;
    undos.delete(k);
    if (nk) undos.set(nk, snap);
  }
}

export const renameProjectState = (ws: string, from: string, to: string) =>
  mapTodoState(([w, p, id]) => [w, w === ws && p === from ? to : p, id]);

export const forgetProjectState = (ws: string, project: string) =>
  mapTodoState((k) => (k[0] === ws && k[1] === project ? null : k));

/** 待办移到同一工作区的另一个项目，id 可能因为重名而变 */
export const moveTodoState = (ws: string, project: string, id: string, target: string, newId: string) =>
  mapTodoState((k) => (k[0] === ws && k[1] === project && k[2] === id ? [ws, target, newId] : k));

export const forgetTodoState = (ws: string, project: string, id: string) =>
  mapTodoState((k) => (k[0] === ws && k[1] === project && k[2] === id ? null : k));

/** 工作区改名后，记住的选中、折叠状态、编辑位置和撤销记录跟过去 */
export function renameWorkspaceState(from: string, to: string) {
  const collapsed = readJson<Record<string, boolean> | null>(collapsedKey(from), null);
  if (collapsed) {
    writeJson(collapsedKey(to), collapsed);
    remove(collapsedKey(from));
  }
  writeOpenWorkspaces(readOpenWorkspaces().map((ws) => (ws === from ? to : ws)));
  mapTodoState(([w, p, id]) => [w === from ? to : w, p, id]);
}

/** 工作区删除后不再记住它，免得以后新建同名工作区时沿用 */
export function forgetWorkspaceState(name: string) {
  remove(collapsedKey(name));
  writeOpenWorkspaces(readOpenWorkspaces().filter((ws) => ws !== name));
  mapTodoState((k) => (k[0] === name ? null : k));
}
