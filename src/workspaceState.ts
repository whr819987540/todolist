// 记在 localStorage 里的界面状态：侧栏选中显示的工作区、每个工作区的折叠状态、上次停在哪里。
// 工作区在首页改名 / 删除时也要跟着更新，所以放在这里供首页和工作区视图共用。

import type { Selection } from "./components/Sidebar";

const OPEN_KEY = "openWorkspaces";
const LAST_VIEW_KEY = "lastView";

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

/** 工作区改名后，记住的选中和折叠状态跟过去 */
export function renameWorkspaceState(from: string, to: string) {
  const collapsed = readJson<Record<string, boolean> | null>(collapsedKey(from), null);
  if (collapsed) {
    writeJson(collapsedKey(to), collapsed);
    remove(collapsedKey(from));
  }
  writeOpenWorkspaces(readOpenWorkspaces().map((ws) => (ws === from ? to : ws)));
}

/** 工作区删除后不再记住它，免得以后新建同名工作区时沿用 */
export function forgetWorkspaceState(name: string) {
  remove(collapsedKey(name));
  writeOpenWorkspaces(readOpenWorkspaces().filter((ws) => ws !== name));
}
