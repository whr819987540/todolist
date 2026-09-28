mod backup;
mod settings;
mod store;
mod webdav;

use backup::RemoteBackup;
use chrono::Local;
use serde::Serialize;
use settings::{EditorBackground, FontArea, Settings, SettingsStore, ShortcutAction, StartupView, Theme};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use store::{Store, TodoDetail, TodoSummary, WorkspaceInfo, WorkspaceTree, SaveResult};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_window_state::StateFlags;
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

// ----- 系统托盘 -----

/// 把主窗口从托盘 / 最小化状态调回前台
fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
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

/// 最近一次注册全局快捷键是否成功。录制快捷键时的临时暂停不算失败，所以不能直接用 is_registered 判断
static TOGGLE_REGISTERED: AtomicBool = AtomicBool::new(false);

/// 重新注册显示/隐藏主窗口的全局快捷键（先清掉旧的）；None 表示不使用
fn register_toggle_shortcut(app: &AppHandle, shortcut: Option<&str>) -> Cmd<()> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let result = shortcut.map_or(Ok(()), |text| {
        gs.register(parse_shortcut(text)?)
            .map_err(|_| format!("快捷键 {text} 注册失败，可能已被其他程序占用，请换一个"))
    });
    TOGGLE_REGISTERED.store(shortcut.is_some() && result.is_ok(), Ordering::Relaxed);
    result
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
}

fn settings_info(store: &SettingsStore) -> SettingsInfo {
    SettingsInfo {
        settings: store.get(),
        defaults: Settings::default(),
        toggle_shortcut_registered: TOGGLE_REGISTERED.load(Ordering::Relaxed),
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
    next.set_shortcut(action, shortcut);
    if action != ShortcutAction::ToggleWindow {
        settings.save(next)?;
    } else {
        let saved = register_toggle_shortcut(&app, next.toggle_shortcut.as_deref())
            .and_then(|_| settings.save(next));
        if let Err(e) = saved {
            // 新的用不了就恢复原来的
            let _ = register_toggle_shortcut(&app, old.toggle_shortcut.as_deref());
            return Err(e);
        }
    }
    Ok(settings_info(&settings))
}

/// 设置界面录制快捷键期间暂停，否则按下当前快捷键会直接把窗口藏起来、录不到。
/// 返回最新设置：恢复时可能注册失败（暂停期间被其他程序占用了）
#[tauri::command]
fn pause_toggle_shortcut(app: AppHandle, settings: State<'_, SettingsStore>, paused: bool) -> SettingsInfo {
    if paused {
        let _ = app.global_shortcut().unregister_all();
    } else {
        let _ = register_toggle_shortcut(&app, settings.get().toggle_shortcut.as_deref());
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

// ----- 设置备份（WebDAV） -----

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
    restore_settings(&app, &settings, &data)
}

/// 从本地选择的备份包恢复（前端读出文件内容传过来）
#[tauri::command]
fn restore_from_file(app: AppHandle, settings: State<'_, SettingsStore>, data: Vec<u8>) -> Cmd<SettingsInfo> {
    restore_settings(&app, &settings, &data)
}

fn restore_settings(app: &AppHandle, settings: &SettingsStore, zip: &[u8]) -> Cmd<SettingsInfo> {
    let next = backup::unpack(zip)?;
    check_shortcuts(&next)?;
    settings.save(next.clone())?;
    // 全局快捷键被占用不影响恢复，设置界面会提示
    let _ = register_toggle_shortcut(app, next.toggle_shortcut.as_deref());
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
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let store = Store::new(data_root(app)?)?;
            let settings = SettingsStore::load(store.root());
            // 注册失败（被其他程序占用）不影响启动，设置界面里会提示
            let _ = register_toggle_shortcut(app.handle(), settings.get().toggle_shortcut.as_deref());
            let webdav = WebDavStore::load(store.root(), &app.config().identifier);
            app.manage(store);
            app.manage(settings);
            app.manage(webdav);
            setup_tray(app)?;
            #[cfg(windows)]
            if let Some(w) = app.get_webview_window("main") {
                set_window_icons(&w);
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
            create_todo,
            read_todo,
            save_todo_content,
            set_todo_title,
            set_todo_done,
            delete_todo,
            move_todo,
            read_ui_state,
            write_ui_state,
            open_todo_external,
            reveal_todo,
            open_folder,
            open_url,
            quit_app,
            get_settings,
            set_shortcut,
            pause_toggle_shortcut,
            set_theme,
            set_font_size,
            set_editor_background,
            set_save_options,
            set_startup_view,
            get_webdav,
            save_webdav,
            test_webdav,
            backup_to_webdav,
            list_webdav_backups,
            restore_from_webdav,
            restore_from_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::is_web_link;

    #[test]
    fn only_web_links_can_be_opened() {
        for ok in ["https://example.com", "HTTP://a.cn/x?y=1", "mailto:a@b.com"] {
            assert!(is_web_link(ok), "{ok}");
        }
        for bad in ["https://", "file:///C:/Windows/notepad.exe", "C:\\a.exe", "./a.md", "javascript:alert(1)", ""] {
            assert!(!is_web_link(bad), "{bad}");
        }
    }
}
