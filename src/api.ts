import { invoke } from "@tauri-apps/api/core";
import type {
  EditorBackground,
  FontArea,
  RemoteBackup,
  SaveResult,
  SettingsInfo,
  ShortcutAction,
  StartupView,
  ThemeMode,
  TodoDetail,
  TodoSummary,
  WebDavConfig,
  WebDavInfo,
  WorkspaceInfo,
  WorkspaceTree,
} from "./types";

export const api = {
  dataRoot: () => invoke<string>("get_data_root"),

  listWorkspaces: () => invoke<WorkspaceInfo[]>("list_workspaces"),
  createWorkspace: (name: string) => invoke<string>("create_workspace", { name }),
  renameWorkspace: (name: string, newName: string) =>
    invoke<string>("rename_workspace", { name, newName }),
  deleteWorkspace: (name: string) => invoke<void>("delete_workspace", { name }),
  loadWorkspace: (workspace: string) => invoke<WorkspaceTree>("load_workspace", { workspace }),

  createProject: (workspace: string, name: string) =>
    invoke<string>("create_project", { workspace, name }),
  renameProject: (workspace: string, name: string, newName: string) =>
    invoke<string>("rename_project", { workspace, name, newName }),
  deleteProject: (workspace: string, name: string) =>
    invoke<void>("delete_project", { workspace, name }),

  createTodo: (workspace: string, project: string, title: string) =>
    invoke<TodoSummary>("create_todo", { workspace, project, title }),
  readTodo: (workspace: string, project: string, id: string) =>
    invoke<TodoDetail>("read_todo", { workspace, project, id }),
  saveTodoContent: (
    workspace: string,
    project: string,
    id: string,
    content: string,
    baseMtime: number | null,
    force: boolean,
  ) =>
    invoke<SaveResult>("save_todo_content", { workspace, project, id, content, baseMtime, force }),
  setTodoTitle: (workspace: string, project: string, id: string, title: string) =>
    invoke<TodoSummary>("set_todo_title", { workspace, project, id, title }),
  setTodoDone: (workspace: string, project: string, id: string, done: boolean) =>
    invoke<TodoSummary>("set_todo_done", { workspace, project, id, done }),
  deleteTodo: (workspace: string, project: string, id: string) =>
    invoke<void>("delete_todo", { workspace, project, id }),
  moveTodo: (workspace: string, project: string, id: string, target: string) =>
    invoke<TodoSummary>("move_todo", { workspace, project, id, target }),

  /** 数据目录的 .state.json 里的界面状态（JSON 文本），还没有这个文件时是 null */
  readUiState: () => invoke<string | null>("read_ui_state"),
  writeUiState: (data: string) => invoke<void>("write_ui_state", { data }),

  openTodoExternal: (workspace: string, project: string, id: string) =>
    invoke<void>("open_todo_external", { workspace, project, id }),
  revealTodo: (workspace: string, project: string, id: string) =>
    invoke<void>("reveal_todo", { workspace, project, id }),
  /** 用浏览器 / 邮件程序打开正文里的链接，只接受 http(s) 和 mailto */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  openFolder: (workspace?: string, project?: string) =>
    invoke<void>("open_folder", { workspace: workspace ?? null, project: project ?? null }),
  quitApp: () => invoke<void>("quit_app"),

  getSettings: () => invoke<SettingsInfo>("get_settings"),
  /** shortcut 为 null 表示不使用 */
  setShortcut: (action: ShortcutAction, shortcut: string | null) =>
    invoke<SettingsInfo>("set_shortcut", { action, shortcut }),
  /** 替换编辑快捷键里改过的那些（命令 → 快捷键，null 表示不使用）；没列出的用默认值 */
  setEditShortcuts: (shortcuts: Record<string, string | null>) =>
    invoke<SettingsInfo>("set_edit_shortcuts", { shortcuts }),
  pauseToggleShortcut: (paused: boolean) => invoke<SettingsInfo>("pause_toggle_shortcut", { paused }),
  setTheme: (theme: ThemeMode) => invoke<SettingsInfo>("set_theme", { theme }),
  /** 超出范围时后端取最近的边界值 */
  setFontSize: (area: FontArea, size: number) => invoke<SettingsInfo>("set_font_size", { area, size }),
  /** customColor 是「自定义」用的颜色（#rrggbb），选别的背景色时也一起保存 */
  setEditorBackground: (background: EditorBackground, customColor: string) =>
    invoke<SettingsInfo>("set_editor_background", { background, customColor }),
  /** 超出范围的间隔后端取最近的边界值 */
  setSaveOptions: (autoSave: boolean, saveDelaySecs: number) =>
    invoke<SettingsInfo>("set_save_options", { autoSave, saveDelaySecs }),
  setStartupView: (view: StartupView) => invoke<SettingsInfo>("set_startup_view", { view }),

  getWebdav: () => invoke<WebDavInfo>("get_webdav"),
  /** password 为 null 时保留原来的密码 */
  saveWebdav: (config: WebDavConfig, password: string | null) =>
    invoke<WebDavInfo>("save_webdav", { config, password }),
  /** 用还没保存的配置测试连接；password 为 null 时用已保存的密码。返回提示文字 */
  testWebdav: (config: WebDavConfig, password: string | null) =>
    invoke<string>("test_webdav", { config, password }),
  /** 返回备份文件名 */
  backupToWebdav: () => invoke<string>("backup_to_webdav"),
  /** 弹出「另存为」对话框（从上次备份到的文件所在的文件夹打开），返回保存的路径；取消时返回 null */
  backupToFile: (lastFile: string | null) => invoke<string | null>("backup_to_file", { lastFile }),
  listWebdavBackups: () => invoke<RemoteBackup[]>("list_webdav_backups"),
  restoreFromWebdav: (name: string) => invoke<SettingsInfo>("restore_from_webdav", { name }),
  restoreFromFile: (data: Uint8Array) => invoke<SettingsInfo>("restore_from_file", { data: Array.from(data) }),
};

/** invoke 失败时 reject 的是 Rust 端返回的中文错误字符串 */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
