//! 应用设置，保存在数据根目录下的 `.settings.json`。
//!
//! 工作区只认子目录，这个文件不会被当成工作区。

use crate::store::{atomic_write, strip_bom};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const SETTINGS_FILE: &str = ".settings.json";
pub const DEFAULT_TOGGLE_SHORTCUT: &str = "Ctrl+Alt+T";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 显示主窗口 / 隐藏到托盘的全局快捷键，格式如 `Ctrl+Alt+T`；None 表示不使用
    pub toggle_shortcut: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            toggle_shortcut: Some(DEFAULT_TOGGLE_SHORTCUT.into()),
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
