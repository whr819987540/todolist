mod autostart;
mod backup;
mod data_backup;
mod export;
mod settings;
mod store;
mod update;
mod watch;
mod webdav;

use backup::RemoteBackup;
use chrono::Local;
use data_backup::{AutoLocal, AutoRun, BackupInfo, BackupJobs, LocalBackup, Outcome, Packed, RestoreRecovery, Restored};
use serde::Serialize;
use settings::{
    EditorBackground, FontArea, QuickTarget, Settings, SettingsStore, ShortcutAction, StartupView, Theme,
};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use store::{
    DoneTodo, ImageFile, PurgeResult, RecycleEntry, RestoreResult, SaveResult, SavedImage, SearchHit, Store,
    TodoDetail, TodoRef, TodoSummary, WorkspaceInfo, WorkspaceProjects, WorkspaceTree, RECYCLE_KEEP_DAYS,
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
use tauri_plugin_updater::UpdaterExt;
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

/// 新建项目，parent 不为空时在这个项目（可以是子项目）里新建子项目；返回新项目的路径（子项目是「父项目/子项目」）
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

/// 项目（或子项目）移到工作区 target_workspace 的顶层，或放进那里的项目 target_parent（可以是子项目）里成为子项目；返回移过去后的路径。
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

/// 手动排序项目：names 是工作区的顶层（parent 为空）或项目 parent（哪一级都行）里的下一级子项目从前到后的名字；
/// 这个工作区改成手动排序
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

/// 项目 from 改名、移动成 to 之后，路径 project 变成什么：就是它或它的各级子项目时跟着改，不相干时返回 None
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

/// 彻底删除：移到系统回收站，返回移走了几项、几项路径太长留在了软件的回收站里
#[tauri::command]
async fn purge_recycled(store: State<'_, Store>, ids: Vec<String>) -> Cmd<PurgeResult> {
    store.purge(&ids)
}

/// 清空软件的回收站（都移到系统回收站；路径太长的留下）
#[tauri::command]
async fn empty_recycle(store: State<'_, Store>) -> Cmd<PurgeResult> {
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

/// 用系统默认的浏览器 / 邮件程序打开链接：只开网页和邮件地址（export::is_web_link），免得点了链接就运行了本地程序
fn open_web_link(url: &str) -> Cmd<()> {
    if !export::is_web_link(url) {
        return Err("只能打开网页和邮件链接".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| format!("无法打开链接：{e}"))
}

/// 用系统默认的浏览器 / 邮件程序打开正文里的链接（Ctrl+单击）
#[tauri::command]
fn open_url(url: String) -> Cmd<()> {
    open_web_link(&url)
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

/// 前端收到退出请求、开始存盘时调用：由前端存好后调 quit_app；有存不下来的修改时不退出，调出主窗口问用户（show_main）
#[tauri::command]
fn hold_quit() {
    QUIT_HELD.store(QUIT_REQUESTS.load(Ordering::SeqCst), Ordering::SeqCst);
}

/// 把主窗口调出来（藏在托盘里、最小化、在别的虚拟桌面上时都行，同 show_main_window）：从托盘退出、自动更新前
/// 有修改存不下来（或一直没存完）时，先调出来再问用户还退不退、还更不更新，不然对话框弹在看不见的窗口里
#[tauri::command]
fn show_main(app: AppHandle) {
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

/// 把主窗口从托盘 / 最小化状态调回前台；藏在托盘里时数据目录有变化的，这时让它刷新。
/// 开着的主窗口可能在别的虚拟桌面上：先挪到当前桌面（move_to_current_desktop）再调到前台，在后台线程里做
fn show_main_window(app: &AppHandle) {
    #[cfg(windows)]
    {
        if app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false)) {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Some(w) = app.get_webview_window("main") {
                    move_to_current_desktop(&w);
                }
                present_main_window(&app);
            });
            return;
        }
    }
    present_main_window(app);
}

/// 主窗口开着、但在别的虚拟桌面上（用户切到了另一个桌面，在那里按快捷键、点托盘图标调它）：直接调到前台的话，
/// Windows 会把用户切回窗口所在的桌面，所以先把它挪到当前桌面。
/// 用 IVirtualDesktopManager（有文档的接口）的 MoveWindowToDesktop 挪，挪完再问一次是不是到了当前桌面；当前桌面的 id
/// 没有公开的接口能问，读 explorer 记在注册表里的（current_desktop_ids）。读不到、挪不过去时退回藏起来再显示：
/// 窗口藏起来时 explorer 马上把它从原来的桌面上拿掉，再显示出来就放在当前桌面上（同从托盘里调出来时）。只当退路：
/// 在 GitHub 的 Windows Server 2025 上，主窗口刚在桌面 1 上用过、切到新建的空桌面 2 后这样做，用户仍被切回了桌面 1（原因不明；
/// 最小化着的、藏在托盘里的没有这个问题）。
/// 藏、显示直接调 ShowWindow，不经 tao 的 hide / show：tao 隐藏最大化的窗口前先 ShowWindow(SW_MAXIMIZE)，会激活它、把用户切过去；
/// 藏起来又显示出来，tao 记着的「可见」前后一样，不用让它知道。
/// 都是到 explorer 的跨进程 COM 调用，只在后台线程里调：在主线程上等回话时主线程会被重入（Chromium 同样放在别的线程上做）
#[cfg(windows)]
fn move_to_current_desktop(w: &WebviewWindow) {
    use std::time::Instant;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SHOW_WINDOW_CMD, SW_HIDE, SW_SHOWNA};

    let Ok(hwnd) = w.hwnd() else { return };
    // HWND 是裸指针，不能直接带进主线程上执行的闭包
    let raw = hwnd.0 as isize;
    let show = |cmd: SHOW_WINDOW_CMD| {
        let _ = w.run_on_main_thread(move || unsafe {
            ShowWindow(raw as windows_sys::Win32::Foundation::HWND, cmd);
        });
    };
    unsafe {
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            return;
        }
        let desktops: windows::core::Result<IVirtualDesktopManager> =
            CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_ALL);
        if let Ok(desktops) = desktops {
            let here = || desktops.IsWindowOnCurrentVirtualDesktop(hwnd).map(|on| on.as_bool());
            // 问不出来（explorer 没在运行等）时当在当前桌面上，照常调到前台
            if here().is_ok_and(|on| !on)
                && !current_desktop_ids()
                    .iter()
                    .any(|id| desktops.MoveWindowToDesktop(hwnd, id).is_ok() && here().is_ok_and(|on| on))
            {
                let old = desktops.GetWindowDesktopId(hwnd).ok();
                show(SW_HIDE);
                // 等 explorer 把它从原来的桌面上拿掉（问不出它在原来的桌面上了）再显示，还没拿掉就显示的话仍在原来的桌面上；
                // 一般几毫秒，最多等 0.5 秒
                let deadline = Instant::now() + Duration::from_millis(500);
                while Instant::now() < deadline && desktops.GetWindowDesktopId(hwnd).ok() == old {
                    std::thread::sleep(Duration::from_millis(20));
                }
                show(SW_SHOWNA);
            }
        }
        CoUninitialize();
    }
}

/// explorer 记在注册表里的当前虚拟桌面的 id：Windows 11 记在 Explorer\VirtualDesktops，
/// Windows 10 记在 Explorer\SessionInfo\{会话}\VirtualDesktops。都列出来，由用的地方挨个试
#[cfg(windows)]
fn current_desktop_ids() -> Vec<windows::core::GUID> {
    use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;

    const EXPLORER: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer";
    let mut keys = vec![format!(r"{EXPLORER}\VirtualDesktops")];
    let mut session = 0;
    if unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) } != 0 {
        keys.push(format!(r"{EXPLORER}\SessionInfo\{session}\VirtualDesktops"));
    }
    keys.iter()
        .filter_map(|k| {
            let v = windows_registry::CURRENT_USER.open(k).ok()?.get_value("CurrentVirtualDesktop").ok()?;
            // GUID 结构按内存里的样子存：前三段是小端
            let b: [u8; 16] = v[..].try_into().ok()?;
            Some(windows::core::GUID::from_values(
                u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
                u16::from_le_bytes([b[4], b[5]]),
                u16::from_le_bytes([b[6], b[7]]),
                [b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]],
            ))
        })
        .collect()
}

fn present_main_window(app: &AppHandle) {
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

/// 托盘图标的 id
const TRAY: &str = "main";

/// 托盘图标：左键单击显示主窗口，右键菜单「显示主窗口 / 退出」
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "快速记录", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quick, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id(TRAY)
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

/// 藏起 / 显示回托盘图标（更新退出时用，见 before_update_exit）。tray-icon 在 Windows 上是给通知区里的这个图标加上 / 去掉
/// NIS_HIDDEN（NIM_MODIFY），不删掉它：显示回来的还是原来那个，图标、提示文字不用重设，菜单在本进程里，也不变。
/// TrayIcon 的方法转到主线程上执行、等它做完：在别的线程里调用时，不能拿着主线程上也要用的锁
fn set_tray_visible(app: &AppHandle, visible: bool) {
    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_visible(visible);
    }
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
    if next.auto_update {
        app.state::<Updates>().wake();
    }
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

/// 上次恢复待办数据时中途退出、这次启动时处理掉的（换回了原来的、做完了收尾、处理不了原样留着的）；只给一次，前端启动时提示
#[tauri::command]
fn take_restore_recovery(jobs: State<'_, BackupJobs>) -> Vec<RestoreRecovery> {
    jobs.take_recovered()
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
    let dir = data_backup::backup_dir(&settings.auto_backup_dir, store.root());
    let keep = settings.auto_backup_keep as usize;
    // 监听着数据目录时外部的改动也会记下来，数据目录没变时少重扫几次（见 run_auto）
    let watching = app.try_state::<watch::DataWatcher>().is_some();
    // 只在本地打包时和别的备份、恢复错开；上传 WebDAV（可能要好几分钟）在外面做，不让手动备份、恢复一直等着
    let result = {
        let _busy = jobs.exclusive();
        data_backup::run_auto(&store, &dir, keep, Local::now(), jobs.scan(), watching, || {
            jobs.set_running(true);
            let _ = app.emit_to("main", "auto-backup", ());
        })
    };
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
/// 默认文件名是待办的标题（没有标题时正文开头）、项目的路径（各级用「 - 」连起来，太长时中间折叠）或工作区名；
/// 从 dir（上次导出到的目录，前端记在本机）打开，没有或不在了时从「文档」打开
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

/// 按前端排好的顺序（项目树）把待办导出到 request.path（在后台线程里做），返回存到的路径和导出了几条；
/// 导出 PDF 退回了系统的打印对话框时 print_dialog 是没能直接存成 PDF 的原因
#[tauri::command]
async fn export_todos(app: AppHandle, request: export::Request) -> Cmd<export::Exported> {
    in_background(&app, move |app| {
        let doc = export::collect(&app.state::<Store>(), &request)?;
        let html = export::render(&doc, Local::now());
        let path = export::with_extension(Path::new(&request.path), request.format);
        let print_dialog = match request.format {
            export::Format::Html => {
                store::atomic_write(&path, html.as_bytes()).map_err(|e| format!("保存导出的文件失败：{e}"))?;
                None
            }
            export::Format::Pdf => match print_pdf(app, &html, &path, &doc.title())? {
                Printed::Pdf => None,
                Printed::Dialog(reason) => Some(reason),
            },
        };
        if print_dialog.is_none() {
            app.state::<ExportedFiles>().add(path.clone());
        }
        Ok(export::Exported { path: path.to_string_lossy().into_owned(), count: doc.count(), print_dialog })
    })
    .await
}

/// 导出 PDF 是怎么做成的
enum Printed {
    /// 直接存成了 PDF
    Pdf,
    /// WebView2 没能直接存成 PDF（附上原因），退回了系统的打印对话框，用户在里面自己存
    Dialog(String),
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
/// PrintToPdf 做不成（WebView2 太旧、打印失败）时退回系统的打印对话框（见 show_print_dialog），临时文件等那个窗口关掉再删；
/// 窗口开着时退出，退出时删（TEMP_HTMLS）。
/// 要在后台线程里调用：WebView2 在主线程的事件处理里同步建窗口可能卡死（见 quick_window），这里还要等它加载、打印完
fn print_pdf(app: &AppHandle, html: &str, pdf: &Path, title: &str) -> Cmd<Printed> {
    // 目标位置不能写（文件夹不在了、文件被别的程序占用）时直接说原因，不退回打印对话框：换个地方就行
    export::check_writable(pdf)?;
    let _one = PDF_PRINTING.lock().unwrap_or_else(|e| e.into_inner());
    let n = PDF_WINDOWS.fetch_add(1, Ordering::Relaxed) + 1;
    let tmp = std::env::temp_dir().join(export::temp_html_name(std::process::id(), n));
    // 先记下再写：启动时清理临时文件夹（sweep_temp_htmls）不会删掉它，哪怕以前用过同一个进程号的进程留下了同名的
    temp_htmls().insert(tmp.clone());
    if let Err(e) = std::fs::write(&tmp, html) {
        remove_temp_html(&tmp);
        return Err(format!("写临时文件失败：{e}"));
    }
    let result = print_file(app, &format!("{PDF_WINDOW}-{n}"), &tmp, pdf, title);
    if !matches!(result, Ok(Printed::Dialog(_))) {
        remove_temp_html(&tmp);
    }
    result
}

/// 这次运行中写了、还没删掉的导出 PDF 的临时文件（退回打印对话框的窗口开着时留着）：退出时（clean_up_on_exit，正常退出、
/// 更新退出都做）一起删掉；启动时清理临时文件夹不碰它们
static TEMP_HTMLS: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

fn temp_htmls() -> MutexGuard<'static, BTreeSet<PathBuf>> {
    TEMP_HTMLS.lock().unwrap_or_else(|e| e.into_inner())
}

/// 删掉一个临时文件；删不掉（还被占着）时还记着，退出时再删一次，再删不掉的下次启动时清理
fn remove_temp_html(path: &Path) {
    let mut live = temp_htmls();
    if std::fs::remove_file(path).is_ok() || !path.exists() {
        live.remove(path);
    }
}

/// 退出时删掉这次运行中还留着的临时文件（退回打印对话框的窗口还开着的）
fn remove_temp_htmls() {
    let mut live = temp_htmls();
    for path in std::mem::take(&mut *live) {
        let _ = std::fs::remove_file(path);
    }
}

/// 启动时清掉以前留在系统的临时文件夹里的导出 PDF 的临时文件（哪些算丢下的见 export::abandoned_temp_html）：
/// 只看名字是 todolist-export-{进程号}-{序号}.html 的文件，不进子文件夹
fn sweep_temp_htmls() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
    let me = std::process::id();
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(export::temp_html_pid) else { continue };
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let age = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok());
        let path = entry.path();
        // 拿着锁看、删：这次运行正要写同名的文件时（进程号和以前的一样），要么先删了旧的再写，要么记下了不删
        let live = temp_htmls();
        if export::abandoned_temp_html(pid, me, live.contains(&path), age, process_running) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 进程号为 pid 的进程是不是还在运行：没有这个进程、已经结束了的不算；打不开（别的用户的、权限不够）的当作还在运行
#[cfg(windows)]
fn process_running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return GetLastError() != ERROR_INVALID_PARAMETER;
        }
        let mut code = 0u32;
        let got = GetExitCodeProcess(process, &mut code) != 0;
        CloseHandle(process);
        !got || code == STILL_ACTIVE as u32
    }
}

#[cfg(not(windows))]
fn process_running(_pid: u32) -> bool {
    true
}

#[cfg(not(windows))]
fn print_file(_app: &AppHandle, _label: &str, _html: &Path, _pdf: &Path, _title: &str) -> Cmd<Printed> {
    Err("只能在 Windows 上导出 PDF".into())
}

/// 打印用的窗口发回来的一次性消息（加载完了、打印完了）的发送端，发过一次就没了。窗口被关掉时随即放开（print_file 里的
/// Destroyed），等着的那边马上收到 Disconnected、说明窗口关掉了，不用等到超时、也不说成超时：交给 WebView2 的回调
/// 什么时候放开说不准，不靠它。退出程序时没有 Destroyed，进程也就结束了
#[cfg(windows)]
type Reply<T> = std::sync::Arc<Mutex<Option<mpsc::Sender<T>>>>;

#[cfg(windows)]
fn reply<T>() -> (Reply<T>, mpsc::Receiver<T>) {
    let (tx, rx) = mpsc::channel();
    (std::sync::Arc::new(Mutex::new(Some(tx))), rx)
}

/// 发回去（只有第一次发得出去）
#[cfg(windows)]
fn send_reply<T>(reply: &Reply<T>, value: T) {
    if let Some(tx) = reply.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = tx.send(value);
    }
}

/// 不会再发了：等着的那边收到 Disconnected
#[cfg(windows)]
fn drop_reply<T>(reply: &Reply<T>) {
    reply.lock().unwrap_or_else(|e| e.into_inner()).take();
}

#[cfg(windows)]
fn print_file(app: &AppHandle, label: &str, html: &Path, pdf: &Path, title: &str) -> Cmd<Printed> {
    let url = tauri::Url::from_file_path(html).map_err(|_| format!("临时文件的路径不对：{}", html.display()))?;
    let (doc, new_window_doc) = (url.to_string(), url.to_string());
    let (loaded, wait_loaded) = reply::<()>();
    let (done, wait_done) = reply::<Cmd<()>>();
    let on_loaded = loaded.clone();
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("导出 PDF")
        .inner_size(export::PRINT_WINDOW_SIZE.0, export::PRINT_WINDOW_SIZE.1)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        // 加载完了（连同图片，同 onload）才打印
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished && payload.url().scheme() == "file" {
                send_reply(&on_loaded, ());
            }
        })
        // 窗口里一直是导出的这一页（见 print_window_navigates）。建窗口时就设好，看不见的时候也拦着：
        // 导出的 HTML 里没有脚本，本来不会自己跳走，拦着的话万一跳走了也不会把别的页面印进 PDF
        .on_navigation(move |to| print_window_navigates(to, &doc))
        // 要开新窗口的（Ctrl / Shift / 中键点链接）：一样处理，不开新窗口
        .on_new_window(move |to, _| {
            print_window_navigates(&to, &new_window_doc);
            tauri::webview::NewWindowResponse::Deny
        });
    if let Some(args) = main_browser_args(app) {
        builder = builder.additional_browser_args(&args);
    }
    let window = builder.build().map_err(|e| format!("无法打开打印用的窗口：{e}"))?;
    let gone = done.clone();
    window.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            drop_reply(&loaded);
            drop_reply(&gone);
        }
    });
    // 加载超时也照样打印：多半是网上的图片太慢。还没加载完窗口就没了的打印不了
    if let Err(RecvTimeoutError::Disconnected) = wait_loaded.recv_timeout(PDF_LOAD_TIMEOUT) {
        let _ = window.destroy();
        return Err("打印用的窗口还没加载完就关掉了".into());
    }
    let (target, title) = (pdf.to_path_buf(), title.to_string());
    let started = window.with_webview(move |w| {
        if let Err(e) = start_print(&w, &target, &title, done.clone()) {
            send_reply(&done, Err(e));
        }
    });
    // 打印出错的（连同 WebView2 太旧的）退回打印对话框；开始不了、超时、窗口没了的直接报错
    let reason = match started.map(|()| wait_done.recv_timeout(PDF_PRINT_TIMEOUT)) {
        Ok(Ok(Ok(()))) => {
            let _ = window.destroy();
            return Ok(Printed::Pdf);
        }
        Ok(Ok(Err(reason))) => reason,
        Ok(Err(RecvTimeoutError::Timeout)) => {
            let _ = window.destroy();
            return Err("打印成 PDF 超时".into());
        }
        // 窗口在打印完之前没了（开始打印之前就没了的，with_webview 交过去的也不会执行）
        Ok(Err(RecvTimeoutError::Disconnected)) => {
            let _ = window.destroy();
            return Err("打印用的窗口还没打印完就关掉了".into());
        }
        Err(e) => {
            let _ = window.destroy();
            return Err(format!("无法打印成 PDF：{e}"));
        }
    };
    // 目标位置是能写的（print_pdf 先看过），没做成多半是 WebView2 的问题
    match show_print_dialog(&window, html) {
        Ok(()) => Ok(Printed::Dialog(reason)),
        Err(e) => {
            let _ = window.destroy();
            Err(format!("{reason}；{e}"))
        }
    }
}

/// 打印用的窗口要去 to 时让不让它去（export::print_navigation）：还是导出的这一页（目录、脚注这些锚点）才去；网页、邮件链接
/// 交给默认的浏览器 / 邮件程序（open_web_link，同正文里的链接；在别的线程里打开，不在 WebView2 的事件里等），窗口里不动；
/// 别的（本地的文件等）不理。退回打印对话框时窗口显示出来、点得到链接，以前点了整个窗口就跳走了、回不来
#[cfg(windows)]
fn print_window_navigates(to: &tauri::Url, doc: &str) -> bool {
    match export::print_navigation(to.as_str(), doc) {
        export::PrintNavigation::Stay => true,
        export::PrintNavigation::Browser => {
            let url = to.to_string();
            std::thread::spawn(move || {
                let _ = open_web_link(&url);
            });
            false
        }
        export::PrintNavigation::Block => false,
    }
}

/// 退回系统的打印对话框：把打印用的窗口显示出来（里面是导出的内容），打开打印对话框，用户在里面选「另存为 PDF」或
/// 「Microsoft Print to PDF」自己存。窗口留着由用户关掉（不像主窗口那样藏到托盘，见 run 的 on_window_event）：
/// 打印完就关的话，打印到打印机（包括 Microsoft Print to PDF）时页面还要再排一次版，可能被打断。窗口关掉后删掉临时文件
#[cfg(windows)]
fn show_print_dialog(window: &WebviewWindow, html: &Path) -> Cmd<()> {
    let tmp = html.to_path_buf();
    window.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            remove_temp_html(&tmp);
        }
    });
    let _ = window.set_title("导出 PDF：在打印对话框里选「另存为 PDF」，存好后关掉这个窗口");
    let _ = window.set_skip_taskbar(false);
    place_print_window(window);
    window.show().map_err(|e| format!("无法打开打印对话框：{e}"))?;
    let _ = window.set_focus();
    window.eval("print()").map_err(|e| format!("无法打开打印对话框：{e}"))
}

/// 退回打印对话框时把窗口放在主窗口所在的屏幕上（主窗口藏在托盘里、最小化了时是它原来在的那块），按那块屏幕的工作区
/// （去掉任务栏）缩小到放得下（export::print_window_size），居中。800×1000 在高分屏放大显示、分辨率低的屏幕上会比屏幕还高
#[cfg(windows)]
fn place_print_window(window: &WebviewWindow) {
    let monitor = window
        .app_handle()
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(m) = monitor else {
        let _ = window.center();
        return;
    };
    let (area, scale) = (m.work_area(), m.scale_factor());
    let (width, height) = export::print_window_size((area.size.width as f64 / scale, area.size.height as f64 / scale));
    // 先按那块屏幕的缩放缩小到放得下，再挪到它的中间：这时整个窗口都在那块屏幕上，两块屏幕的缩放不同时窗口在这时换成
    // 那块的缩放（看不见的窗口建在主屏幕上；主屏幕的缩放比那块的大时，不先缩小就挪过去，窗口会伸到别的屏幕上、被算成
    // 在别的屏幕上）。再按逻辑像素定一次大小（换了缩放时 tao 按原来的逻辑大小重新算过），最后按定好的大小（连同标题栏
    // 和边框）在它现在所在的那块屏幕上居中
    let size = tauri::PhysicalSize::new((width * scale) as u32, (height * scale) as u32);
    let _ = window.set_size(size);
    let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
    let y = area.position.y + (area.size.height as i32 - size.height as i32) / 2;
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    let _ = window.center();
}

/// 调试版设了环境变量 TODOLIST_PDF_PRINT_DIALOG 时不直接存成 PDF，总是退回打印对话框（手动测试退回的流程用）
#[cfg(windows)]
fn force_print_dialog() -> bool {
    cfg!(debug_assertions) && std::env::var_os("TODOLIST_PDF_PRINT_DIALOG").is_some()
}

/// 在主线程上（with_webview 里）开始打印，打完把结果发给 done；出错时返回的、发给 done 的是没做成的原因
#[cfg(windows)]
fn start_print(webview: &tauri::webview::PlatformWebview, pdf: &Path, title: &str, done: Reply<Cmd<()>>) -> Cmd<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};
    if force_print_dialog() {
        return Err("调试版设了 TODOLIST_PDF_PRINT_DIALOG".into());
    }
    let too_old = |_| "系统的 WebView2 太旧，不支持直接存成 PDF（更新 Microsoft Edge WebView2 Runtime 后就可以）".to_string();
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
            send_reply(
                &done,
                match result {
                    Err(e) => Err(print_error(e)),
                    Ok(()) if !ok => Err("WebView2 没能打印成 PDF".into()),
                    Ok(()) => Ok(()),
                },
            );
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

// ----- 自动更新 -----

/// 启动后多久第一次检查更新（不和启动抢时间），之后每隔多久检查一次（藏在托盘里也照常；按墙上时间算，电脑睡眠的
/// 时间也算）。定时检查的线程最多等 UPDATE_CHECK_TICK 就醒来看看到没到时候（见 update::check_wait）：睡醒后过了
/// 6 小时的，最多再过这么久就检查；刚醒来时网络可能还没连上，不用醒得太勤
const UPDATE_FIRST_CHECK: Duration = Duration::from_secs(10);
const UPDATE_CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const UPDATE_CHECK_TICK: Duration = Duration::from_secs(10 * 60);
/// 检查最多等多久（网络卡住时不一直挂着）：从连接到读完 latest.json 一共的时间
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// 下载不限一共用多久（网速很慢时几 MB 的安装包要下很久），只限连接多久连不上、下载中多久收不到数据（检查也一样，
/// 另有上面的总时长）
const UPDATE_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// 检查更新的结果：设置里显示，主窗口据此提示（update-status 事件）
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    /// 正在用的版本
    current: String,
    /// 正在检查
    checking: bool,
    /// 上次检查完的时间（毫秒时间戳），还没检查过时为 None
    checked_at: Option<i64>,
    /// 上次检查失败的原因
    error: Option<String>,
    /// 检查到的新版本；之后哪次检查失败了也留着
    available: Option<AvailableUpdate>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AvailableUpdate {
    version: String,
    /// 更新说明（发布时写在 latest.json 里的）
    notes: String,
}

/// 下载新版本的进度（update-progress 事件）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Default)]
struct Updates {
    status: Mutex<UpdateStatus>,
    /// 检查到的新版本（下载、安装用）
    found: Mutex<Option<tauri_plugin_updater::Update>>,
    /// 下载好、验过签名的安装包：版本号和内容。Arc：安装时交给插件不用再复制一份（几 MB）。选「先不更新」后也留着，
    /// 再点「立即更新」时不用重新下载；下一次下载时换掉，最多留一个
    downloaded: Mutex<Option<(String, Arc<[u8]>)>>,
    /// 叫醒定时检查的线程：打开「自动检查更新」时马上检查一次
    waker: Mutex<Option<mpsc::Sender<()>>>,
    /// 上次的更新装好了没有：启动时从标记文件读出来，前端取一次（take_update_outcome）
    outcome: Mutex<Option<update::Outcome>>,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Updates {
    fn new(current: String, outcome: Option<update::Outcome>) -> Self {
        Self {
            status: Mutex::new(UpdateStatus { current, ..Default::default() }),
            outcome: Mutex::new(outcome),
            ..Default::default()
        }
    }

    /// 改检查的结果，发给主窗口
    fn set_status(&self, app: &AppHandle, f: impl FnOnce(&mut UpdateStatus)) -> UpdateStatus {
        let status = {
            let mut s = locked(&self.status);
            f(&mut s);
            s.clone()
        };
        let _ = app.emit_to("main", "update-status", status.clone());
        status
    }

    fn wake(&self) {
        if let Some(tx) = locked(&self.waker).as_ref() {
            let _ = tx.send(());
        }
    }
}

/// 插件的错误换成给用户看的说明
fn update_error(e: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        // 连不上、检查的总时长到了、下载中太久收不到数据：reqwest 的说明里看不出是超时
        E::Reqwest(r) if r.is_timeout() => "更新服务器太久没有响应（超时），请检查网络后再试".into(),
        E::Reqwest(_) | E::Network(_) => format!("连不上更新服务器：{e}"),
        E::ReleaseNotFound => "没能从更新服务器读到最新版本的信息".into(),
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => {
            "下载的安装包和签名对不上（可能下载出错或被改过），没有安装".into()
        }
        // 签名对得上，但签名里记的版本（发布时打包签名的那一版）不是 latest.json 宣布的版本：可能有人把旧版的安装包
        // 换上新的版本号发出来
        E::SignedVersionMismatch { signed, announced } => format!(
            "安装包签名里记的版本（{signed}）和更新服务器宣布的版本（{announced}）对不上，可能被改过，没有安装"
        ),
        // 只在打开了插件的 requireSignedVersion 时才会有（现在没开）：签名里没记版本，没法和宣布的版本对
        E::MissingSignedVersion => "安装包的签名里没有记着是哪个版本，没法确认是不是宣布的版本，没有安装".into(),
        _ => e.to_string(),
    }
}

/// 检查一次有没有新版本：结果记下来、发给主窗口；失败不弹窗，设置里显示原因
async fn check_update_now(app: &AppHandle) -> UpdateStatus {
    let updates = app.state::<Updates>();
    updates.set_status(app, |s| s.checking = true);
    let handle = app.clone();
    let builder = app
        .updater_builder()
        .timeout(UPDATE_CHECK_TIMEOUT)
        // 检查到的 Update 带着它，下载时也用：插件给 reqwest 设好 timeout（下载时是 Update::timeout，不设就不限总时长）
        // 之后才调它，这里只加连接超时、读超时，不动总时长
        .configure_client(|c| c.connect_timeout(UPDATE_CONNECT_TIMEOUT).read_timeout(UPDATE_READ_TIMEOUT));
    let checked = match builder.on_before_exit(move || before_update_exit(&handle)).build() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    let mut found = locked(&updates.found);
    updates.set_status(app, |s| {
        s.checking = false;
        s.checked_at = Some(Local::now().timestamp_millis());
        match checked {
            Ok(Some(u)) => {
                s.error = None;
                s.available = Some(AvailableUpdate { version: u.version.clone(), notes: u.body.clone().unwrap_or_default() });
                *found = Some(u);
            }
            Ok(None) => {
                s.error = None;
                s.available = None;
                *found = None;
            }
            Err(e) => s.error = Some(update_error(&e)),
        }
    })
}

/// 定时检查更新：启动后 UPDATE_FIRST_CHECK 检查一次，之后离上次检查过了 UPDATE_CHECK_EVERY 就检查（按墙上时间算，电脑
/// 睡眠的时间也算，见 update::check_wait）；关了「自动检查更新」时不检查，打开时叫醒它（wake），马上检查
fn start_update_checks(app: &AppHandle) {
    let (tx, rx) = mpsc::channel();
    *locked(&app.state::<Updates>().waker) = Some(tx);
    let app = app.clone();
    std::thread::spawn(move || {
        let now = || Local::now().timestamp_millis();
        // 第一次在启动后 UPDATE_FIRST_CHECK 检查：当作上次检查是在那之前 UPDATE_CHECK_EVERY
        let mut last = now() + UPDATE_FIRST_CHECK.as_millis() as i64 - UPDATE_CHECK_EVERY.as_millis() as i64;
        loop {
            let wait = update::check_wait(last, now(), UPDATE_CHECK_EVERY, UPDATE_CHECK_TICK);
            if !wait.is_zero() {
                match rx.recv_timeout(wait) {
                    // 叫醒了（打开了「自动检查更新」）：马上检查
                    Ok(()) => {}
                    // 还没到时候，等完了这一小段：再看过了多久（这期间电脑可能睡眠过）
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            while rx.try_recv().is_ok() {}
            if app.state::<SettingsStore>().get().auto_update {
                tauri::async_runtime::block_on(check_update_now(&app));
            }
            last = now();
        }
    });
}

/// 退出时的收尾：正常退出（RunEvent::Exit，托盘「退出」最后也走到这里）和更新退出（before_update_exit）都做，正常退出时
/// 要加的收尾加在这里，更新退出也就跟着做了。更新时这里在运行安装程序之前做（插件先调钩子再运行安装程序），安装程序
/// 没运行起来时软件接着运行，所以这里做的都不能妨碍接着用：
/// - keep_unshown_window_state 取走 HIDDEN_AT_START：「立即更新」在主窗口里点，这时主窗口显示过了：藏着启动的，第一次显示时
///   （都经 present_main_window）已经取走了它，一开始就显示的没有记，它是 None，什么都不做
/// - remove_temp_htmls 删掉退回打印对话框的窗口还在用的临时文件：那些窗口早就加载完了，导出的 HTML 只有一个文件（图片嵌在
///   里面），删了照常显示、打印、点目录跳转，只是在那个窗口里刷新时找不到文件
fn clean_up_on_exit(app: &AppHandle) {
    keep_unshown_window_state(app);
    remove_temp_htmls();
}

/// 插件运行安装程序之前调的钩子。安装程序运行起来后插件直接结束进程（不经 RunEvent::Exit）：这里做正常退出时的收尾
/// （clean_up_on_exit），记下窗口的大小位置（正常退出时由记住窗口状态的插件自己记），再藏起托盘图标：进程直接结束时
/// 没人删它，通知区里会留下一个点不了的旧图标，鼠标移过去才消失；藏起来的，进程结束后也不会再显示出来。
/// 设了这个钩子，插件默认的钩子 cleanup_before_exit（删掉托盘图标、清空 resources table、在 Windows 上藏起所有窗口）就不跑了，
/// 这里也不调它：这时还不知道安装程序能不能运行起来，运行不起来时软件照常运行，它做的恢复不回来。托盘图标只是藏起来，
/// 安装程序没运行起来时 install_update 再显示回来。
/// 跑在 install_update 的后台线程里，这时主线程空着：转到主线程上做的（读窗口的状态、藏托盘图标）不会卡住
fn before_update_exit(app: &AppHandle) {
    let _ = app.save_window_state(window_state_flags());
    clean_up_on_exit(app);
    set_tray_visible(app, false);
}

#[tauri::command]
fn get_update_status(updates: State<'_, Updates>) -> UpdateStatus {
    locked(&updates.status).clone()
}

/// 设置里的「检查更新」
#[tauri::command]
async fn check_update(app: AppHandle) -> UpdateStatus {
    check_update_now(&app).await
}

/// 下载检查到的新版本、验签名，留着等 install_update；下载中发 update-progress（进度变了 1% 以上才发）。
/// 不限一共下载多久，只限连接、多久收不到数据（检查时设的 configure_client，见 check_update_now）
#[tauri::command]
async fn download_update(app: AppHandle, updates: State<'_, Updates>) -> Cmd<()> {
    let update = locked(&updates.found).clone().ok_or("没有检查到新版本，先检查更新")?;
    if locked(&updates.downloaded).as_ref().is_some_and(|(v, _)| *v == update.version) {
        return Ok(());
    }
    let (mut done, mut sent) = (0u64, 0u64);
    let bytes = update
        .download(
            |chunk, total| {
                done += chunk as u64;
                let step = total.map_or(256 * 1024, |t| (t / 100).max(1));
                if done - sent >= step || total == Some(done) {
                    sent = done;
                    let _ = app.emit_to("main", "update-progress", UpdateProgress { downloaded: done, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| update_error(&e))?;
    *locked(&updates.downloaded) = Some((update.version.clone(), bytes.into()));
    Ok(())
}

/// 运行下载好的安装程序：先记下从哪个版本更新到哪个版本（下次启动时提示），插件运行安装程序后结束这个进程
/// （之前调 before_update_exit 收尾、藏起托盘图标），装好后安装程序重新打开软件。只有出错时才返回
#[tauri::command]
async fn install_update(app: AppHandle, updates: State<'_, Updates>) -> Cmd<()> {
    let update = locked(&updates.found).clone().ok_or("没有检查到新版本，先检查更新")?;
    let bytes = match locked(&updates.downloaded).as_ref() {
        Some((v, bytes)) if *v == update.version => Arc::clone(bytes),
        _ => return Err("新版本还没下载好".into()),
    };
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    update::write_marker(&dir, &update::Marker { from: update.current_version.clone(), to: update.version.clone() })?;
    let result = update.install(bytes);
    // 走到这里说明安装程序没运行起来，软件接着运行：钩子藏起来的托盘图标显示回来（安装包没能写出来时钩子还没跑，图标本来就显示着）
    set_tray_visible(&app, true);
    update::remove_marker(&dir);
    result.map_err(|e| format!("没能运行安装程序：{}", update_error(&e)))
}

#[tauri::command]
fn set_auto_update(settings: State<'_, SettingsStore>, updates: State<'_, Updates>, enabled: bool) -> Cmd<SettingsInfo> {
    let mut next = settings.get();
    next.auto_update = enabled;
    settings.save(next)?;
    if enabled {
        updates.wake();
    }
    Ok(settings_info(&settings))
}

/// 上次的更新装好了没有（只给一次）：刚更新完重新打开时提示
#[tauri::command]
fn take_update_outcome(updates: State<'_, Updates>) -> Option<update::Outcome> {
    locked(&updates.outcome).take()
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
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            // 上次恢复待办数据时中途退出留下的临时文件夹：在开始监听、自动备份和前端读数据之前换回原来的数据（或做完收尾）
            app.manage(BackupJobs::with_recovered(data_backup::recover_leftovers(&app.state::<Store>())));
            app.manage(ExportedFiles::default());
            // 上次运行时开始了更新：这次照常显示主窗口（开机自启只在托盘里时也是），提示装好了没有
            let current = app.package_info().version.to_string();
            let outcome = app.path().app_config_dir().ok().and_then(|d| update::take_outcome(&d, &current));
            let just_updated = outcome.is_some();
            app.manage(Updates::new(current, outcome));
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
            start_update_checks(app.handle());
            // 启动后过一会儿（不和主窗口抢启动时间）先把快速记录小窗建好，第一次按快捷键时不用等它加载；
            // 清掉以前导出 PDF 时留在临时文件夹里的临时文件；软件回收站里放了超过 30 天的移到系统回收站
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                sweep_temp_htmls();
                let _ = handle.state::<Store>().purge_expired(RECYCLE_KEEP_DAYS);
                quick_window(&handle);
            });
            // 主窗口一开始是隐藏的（tauri.conf.json 里 visible: false）：开机自启、设置了只在托盘里时不显示
            let hidden = !just_updated && autostart::launched_at_login(std::env::args()) && settings_hidden;
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
                // 导出 PDF 退回打印对话框时显示出来的窗口直接关掉（见 show_print_dialog）
                if window.label().starts_with(PDF_WINDOW) {
                    return;
                }
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
            show_main,
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
            take_restore_recovery,
            get_update_status,
            check_update,
            download_update,
            install_update,
            set_auto_update,
            take_update_outcome,
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
                clean_up_on_exit(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{reparent, with_window_state};
    use serde_json::json;

    #[test]
    fn quick_target_follows_renamed_and_moved_projects() {
        assert_eq!(reparent("需求", "需求", "开发").as_deref(), Some("开发"));
        assert_eq!(reparent("需求/前端", "需求", "开发").as_deref(), Some("开发/前端"));
        assert_eq!(reparent("需求/前端", "需求/前端", "前端").as_deref(), Some("前端"));
        assert_eq!(reparent("需求/前端/组件/按钮", "需求/前端", "开发/界面").as_deref(), Some("开发/界面/组件/按钮"));
        assert_eq!(reparent("需求/前端二/组件", "需求/前端", "x"), None);
        assert_eq!(reparent("需求二", "需求", "开发"), None);
        assert_eq!(reparent("日常", "需求", "开发"), None);
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
