mod store;

use std::path::{Path, PathBuf};
use store::{Store, TodoDetail, TodoSummary, WorkspaceInfo, WorkspaceTree, SaveResult};
use tauri::{Manager, State};

type Cmd<T> = Result<T, String>;

/// 数据根目录：默认 `%USERPROFILE%\TodoList`，可用环境变量 TODOLIST_DATA_DIR 覆盖（便于测试）
fn data_root(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(dir) = std::env::var_os("TODOLIST_DATA_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    Ok(app.path().home_dir()?.join("TodoList"))
}

/// 用系统默认程序打开；没有关联程序时弹出 Windows 的“打开方式”对话框
fn open_with_default(path: &Path) -> Cmd<()> {
    if tauri_plugin_opener::open_path(path, None::<&str>).is_ok() {
        return Ok(());
    }
    std::process::Command::new("rundll32.exe")
        .arg("shell32.dll,OpenAs_RunDLL")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开文件：{e}"))
}

#[tauri::command]
fn get_data_root(store: State<'_, Store>) -> String {
    store.root().to_string_lossy().into_owned()
}

// ----- 工作区 -----

#[tauri::command]
async fn list_workspaces(store: State<'_, Store>) -> Cmd<Vec<WorkspaceInfo>> {
    store.list_workspaces()
}

#[tauri::command]
async fn create_workspace(store: State<'_, Store>, name: String) -> Cmd<String> {
    store.create_workspace(&name)
}

#[tauri::command]
async fn rename_workspace(store: State<'_, Store>, name: String, new_name: String) -> Cmd<String> {
    store.rename_workspace(&name, &new_name)
}

#[tauri::command]
async fn delete_workspace(store: State<'_, Store>, name: String) -> Cmd<()> {
    store.delete_workspace(&name)
}

#[tauri::command]
async fn load_workspace(store: State<'_, Store>, workspace: String) -> Cmd<WorkspaceTree> {
    store.load_workspace(&workspace)
}

// ----- 项目 -----

#[tauri::command]
async fn create_project(store: State<'_, Store>, workspace: String, name: String) -> Cmd<String> {
    store.create_project(&workspace, &name)
}

#[tauri::command]
async fn rename_project(
    store: State<'_, Store>,
    workspace: String,
    name: String,
    new_name: String,
) -> Cmd<String> {
    store.rename_project(&workspace, &name, &new_name)
}

#[tauri::command]
async fn delete_project(store: State<'_, Store>, workspace: String, name: String) -> Cmd<()> {
    store.delete_project(&workspace, &name)
}

// ----- 待办 -----

#[tauri::command]
async fn create_todo(
    store: State<'_, Store>,
    workspace: String,
    project: String,
    title: String,
) -> Cmd<TodoSummary> {
    store.create_todo(&workspace, &project, &title)
}

#[tauri::command]
async fn read_todo(
    store: State<'_, Store>,
    workspace: String,
    project: String,
    id: String,
) -> Cmd<TodoDetail> {
    store.read_todo(&workspace, &project, &id)
}

#[tauri::command]
async fn save_todo_content(
    store: State<'_, Store>,
    workspace: String,
    project: String,
    id: String,
    content: String,
    base_mtime: Option<i64>,
    force: bool,
) -> Cmd<SaveResult> {
    store.save_todo_content(&workspace, &project, &id, &content, base_mtime, force)
}

#[tauri::command]
async fn set_todo_title(
    store: State<'_, Store>,
    workspace: String,
    project: String,
    id: String,
    title: String,
) -> Cmd<TodoSummary> {
    store.set_todo_title(&workspace, &project, &id, &title)
}

#[tauri::command]
async fn set_todo_done(
    store: State<'_, Store>,
    workspace: String,
    project: String,
    id: String,
    done: bool,
) -> Cmd<TodoSummary> {
    store.set_todo_done(&workspace, &project, &id, done)
}

#[tauri::command]
async fn delete_todo(store: State<'_, Store>, workspace: String, project: String, id: String) -> Cmd<()> {
    store.delete_todo(&workspace, &project, &id)
}

#[tauri::command]
async fn move_todo(
    store: State<'_, Store>,
    workspace: String,
    project: String,
    id: String,
    target: String,
) -> Cmd<TodoSummary> {
    store.move_todo(&workspace, &project, &id, &target)
}

// ----- 系统集成 -----

#[tauri::command]
async fn open_todo_external(
    store: State<'_, Store>,
    workspace: String,
    project: String,
    id: String,
) -> Cmd<()> {
    open_with_default(&store.todo_path(&workspace, &project, &id)?)
}

#[tauri::command]
async fn reveal_todo(store: State<'_, Store>, workspace: String, project: String, id: String) -> Cmd<()> {
    let path = store.todo_path(&workspace, &project, &id)?;
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| format!("无法打开资源管理器：{e}"))
}

/// 在资源管理器中打开文件夹：都不传 → 数据根目录；只传工作区 → 工作区目录；都传 → 项目目录
#[tauri::command]
async fn open_folder(
    store: State<'_, Store>,
    workspace: Option<String>,
    project: Option<String>,
) -> Cmd<()> {
    let dir = match (workspace, project) {
        (Some(ws), Some(p)) => store.project_path(&ws, &p)?,
        (Some(ws), None) => store.workspace_path(&ws)?,
        _ => store.root().to_path_buf(),
    };
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| format!("无法打开文件夹：{e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 已经开着时再次启动只把原窗口调到前台，避免两个进程同时写同一份数据
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        // 记住窗口大小和位置
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let store = Store::new(data_root(app)?)?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_data_root,
            list_workspaces,
            create_workspace,
            rename_workspace,
            delete_workspace,
            load_workspace,
            create_project,
            rename_project,
            delete_project,
            create_todo,
            read_todo,
            save_todo_content,
            set_todo_title,
            set_todo_done,
            delete_todo,
            move_todo,
            open_todo_external,
            reveal_todo,
            open_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
