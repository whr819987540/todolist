//! 应用设置，保存在数据根目录下的 `.settings.json`。
//!
//! 工作区只认子目录，这个文件不会被当成工作区。

use crate::store::{atomic_write, normalize_name, normalize_project_path, strip_bom};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub const SETTINGS_FILE: &str = ".settings.json";

/// 编辑区自定义背景色的默认值：豆沙绿
const DEFAULT_CUSTOM_COLOR: &str = "#c7edcc";

/// 快速记录默认存到的工作区和项目，不在时第一次保存时自动建
pub const DEFAULT_QUICK_WORKSPACE: &str = "收件箱";
pub const DEFAULT_QUICK_PROJECT: &str = "快速记录";

/// 定时保存的可调范围（秒）：1 秒到 1 小时；前端 settings.tsx 的 SAVE_DELAY_LIMITS 与此一致
pub const SAVE_DELAY_RANGE: RangeInclusive<u32> = 1..=3600;

/// 快捷键格式如 `Ctrl+Alt+T`，None 表示不使用；文件里缺的字段取默认值
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 全局快捷键：显示主窗口 / 隐藏到托盘
    pub toggle_shortcut: Option<String>,
    /// 全局快捷键：弹出快速记录小窗
    pub quick_capture_shortcut: Option<String>,
    /// 快速记录存到哪个项目；工作区、项目改名或移动后跟着改，不在了保存时自动建
    #[serde(deserialize_with = "lenient_target")]
    pub quick_capture_target: QuickTarget,
    /// 应用内快捷键（窗口在前台且选中了待办时生效）：标记完成 / 未完成
    pub toggle_done_shortcut: Option<String>,
    /// 应用内快捷键：用默认程序打开选中的待办
    pub open_external_shortcut: Option<String>,
    /// 左侧工作区 / 项目 / 待办列表的字号（px）
    pub sidebar_font_size: u32,
    /// 右侧待办正文编辑区的字号（px）
    pub editor_font_size: u32,
    /// 右侧待办编辑区的背景色
    pub editor_background: EditorBackground,
    /// 背景色选「自定义」时用的颜色，`#rrggbb`；选别的背景色时也保留，再选「自定义」还是它
    pub editor_custom_color: String,
    /// auto save 开着时，待办的标题或正文改动后多久自动保存（秒），从第一处未保存的修改算起
    pub save_delay_secs: u32,
    /// auto save：定时保存，以及编辑器失去焦点、窗口失去焦点时立即保存；
    /// 关掉时只在 Ctrl+S、切换待办和从托盘退出时保存
    pub auto_save: bool,
    /// 打开软件时显示首页还是回到上次的位置
    pub startup_view: StartupView,
    /// 开机自启时不显示主窗口，只在托盘里（开机自启本身记在注册表里，见 autostart.rs）
    pub autostart_hidden: bool,
    /// 界面主题：浅色、深色或跟随系统
    pub theme: Theme,
    /// 编辑快捷键（正文里的加粗、标题等）里用户改过的：命令 → 快捷键，None 表示不使用。
    /// 没改过的不记，用前端 editShortcuts.ts 里的默认值
    #[serde(deserialize_with = "lenient_edit_shortcuts")]
    pub edit_shortcuts: BTreeMap<String, Option<String>>,
}

/// 快速记录存到的项目
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickTarget {
    pub workspace: String,
    pub project: String,
}

impl Default for QuickTarget {
    fn default() -> Self {
        Self {
            workspace: DEFAULT_QUICK_WORKSPACE.into(),
            project: DEFAULT_QUICK_PROJECT.into(),
        }
    }
}

/// 手改坏的快速记录目标用默认的，不能连累整个设置文件读不出来
fn lenient_target<'de, D: Deserializer<'de>>(d: D) -> Result<QuickTarget, D::Error> {
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).unwrap_or_default())
}

/// 手改坏的编辑快捷键只丢掉坏的那几项，不能连累整个设置文件读不出来
fn lenient_edit_shortcuts<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<String, Option<String>>, D::Error> {
    use serde_json::Value;
    let Value::Object(map) = Value::deserialize(d)? else {
        return Ok(BTreeMap::new());
    };
    Ok(map
        .into_iter()
        .filter_map(|(id, v)| match v {
            Value::Null => Some((id, None)),
            Value::String(s) if !s.trim().is_empty() => Some((id, Some(s.trim().to_string()))),
            _ => None,
        })
        .collect())
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            toggle_shortcut: Some("Ctrl+Alt+T".into()),
            quick_capture_shortcut: Some("Ctrl+Alt+N".into()),
            quick_capture_target: QuickTarget::default(),
            toggle_done_shortcut: Some("Ctrl+Alt+D".into()),
            open_external_shortcut: Some("Ctrl+Alt+O".into()),
            sidebar_font_size: 14,
            editor_font_size: 15,
            editor_background: EditorBackground::default(),
            editor_custom_color: DEFAULT_CUSTOM_COLOR.into(),
            save_delay_secs: 180,
            auto_save: false,
            startup_view: StartupView::default(),
            autostart_hidden: true,
            theme: Theme::default(),
            edit_shortcuts: BTreeMap::new(),
        }
    }
}

/// 界面主题，窗口标题栏跟着切换
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    Light,
    Dark,
    /// 跟随 Windows 的深浅色设置；认不出的值也按它处理
    #[default]
    #[serde(other)]
    System,
}

/// 打开软件时显示的界面
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StartupView {
    /// 回到上次的位置：侧栏选中的工作区、右侧打开的待办（前端记在数据目录的 `.state.json` 里）
    LastPosition,
    /// 首页；认不出的值也按它处理
    #[default]
    #[serde(other)]
    Home,
}

/// 待办编辑区的背景色，只在浅色模式下区分；深色模式下编辑区总是深色背景
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorBackground {
    /// 白色，和界面其他部分一致
    White,
    /// 用户按 RGB 设置的颜色（`editor_custom_color`）
    Custom,
    /// 护眼米色；认不出的值（手改的文件、新版本的备份）也按它处理，免得整个设置文件读不出来
    #[default]
    #[serde(other)]
    Beige,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutAction {
    ToggleWindow,
    QuickCapture,
    ToggleDone,
    OpenExternal,
}

impl ShortcutAction {
    pub const ALL: [Self; 4] = [Self::ToggleWindow, Self::QuickCapture, Self::ToggleDone, Self::OpenExternal];
    /// 全局快捷键（在任何程序里都能用，要向系统注册）
    pub const GLOBAL: [Self; 2] = [Self::ToggleWindow, Self::QuickCapture];

    pub fn label(self) -> &'static str {
        match self {
            Self::ToggleWindow => "显示 / 隐藏主窗口",
            Self::QuickCapture => "快速记录",
            Self::ToggleDone => "标记完成 / 未完成",
            Self::OpenExternal => "用默认程序打开",
        }
    }
}

/// 可以单独调字号的区域
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FontArea {
    Sidebar,
    Editor,
}

impl FontArea {
    pub const ALL: [Self; 2] = [Self::Sidebar, Self::Editor];

    /// 可调范围，前端 settings.tsx 的 FONT_LIMITS 与此一致
    pub fn range(self) -> RangeInclusive<u32> {
        match self {
            Self::Sidebar => 12..=20,
            Self::Editor => 12..=32,
        }
    }
}

impl Settings {
    pub fn shortcut(&self, action: ShortcutAction) -> Option<&str> {
        match action {
            ShortcutAction::ToggleWindow => self.toggle_shortcut.as_deref(),
            ShortcutAction::QuickCapture => self.quick_capture_shortcut.as_deref(),
            ShortcutAction::ToggleDone => self.toggle_done_shortcut.as_deref(),
            ShortcutAction::OpenExternal => self.open_external_shortcut.as_deref(),
        }
    }

    pub fn set_shortcut(&mut self, action: ShortcutAction, shortcut: Option<String>) {
        let slot = match action {
            ShortcutAction::ToggleWindow => &mut self.toggle_shortcut,
            ShortcutAction::QuickCapture => &mut self.quick_capture_shortcut,
            ShortcutAction::ToggleDone => &mut self.toggle_done_shortcut,
            ShortcutAction::OpenExternal => &mut self.open_external_shortcut,
        };
        *slot = shortcut;
    }

    pub fn font_size(&self, area: FontArea) -> u32 {
        match area {
            FontArea::Sidebar => self.sidebar_font_size,
            FontArea::Editor => self.editor_font_size,
        }
    }

    /// 超出范围时取最近的边界值
    pub fn set_font_size(&mut self, area: FontArea, size: u32) {
        let slot = match area {
            FontArea::Sidebar => &mut self.sidebar_font_size,
            FontArea::Editor => &mut self.editor_font_size,
        };
        *slot = size.clamp(*area.range().start(), *area.range().end());
    }

    /// 手改过的设置文件或备份包里，字号、保存间隔可能超出范围，颜色可能写错；
    /// 加快速记录之前的设置里，别的快捷键可能已经设成了快速记录的默认按键，这时快速记录让给它、设为不使用
    pub fn normalize(&mut self) {
        if let Some(quick) = self.quick_capture_shortcut.as_deref() {
            let others = [&self.toggle_shortcut, &self.toggle_done_shortcut, &self.open_external_shortcut];
            if others.iter().any(|o| o.as_deref().is_some_and(|o| same_keys(o, quick))) {
                self.quick_capture_shortcut = None;
            }
        }
        for area in FontArea::ALL {
            self.set_font_size(area, self.font_size(area));
        }
        self.save_delay_secs = self.save_delay_secs.clamp(*SAVE_DELAY_RANGE.start(), *SAVE_DELAY_RANGE.end());
        self.editor_custom_color =
            parse_color(&self.editor_custom_color).unwrap_or_else(|| DEFAULT_CUSTOM_COLOR.into());
        let t = &self.quick_capture_target;
        // 项目可以是子项目（「父项目/子项目」，可以有好几级）
        self.quick_capture_target = match (normalize_name(&t.workspace, "工作区"), normalize_project_path(&t.project)) {
            (Ok(workspace), Ok(project)) => QuickTarget { workspace, project },
            _ => QuickTarget::default(),
        };
    }
}

/// 两个快捷键是不是同一组按键：不分大小写、修饰键的顺序，`KeyN` 和 `N`、`Digit1` 和 `1` 算一样
fn same_keys(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let mut parts: Vec<String> = s
            .split('+')
            .map(|p| {
                let p = p.trim().to_ascii_uppercase();
                let p = if p == "CONTROL" { "CTRL".to_string() } else { p };
                match (p.strip_prefix("KEY"), p.strip_prefix("DIGIT")) {
                    (Some(k), _) if k.len() == 1 => k.to_string(),
                    (_, Some(d)) if d.len() == 1 => d.to_string(),
                    _ => p,
                }
            })
            .collect();
        parts.sort();
        parts
    };
    norm(a) == norm(b)
}

/// 认 `#rrggbb`（不区分大小写，`#` 可省略），统一成小写的 `#rrggbb`
pub fn parse_color(text: &str) -> Option<String> {
    let hex = text.trim().trim_start_matches('#');
    (hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| format!("#{}", hex.to_ascii_lowercase()))
}

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    /// 文件不存在或内容损坏时使用默认设置
    pub fn load(root: &Path) -> Self {
        let path = root.join(SETTINGS_FILE);
        let mut current: Settings = fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(strip_bom(&b)).ok())
            .unwrap_or_default();
        current.normalize();
        Self {
            path,
            current: Mutex::new(current),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Settings> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(&self) -> Settings {
        self.lock().clone()
    }

    pub fn save(&self, mut next: Settings) -> Result<(), String> {
        next.normalize();
        let mut cur = self.lock();
        let json = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
        atomic_write(&self.path, &json).map_err(|e| format!("保存设置失败：{e}"))?;
        *cur = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("todolist-settings-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_fields_use_defaults() {
        let tmp = TempRoot::new("missing");
        // 加字号之前的设置文件
        fs::write(tmp.0.join(SETTINGS_FILE), br#"{"toggleShortcut":"Ctrl+Alt+Y"}"#).unwrap();
        let s = SettingsStore::load(&tmp.0).get();
        assert_eq!(s.toggle_shortcut.as_deref(), Some("Ctrl+Alt+Y"));
        assert_eq!(s.font_size(FontArea::Sidebar), 14);
        assert_eq!(s.font_size(FontArea::Editor), 15);
        assert_eq!(s.editor_background, EditorBackground::Beige);
        assert_eq!(s.editor_custom_color, DEFAULT_CUSTOM_COLOR);
        assert_eq!(s.save_delay_secs, 180);
        assert!(!s.auto_save);
        assert_eq!(s.startup_view, StartupView::Home);
        assert!(s.autostart_hidden);
        assert_eq!(s.theme, Theme::System);
        assert_eq!(s.quick_capture_shortcut.as_deref(), Some("Ctrl+Alt+N"));
        assert_eq!(s.quick_capture_target, QuickTarget::default());
    }

    #[test]
    fn quick_capture_shortcut_yields_to_existing_ones() {
        let tmp = TempRoot::new("quick-key");
        // 加快速记录之前，显示 / 隐藏主窗口已经改成了 Ctrl+Alt+N（写法不同也算）
        fs::write(tmp.0.join(SETTINGS_FILE), br#"{"toggleShortcut":"alt+ctrl+KeyN"}"#).unwrap();
        let s = SettingsStore::load(&tmp.0).get();
        assert_eq!(s.toggle_shortcut.as_deref(), Some("alt+ctrl+KeyN"));
        assert_eq!(s.quick_capture_shortcut, None);
        // 不重复时照常用默认的
        fs::write(tmp.0.join(SETTINGS_FILE), br#"{"toggleShortcut":"Ctrl+Alt+Y"}"#).unwrap();
        assert_eq!(SettingsStore::load(&tmp.0).get().quick_capture_shortcut.as_deref(), Some("Ctrl+Alt+N"));
        assert!(same_keys("Ctrl+Shift+1", "shift+control+Digit1"));
        assert!(!same_keys("Ctrl+Alt+N", "Ctrl+N"));
    }

    #[test]
    fn quick_capture_target_roundtrip_and_bad_values() {
        let tmp = TempRoot::new("quick");
        let store = SettingsStore::load(&tmp.0);
        let mut next = store.get();
        next.quick_capture_target = QuickTarget { workspace: "工作".into(), project: " 灵感 ".into() };
        next.quick_capture_shortcut = None;
        store.save(next).unwrap();
        let s = SettingsStore::load(&tmp.0).get();
        assert_eq!(s.quick_capture_target, QuickTarget { workspace: "工作".into(), project: "灵感".into() });
        assert_eq!(s.quick_capture_shortcut, None);

        // 可以存到子项目里，好几级的也行
        let mut next = store.get();
        next.quick_capture_target = QuickTarget { workspace: "工作".into(), project: "需求 / 前端 ".into() };
        store.save(next).unwrap();
        let s = SettingsStore::load(&tmp.0).get();
        assert_eq!(s.quick_capture_target, QuickTarget { workspace: "工作".into(), project: "需求/前端".into() });
        let mut next = store.get();
        next.quick_capture_target = QuickTarget { workspace: "工作".into(), project: "需求/前端/组件".into() };
        store.save(next).unwrap();
        assert_eq!(SettingsStore::load(&tmp.0).get().quick_capture_target.project, "需求/前端/组件");

        // 手改坏的、名字不合法的用默认的，别的设置照常读出来
        for bad in [
            r#""收件箱""#,
            r#"{"workspace":"a/b","project":"x"}"#,
            r#"{"workspace":"w"}"#,
            r#"{"workspace":"w","project":"a/../c"}"#,
            r#"{"workspace":"w","project":"a//b"}"#,
        ] {
            let json = format!(r#"{{"toggleShortcut":"Ctrl+Alt+Y","quickCaptureTarget":{bad}}}"#);
            fs::write(tmp.0.join(SETTINGS_FILE), json).unwrap();
            let s = SettingsStore::load(&tmp.0).get();
            assert_eq!(s.quick_capture_target, QuickTarget::default(), "{bad}");
            assert_eq!(s.toggle_shortcut.as_deref(), Some("Ctrl+Alt+Y"));
        }
    }

    #[test]
    fn theme_roundtrip_and_bad_values() {
        let tmp = TempRoot::new("theme");
        let store = SettingsStore::load(&tmp.0);
        let mut next = store.get();
        next.theme = Theme::Dark;
        store.save(next).unwrap();
        let text = fs::read_to_string(tmp.0.join(SETTINGS_FILE)).unwrap();
        assert!(text.contains(r#""theme": "dark""#), "{text}");
        assert_eq!(SettingsStore::load(&tmp.0).get().theme, Theme::Dark);

        fs::write(tmp.0.join(SETTINGS_FILE), br#"{"toggleShortcut":"Ctrl+Alt+Y","theme":"sepia"}"#).unwrap();
        let s = SettingsStore::load(&tmp.0).get();
        assert_eq!(s.theme, Theme::System);
        assert_eq!(s.toggle_shortcut.as_deref(), Some("Ctrl+Alt+Y"));
    }

    #[test]
    fn startup_view_roundtrip_and_bad_values() {
        let tmp = TempRoot::new("startup");
        let store = SettingsStore::load(&tmp.0);
        let mut next = store.get();
        next.startup_view = StartupView::LastPosition;
        store.save(next).unwrap();
        let text = fs::read_to_string(tmp.0.join(SETTINGS_FILE)).unwrap();
        assert!(text.contains(r#""startupView": "lastPosition""#), "{text}");
        assert_eq!(SettingsStore::load(&tmp.0).get().startup_view, StartupView::LastPosition);

        fs::write(tmp.0.join(SETTINGS_FILE), br#"{"toggleShortcut":"Ctrl+Alt+Y","startupView":"somewhere"}"#).unwrap();
        let s = SettingsStore::load(&tmp.0).get();
        assert_eq!(s.startup_view, StartupView::Home);
        assert_eq!(s.toggle_shortcut.as_deref(), Some("Ctrl+Alt+Y"));
    }

    #[test]
    fn save_options_roundtrip_and_clamp() {
        let tmp = TempRoot::new("save");
        let store = SettingsStore::load(&tmp.0);
        let mut next = store.get();
        next.auto_save = true;
        next.save_delay_secs = 30;
        store.save(next).unwrap();
        let text = fs::read_to_string(tmp.0.join(SETTINGS_FILE)).unwrap();
        assert!(text.contains(r#""autoSave": true"#), "{text}");
        assert!(text.contains(r#""saveDelaySecs": 30"#), "{text}");
        let s = SettingsStore::load(&tmp.0).get();
        assert!(s.auto_save);
        assert_eq!(s.save_delay_secs, 30);

        fs::write(tmp.0.join(SETTINGS_FILE), br#"{"saveDelaySecs":0}"#).unwrap();
        assert_eq!(SettingsStore::load(&tmp.0).get().save_delay_secs, 1);
        fs::write(tmp.0.join(SETTINGS_FILE), br#"{"saveDelaySecs":99999}"#).unwrap();
        assert_eq!(SettingsStore::load(&tmp.0).get().save_delay_secs, 3600);
    }

    #[test]
    fn editor_background_roundtrip_and_bad_values() {
        let tmp = TempRoot::new("background");
        let store = SettingsStore::load(&tmp.0);
        let mut next = store.get();
        next.editor_background = EditorBackground::Custom;
        next.editor_custom_color = "#FFAA00".into();
        store.save(next).unwrap();
        let text = fs::read_to_string(tmp.0.join(SETTINGS_FILE)).unwrap();
        assert!(text.contains(r#""editorBackground": "custom""#), "{text}");
        let s = SettingsStore::load(&tmp.0).get();
        assert_eq!(s.editor_background, EditorBackground::Custom);
        assert_eq!(s.editor_custom_color, "#ffaa00");

        // 认不出的背景色、写错的颜色不能连累其他设置
        fs::write(
            tmp.0.join(SETTINGS_FILE),
            br#"{"toggleShortcut":"Ctrl+Alt+Y","editorBackground":"green","editorCustomColor":"rgb(1,2,3)"}"#,
        )
        .unwrap();
        let s = SettingsStore::load(&tmp.0).get();
        assert_eq!(s.editor_background, EditorBackground::Beige);
        assert_eq!(s.editor_custom_color, DEFAULT_CUSTOM_COLOR);
        assert_eq!(s.toggle_shortcut.as_deref(), Some("Ctrl+Alt+Y"));
    }

    #[test]
    fn edit_shortcuts_roundtrip_and_bad_values() {
        let tmp = TempRoot::new("edit-shortcuts");
        let store = SettingsStore::load(&tmp.0);
        assert!(store.get().edit_shortcuts.is_empty());
        let mut next = store.get();
        next.edit_shortcuts.insert("bold".into(), Some("Ctrl+Alt+B".into()));
        next.edit_shortcuts.insert("strike".into(), None);
        store.save(next).unwrap();
        let s = SettingsStore::load(&tmp.0).get();
        assert_eq!(s.edit_shortcuts.get("bold"), Some(&Some("Ctrl+Alt+B".to_string())));
        assert_eq!(s.edit_shortcuts.get("strike"), Some(&None));

        // 写坏的项丢掉，其余的和别的设置照常
        fs::write(
            tmp.0.join(SETTINGS_FILE),
            br#"{"toggleShortcut":"Ctrl+Alt+Y","editShortcuts":{"bold":"Ctrl+Alt+B","italic":3,"code":"  ","link":null}}"#,
        )
        .unwrap();
        let s = SettingsStore::load(&tmp.0).get();
        assert_eq!(s.toggle_shortcut.as_deref(), Some("Ctrl+Alt+Y"));
        assert_eq!(s.edit_shortcuts.len(), 2);
        assert_eq!(s.edit_shortcuts.get("link"), Some(&None));
        fs::write(tmp.0.join(SETTINGS_FILE), br#"{"toggleShortcut":"Ctrl+Alt+Y","editShortcuts":"oops"}"#).unwrap();
        let s = SettingsStore::load(&tmp.0).get();
        assert_eq!(s.toggle_shortcut.as_deref(), Some("Ctrl+Alt+Y"));
        assert!(s.edit_shortcuts.is_empty());
    }

    #[test]
    fn colors_are_parsed() {
        assert_eq!(parse_color("#C7EDCC").as_deref(), Some("#c7edcc"));
        assert_eq!(parse_color(" c7edcc ").as_deref(), Some("#c7edcc"));
        assert_eq!(parse_color("#c7edc"), None);
        assert_eq!(parse_color("#c7edcg"), None);
        assert_eq!(parse_color(""), None);
    }

    #[test]
    fn font_sizes_are_clamped() {
        let tmp = TempRoot::new("clamp");
        fs::write(tmp.0.join(SETTINGS_FILE), br#"{"sidebarFontSize":3,"editorFontSize":100}"#).unwrap();
        let store = SettingsStore::load(&tmp.0);
        assert_eq!(store.get().font_size(FontArea::Sidebar), 12);
        assert_eq!(store.get().font_size(FontArea::Editor), 32);

        let mut next = store.get();
        next.set_font_size(FontArea::Editor, 18);
        next.sidebar_font_size = 99;
        store.save(next).unwrap();
        let saved = SettingsStore::load(&tmp.0).get();
        assert_eq!(saved.font_size(FontArea::Editor), 18);
        assert_eq!(saved.font_size(FontArea::Sidebar), 20);
    }
}
