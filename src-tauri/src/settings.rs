//! 应用设置，保存在数据根目录下的 `.settings.json`。
//!
//! 工作区只认子目录，这个文件不会被当成工作区。

use crate::store::{atomic_write, strip_bom};
use serde::{Deserialize, Serialize};
use std::fs;
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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            toggle_shortcut: Some("Ctrl+Alt+T".into()),
            toggle_done_shortcut: Some("Ctrl+Alt+D".into()),
            open_external_shortcut: Some("Ctrl+Alt+O".into()),
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
}

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    /// 文件不存在或内容损坏时使用默认设置
    pub fn load(root: &Path) -> Self {
        let path = root.join(SETTINGS_FILE);
        let current = fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(strip_bom(&b)).ok())
            .unwrap_or_default();
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

    pub fn save(&self, next: Settings) -> Result<(), String> {
        let mut cur = self.lock();
        let json = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
        atomic_write(&self.path, &json).map_err(|e| format!("保存设置失败：{e}"))?;
        *cur = next;
        Ok(())
    }
}
