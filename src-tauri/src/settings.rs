//! 应用设置，保存在数据根目录下的 `.settings.json`。
//!
//! 工作区只认子目录，这个文件不会被当成工作区。

use crate::store::{atomic_write, strip_bom};
use serde::{Deserialize, Serialize};
use std::fs;
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub const SETTINGS_FILE: &str = ".settings.json";

/// 编辑区自定义背景色的默认值：豆沙绿
const DEFAULT_CUSTOM_COLOR: &str = "#c7edcc";

/// 定时保存的可调范围（秒）：1 秒到 1 小时；前端 settings.tsx 的 SAVE_DELAY_LIMITS 与此一致
pub const SAVE_DELAY_RANGE: RangeInclusive<u32> = 1..=3600;

/// 快捷键格式如 `Ctrl+Alt+T`，None 表示不使用；文件里缺的字段取默认值
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 全局快捷键：显示主窗口 / 隐藏到托盘
    pub toggle_shortcut: Option<String>,
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
    /// 界面主题：浅色、深色或跟随系统
    pub theme: Theme,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            toggle_shortcut: Some("Ctrl+Alt+T".into()),
            toggle_done_shortcut: Some("Ctrl+Alt+D".into()),
            open_external_shortcut: Some("Ctrl+Alt+O".into()),
            sidebar_font_size: 14,
            editor_font_size: 15,
            editor_background: EditorBackground::default(),
            editor_custom_color: DEFAULT_CUSTOM_COLOR.into(),
            save_delay_secs: 180,
            auto_save: false,
            startup_view: StartupView::default(),
            theme: Theme::default(),
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
    /// 回到上次的位置：侧栏选中的工作区、右侧打开的待办（记在前端的 localStorage 里）
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
    ToggleDone,
    OpenExternal,
}

impl ShortcutAction {
    pub const ALL: [Self; 3] = [Self::ToggleWindow, Self::ToggleDone, Self::OpenExternal];

    pub fn label(self) -> &'static str {
        match self {
            Self::ToggleWindow => "显示 / 隐藏主窗口",
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
            ShortcutAction::ToggleDone => self.toggle_done_shortcut.as_deref(),
            ShortcutAction::OpenExternal => self.open_external_shortcut.as_deref(),
        }
    }

    pub fn set_shortcut(&mut self, action: ShortcutAction, shortcut: Option<String>) {
        let slot = match action {
            ShortcutAction::ToggleWindow => &mut self.toggle_shortcut,
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

    /// 手改过的设置文件或备份包里，字号、保存间隔可能超出范围，颜色可能写错
    fn normalize(&mut self) {
        for area in FontArea::ALL {
            self.set_font_size(area, self.font_size(area));
        }
        self.save_delay_secs = self.save_delay_secs.clamp(*SAVE_DELAY_RANGE.start(), *SAVE_DELAY_RANGE.end());
        self.editor_custom_color =
            parse_color(&self.editor_custom_color).unwrap_or_else(|| DEFAULT_CUSTOM_COLOR.into());
    }
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
        assert_eq!(s.theme, Theme::System);
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
