// 侧栏树共用的定义：右侧显示的内容（选中项）和它在行上的键、折叠状态、待办计数
import type { ProjectNode, WorkspaceTree } from "../../types";

/** 折叠状态里工作区本身用的键（项目用项目名） */
export const WS_KEY = "\u0000workspace";

/** 右侧显示的内容：只有 workspace 时是工作区概览，有 project 时是项目概览，再有 todoId 时是这条待办 */
export interface Selection {
  workspace: string;
  project?: string;
  todoId?: string;
}

export type Collapsed = Record<string, boolean>;

/** 列表里每一行对应的选中项，存在行的 data-sel 上，键盘上下移动时按显示顺序取 */
export const selKey = (s: Selection) => JSON.stringify([s.workspace, s.project ?? "", s.todoId ?? ""]);

export function parseSelKey(key: string): Selection {
  const [workspace, project, todoId] = JSON.parse(key) as string[];
  return { workspace, project: project || undefined, todoId: todoId || undefined };
}

/** 全部完成的项目：里面有待办，而且全都完成了。没有待办的（刚建的）不算 */
export const isProjectDone = (p: ProjectNode) => p.todos.length > 0 && p.todos.every((t) => t.done);

/** 没有藏起来的项目时都用这一个，侧栏的行不必重新渲染 */
const NONE_HIDDEN: ReadonlySet<string> = new Set();

/**
 * 「隐藏全部完成的项目」开着时，侧栏里藏起来的项目（名字）：全部完成的，除了右侧正在显示的那个（项目概览，或打开着其中的
 * 待办），免得正看着的东西从左边消失；侧栏搜索时什么都不藏，名字或待办命中的照常列出
 */
export function hiddenDoneProjects(
  projects: readonly ProjectNode[],
  o: { hide: boolean; keyword: string; selProject?: string },
): ReadonlySet<string> {
  if (!o.hide || o.keyword.trim()) return NONE_HIDDEN;
  const hidden = projects.filter((p) => p.name !== o.selProject && isProjectDone(p)).map((p) => p.name);
  return hidden.length ? new Set(hidden) : NONE_HIDDEN;
}

export const countDone = (t: WorkspaceTree) => t.projects.reduce((n, p) => n + p.todos.filter((x) => x.done).length, 0);
export const countAll = (t: WorkspaceTree) => t.projects.reduce((n, p) => n + p.todos.length, 0);
