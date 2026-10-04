export interface TodoSummary {
  id: string;
  title: string;
  /** 正文开头（已去掉 Markdown 行首标记），标题为空时显示它 */
  preview: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
  /** 置顶：在列表里排在最前面（已完成的仍排在未完成的后面） */
  pinned: boolean;
  /** 手动排序时的位置（从小到大）；没拖动排过的（新建的、移过来的）为 null，手动排序时排在最前面 */
  order: number | null;
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

/** 全文搜索命中的一条待办（正文里有关键字） */
export interface SearchHit {
  workspace: string;
  project: string;
  id: string;
  /** 正文里第一处命中附近的一段，合并成一行，前后被截掉的地方有省略号 */
  snippet: string;
}

/** 软件回收站里一项是什么 */
export type RecycleKind = "todo" | "project" | "workspace";

/** 软件回收站里的一项 */
export interface RecycleEntry {
  id: string;
  kind: RecycleKind;
  /** 原来在哪个工作区（删除的是工作区时是它自己） */
  workspace: string;
  /** 原来在哪个项目（删除的是项目时是它自己；工作区没有） */
  project: string | null;
  /** 待办的标题（没有标题时为空，显示 preview）、项目名或工作区名 */
  title: string;
  preview: string;
  done: boolean;
  deletedAt: number;
  /** 项目、工作区里有几条待办 */
  todoCount: number;
}

/** 恢复到了哪里 */
export interface Restored {
  kind: RecycleKind;
  workspace: string;
  project: string | null;
  /** 恢复的待办现在的 id（文件名被占用时换了一个） */
  todoId: string | null;
  /** 项目、工作区原来的名字被占用了，改了名（加「（恢复）」） */
  renamed: boolean;
}

export interface RestoreResult {
  restored: Restored[];
  /** 没恢复成的原因 */
  errors: string[];
}

export interface SaveResult {
  saved: boolean;
  summary: TodoSummary;
  mtime: number;
}

/** 排序：按创建时间（新的在前）、修改时间（新的在前）、标题，或手动排序（拖动调整） */
export type SortKey = "created" | "updated" | "title" | "manual";

export type ShortcutAction = "toggleWindow" | "quickCapture" | "toggleDone" | "openExternal";

/** 快速记录存到的项目 */
export interface QuickTarget {
  workspace: string;
  project: string;
}

/** 一个工作区里的项目名（快速记录选择存到哪里时用） */
export interface WorkspaceProjects {
  name: string;
  projects: string[];
}

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
  /** 全局快捷键：弹出快速记录小窗 */
  quickCaptureShortcut: string | null;
  /** 快速记录存到哪个项目，不在时保存时自动建 */
  quickCaptureTarget: QuickTarget;
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
  /** 开机自启时不显示主窗口，只在托盘里（开机自启本身记在注册表里） */
  autostartHidden: boolean;
  /** 界面主题，窗口标题栏跟着切换 */
  theme: ThemeMode;
  /** 编辑快捷键里改过的：命令（editShortcuts.ts 的 EditCommandId）→ 快捷键，null 表示不使用；没改过的不在里面 */
  editShortcuts: Record<string, string | null>;
}

export interface SettingsInfo {
  settings: AppSettings;
  defaults: AppSettings;
  /** 全局快捷键是否注册成功；设置了却为 false 说明被其他程序占用了 */
  toggleShortcutRegistered: boolean;
  quickCaptureShortcutRegistered: boolean;
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
