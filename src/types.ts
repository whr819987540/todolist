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

/** 待办编辑区的背景色：护眼米色（默认）、白色或自定义颜色；深色模式下都是深色背景 */
export type EditorBackground = "beige" | "white" | "custom";

/** 打开软件时显示首页（默认），还是回到上次的位置（侧栏选中的工作区、右侧打开的待办） */
export type StartupView = "home" | "lastPosition";

/** 界面主题：跟随系统（默认）、浅色、深色 */
export type ThemeMode = "system" | "light" | "dark";

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
  /** 右侧待办编辑区的背景色 */
  editorBackground: EditorBackground;
  /** 背景色选「自定义」时用的颜色，#rrggbb；选别的背景色时也保留 */
  editorCustomColor: string;
  /** auto save 开着时，待办的标题或正文改动后多久自动保存（秒），从第一处未保存的修改算起 */
  saveDelaySecs: number;
  /** auto save：定时保存，以及编辑器失去焦点、窗口失去焦点时立即保存；关掉时只在 Ctrl+S、切换待办和从托盘退出时保存 */
  autoSave: boolean;
  /** 打开软件时显示的界面，下次启动时生效 */
  startupView: StartupView;
  /** 界面主题，窗口标题栏跟着切换 */
  theme: ThemeMode;
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
