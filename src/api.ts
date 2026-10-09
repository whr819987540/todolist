import { invoke } from "@tauri-apps/api/core";
import type {
  AutoBackupStatus,
  DataBackupDone,
  DataBackupInfo,
  DataRestoreDone,
  EditorBackground,
  FontArea,
  ImageFile,
  Priority,
  QuickTarget,
  RecycleEntry,
  RestoreResult,
  RemoteBackup,
  SaveResult,
  SavedImage,
  SearchHit,
  SettingsInfo,
  ShortcutAction,
  StartupView,
  ThemeMode,
  TodoDetail,
  TodoSummary,
  WebDavConfig,
  WebDavInfo,
  WorkspaceInfo,
  WorkspaceProjects,
  WorkspaceTree,
} from "./types";

export const api = {
  dataRoot: () => invoke<string>("get_data_root"),

  listWorkspaces: () => invoke<WorkspaceInfo[]>("list_workspaces"),
  createWorkspace: (name: string) => invoke<string>("create_workspace", { name }),
  renameWorkspace: (name: string, newName: string) =>
    invoke<string>("rename_workspace", { name, newName }),
  /** 放进软件的回收站，返回回收站里这一项的 id（撤销删除时用） */
  deleteWorkspace: (name: string) => invoke<string>("delete_workspace", { name }),
  loadWorkspace: (workspace: string) => invoke<WorkspaceTree>("load_workspace", { workspace }),

  // 项目都是路径：顶层项目是名字，子项目是「父项目/子项目」（projects.ts）

  /** 新建项目，给了 parent（顶层项目）时是在它里面新建子项目；返回新项目的路径 */
  createProject: (workspace: string, name: string, parent?: string) =>
    invoke<string>("create_project", { workspace, name, parent: parent ?? null }),
  /** 改项目（或子项目）自己的名字，返回改名后的路径（子项目仍在原来的父项目里） */
  renameProject: (workspace: string, name: string, newName: string) =>
    invoke<string>("rename_project", { workspace, name, newName }),
  /** 放进软件的回收站（连同子项目），返回回收站里这一项的 id */
  deleteProject: (workspace: string, name: string) =>
    invoke<string>("delete_project", { workspace, name }),
  /**
   * 连同其中的待办（和子项目）移到工作区 targetWorkspace 的顶层，或放进那里的顶层项目 targetParent 成为子项目；
   * 名字不变，返回移过去后的路径。order 是放下的位置：那一层从前到后的名字（含移过去的这个），记成那一层的顺序
   * （那个工作区改成手动排序）；不给时在那里是没排过的，排在后面
   */
  moveProject: (workspace: string, name: string, targetWorkspace: string, targetParent?: string, order?: string[]) =>
    invoke<string>("move_project", {
      workspace,
      name,
      targetWorkspace,
      targetParent: targetParent ?? null,
      order: order ?? null,
    }),
  /**
   * 手动排序项目：names 是工作区的顶层（parent 不给）或父项目 parent 里的子项目从前到后的名字，这个工作区改成手动排序。
   * 本来按名称排时，别的层留着的旧顺序不再用
   */
  reorderProjects: (workspace: string, parent: string | undefined, names: string[]) =>
    invoke<void>("reorder_projects", { workspace, parent: parent ?? null, names }),
  /** 工作区的项目改成手动排序或按名称；按名称时记下的顺序留着，换回手动排序时恢复 */
  setProjectsManual: (workspace: string, manual: boolean) => invoke<void>("set_projects_manual", { workspace, manual }),

  /**
   * content 是正文，不传时新建空白待办；带正文时正文和待办在同一次调用里建好。
   * createProject 为 true 时工作区、项目不在就先建（离开待办时存不上的修改另存到快速记录存到的项目）。
   * assetsFrom 是外部修改冲突时「另存为新待办」的原来那条：复制一份它的图片（附件目录）给新的这条，正文里的链接改成新的；
   * 新的这条也带上它现在的标签和优先级
   */
  createTodo: (
    workspace: string,
    project: string,
    title: string,
    content?: string,
    createProject = false,
    assetsFrom?: { workspace: string; project: string; id: string },
  ) =>
    invoke<TodoSummary>("create_todo", {
      workspace,
      project,
      title,
      content: content ?? null,
      createProject,
      assetsFrom: assetsFrom ?? null,
    }),
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
  /** 置顶 / 取消置顶，修改时间不变 */
  setTodoPinned: (workspace: string, project: string, id: string, pinned: boolean) =>
    invoke<TodoSummary>("set_todo_pinned", { workspace, project, id, pinned }),
  /** 设置标签（全部标签，按先后），修改时间不变；有不合规则的标签时 reject 原因，什么都不改 */
  setTodoTags: (workspace: string, project: string, id: string, tags: string[]) =>
    invoke<TodoSummary>("set_todo_tags", { workspace, project, id, tags }),
  /** 设置优先级，修改时间不变 */
  setTodoPriority: (workspace: string, project: string, id: string, priority: Priority) =>
    invoke<TodoSummary>("set_todo_priority", { workspace, project, id, priority }),
  /** 工作区 workspaces 里所有待办上的标签 from（不区分大小写）改名成 to，已经有 to 的就是合并；返回改了几条 */
  renameTag: (workspaces: string[], from: string, to: string) => invoke<number>("rename_tag", { workspaces, from, to }),
  /** 工作区 workspaces 里所有待办上去掉标签 tag（不区分大小写），返回改了几条 */
  removeTag: (workspaces: string[], tag: string) => invoke<number>("remove_tag", { workspaces, tag }),
  /** 手动排序：ids 是项目里待办从前到后的顺序（修改时间不变） */
  reorderTodos: (workspace: string, project: string, ids: string[]) =>
    invoke<void>("reorder_todos", { workspace, project, ids }),
  /** 放进软件的回收站，返回回收站里这一项的 id */
  deleteTodo: (workspace: string, project: string, id: string) =>
    invoke<string>("delete_todo", { workspace, project, id }),

  /** 软件回收站里的东西，最近删除的在前 */
  listRecycle: () => invoke<RecycleEntry[]>("list_recycle"),
  /** 恢复到原来的位置（撤销删除也是它）；恢复了的话主窗口会收到 data-changed 刷新 */
  restoreRecycled: (ids: string[]) => invoke<RestoreResult>("restore_recycled", { ids }),
  /** 彻底删除：移到 Windows 回收站，返回移走了几项 */
  purgeRecycled: (ids: string[]) => invoke<number>("purge_recycled", { ids }),
  /** 清空软件的回收站（都移到 Windows 回收站） */
  emptyRecycle: () => invoke<number>("empty_recycle"),
  /**
   * 粘贴的图片（ext 是扩展名）存进待办的附件目录，返回写进正文的地址。图片的数据直接作为请求体发过去（不经 JSON），
   * 别的放在请求头里（请求头只能是 ASCII，转义过）
   */
  saveImage: (workspace: string, project: string, id: string, ext: string, data: Uint8Array) =>
    invoke<SavedImage>("save_image", data, {
      headers: {
        workspace: encodeURIComponent(workspace),
        project: encodeURIComponent(project),
        id: encodeURIComponent(id),
        ext: encodeURIComponent(ext),
      },
    }),
  /** 拖进来的图片文件（资源管理器里的路径）复制一份到待办的附件目录（原文件不动），返回写进正文的地址 */
  importImage: (workspace: string, project: string, id: string, source: string) =>
    invoke<SavedImage>("import_image", { workspace, project, id, source }),
  /** 正文里本地图片的地址（相对于项目文件夹，或绝对路径）对应的文件；找不到、不是图片时 reject 原因 */
  imageFile: (workspace: string, project: string, src: string) =>
    invoke<ImageFile>("image_file", { workspace, project, src }),
  /** 移到另一个项目，可以在别的工作区里；返回移过去后的摘要（id 可能因为重名而变） */
  moveTodo: (workspace: string, project: string, id: string, targetWorkspace: string, targetProject: string) =>
    invoke<TodoSummary>("move_todo", { workspace, project, id, targetWorkspace, targetProject }),

  /** 在正文全文里查找（不区分大小写），返回正文里有关键字的待办；workspaces 为 null 时查全部工作区 */
  searchTodos: (workspaces: string[] | null, keyword: string) =>
    invoke<SearchHit[]>("search_todos", { workspaces, keyword }),

  /** 全部工作区和其中的项目名（不读待办） */
  listProjects: () => invoke<WorkspaceProjects[]>("list_projects"),
  /**
   * 快速记录：第一行当标题、其余当正文，存到 target（不在时先建，并记成以后默认存到的地方）；
   * 存好后小窗藏起来、主窗口刷新，open 为 true 时在主窗口里打开它
   */
  quickCapture: (text: string, target: QuickTarget, open: boolean) =>
    invoke<TodoSummary>("quick_capture", { text, target, open }),
  hideQuickCapture: () => invoke<void>("hide_quick_capture"),
  setQuickCaptureTarget: (target: QuickTarget) => invoke<SettingsInfo>("set_quick_capture_target", { target }),

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
  /** 收到退出请求、开始存盘：Rust 端这一次不再强制退出，存好后调 quitApp */
  holdQuit: () => invoke<void>("hold_quit"),
  /** 有修改存不下来，这次不退出：把主窗口调出来 */
  cancelQuit: () => invoke<void>("cancel_quit"),

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
  /** 是否已设置开机自启（以注册表为准，在任务管理器里禁用了的算没开） */
  getAutostart: () => invoke<boolean>("get_autostart"),
  /** 打开 / 关闭开机自启，返回改完后的状态 */
  setAutostart: (enabled: boolean) => invoke<boolean>("set_autostart", { enabled }),
  setAutostartHidden: (hidden: boolean) => invoke<SettingsInfo>("set_autostart_hidden", { hidden }),

  getWebdav: () => invoke<WebDavInfo>("get_webdav"),
  /** password 为 null 时保留原来的密码 */
  saveWebdav: (config: WebDavConfig, password: string | null) =>
    invoke<WebDavInfo>("save_webdav", { config, password }),
  /** 用还没保存的配置测试连接；password 为 null 时用已保存的密码。返回提示文字 */
  testWebdav: (config: WebDavConfig, password: string | null) =>
    invoke<string>("test_webdav", { config, password }),
  /** 返回备份文件名 */
  backupToWebdav: () => invoke<string>("backup_to_webdav"),
  /** 弹出「另存为」对话框（从数据目录打开），返回保存的路径；取消时返回 null */
  backupToFile: () => invoke<string | null>("backup_to_file"),
  listWebdavBackups: () => invoke<RemoteBackup[]>("list_webdav_backups"),
  restoreFromWebdav: (name: string) => invoke<SettingsInfo>("restore_from_webdav", { name }),
  /** 弹出「打开」对话框（从数据目录打开）选择本地的备份包，返回路径；取消时返回 null */
  pickBackupFile: () => invoke<string | null>("pick_backup_file"),
  restoreFromFile: (path: string) => invoke<SettingsInfo>("restore_from_file", { path }),

  // 待办数据的备份与恢复

  /** 弹出「另存为」对话框（从自动备份目录打开）选择数据备份存到哪里，返回路径；取消时返回 null */
  pickDataBackupTarget: () => invoke<string | null>("pick_data_backup_target"),
  /** 把待办数据打包存到 path（后台做，数据多时要几秒） */
  backupDataToFile: (path: string) => invoke<DataBackupDone>("backup_data_to_file", { path }),
  /** 把待办数据打包上传到 WebDAV 的远程目录 */
  backupDataToWebdav: () => invoke<DataBackupDone>("backup_data_to_webdav"),
  /** 弹出「打开」对话框（从自动备份目录打开）选择要恢复的数据备份，返回路径；取消时返回 null */
  pickDataBackupFile: () => invoke<string | null>("pick_data_backup_file"),
  /** 读出本地数据备份的备份时间等；不是数据备份时 reject，说明是什么 */
  inspectDataBackup: (path: string) => invoke<DataBackupInfo>("inspect_data_backup", { path }),
  /** 用备份替换现在的全部待办数据（先自动备份一份现在的）；要经 dataBackup.ts 的 restoreData 调用 */
  restoreDataFromFile: (path: string) => invoke<DataRestoreDone>("restore_data_from_file", { path }),
  restoreDataFromWebdav: (name: string) => invoke<DataRestoreDone>("restore_data_from_webdav", { name }),
  getAutoBackupStatus: () => invoke<AutoBackupStatus>("get_auto_backup_status"),
  /** dir 为空串时用默认的备份目录；keep 超出范围时后端取边界值。改完马上检查一次 */
  setAutoBackup: (options: { enabled: boolean; dir: string; keep: number; webdav: boolean }) =>
    invoke<SettingsInfo>("set_auto_backup", options),
  /** 选备份目录的对话框，返回选中的文件夹；取消时返回 null */
  pickBackupDir: () => invoke<string | null>("pick_backup_dir"),
  openBackupDir: () => invoke<void>("open_backup_dir"),
};

/** invoke 失败时 reject 的是 Rust 端返回的中文错误字符串 */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
