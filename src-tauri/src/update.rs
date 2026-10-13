//! 自动更新里和 Tauri 无关的部分：运行安装程序之前记下的标记（从哪个版本更新到哪个版本），
//! 下次启动时读出来，据此显示主窗口、提示更新好了没有。
//! 检查、下载、安装在 lib.rs 的「自动更新」里（tauri-plugin-updater）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// 标记文件：放在这台电脑上的配置目录（和记住窗口位置的文件在一起），不跟着数据目录走
pub const MARKER_FILE: &str = "update-pending.json";

/// 运行安装程序之前记下的：从哪个版本更新到哪个版本
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Marker {
    pub from: String,
    pub to: String,
}

/// 启动时交给前端的：上次的更新装好了没有
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub from: String,
    pub to: String,
    /// 现在运行的就是要更新到的版本
    pub done: bool,
}

/// 记下标记（配置目录还没有时建出来）
pub fn write_marker(dir: &Path, marker: &Marker) -> Result<(), String> {
    let json = serde_json::to_vec(marker).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir)
        .and_then(|_| fs::write(dir.join(MARKER_FILE), json))
        .map_err(|e| format!("没能记下要更新到的版本：{e}"))
}

/// 安装程序没运行起来时删掉标记
pub fn remove_marker(dir: &Path) {
    let _ = fs::remove_file(dir.join(MARKER_FILE));
}

/// 启动时读出并删掉标记：有标记说明上次运行时开始了更新，返回装好了没有（current 是现在运行的版本）。
/// 读坏了的也删掉，当没有
pub fn take_outcome(dir: &Path, current: &str) -> Option<Outcome> {
    let path = dir.join(MARKER_FILE);
    let bytes = fs::read(&path).ok()?;
    let _ = fs::remove_file(&path);
    let marker: Marker = serde_json::from_slice(&bytes).ok()?;
    let done = marker.to == current;
    Some(Outcome { from: marker.from, to: marker.to, done })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("todolist-update-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn marker_is_read_once() {
        let dir = temp_dir("once");
        // 配置目录还没有时建出来
        write_marker(&dir, &Marker { from: "0.1.2".into(), to: "0.1.3".into() }).unwrap();
        assert_eq!(
            take_outcome(&dir, "0.1.3"),
            Some(Outcome { from: "0.1.2".into(), to: "0.1.3".into(), done: true })
        );
        assert!(!dir.join(MARKER_FILE).exists());
        assert_eq!(take_outcome(&dir, "0.1.3"), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn still_old_version_is_not_done() {
        let dir = temp_dir("old");
        write_marker(&dir, &Marker { from: "0.1.2".into(), to: "0.1.3".into() }).unwrap();
        assert_eq!(
            take_outcome(&dir, "0.1.2"),
            Some(Outcome { from: "0.1.2".into(), to: "0.1.3".into(), done: false })
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn broken_marker_is_dropped() {
        let dir = temp_dir("broken");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(MARKER_FILE), "不是 JSON").unwrap();
        assert_eq!(take_outcome(&dir, "0.1.3"), None);
        assert!(!dir.join(MARKER_FILE).exists());
        // 没有标记
        assert_eq!(take_outcome(&dir, "0.1.3"), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn removed_marker_is_gone() {
        let dir = temp_dir("removed");
        write_marker(&dir, &Marker { from: "0.1.2".into(), to: "0.1.3".into() }).unwrap();
        remove_marker(&dir);
        assert_eq!(take_outcome(&dir, "0.1.2"), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
