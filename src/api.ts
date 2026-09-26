import { invoke } from "@tauri-apps/api/core";
import type {
  SaveResult,
  SettingsInfo,
  ShortcutAction,
  TodoDetail,
  TodoSummary,
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

  openTodoExternal: (workspace: string, project: string, id: string) =>
    invoke<void>("open_todo_external", { workspace, project, id }),
  revealTodo: (workspace: string, project: string, id: string) =>
    invoke<void>("reveal_todo", { workspace, project, id }),
  openFolder: (workspace?: string, project?: string) =>
    invoke<void>("open_folder", { workspace: workspace ?? null, project: project ?? null }),
  quitApp: () => invoke<void>("quit_app"),

  getSettings: () => invoke<SettingsInfo>("get_settings"),
  /** shortcut 为 null 表示不使用 */
  setShortcut: (action: ShortcutAction, shortcut: string | null) =>
    invoke<SettingsInfo>("set_shortcut", { action, shortcut }),
  pauseToggleShortcut: (paused: boolean) => invoke<SettingsInfo>("pause_toggle_shortcut", { paused }),
};

/** invoke 失败时 reject 的是 Rust 端返回的中文错误字符串 */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
