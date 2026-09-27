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

/** 正文文件的编码；unknown 表示认不出来，只能只读显示 */
export type TextEncoding = "UTF-8" | "UTF-16" | "GBK" | "unknown";

export interface TodoDetail {
  summary: TodoSummary;
  content: string;
  path: string;
  mtime: number;
  /** 文件现在的编码；在软件里保存后一律是 UTF-8 */
  encoding: TextEncoding;
}

export interface SaveResult {
  saved: boolean;
  summary: TodoSummary;
  mtime: number;
}

export type SortKey = "created" | "updated" | "title";

export type ShortcutAction = "toggleWindow" | "toggleDone" | "openExternal";

/** 可以单独调字号的区域：左侧列表、右侧待办编辑区 */
export type FontArea = "sidebar" | "editor";

/** 快捷键格式如 "Ctrl+Alt+T"；null 表示不使用 */
export interface AppSettings {
  /** 全局快捷键：显示主窗口 / 隐藏到托盘 */
  toggleShortcut: string | null;
  /** 应用内快捷键：标记选中的待办完成 / 未完成 */
  toggleDoneShortcut: string | null;
  /** 应用内快捷键：用默认程序打开选中的待办 */
  openExternalShortcut: string | null;
  /** 左侧工作区 / 项目 / 待办列表的字号（px） */
  sidebarFontSize: number;
  /** 右侧待办正文编辑区的字号（px） */
  editorFontSize: number;
}

export interface SettingsInfo {
  settings: AppSettings;
  defaults: AppSettings;
  /** 全局快捷键是否注册成功；设置了却为 false 说明被其他程序占用了 */
  toggleShortcutRegistered: boolean;
}

export interface WebDavConfig {
  /** 服务地址，如 https://dav.jianguoyun.com/dav/ */
  url: string;
  username: string;
  /** 存放备份的远程目录，可多级 */
  dir: string;
}

export interface WebDavInfo {
  config: WebDavConfig;
  /** 是否已保存密码（密码存在 Windows 凭据管理器，不返回给前端） */
  hasPassword: boolean;
}

export interface RemoteBackup {
  /** 文件名，如 TodoList-settings-20260926-153012.zip */
  name: string;
  size: number | null;
  /** 备份时间，从文件名解析 */
  time: number;
}
