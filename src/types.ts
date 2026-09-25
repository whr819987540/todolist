export interface TodoSummary {
  id: string;
  title: string;
  /** 正文开头（已去掉 Markdown 行首标记），标题为空时显示它 */
  preview: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
}

export interface ProjectNode {
  name: string;
  todos: TodoSummary[];
}

export interface WorkspaceTree {
  name: string;
  projects: ProjectNode[];
}

export interface WorkspaceInfo {
  name: string;
  projectCount: number;
  todoCount: number;
  doneCount: number;
  updatedAt: number;
}

export interface TodoDetail {
  summary: TodoSummary;
  content: string;
  path: string;
  mtime: number;
}

export interface SaveResult {
  saved: boolean;
  summary: TodoSummary;
  mtime: number;
}

export type SortKey = "created" | "updated" | "title";
