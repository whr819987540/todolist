// 侧栏树共用的定义：右侧显示的内容（选中项）和它在行上的键、折叠状态、待办计数
import type { WorkspaceTree } from "../../types";

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

export const countDone = (t: WorkspaceTree) => t.projects.reduce((n, p) => n + p.todos.filter((x) => x.done).length, 0);
export const countAll = (t: WorkspaceTree) => t.projects.reduce((n, p) => n + p.todos.length, 0);
