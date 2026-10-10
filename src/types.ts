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
  /** 项目路径：顶层项目是名字，子项目是「父项目/子项目」（projects.ts） */
  name: string;
  /** 只是这个项目自己的待办，不含子项目的 */
  todos: TodoSummary[];
}

export interface WorkspaceTree {
  name: string;
  /** 全部项目，包括子项目（排好序后每个顶层项目后面跟着它的子项目） */
  projects: ProjectNode[];
}

export interface WorkspaceInfo {
  name: string;
  /** 顶层项目的个数（子项目不另算） */
  projectCount: number;
  /** 待办数，包括子项目里的 */
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

/** 完成记录里的一条：已完成的待办和它在哪里 */
export interface DoneTodo {
  workspace: string;
  /** 项目路径：子项目是「父项目/子项目」（projects.ts） */
  project: string;
  todo: TodoSummary;
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

/** 一个工作区里的项目路径（快速记录选择存到哪里时用），包括子项目 */
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
  /** 每天自动备份待办数据 */
  autoBackup: boolean;
  /** 自动备份存到的目录；空串是默认的（数据目录旁边的「数据目录名-backups」） */
  autoBackupDir: string;
  /** 自动备份保留最近几份 */
  autoBackupKeep: number;
  /** 自动备份时同时上传到 WebDAV */
  autoBackupWebdav: boolean;
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

/** 备份是哪一种：设置的、待办数据的 */
export type BackupKind = "settings" | "data";

export interface RemoteBackup {
  /** 文件名，如 TodoList-settings-20260926-153012.zip、TodoList-data-20261009-153012.zip */
  name: string;
  size: number | null;
  /** 备份时间，从文件名解析 */
  time: number;
  kind: BackupKind;
}

/** 备份完待办数据 */
export interface DataBackupDone {
  /** 本地的是完整路径，WebDAV 上的是文件名 */
  path: string;
  name: string;
  workspaces: number;
  todos: number;
}

/** 本地数据备份的说明（恢复前确认时显示） */
export interface DataBackupInfo {
  name: string;
  /** 备份时间 */
  time: number;
  workspaces: number;
  todos: number;
  appVersion: string;
}

/** 恢复完待办数据 */
export interface DataRestoreDone {
  workspaces: number;
  todos: number;
  /** 备份的时间 */
  time: number;
  /** 恢复前的数据备份到了哪里（完整路径） */
  before: string;
}

/** 自动备份的一次结果：备份了、数据没有变化而跳过、失败了 */
export interface AutoBackupRun {
  time: number;
  outcome: "done" | "unchanged" | "failed";
  /** 备份的文件名 */
  name: string | null;
  /** 失败的原因 */
  error: string | null;
  /** 本地备份好了、上传 WebDAV 失败的原因 */
  webdavError: string | null;
}

export interface AutoBackupStatus {
  /** 现在用的备份目录 */
  dir: string;
  defaultDir: string;
  /** 正在自动备份 */
  running: boolean;
  /** 备份目录里最新的一份自动备份 */
  latest: { name: string; time: number } | null;
  /** 备份目录里有几份 */
  count: number;
  /** 这次运行期间最近一次自动备份的结果 */
  lastRun: AutoBackupRun | null;
}

/** 导出成什么：HTML（一个文件，图片嵌在里面）或 PDF（WebView2 把同样的 HTML 打印出来） */
export type ExportFormat = "html" | "pdf";

/** 导出的范围：一条待办、一个项目（连同子项目）、整个工作区 */
export type ExportScope = "todo" | "project" | "workspace";

/** 导出的一个项目（或子项目）和其中排好序的待办 id */
export interface ExportGroup {
  project: string;
  ids: string[];
}

/** 交给 Rust 端的导出请求：导出哪些、什么顺序由前端定（侧栏的排序），Rust 端按这个顺序从磁盘读 */
export interface ExportRequest {
  format: ExportFormat;
  /** 存到哪里（pickExportTarget 选的） */
  path: string;
  scope: ExportScope;
  workspace: string;
  /** 导出项目时是这个项目的路径 */
  project: string | null;
  /** 包含已完成的待办 */
  includeDone: boolean;
  /** 项目按侧栏的顺序（项目自己的在前，子项目跟在后面） */
  groups: ExportGroup[];
}

/** 导出完的结果 */
export interface Exported {
  /** 存到的完整路径 */
  path: string;
  /** 导出了几条待办 */
  count: number;
}
