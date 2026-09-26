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

export type ShortcutAction = "toggleWindow" | "toggleDone" | "openExternal";

/** 快捷键格式如 "Ctrl+Alt+T"；null 表示不使用 */
export interface AppSettings {
  /** 全局快捷键：显示主窗口 / 隐藏到托盘 */
  toggleShortcut: string | null;
  /** 应用内快捷键：标记选中的待办完成 / 未完成 */
  toggleDoneShortcut: string | null;
  /** 应用内快捷键：用默认程序打开选中的待办 */
  openExternalShortcut: string | null;
}

export interface SettingsInfo {
  settings: AppSettings;
  defaults: AppSettings;
  /** 全局快捷键是否注册成功；设置了却为 false 说明被其他程序占用了 */
  toggleShortcutRegistered: boolean;
}
