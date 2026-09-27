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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            toggle_shortcut: Some("Ctrl+Alt+T".into()),
            toggle_done_shortcut: Some("Ctrl+Alt+D".into()),
            open_external_shortcut: Some("Ctrl+Alt+O".into()),
            sidebar_font_size: 14,
            editor_font_size: 15,
        }
    }
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

    /// 手改过的设置文件或备份包里，字号可能超出范围
    fn normalize(&mut self) {
        for area in FontArea::ALL {
            self.set_font_size(area, self.font_size(area));
        }
    }
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
