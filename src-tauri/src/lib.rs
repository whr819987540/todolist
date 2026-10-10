mod autostart;
mod backup;
mod data_backup;
mod export;
mod settings;
mod store;
mod watch;
mod webdav;

use backup::RemoteBackup;
use chrono::Local;
use data_backup::{AutoLocal, AutoRun, BackupInfo, BackupJobs, LocalBackup, Outcome, Packed, Restored};
use serde::Serialize;
use settings::{
    EditorBackground, FontArea, QuickTarget, Settings, SettingsStore, ShortcutAction, StartupView, Theme,
};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use store::{
    DoneTodo, ImageFile, RecycleEntry, RestoreResult, SaveResult, SavedImage, SearchHit, Store, TodoDetail,
    TodoRef, TodoSummary, WorkspaceInfo, WorkspaceProjects, WorkspaceTree, RECYCLE_KEEP_DAYS,
};
use tauri::ipc::{InvokeBody, Request};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};
use watch::DataChanged;
use webdav::{WebDav, WebDavConfig, WebDavInfo, WebDavStore};

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
async fn rename_workspace(
    store: State<'_, Store>,
    settings: State<'_, SettingsStore>,
    name: String,
    new_name: String,
) -> Cmd<String> {
    let new_name = store.rename_workspace(&name, &new_name)?;
    follow_quick_target(&settings, |t| (t.workspace == name).then(|| QuickTarget { workspace: new_name.clone(), ..t.clone() }));
    Ok(new_name)
}

/// 放进软件的回收站，返回回收站里这一项的 id（撤销删除时用）
#[tauri::command]
async fn delete_workspace(store: State<'_, Store>, name: String) -> Cmd<String> {
    store.delete_workspace(&name)
}

#[tauri::command]
async fn load_workspace(store: State<'_, Store>, workspace: String) -> Cmd<WorkspaceTree> {
    store.load_workspace(&workspace)
}

// ----- 项目 -----

/// 新建项目，parent 不为空时在这个顶层项目里新建子项目；返回新项目的路径（子项目是「父项目/子项目」）
#[tauri::command]
async fn create_project(
    store: State<'_, Store>,
    workspace: String,
    name: String,
    parent: Option<String>,
) -> Cmd<String> {
    match parent {
        Some(parent) => store.create_sub_project(&workspace, &parent, &name),
        None => store.create_project(&workspace, &name),
    }
}

/// 改项目（或子项目）自己的名字，返回改名后的路径
#[tauri::command]
async fn rename_project(
    store: State<'_, Store>,
    settings: State<'_, SettingsStore>,
    workspace: String,
    name: String,
    new_name: String,
) -> Cmd<String> {
    let new_name = store.rename_project(&workspace, &name, &new_name)?;
    follow_quick_target(&settings, |t| {
        let project = reparent(&t.project, &name, &new_name)?;
        (t.workspace == workspace).then(|| QuickTarget { project, ..t.clone() })
    });
    Ok(new_name)
}

/// 放进软件的回收站，返回回收站里这一项的 id
#[tauri::command]
async fn delete_project(store: State<'_, Store>, workspace: String, name: String) -> Cmd<String> {
    store.delete_project(&workspace, &name)
}

/// 项目（或子项目）移到工作区 target_workspace 的顶层，或放进它的项目 target_parent 里成为子项目；返回移过去后的路径。
/// order 是放下的位置：那一层从前到后的名字（含移过去的），记成那一层的顺序；没给时在那里排在后面
#[tauri::command]
async fn move_project(
    store: State<'_, Store>,
    settings: State<'_, SettingsStore>,
    workspace: String,
    name: String,
    target_workspace: String,
    target_parent: Option<String>,
    order: Option<Vec<String>>,
) -> Cmd<String> {
    let moved =
        store.move_project(&workspace, &name, &target_workspace, target_parent.as_deref(), order.as_deref())?;
    follow_quick_target(&settings, |t| {
        let project = reparent(&t.project, &name, &moved)?;
        (t.workspace == workspace).then(|| QuickTarget { workspace: target_workspace.clone(), project })
    });
    Ok(moved)
}

/// 手动排序项目：names 是工作区的顶层（parent 为空）或父项目 parent 里的子项目从前到后的名字；这个工作区改成手动排序
#[tauri::command]
async fn reorder_projects(
    store: State<'_, Store>,
    workspace: String,
    parent: Option<String>,
    names: Vec<String>,
) -> Cmd<()> {
    store.reorder_projects(&workspace, parent.as_deref(), &names)
}

/// 工作区的项目改成手动排序（manual 为 true）或按名称；按名称时记下的顺序留着，换回手动排序时恢复
#[tauri::command]
async fn set_projects_manual(store: State<'_, Store>, workspace: String, manual: bool) -> Cmd<()> {
    store.set_projects_manual(&workspace, manual)
}

/// 项目 from 改名、移动成 to 之后，路径 project 变成什么：就是它或它的子项目时跟着改，不相干时返回 None
fn reparent(project: &str, from: &str, to: &str) -> Option<String> {
    if project == from {
        return Some(to.to_string());
    }
    let rest = project.strip_prefix(from)?.strip_prefix(store::PROJECT_SEP)?;
    Some(format!("{to}{}{rest}", store::PROJECT_SEP))
}

/// 工作区、项目改名或移动后，快速记录存到的地方跟着改；f 返回新的目标，不相干时返回 None
fn follow_quick_target(settings: &SettingsStore, f: impl FnOnce(&QuickTarget) -> Option<QuickTarget>) {
    let mut next = settings.get();
    if let Some(t) = f(&next.quick_capture_target) {
        next.quick_capture_target = t;
        let _ = settings.save(next);
    }
}

// ----- 待办 -----

/// 新建待办；content 是正文，不传时是空白待办（外部修改冲突时「另存为新待办」带着正文一起建）。
/// create_project 为 true 时工作区、项目不在就先建（离开待办时存不上、原来的项目也不在了，另存到快速记录存到的项目）；
/// assets_from 是另存时原来那条待办，复制一份它的图片（附件目录）给新的这条，也带上它的标签和优先级
#[tauri::command]
async fn create_todo(
    store: State<'_, Store>,
    workspace: String,
    project: String,
    title: String,
    content: Option<String>,
    create_project: Option<bool>,
    assets_from: Option<TodoRef>,
) -> Cmd<TodoSummary> {
    let content = content.as_deref().unwrap_or_default();
    if create_project == Some(true) {
        store.create_todo_creating_project(&workspace, &project, &title, content, assets_from.as_ref())
    } else {
        store.create_todo_from(&workspace, &project, &title, content, assets_from.as_ref())
    }
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

/// 置顶 / 取消置顶（修改时间不变）
#[tauri::command]
async fn set_todo_pinned(
    store: State<'_, Store>,
    workspace: String,
    project: String,
    id: String,
    pinned: bool,
) -> Cmd<TodoSummary> {
    store.set_todo_pinned(&workspace, &project, &id, pinned)
}

/// 设置标签（全部标签，按先后；修改时间不变）。有不合规则的标签时不改，返回原因
#[tauri::command]
async fn set_todo_tags(
    store: State<'_, Store>,
    workspace: String,
    project: String,
    id: String,
    tags: Vec<String>,
) -> Cmd<TodoSummary> {
    store.set_todo_tags(&workspace, &project, &id, &tags)
}

/// 设置优先级：0 无、1 低、2 中、3 高（修改时间不变）
#[tauri::command]
async fn set_todo_priority(
    store: State<'_, Store>,
    workspace: String,
    project: String,
    id: String,
    priority: u8,
) -> Cmd<TodoSummary> {
    store.set_todo_priority(&workspace, &project, &id, priority)
}

/// 工作区 workspaces 里所有待办上的标签 from 改名成 to（已经有 to 的就是合并），返回改了几条
#[tauri::command]
async fn rename_tag(store: State<'_, Store>, workspaces: Vec<String>, from: String, to: String) -> Cmd<usize> {
    store.rename_tag(&workspaces, &from, &to)
}

/// 工作区 workspaces 里所有待办上去掉标签 tag，返回改了几条
#[tauri::command]
async fn remove_tag(store: State<'_, Store>, workspaces: Vec<String>, tag: String) -> Cmd<usize> {
    store.remove_tag(&workspaces, &tag)
}

/// 手动排序：ids 是项目里待办从前到后的顺序（修改时间不变）
#[tauri::command]
async fn reorder_todos(store: State<'_, Store>, workspace: String, project: String, ids: Vec<String>) -> Cmd<()> {
    store.reorder_todos(&workspace, &project, &ids)
}

/// 放进软件的回收站，返回回收站里这一项的 id
#[tauri::command]
async fn delete_todo(store: State<'_, Store>, workspace: String, project: String, id: String) -> Cmd<String> {
    store.delete_todo(&workspace, &project, &id)
}

// ----- 软件的回收站 -----

#[tauri::command]
async fn list_recycle(store: State<'_, Store>) -> Cmd<Vec<RecycleEntry>> {
    store.list_recycle()
}

/// 恢复到原来的位置（撤销删除、在回收站里恢复）；恢复了的话通知主窗口刷新
#[tauri::command]
async fn restore_recycled(app: AppHandle, store: State<'_, Store>, ids: Vec<String>) -> Cmd<RestoreResult> {
    let result = store.restore(&ids);
    if !result.restored.is_empty() {
        let _ = app.emit_to("main", "data-changed", ());
    }
    Ok(result)
}

/// 彻底删除：移到系统回收站，返回移走了几项
#[tauri::command]
async fn purge_recycled(store: State<'_, Store>, ids: Vec<String>) -> Cmd<usize> {
    store.purge(&ids)
}

/// 清空软件的回收站（都移到系统回收站）
#[tauri::command]
async fn empty_recycle(store: State<'_, Store>) -> Cmd<usize> {
    store.empty_recycle()
}

#[tauri::command]
async fn move_todo(
    store: State<'_, Store>,
    workspace: String,
    project: String,
    id: String,
    target_workspace: String,
    target_project: String,
) -> Cmd<TodoSummary> {
    store.move_todo(&workspace, &project, &id, &target_workspace, &target_project)
}

// ----- 正文里的图片 -----

/// 粘贴的图片存进待办的附件目录，返回写进正文的地址。图片的数据直接作为请求体发过来（不经 JSON，几 MB 的截图
/// 也不慢），工作区、项目、待办 id 和扩展名放在请求头里（请求头只能是 ASCII，前端按 encodeURIComponent 转义过）
#[tauri::command]
async fn save_image(store: State<'_, Store>, request: Request<'_>) -> Cmd<SavedImage> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("没有收到图片的数据".into());
    };
    let header = |name: &str| -> Cmd<String> {
        let value = request.headers().get(name).and_then(|v| v.to_str().ok()).ok_or_else(|| format!("缺少 {name}"))?;
        Ok(percent_encoding::percent_decode_str(value).decode_utf8_lossy().into_owned())
    };
    store.save_image(&header("workspace")?, &header("project")?, &header("id")?, &header("ext")?, data)
}

/// 拖进正文的图片文件（资源管理器里的路径）复制一份到待办的附件目录，返回写进正文的地址
#[tauri::command]
async fn import_image(
    store: State<'_, Store>,
    workspace: String,
    project: String,
    id: String,
    source: String,
) -> Cmd<SavedImage> {
    store.import_image(&workspace, &project, &id, Path::new(&source))
}

/// 正文里本地图片的地址（相对于项目文件夹，或绝对路径）对应的文件，前端经 asset 协议显示。数据目录在启动时整个放开了；
/// 数据目录以外的，这里只放开这一个文件，而且只放开图片（image_file 只认图片扩展名），别的文件经 asset 协议读不到
#[tauri::command]
async fn image_file(
    app: AppHandle,
    store: State<'_, Store>,
    workspace: String,
    project: String,
    src: String,
) -> Cmd<ImageFile> {
    let file = store.image_file(&workspace, &project, &src)?;
    if !Path::new(&file.path).starts_with(store.root()) {
        app.asset_protocol_scope().allow_file(&file.path).map_err(|e| format!("不能显示这张图片：{e}"))?;
    }
    Ok(file)
}

// ----- 全文搜索 -----

/// 在正文全文里查找（不区分大小写）；workspaces 为 null 时查全部工作区
#[tauri::command]
async fn search_todos(
    store: State<'_, Store>,
    workspaces: Option<Vec<String>>,
    keyword: String,
) -> Cmd<Vec<SearchHit>> {
    store.search(workspaces.as_deref(), &keyword)
}

// ----- 完成记录 -----

/// 已完成的待办；workspaces 为 null 时是全部工作区，给了 since（毫秒）时只要完成时间不早于它的
#[tauri::command]
async fn list_done_todos(
    store: State<'_, Store>,
    workspaces: Option<Vec<String>>,
    since: Option<i64>,
) -> Cmd<Vec<DoneTodo>> {
    store.list_done(workspaces.as_deref(), since)
}

// ----- 界面状态（数据目录的 .state.json） -----

#[tauri::command]
async fn read_ui_state(store: State<'_, Store>) -> Cmd<Option<String>> {
    store.read_ui_state()
}

#[tauri::command]
async fn write_ui_state(store: State<'_, Store>, data: String) -> Cmd<()> {
    store.write_ui_state(&data)
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

/// 正文里的链接只允许网页和邮件地址，免得 Ctrl+单击链接就运行了本地程序
fn is_web_link(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    ["http://", "https://", "mailto:"]
        .iter()
        .any(|p| lower.starts_with(p) && lower.len() > p.len())
}

/// 用系统默认的浏览器 / 邮件程序打开正文里的链接
#[tauri::command]
fn open_url(url: String) -> Cmd<()> {
    if !is_web_link(&url) {
        return Err("只能打开网页和邮件链接".into());
    }
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| format!("无法打开链接：{e}"))
}

/// 前端把编辑中的内容写盘后调用，真正退出程序
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// 第几次从托盘请求退出（request_quit）
static QUIT_REQUESTS: AtomicU64 = AtomicU64::new(0);
/// 前端已经收到、接手了的那一次（hold_quit）：这一次不再强制退出
static QUIT_HELD: AtomicU64 = AtomicU64::new(0);

/// 前端收到退出请求、开始存盘时调用：由前端存好后调 quit_app；有存不下来的修改时不退出，问用户（cancel_quit）
#[tauri::command]
fn hold_quit() {
    QUIT_HELD.store(QUIT_REQUESTS.load(Ordering::SeqCst), Ordering::SeqCst);
}

/// 退出前有修改存不下来（或一直没存完），这次不退出：把主窗口调出来，让用户看到提示、决定还退不退
#[tauri::command]
fn cancel_quit(app: AppHandle) {
    show_main_window(&app);
}

// ----- 快速记录 -----

const QUICK: &str = "quick";

/// 快速记录小窗：第一次用时才建，之后隐藏起来留着（启动后过一会儿也会先建好，第一次按快捷键不用等）。
/// 不能在主线程的事件处理里调用：WebView2 在那里同步建窗口可能卡死（Tauri 文档的已知问题），要在别的线程里建
fn quick_window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(QUICK) {
        return Some(w);
    }
    let mut builder = WebviewWindowBuilder::new(app, QUICK, WebviewUrl::App("quick.html".into()))
        .title("快速记录")
        .inner_size(600.0, 248.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false);
    if let Some(args) = main_browser_args(app) {
        builder = builder.additional_browser_args(&args);
    }
    let built = builder.build();
    // 两处同时在建（启动时预先建的和按了快捷键的）：后建的会因为 label 重复失败，用先建好的
    built.ok().or_else(|| app.get_webview_window(QUICK))
}

/// 主窗口的 WebView2 参数：别的窗口（快速记录小窗、打印 PDF 用的）要用一样的，同一个数据目录里参数不同的 WebView 建不起来
/// （端到端测试版经 TAURI_CONFIG 给主窗口加了远程调试端口）
fn main_browser_args(app: &AppHandle) -> Option<String> {
    let main = app.config().app.windows.iter().find(|w| w.label == "main")?;
    main.additional_browser_args.clone()
}

/// 放在鼠标所在的屏幕上，水平居中、偏上
fn place_quick_window(app: &AppHandle, w: &WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten());
    let (Some(m), Ok(size)) = (monitor, w.outer_size()) else {
        let _ = w.center();
        return;
    };
    let (pos, area) = (m.work_area().position, m.work_area().size);
    let x = pos.x + (area.width as i32 - size.width as i32) / 2;
    let y = pos.y + (area.height as i32 - size.height as i32) / 4;
    let _ = w.set_position(PhysicalPosition::new(x, y));
}

/// 弹出快速记录小窗并聚焦输入框。由全局快捷键、托盘菜单（主线程的事件处理）调用：小窗还没建好时换到别的线程里建
fn show_quick_capture(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(QUICK) {
        present_quick_window(app, &w);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(w) = quick_window(&app) {
            present_quick_window(&app, &w);
        }
    });
}

fn present_quick_window(app: &AppHandle, w: &WebviewWindow) {
    if !w.is_visible().unwrap_or(false) {
        place_quick_window(app, w);
    }
    let _ = w.show();
    #[cfg(windows)]
    hide_from_alt_tab(w);
    let _ = w.set_focus();
    // 小窗据此聚焦输入框、重新读设置（主题、存到哪里）和项目列表
    let _ = app.emit_to(QUICK, "quick-capture-shown", ());
}

/// 快速记录小窗不出现在 Alt+Tab 里：标成工具窗口（加 WS_EX_TOOLWINDOW、去掉 WS_EX_APPWINDOW）。
/// skip_taskbar 只是从任务栏上去掉按钮，Alt+Tab 里还有；tao 每次显示、隐藏窗口时都按自己记的样式重设一遍扩展样式
/// （没有所有者的窗口总带着 WS_EX_APPWINDOW），所以每次显示之后再标一次，排在主线程里 show 的后面
#[cfg(windows)]
fn hide_from_alt_tab(w: &WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };
    let Ok(hwnd) = w.hwnd() else { return };
    // HWND 是裸指针，不能直接带进别的线程
    let hwnd = hwnd.0 as isize;
    let _ = w.run_on_main_thread(move || unsafe {
        let hwnd = hwnd as windows_sys::Win32::Foundation::HWND;
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize));
    });
}

/// 快速记录的全局快捷键：小窗在前台时藏起来，否则弹出来
fn toggle_quick_capture(app: &AppHandle) {
    match app.get_webview_window(QUICK) {
        Some(w) if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) => {
            let _ = w.hide();
        }
        _ => show_quick_capture(app),
    }
}

/// 快速记录小窗失去焦点、按了 Esc 时藏起来
#[tauri::command]
fn hide_quick_capture(app: AppHandle) {
    if let Some(w) = app.get_webview_window(QUICK) {
        let _ = w.hide();
    }
}

/// 全部工作区和其中的项目名（快速记录选择存到哪里）
#[tauri::command]
async fn list_projects(store: State<'_, Store>) -> Cmd<Vec<WorkspaceProjects>> {
    store.list_projects()
}

/// 改快速记录存到的项目
#[tauri::command]
fn set_quick_capture_target(settings: State<'_, SettingsStore>, target: QuickTarget) -> Cmd<SettingsInfo> {
    let mut next = settings.get();
    next.quick_capture_target = target;
    settings.save(next)?;
    Ok(settings_info(&settings))
}

/// 主窗口里打开一条待办
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenTodo {
    workspace: String,
    project: String,
    todo_id: String,
}

/// 快速记录：第一行当标题、其余当正文，存到 target（不在时先建，并记成以后默认存到的地方）；
/// 存好后藏起小窗、通知主窗口刷新，open 为 true 时在主窗口里打开它
#[tauri::command]
async fn quick_capture(
    app: AppHandle,
    store: State<'_, Store>,
    settings: State<'_, SettingsStore>,
    text: String,
    target: QuickTarget,
    open: bool,
) -> Cmd<TodoSummary> {
    let todo = store.quick_capture(&target.workspace, &target.project, &text)?;
    // 存成功了，名字都合法；记下规整过（去掉首尾空白）的
    let target = QuickTarget {
        workspace: store::normalize_name(&target.workspace, "工作区")?,
        project: store::normalize_project_path(&target.project)?,
    };
    let mut next = settings.get();
    if next.quick_capture_target != target {
        next.quick_capture_target = target.clone();
        let _ = settings.save(next);
    }
    hide_quick_capture(app.clone());
    let _ = app.emit_to("main", "data-changed", ());
    if open {
        show_main_window(&app);
        let _ = app.emit_to(
            "main",
            "open-todo",
            OpenTodo { workspace: target.workspace, project: target.project, todo_id: todo.id.clone() },
        );
    }
    Ok(todo)
}

// ----- 系统托盘 -----

/// 记住窗口大小、位置和最大化（不记可见性，否则从托盘退出后会记成“隐藏”）
fn window_state_flags() -> StateFlags {
    StateFlags::all() & !StateFlags::VISIBLE
}

/// 开机自启、只在托盘里时主窗口还没显示过：这时还没恢复「最大化」（恢复最大化会把隐藏的窗口显示出来），
/// 等第一次显示主窗口时再恢复。Some 里是启动时窗口状态文件里主窗口的那一项（没有时为 Null），
/// 一直没显示过就退出时原样写回（见 keep_unshown_window_state）
static HIDDEN_AT_START: Mutex<Option<serde_json::Value>> = Mutex::new(None);

fn hidden_at_start() -> MutexGuard<'static, Option<serde_json::Value>> {
    HIDDEN_AT_START.lock().unwrap_or_else(|e| e.into_inner())
}

/// 记住窗口大小和位置的文件（tauri-plugin-window-state 的）
fn window_state_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(app.filename()))
}

/// 窗口状态文件里主窗口的那一项，没有时为 Null
fn saved_main_window_state(app: &AppHandle) -> serde_json::Value {
    window_state_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|mut v| v.get_mut("main").map(serde_json::Value::take))
        .unwrap_or_default()
}

/// 开机自启只在托盘里、一直没显示过主窗口就退出了：记住窗口状态的插件退出时按隐藏着的窗口记下了「没最大化」，
/// 下次正常打开时就不是最大化的了，所以把主窗口那一项改回启动时的样子。插件先于这里处理退出事件
fn keep_unshown_window_state(app: &AppHandle) {
    let Some(saved) = hidden_at_start().take() else { return };
    let Some(path) = window_state_path(app) else { return };
    let current = std::fs::read_to_string(&path).ok();
    if let Some(text) = with_window_state(current.as_deref(), "main", saved) {
        let _ = std::fs::write(&path, text);
    }
}

/// 窗口状态文件的内容 text 里 label 那一项换成 state；state 为 Null（启动时还没有记过）时不改，返回 None
fn with_window_state(text: Option<&str>, label: &str, state: serde_json::Value) -> Option<String> {
    if state.is_null() {
        return None;
    }
    let mut all: serde_json::Map<String, serde_json::Value> =
        text.and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default();
    all.insert(label.into(), state);
    serde_json::to_string_pretty(&all).ok()
}

/// 把主窗口从托盘 / 最小化状态调回前台；藏在托盘里时数据目录有变化的，这时让它刷新
fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if hidden_at_start().take().is_some() {
            let _ = w.restore_state(StateFlags::MAXIMIZED);
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(changed) = hidden_changes().take() {
            let _ = app.emit_to("main", "data-changed", changed);
        }
    }
}

// ----- 数据目录在外部变了 -----

/// 主窗口藏在托盘里时数据目录的变化先攒着，显示出来时一起发（show_main_window）
static HIDDEN_CHANGES: Mutex<Option<DataChanged>> = Mutex::new(None);

fn hidden_changes() -> MutexGuard<'static, Option<DataChanged>> {
    HIDDEN_CHANGES.lock().unwrap_or_else(|e| e.into_inner())
}

/// 监听到数据目录在外部变了（watch.rs 合并过、去掉了软件自己写的）：让主窗口刷新变了的部分（data-changed 带上变了什么）。
/// 主窗口藏在托盘里时不白白刷新，攒着等显示出来再发（显示出来获得焦点时本来也会刷新，这样没拿到焦点时也不会漏）。
/// 快速记录小窗不用通知，每次弹出时自己重新列出项目
fn on_data_changed(app: &AppHandle, changed: DataChanged) {
    let Some(w) = app.get_webview_window("main") else { return };
    // 不能拿着 HIDDEN_CHANGES 的锁问窗口是否可见：要等主线程回话，主线程上的 show_main_window 可能正等着这把锁
    if w.is_visible().unwrap_or(true) {
        let _ = app.emit_to("main", "data-changed", changed);
        return;
    }
    hidden_changes().get_or_insert_with(DataChanged::default).merge(changed);
}

/// 主窗口在前台时藏到托盘，否则（隐藏、最小化、被其他窗口挡住）调到前台
fn toggle_main_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let in_front = w.is_visible().unwrap_or(false)
        && !w.is_minimized().unwrap_or(false)
        && w.is_focused().unwrap_or(false);
    if in_front {
        let _ = w.hide();
    } else {
        show_main_window(app);
    }
}

/// 通知前端保存后调用 quit_app；前端卡住没响应（5 秒内没有 hold_quit）时强制退出。
/// 前端接手了的不强制退出：离开时存不上的修改要另存为新待办，存不下来时不退出、问用户
fn request_quit(app: &AppHandle) {
    let seq = QUIT_REQUESTS.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit("quit-requested", ());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        if QUIT_HELD.load(Ordering::SeqCst) < seq {
            app.exit(0);
        }
    });
}

/// 托盘图标：左键单击显示主窗口，右键菜单「显示主窗口 / 退出」
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "快速记录", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quick, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("待办清单")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "show" => show_main_window(app),
            "quick" => show_quick_capture(app),
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

// ----- 窗口图标 -----

/// Tauri 只给窗口设了小图标（ICON_SMALL），大图标和窗口类图标都是空的，
/// Alt+Tab、任务栏缩略图等用大图标的地方就会显示系统默认图标。
/// 这里从 exe 资源里（tauri-build 以 ID 32512 嵌入的 icon.ico）按当前 DPI 取合适尺寸，大小图标都补上。
#[cfg(windows)]
fn set_window_icons(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_DEFAULTCOLOR, SM_CXICON,
        SM_CXSMICON, WM_SETICON,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0;
    unsafe {
        let dpi = GetDpiForWindow(hwnd);
        let module = GetModuleHandleW(std::ptr::null());
        for (kind, metric) in [(ICON_BIG, SM_CXICON), (ICON_SMALL, SM_CXSMICON)] {
            let size = GetSystemMetricsForDpi(metric, dpi);
            let icon = LoadImageW(module, 32512usize as *const u16, IMAGE_ICON, size, size, LR_DEFAULTCOLOR);
            if !icon.is_null() {
                SendMessageW(hwnd, WM_SETICON, kind as usize, icon as isize);
            }
        }
    }
}

// ----- 全局快捷键 -----

/// 设置了的全局快捷键（显示 / 隐藏主窗口、快速记录）和最近一次注册是否成功：按下时按这张表找是哪个操作。
/// 录制快捷键时的临时暂停不算注册失败，所以不能直接用 is_registered 判断
static GLOBAL_KEYS: Mutex<Vec<(ShortcutAction, Shortcut, bool)>> = Mutex::new(Vec::new());

fn global_keys() -> MutexGuard<'static, Vec<(ShortcutAction, Shortcut, bool)>> {
    GLOBAL_KEYS.lock().unwrap_or_else(|e| e.into_inner())
}

/// 按设置重新注册全部全局快捷键（先清掉旧的），返回注册失败（被其他程序占用）的那些
fn register_global_shortcuts(app: &AppHandle, s: &Settings) -> Vec<ShortcutAction> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut table = Vec::new();
    let mut failed = Vec::new();
    for action in ShortcutAction::GLOBAL {
        let Some(shortcut) = s.shortcut(action).and_then(|t| parse_shortcut(t).ok()) else {
            continue;
        };
        let ok = gs.register(shortcut).is_ok();
        if !ok {
            failed.push(action);
        }
        table.push((action, shortcut, ok));
    }
    *global_keys() = table;
    failed
}

/// 全局快捷键被按下
fn on_global_shortcut(app: &AppHandle, shortcut: &Shortcut) {
    let action = global_keys().iter().find(|(_, s, _)| s == shortcut).map(|(a, _, _)| *a);
    match action {
        Some(ShortcutAction::ToggleWindow) => toggle_main_window(app),
        Some(ShortcutAction::QuickCapture) => toggle_quick_capture(app),
        _ => {}
    }
}

/// 这个全局快捷键最近一次是否注册成功
fn registered(action: ShortcutAction) -> bool {
    global_keys().iter().any(|(a, _, ok)| *a == action && *ok)
}

fn parse_shortcut(text: &str) -> Cmd<Shortcut> {
    text.parse().map_err(|_| format!("无法识别的快捷键：{text}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsInfo {
    settings: Settings,
    defaults: Settings,
    /// 全局快捷键是否注册成功；设置了却为 false 说明被其他程序占用了
    toggle_shortcut_registered: bool,
    quick_capture_shortcut_registered: bool,
}

fn settings_info(store: &SettingsStore) -> SettingsInfo {
    SettingsInfo {
        settings: store.get(),
        defaults: Settings::default(),
        toggle_shortcut_registered: registered(ShortcutAction::ToggleWindow),
        quick_capture_shortcut_registered: registered(ShortcutAction::QuickCapture),
    }
}

#[tauri::command]
fn get_settings(settings: State<'_, SettingsStore>) -> SettingsInfo {
    settings_info(&settings)
}

/// 修改某个快捷键（None 表示不使用）；和其他操作的快捷键重复时拒绝
#[tauri::command]
fn set_shortcut(
    app: AppHandle,
    settings: State<'_, SettingsStore>,
    action: ShortcutAction,
    shortcut: Option<String>,
) -> Cmd<SettingsInfo> {
    let old = settings.get();
    if let Some(text) = shortcut.as_deref() {
        let parsed = parse_shortcut(text)?;
        for other in ShortcutAction::ALL {
            if other != action && old.shortcut(other).and_then(|s| s.parse::<Shortcut>().ok()) == Some(parsed) {
                return Err(format!("{text} 已用于「{}」，请换一个", other.label()));
            }
        }
    }
    let mut next = old.clone();
    next.set_shortcut(action, shortcut.clone());
    if !ShortcutAction::GLOBAL.contains(&action) {
        settings.save(next)?;
        return Ok(settings_info(&settings));
    }
    let saved = if register_global_shortcuts(&app, &next).contains(&action) {
        Err(format!(
            "快捷键 {} 注册失败，可能已被其他程序占用，请换一个",
            shortcut.unwrap_or_default()
        ))
    } else {
        settings.save(next)
    };
    if let Err(e) = saved {
        // 新的用不了就恢复原来的
        register_global_shortcuts(&app, &old);
        return Err(e);
    }
    Ok(settings_info(&settings))
}

/// 替换编辑快捷键里改过的那些（命令 → 快捷键，None 表示不使用；没列出的用默认值）。
/// 互不重复、不和应用快捷键重复由前端检查，前端知道每个命令的默认值
#[tauri::command]
fn set_edit_shortcuts(
    settings: State<'_, SettingsStore>,
    shortcuts: BTreeMap<String, Option<String>>,
) -> Cmd<SettingsInfo> {
    let mut next = settings.get();
    next.edit_shortcuts = shortcuts;
    settings.save(next)?;
    Ok(settings_info(&settings))
}

/// 设置界面录制快捷键期间暂停全部全局快捷键，否则按下当前快捷键会直接把窗口藏起来（弹出快速记录）、录不到。
/// 返回最新设置：恢复时可能注册失败（暂停期间被其他程序占用了）
#[tauri::command]
fn pause_toggle_shortcut(app: AppHandle, settings: State<'_, SettingsStore>, paused: bool) -> SettingsInfo {
    if paused {
        let _ = app.global_shortcut().unregister_all();
    } else {
        register_global_shortcuts(&app, &settings.get());
    }
    settings_info(&settings)
}

// ----- 外观：主题、字号、编辑区背景色 -----

/// 修改界面主题：浅色、深色或跟随系统
#[tauri::command]
fn set_theme(settings: State<'_, SettingsStore>, theme: Theme) -> Cmd<SettingsInfo> {
    let mut next = settings.get();
    next.theme = theme;
    settings.save(next)?;
    Ok(settings_info(&settings))
}

/// 修改左侧列表或编辑区的字号，超出范围时取最近的边界值
#[tauri::command]
fn set_font_size(settings: State<'_, SettingsStore>, area: FontArea, size: u32) -> Cmd<SettingsInfo> {
    let mut next = settings.get();
    next.set_font_size(area, size);
    settings.save(next)?;
    Ok(settings_info(&settings))
}

/// 修改编辑区背景色；custom_color 是「自定义」用的颜色（`#rrggbb`），选别的背景色时也一起保存
#[tauri::command]
fn set_editor_background(
    settings: State<'_, SettingsStore>,
    background: EditorBackground,
    custom_color: String,
) -> Cmd<SettingsInfo> {
    let color = settings::parse_color(&custom_color).ok_or_else(|| format!("无法识别的颜色：{custom_color}"))?;
    let mut next = settings.get();
    next.editor_background = background;
    next.editor_custom_color = color;
    settings.save(next)?;
    Ok(settings_info(&settings))
}

// ----- 保存方式 -----

/// 修改定时保存的间隔（秒，超出范围取边界值）和 auto save 开关
#[tauri::command]
fn set_save_options(settings: State<'_, SettingsStore>, auto_save: bool, save_delay_secs: u32) -> Cmd<SettingsInfo> {
    let mut next = settings.get();
    next.auto_save = auto_save;
    next.save_delay_secs = save_delay_secs;
    settings.save(next)?;
    Ok(settings_info(&settings))
}

// ----- 启动 -----

/// 修改打开软件时显示首页还是回到上次的位置，下次启动时生效
#[tauri::command]
fn set_startup_view(settings: State<'_, SettingsStore>, view: StartupView) -> Cmd<SettingsInfo> {
    let mut next = settings.get();
    next.startup_view = view;
    settings.save(next)?;
    Ok(settings_info(&settings))
}

// ----- 开机自启 -----

/// 开机自启的启动项名（注册表 Run 里），用产品名：卸载程序会删掉同名的这一项
fn autostart_name(app: &AppHandle) -> String {
    app.package_info().name.clone()
}

/// 是否已设置开机自启（以注册表为准，在任务管理器里禁用了的算没开）
#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    autostart::is_enabled(&autostart_name(&app))
}

/// 打开 / 关闭开机自启，返回改完后的状态
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Cmd<bool> {
    let exe = std::env::current_exe().map_err(|e| format!("找不到程序的位置：{e}"))?;
    autostart::set(&autostart_name(&app), &exe, enabled)?;
    Ok(autostart::is_enabled(&autostart_name(&app)))
}

/// 修改开机自启时是否只在托盘里、不显示主窗口
#[tauri::command]
fn set_autostart_hidden(settings: State<'_, SettingsStore>, hidden: bool) -> Cmd<SettingsInfo> {
    let mut next = settings.get();
    next.autostart_hidden = hidden;
    settings.save(next)?;
    Ok(settings_info(&settings))
}

// ----- 设置备份（WebDAV、本地文件） -----

#[tauri::command]
fn get_webdav(webdav: State<'_, WebDavStore>) -> WebDavInfo {
    webdav.info()
}

/// password 为 null 时保留原来的密码
#[tauri::command]
fn save_webdav(webdav: State<'_, WebDavStore>, config: WebDavConfig, password: Option<String>) -> Cmd<WebDavInfo> {
    webdav.save(&config, password.as_deref())?;
    Ok(webdav.info())
}

/// 用界面上还没保存的配置测试连接；password 为 null 时用已保存的密码
#[tauri::command]
async fn test_webdav(
    webdav: State<'_, WebDavStore>,
    config: WebDavConfig,
    password: Option<String>,
) -> Cmd<String> {
    let password = match password {
        Some(p) => p,
        None => webdav.password()?.unwrap_or_default(),
    };
    let client = WebDav::new(&config, &password)?;
    let dir = client.dir_label();
    Ok(if client.check().await? {
        format!("连接成功，远程目录{dir}已存在")
    } else {
        format!("连接成功，远程目录{dir}还不存在，第一次备份时会自动创建")
    })
}

/// 把当前设置打包上传，返回备份文件名
#[tauri::command]
async fn backup_to_webdav(settings: State<'_, SettingsStore>, webdav: State<'_, WebDavStore>) -> Cmd<String> {
    let now = Local::now();
    let name = backup::file_name(now);
    let data = backup::pack(&settings.get(), now)?;
    webdav.connect()?.upload(&name, data).await?;
    Ok(name)
}

/// 本地备份、恢复用的文件对话框：挂在主窗口上，只列 zip，总是从数据目录打开
fn backup_file_dialog(window: &WebviewWindow, store: &Store, title: &str) -> FileDialogBuilder<tauri::Wry> {
    window
        .dialog()
        .file()
        .set_parent(window)
        .set_title(title)
        .add_filter("设置备份", &["zip"])
        .set_directory(store.root())
}

/// 弹出「另存为」对话框，把当前设置打包存到选好的位置；返回保存的路径，取消时返回 null
#[tauri::command]
async fn backup_to_file(
    window: WebviewWindow,
    store: State<'_, Store>,
    settings: State<'_, SettingsStore>,
) -> Cmd<Option<String>> {
    let now = Local::now();
    let picked = backup_file_dialog(&window, &store, "备份设置到本地")
        .set_file_name(backup::file_name(now))
        .blocking_save_file();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| format!("无法保存到这个位置：{e}"))?;
    let data = backup::pack(&settings.get(), now)?;
    std::fs::write(&path, data).map_err(|e| format!("保存备份失败：{e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn list_webdav_backups(webdav: State<'_, WebDavStore>) -> Cmd<Vec<RemoteBackup>> {
    Ok(backup::backups(webdav.connect()?.list().await?))
}

#[tauri::command]
async fn restore_from_webdav(
    app: AppHandle,
    settings: State<'_, SettingsStore>,
    webdav: State<'_, WebDavStore>,
    name: String,
) -> Cmd<SettingsInfo> {
    let data = webdav.connect()?.download(&name).await?;
    restore_settings(&app, &settings, backup::unpack(&data)?)
}

/// 弹出「打开」对话框选择本地的备份包，返回选中的路径；取消时返回 null。恢复前前端要先确认，再调 restore_from_file
#[tauri::command]
async fn pick_backup_file(window: WebviewWindow, store: State<'_, Store>) -> Cmd<Option<String>> {
    let Some(path) = backup_file_dialog(&window, &store, "从本地文件恢复设置").blocking_pick_file() else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| format!("无法打开这个文件：{e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 从本地的备份包恢复（路径来自 pick_backup_file）
#[tauri::command]
fn restore_from_file(app: AppHandle, settings: State<'_, SettingsStore>, path: String) -> Cmd<SettingsInfo> {
    restore_settings(&app, &settings, backup::read_file(Path::new(&path))?)
}

fn restore_settings(app: &AppHandle, settings: &SettingsStore, mut next: Settings) -> Cmd<SettingsInfo> {
    // 加快速记录之前的备份里，别的快捷键可能已经设成了快速记录的默认按键
    next.normalize();
    check_shortcuts(&next)?;
    settings.save(next.clone())?;
    // 全局快捷键被占用不影响恢复，设置界面会提示
    register_global_shortcuts(app, &next);
    // 自动备份的设置可能变了，马上检查一次
    app.state::<BackupJobs>().wake();
    Ok(settings_info(settings))
}

/// 恢复的设置里，快捷键要都能识别、互不重复
fn check_shortcuts(s: &Settings) -> Cmd<()> {
    let mut seen: Vec<(ShortcutAction, Shortcut)> = Vec::new();
    for action in ShortcutAction::ALL {
        let Some(text) = s.shortcut(action) else { continue };
        let parsed = parse_shortcut(text)?;
        if let Some((other, _)) = seen.iter().find(|(_, p)| *p == parsed) {
            return Err(format!(
                "备份里的快捷键 {text} 同时用于「{}」和「{}」，无法恢复",
                other.label(),
                action.label()
            ));
        }
        seen.push((action, parsed));
    }
    Ok(())
}

// ----- 待办数据的备份与恢复（data_backup.rs） -----

/// 设置里的自动备份目录（空的是默认的，数据目录旁边的「数据目录名-backups」）
fn data_backup_dir(app: &AppHandle) -> PathBuf {
    data_backup::backup_dir(&app.state::<SettingsStore>().get().auto_backup_dir, app.state::<Store>().root())
}

/// 打包、解压这些可能要好几秒的事放到后台线程里做，不占着处理命令的线程
async fn in_background<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&AppHandle) -> Cmd<T> + Send + 'static) -> Cmd<T> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || f(&app))
        .await
        .map_err(|e| format!("后台任务出错：{e}"))?
}

/// 本地备份、恢复数据用的文件对话框：挂在主窗口上，只列 zip，从自动备份目录打开（还没有这个目录时先建；
/// 设置里的目录不合用时（恢复的别的电脑的设置里，可能在这里的数据目录里面）不建，免得建出一个工作区）
fn data_backup_dialog(app: &AppHandle, window: &WebviewWindow, title: &str) -> FileDialogBuilder<tauri::Wry> {
    let dir = data_backup_dir(app);
    if data_backup::check_backup_dir(&dir, app.state::<Store>().root()).is_ok() {
        let _ = std::fs::create_dir_all(&dir);
    }
    window
        .dialog()
        .file()
        .set_parent(window)
        .set_title(title)
        .add_filter("待办数据备份", &["zip"])
        .set_directory(dir)
}

/// 弹出「另存为」对话框选择数据备份存到哪里，返回路径；取消时返回 null。之后前端调 backup_data_to_file
#[tauri::command]
async fn pick_data_backup_target(app: AppHandle, window: WebviewWindow) -> Cmd<Option<String>> {
    let picked = data_backup_dialog(&app, &window, "备份数据到本地")
        .set_file_name(data_backup::file_name(Local::now()))
        .blocking_save_file();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| format!("无法保存到这个位置：{e}"))?;
    data_backup::check_target(&path, app.state::<Store>().root())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 把待办数据打包存到 path（在后台线程里做）
#[tauri::command]
async fn backup_data_to_file(app: AppHandle, path: String) -> Cmd<Packed> {
    in_background(&app, move |app| {
        let store = app.state::<Store>();
        let path = PathBuf::from(path);
        data_backup::check_target(&path, store.root())?;
        let _busy = app.state::<BackupJobs>().inner().exclusive();
        data_backup::pack(&store, &path, Local::now())
    })
    .await
}

/// 把待办数据打包上传到 WebDAV 的远程目录（先打包到系统的临时目录，传完删掉）
#[tauri::command]
async fn backup_data_to_webdav(app: AppHandle, webdav: State<'_, WebDavStore>) -> Cmd<Packed> {
    let dav = webdav.connect()?;
    let now = Local::now();
    let name = data_backup::file_name(now);
    let tmp = std::env::temp_dir().join(format!("todolist-upload-{}-{name}", std::process::id()));
    let packing = tmp.clone();
    let packed = in_background(&app, move |app| {
        let _busy = app.state::<BackupJobs>().inner().exclusive();
        data_backup::pack(&app.state::<Store>(), &packing, now)
    })
    .await;
    let uploaded = match packed {
        Ok(p) => data_backup::upload(&dav, &tmp, &name, None).await.map(|_| Packed { path: name.clone(), ..p }),
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_file(&tmp);
    uploaded
}

/// 弹出「打开」对话框（从自动备份目录打开）选择要恢复的数据备份，返回路径；取消时返回 null。
/// 之后前端调 inspect_data_backup 读出备份时间等，确认后调 restore_data_from_file
#[tauri::command]
async fn pick_data_backup_file(app: AppHandle, window: WebviewWindow) -> Cmd<Option<String>> {
    let Some(path) = data_backup_dialog(&app, &window, "从本地文件恢复数据").blocking_pick_file() else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| format!("无法打开这个文件：{e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 读出本地数据备份的说明（备份时间、几个工作区几条待办）；不是数据备份时说明是什么
#[tauri::command]
async fn inspect_data_backup(path: String) -> Cmd<BackupInfo> {
    data_backup::inspect(Path::new(&path))
}

/// 用本地的数据备份恢复（在后台线程里做）
#[tauri::command]
async fn restore_data_from_file(app: AppHandle, path: String) -> Cmd<Restored> {
    in_background(&app, move |app| {
        let _busy = app.state::<BackupJobs>().inner().exclusive();
        data_backup::restore_file(&app.state::<Store>(), Path::new(&path), &data_backup_dir(app), Local::now())
    })
    .await
}

/// 用 WebDAV 上的数据备份恢复：先下载到数据目录里的临时文件夹
#[tauri::command]
async fn restore_data_from_webdav(app: AppHandle, webdav: State<'_, WebDavStore>, name: String) -> Cmd<Restored> {
    let dav = webdav.connect()?;
    let now = Local::now();
    let staging = data_backup::staging_dir(app.state::<Store>().root(), now)?;
    let zip = staging.join("download.zip");
    let result = match dav.download_to(&name, &zip).await {
        Ok(()) => {
            let (staging, zip) = (staging.clone(), zip.clone());
            in_background(&app, move |app| {
                let _busy = app.state::<BackupJobs>().inner().exclusive();
                data_backup::restore_at(&app.state::<Store>(), &staging, &zip, &data_backup_dir(app), now)
            })
            .await
        }
        Err(e) => Err(e),
    };
    data_backup::clean_staging(&staging);
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoBackupStatus {
    /// 现在用的备份目录
    dir: String,
    default_dir: String,
    /// 正在自动备份
    running: bool,
    /// 备份目录里最新的一份自动备份
    latest: Option<LocalBackup>,
    /// 备份目录里有几份
    count: usize,
    /// 这次运行期间最近一次自动备份的结果
    last_run: Option<AutoRun>,
}

#[tauri::command]
fn get_auto_backup_status(app: AppHandle, jobs: State<'_, BackupJobs>) -> AutoBackupStatus {
    let dir = data_backup_dir(&app);
    let list = data_backup::local_backups(&dir);
    AutoBackupStatus {
        default_dir: data_backup::default_dir(app.state::<Store>().root()).to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
        running: jobs.running(),
        count: list.len(),
        latest: list.into_iter().next(),
        last_run: jobs.last(),
    }
}

/// 修改自动备份的设置：开关、备份目录（空的是默认的）、保留几份（超出范围取边界值）、是否同时上传到 WebDAV；
/// 改完马上检查一次
#[tauri::command]
fn set_auto_backup(
    app: AppHandle,
    settings: State<'_, SettingsStore>,
    store: State<'_, Store>,
    enabled: bool,
    dir: String,
    keep: u32,
    webdav: bool,
) -> Cmd<SettingsInfo> {
    let dir = dir.trim().to_string();
    if !dir.is_empty() {
        data_backup::check_backup_dir(Path::new(&dir), store.root())?;
    }
    let mut next = settings.get();
    next.auto_backup = enabled;
    next.auto_backup_dir = dir;
    next.auto_backup_keep = keep;
    next.auto_backup_webdav = webdav;
    settings.save(next)?;
    app.state::<BackupJobs>().wake();
    Ok(settings_info(&settings))
}

/// 选备份目录的对话框（从现在的备份目录打开），返回选中的文件夹；取消时返回 null
#[tauri::command]
async fn pick_backup_dir(app: AppHandle, window: WebviewWindow) -> Cmd<Option<String>> {
    let dir = data_backup_dir(&app);
    let start = if dir.is_dir() { dir } else { dir.parent().map(Path::to_path_buf).unwrap_or(dir) };
    let picked = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("选择自动备份的目录")
        .set_directory(start)
        .blocking_pick_folder();
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| format!("无法使用这个文件夹：{e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 在资源管理器中打开自动备份目录（还没有时先建）
#[tauri::command]
async fn open_backup_dir(app: AppHandle) -> Cmd<()> {
    let dir = data_backup_dir(&app);
    data_backup::check_backup_dir(&dir, app.state::<Store>().root())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建备份目录 {}：{e}", dir.display()))?;
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| format!("无法打开文件夹：{e}"))
}

/// 自动备份每隔多久检查一次（到没到 24 小时、数据变没变）
const AUTO_BACKUP_CHECK: Duration = Duration::from_secs(10 * 60);

/// 自动备份：启动几秒后检查一次，之后每 10 分钟检查一次，改了自动备份的设置时马上检查（BackupJobs::wake）；
/// 藏在托盘里也照常
fn start_auto_backup(app: &AppHandle) {
    let (tx, rx) = mpsc::channel();
    app.state::<BackupJobs>().set_waker(tx);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut wait = Duration::from_secs(5);
        loop {
            if let Err(RecvTimeoutError::Disconnected) = rx.recv_timeout(wait) {
                return;
            }
            // 连着叫醒几次的只检查一次
            while rx.try_recv().is_ok() {}
            auto_backup_once(&app);
            wait = AUTO_BACKUP_CHECK;
        }
    });
}

/// 检查一次自动备份；有了结果（备份了、跳过了、失败了）记下来，通知主窗口刷新设置里显示的状态。失败不弹窗
fn auto_backup_once(app: &AppHandle) {
    let settings = app.state::<SettingsStore>().get();
    if !settings.auto_backup {
        return;
    }
    let store = app.state::<Store>();
    let jobs = app.state::<BackupJobs>();
    let _busy = jobs.exclusive();
    let dir = data_backup::backup_dir(&settings.auto_backup_dir, store.root());
    let keep = settings.auto_backup_keep as usize;
    let result = data_backup::run_auto(&store, &dir, keep, Local::now(), || {
        jobs.set_running(true);
        let _ = app.emit_to("main", "auto-backup", ());
    });
    jobs.set_running(false);
    let run = match result {
        Ok(AutoLocal::NotYet) => return,
        Ok(AutoLocal::Unchanged) => AutoRun::new(Outcome::Unchanged),
        Ok(AutoLocal::Done(packed)) => {
            let mut run = AutoRun::new(Outcome::Done);
            if settings.auto_backup_webdav {
                let uploaded = app.state::<WebDavStore>().connect().and_then(|dav| {
                    tauri::async_runtime::block_on(data_backup::upload(&dav, Path::new(&packed.path), &packed.name, Some(keep)))
                });
                run.webdav_error = uploaded.err();
            }
            run.name = Some(packed.name);
            run
        }
        Err(e) => AutoRun { error: Some(e), ..AutoRun::new(Outcome::Failed) },
    };
    jobs.set_last(run);
    let _ = app.emit_to("main", "auto-backup", ());
}

// ----- 导出成 HTML / PDF（export.rs） -----

/// 这次运行期间导出过的文件：导出完的提示里「打开」「在文件夹中显示」只认这些
#[derive(Default)]
struct ExportedFiles(Mutex<HashSet<PathBuf>>);

impl ExportedFiles {
    fn add(&self, path: PathBuf) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(path);
    }

    fn check(&self, path: &str) -> Cmd<PathBuf> {
        let path = PathBuf::from(path);
        if self.0.lock().unwrap_or_else(|e| e.into_inner()).contains(&path) {
            Ok(path)
        } else {
            Err("只能打开导出的文件".into())
        }
    }
}

/// 弹出「另存为」对话框选导出到哪里，返回路径；取消时返回 null。之后前端调 export_todos。
/// 默认文件名是待办的标题（没有标题时正文开头）、项目名或工作区名；从 dir（上次导出到的目录，前端记在本机）打开，
/// 没有或不在了时从「文档」打开
#[tauri::command]
async fn pick_export_target(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, Store>,
    format: export::Format,
    workspace: String,
    project: Option<String>,
    todo: Option<String>,
    dir: Option<String>,
) -> Cmd<Option<String>> {
    let base = export::default_name(&store, &workspace, project.as_deref(), todo.as_deref());
    let start = dir
        .map(PathBuf::from)
        .filter(|d| d.is_dir())
        .or_else(|| app.path().document_dir().ok())
        .or_else(|| app.path().home_dir().ok());
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("导出")
        .add_filter(format.filter_name(), &[format.ext()])
        .set_file_name(export::file_name(&base, format));
    if let Some(dir) = start {
        dialog = dialog.set_directory(dir);
    }
    let Some(path) = dialog.blocking_save_file() else { return Ok(None) };
    let path = path.into_path().map_err(|e| format!("无法保存到这个位置：{e}"))?;
    Ok(Some(export::with_extension(&path, format).to_string_lossy().into_owned()))
}

/// 按前端排好的顺序把待办导出到 request.path（在后台线程里做），返回存到的路径和导出了几条
#[tauri::command]
async fn export_todos(app: AppHandle, request: export::Request) -> Cmd<export::Exported> {
    in_background(&app, move |app| {
        let doc = export::collect(&app.state::<Store>(), &request)?;
        let html = export::render(&doc, Local::now());
        let path = export::with_extension(Path::new(&request.path), request.format);
        match request.format {
            export::Format::Html => {
                store::atomic_write(&path, html.as_bytes()).map_err(|e| format!("保存导出的文件失败：{e}"))?
            }
            export::Format::Pdf => print_pdf(app, &html, &path, &doc.title())?,
        }
        app.state::<ExportedFiles>().add(path.clone());
        Ok(export::Exported { path: path.to_string_lossy().into_owned(), count: doc.count() })
    })
    .await
}

/// 打印 PDF 用的看不见的窗口的 label 前缀，后面是序号：上一个窗口关掉的消息还没处理完时，新的也建得起来。
/// 记住窗口位置的插件不管这些窗口
const PDF_WINDOW: &str = "export-pdf";
static PDF_WINDOWS: AtomicU64 = AtomicU64::new(0);
/// 同时只打印一份（打印时 WebView2 要占不少内存）
static PDF_PRINTING: Mutex<()> = Mutex::new(());
/// 等导出的内容加载完最多多久：网上的图片太慢、断网时不再等，照样打印，没加载出来的图片就没有
const PDF_LOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// 打印最多等多久
const PDF_PRINT_TIMEOUT: Duration = Duration::from_secs(300);
/// A4 纵向（英寸），页边距 15 毫米，页眉页脚印在页边距里
const A4_INCHES: (f64, f64) = (210.0 / 25.4, 297.0 / 25.4);
const PDF_MARGIN_INCHES: f64 = 15.0 / 25.4;

/// 把导出的 HTML 打印成 PDF 存到 pdf：先写成临时文件，在看不见的窗口里加载，加载完用 WebView2 的 PrintToPdf 打印
/// （A4 纵向、页边距 15 毫米、印出背景色，页眉是日期和标题，页脚是页码），做完关掉窗口、删掉临时文件。
/// 要在后台线程里调用：WebView2 在主线程的事件处理里同步建窗口可能卡死（见 quick_window），这里还要等它加载、打印完
fn print_pdf(app: &AppHandle, html: &str, pdf: &Path, title: &str) -> Cmd<()> {
    let _one = PDF_PRINTING.lock().unwrap_or_else(|e| e.into_inner());
    let n = PDF_WINDOWS.fetch_add(1, Ordering::Relaxed) + 1;
    let tmp = std::env::temp_dir().join(format!("todolist-export-{}-{n}.html", std::process::id()));
    std::fs::write(&tmp, html).map_err(|e| format!("写临时文件失败：{e}"))?;
    let result = print_file(app, &format!("{PDF_WINDOW}-{n}"), &tmp, pdf, title);
    let _ = std::fs::remove_file(&tmp);
    result
}

#[cfg(not(windows))]
fn print_file(_app: &AppHandle, _label: &str, _html: &Path, _pdf: &Path, _title: &str) -> Cmd<()> {
    Err("只能在 Windows 上导出 PDF".into())
}

#[cfg(windows)]
fn print_file(app: &AppHandle, label: &str, html: &Path, pdf: &Path, title: &str) -> Cmd<()> {
    let url = tauri::Url::from_file_path(html).map_err(|_| format!("临时文件的路径不对：{}", html.display()))?;
    let (loaded, wait_loaded) = mpsc::channel();
    let loaded = Mutex::new(Some(loaded));
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("导出 PDF")
        .inner_size(800.0, 1000.0)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        // 加载完了（连同图片，同 onload）才打印
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished && payload.url().scheme() == "file" {
                if let Some(tx) = loaded.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = tx.send(());
                }
            }
        });
    if let Some(args) = main_browser_args(app) {
        builder = builder.additional_browser_args(&args);
    }
    let window = builder.build().map_err(|e| format!("无法打开打印用的窗口：{e}"))?;
    // 加载超时也照样打印：多半是网上的图片太慢
    let _ = wait_loaded.recv_timeout(PDF_LOAD_TIMEOUT);
    let (done, wait_done) = mpsc::channel();
    let (target, title) = (pdf.to_path_buf(), title.to_string());
    let started = window.with_webview(move |w| {
        if let Err(e) = start_print(&w, &target, &title, done.clone()) {
            let _ = done.send(Err(e));
        }
    });
    let result = match started {
        Ok(()) => wait_done.recv_timeout(PDF_PRINT_TIMEOUT).unwrap_or_else(|_| Err("打印成 PDF 超时".into())),
        Err(e) => Err(format!("无法打印成 PDF：{e}")),
    };
    let _ = window.destroy();
    result
}

/// 在主线程上（with_webview 里）开始打印，打完把结果发给 done
#[cfg(windows)]
fn start_print(webview: &tauri::webview::PlatformWebview, pdf: &Path, title: &str, done: mpsc::Sender<Cmd<()>>) -> Cmd<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};
    let too_old = |_| "系统的 WebView2 太旧，不能打印成 PDF，请更新 Microsoft Edge WebView2 Runtime".to_string();
    // 都在主线程上调 WebView2 的 COM 接口，参数都是这里建好的
    unsafe {
        let core: ICoreWebView2_7 = webview.controller().CoreWebView2().map_err(print_error)?.cast().map_err(too_old)?;
        let env: ICoreWebView2Environment6 = webview.environment().cast().map_err(too_old)?;
        let settings = env.CreatePrintSettings().map_err(print_error)?;
        settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT).map_err(print_error)?;
        settings.SetPageWidth(A4_INCHES.0).map_err(print_error)?;
        settings.SetPageHeight(A4_INCHES.1).map_err(print_error)?;
        settings.SetMarginTop(PDF_MARGIN_INCHES).map_err(print_error)?;
        settings.SetMarginBottom(PDF_MARGIN_INCHES).map_err(print_error)?;
        settings.SetMarginLeft(PDF_MARGIN_INCHES).map_err(print_error)?;
        settings.SetMarginRight(PDF_MARGIN_INCHES).map_err(print_error)?;
        settings.SetShouldPrintBackgrounds(true).map_err(print_error)?;
        // 页眉：日期和标题；页脚：页码（不印临时文件的地址）
        settings.SetShouldPrintHeaderAndFooter(true).map_err(print_error)?;
        settings.SetHeaderTitle(&HSTRING::from(title)).map_err(print_error)?;
        settings.SetFooterUri(&HSTRING::new()).map_err(print_error)?;
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
            let _ = done.send(match result {
                Err(e) => Err(print_error(e)),
                Ok(()) if !ok => Err("WebView2 没能打印成 PDF，可能是目标位置不能写".into()),
                Ok(()) => Ok(()),
            });
            Ok(())
        }));
        core.PrintToPdf(&HSTRING::from(pdf), &settings, &handler).map_err(print_error)?;
    }
    Ok(())
}

#[cfg(windows)]
fn print_error(e: windows_core::Error) -> String {
    format!("打印成 PDF 失败：{}", e.message())
}

/// 用默认程序打开导出的文件（导出完的提示里的「打开」）
#[tauri::command]
async fn open_exported(files: State<'_, ExportedFiles>, path: String) -> Cmd<()> {
    open_with_default(&files.check(&path)?)
}

/// 在资源管理器中显示导出的文件
#[tauri::command]
async fn reveal_exported(files: State<'_, ExportedFiles>, path: String) -> Cmd<()> {
    tauri_plugin_opener::reveal_item_in_dir(files.check(&path)?).map_err(|e| format!("无法打开资源管理器：{e}"))
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
                .with_state_flags(window_state_flags())
                // 主窗口的大小、位置在 setup 里恢复：开机自启只在托盘里时不能恢复最大化（会把窗口显示出来）
                .skip_initial_state("main")
                // 快速记录小窗每次都放在鼠标所在的屏幕上，不记位置；打印 PDF 用的窗口用完就关
                .with_denylist(&[QUICK])
                .with_filter(|label| !label.starts_with(PDF_WINDOW))
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        on_global_shortcut(app, shortcut);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let store = Store::new(data_root(app)?)?;
            let root = store.root().to_path_buf();
            // 正文里的本地图片经 asset 协议显示：数据目录（TODOLIST_DATA_DIR 指定了别的时是它）整个放开，
            // 数据目录以外的图片在用到时一张张放开（image_file）
            if let Err(e) = app.asset_protocol_scope().allow_directory(&root, true) {
                eprintln!("没能放开数据目录给 asset 协议，正文里的图片显示不出来：{e}");
            }
            let settings = SettingsStore::load(store.root());
            let settings_hidden = settings.get().autostart_hidden;
            // 注册失败（被其他程序占用）不影响启动，设置界面里会提示
            register_global_shortcuts(app.handle(), &settings.get());
            let webdav = WebDavStore::load(store.root(), &app.config().identifier);
            app.manage(store);
            app.manage(settings);
            app.manage(webdav);
            app.manage(BackupJobs::default());
            app.manage(ExportedFiles::default());
            // 数据目录在外部变了（网盘同步、别的程序保存、在资源管理器里增删改名）时通知主窗口刷新。
            // 监听建不起来（数据目录在不支持变化通知的网络盘上等）时只在窗口获得焦点、F5 时刷新，不打扰用户
            let handle = app.handle().clone();
            match watch::start(&root, move |changed| on_data_changed(&handle, changed)) {
                // 留着它才一直监听
                Ok(watcher) => {
                    app.manage(watcher);
                }
                Err(e) => eprintln!("没能监听数据目录 {}，只在窗口获得焦点时刷新：{e}", root.display()),
            }
            setup_tray(app)?;
            start_auto_backup(app.handle());
            // 启动后过一会儿（不和主窗口抢启动时间）先把快速记录小窗建好，第一次按快捷键时不用等它加载；
            // 软件回收站里放了超过 30 天的移到系统回收站
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                let _ = handle.state::<Store>().purge_expired(RECYCLE_KEEP_DAYS);
                quick_window(&handle);
            });
            // 主窗口一开始是隐藏的（tauri.conf.json 里 visible: false）：开机自启、设置了只在托盘里时不显示
            let hidden = autostart::launched_at_login(std::env::args()) && settings_hidden;
            if let Some(w) = app.get_webview_window("main") {
                #[cfg(windows)]
                set_window_icons(&w);
                if hidden {
                    *hidden_at_start() = Some(saved_main_window_state(app.handle()));
                    let _ = w.restore_state(window_state_flags() & !StateFlags::MAXIMIZED);
                } else {
                    let _ = w.restore_state(window_state_flags());
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
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
            move_project,
            reorder_projects,
            set_projects_manual,
            create_todo,
            read_todo,
            save_todo_content,
            set_todo_title,
            set_todo_done,
            set_todo_pinned,
            set_todo_tags,
            set_todo_priority,
            rename_tag,
            remove_tag,
            reorder_todos,
            delete_todo,
            list_recycle,
            restore_recycled,
            purge_recycled,
            empty_recycle,
            move_todo,
            save_image,
            import_image,
            image_file,
            search_todos,
            list_done_todos,
            read_ui_state,
            write_ui_state,
            open_todo_external,
            reveal_todo,
            open_folder,
            open_url,
            quit_app,
            hold_quit,
            cancel_quit,
            get_settings,
            set_shortcut,
            set_edit_shortcuts,
            pause_toggle_shortcut,
            set_theme,
            set_font_size,
            set_editor_background,
            set_save_options,
            set_startup_view,
            get_autostart,
            set_autostart,
            set_autostart_hidden,
            list_projects,
            set_quick_capture_target,
            quick_capture,
            hide_quick_capture,
            get_webdav,
            save_webdav,
            test_webdav,
            backup_to_webdav,
            backup_to_file,
            pick_backup_file,
            list_webdav_backups,
            restore_from_webdav,
            restore_from_file,
            pick_data_backup_target,
            backup_data_to_file,
            backup_data_to_webdav,
            pick_data_backup_file,
            inspect_data_backup,
            restore_data_from_file,
            restore_data_from_webdav,
            get_auto_backup_status,
            set_auto_backup,
            pick_backup_dir,
            open_backup_dir,
            pick_export_target,
            export_todos,
            open_exported,
            reveal_exported,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                keep_unshown_window_state(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{is_web_link, reparent, with_window_state};
    use serde_json::json;

    #[test]
    fn quick_target_follows_renamed_and_moved_projects() {
        assert_eq!(reparent("需求", "需求", "开发").as_deref(), Some("开发"));
        assert_eq!(reparent("需求/前端", "需求", "开发").as_deref(), Some("开发/前端"));
        assert_eq!(reparent("需求/前端", "需求/前端", "前端").as_deref(), Some("前端"));
        assert_eq!(reparent("需求二", "需求", "开发"), None);
        assert_eq!(reparent("日常", "需求", "开发"), None);
    }

    #[test]
    fn only_web_links_can_be_opened() {
        for ok in ["https://example.com", "HTTP://a.cn/x?y=1", "mailto:a@b.com"] {
            assert!(is_web_link(ok), "{ok}");
        }
        for bad in ["https://", "file:///C:/Windows/notepad.exe", "C:\\a.exe", "./a.md", "javascript:alert(1)", ""] {
            assert!(!is_web_link(bad), "{bad}");
        }
    }

    #[test]
    fn unshown_window_keeps_its_saved_state() {
        let saved = json!({ "width": 1200, "height": 780, "x": -8, "y": -8, "prev_x": 300, "prev_y": 200, "maximized": true });
        // 退出时插件按隐藏着的窗口记成了没最大化；别的窗口的那一项不动
        let written = r#"{ "main": { "width": 1200, "height": 780, "x": 300, "y": 200, "maximized": false }, "other": { "width": 1 } }"#;
        let fixed: serde_json::Value = serde_json::from_str(&with_window_state(Some(written), "main", saved.clone()).unwrap()).unwrap();
        assert_eq!(fixed["main"], saved);
        assert_eq!(fixed["other"], json!({ "width": 1 }));
        // 文件不在、坏了：只写这一项
        for text in [None, Some("不是 JSON")] {
            let fixed: serde_json::Value = serde_json::from_str(&with_window_state(text, "main", saved.clone()).unwrap()).unwrap();
            assert_eq!(fixed, json!({ "main": saved }));
        }
        // 启动时还没有记过：不改
        assert_eq!(with_window_state(Some(written), "main", serde_json::Value::Null), None);
    }
}
