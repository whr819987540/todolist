mod store;

use std::path::{Path, PathBuf};
use std::time::Duration;
use store::{Store, TodoDetail, TodoSummary, WorkspaceInfo, WorkspaceTree, SaveResult};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_window_state::StateFlags;

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

/// 前端把编辑中的内容写盘后调用，真正退出程序
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ----- 系统托盘 -----

/// 把主窗口从托盘 / 最小化状态调回前台
fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 通知前端保存后调用 quit_app；前端卡住没响应时 5 秒后强制退出
fn request_quit(app: &AppHandle) {
    let _ = app.emit("quit-requested", ());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        app.exit(0);
    });
}

/// 托盘图标：左键单击显示主窗口，右键菜单「显示主窗口 / 退出」
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("待办清单")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 已经开着时再次启动只把原窗口调到前台（包括藏在托盘里时），避免两个进程同时写同一份数据
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        // 记住窗口大小和位置；不记可见性，否则从托盘退出后会记成“隐藏”
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .setup(|app| {
            let store = Store::new(data_root(app)?)?;
            app.manage(store);
            setup_tray(app)?;
            Ok(())
        })
        // 点窗口的关闭按钮只隐藏到托盘，真正退出走托盘菜单的「退出」
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
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
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
