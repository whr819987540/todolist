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
/// 读坏了的也删掉，当没有。
///
/// 删不掉（被杀毒软件、同步工具占着，没有删除权限）时不算刚更新过：删不掉就没法只提示一次，每次启动都会当作刚更新完，
/// 强制显示主窗口（开机自启只在托盘里时也是）、再提示一遍；少提示一次「已更新到 x」没什么，设置里看得到现在的版本。
/// 标记留着，以后哪次启动删掉了再看：那时的版本既不是更新前的、也不是要更新到的（之后又装过别的版本），标记是以前
/// 留下的，不提示
pub fn take_outcome(dir: &Path, current: &str) -> Option<Outcome> {
    let path = dir.join(MARKER_FILE);
    let bytes = fs::read(&path).ok()?;
    if let Err(e) = fs::remove_file(&path) {
        eprintln!("没能删掉更新的标记 {}，这次不当作刚更新过：{e}", path.display());
        return None;
    }
    let marker: Marker = serde_json::from_slice(&bytes).ok()?;
    let done = marker.to == current;
    if !done && marker.from != current {
        return None;
    }
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

    /// 让 dir 里的标记删不掉，放掉返回的值后恢复。Linux 上把目录设成只读（删文件要改目录）
    #[cfg(unix)]
    fn hold_undeletable(dir: &Path) -> impl Sized {
        use std::os::unix::fs::PermissionsExt;
        struct Restore(std::path::PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
            }
        }
        fs::set_permissions(dir, fs::Permissions::from_mode(0o555)).unwrap();
        Restore(dir.to_path_buf())
    }

    /// Windows 上 Rust 的 remove_file 连只读的文件也删得掉（去掉只读属性再删），把文件设成只读挡不住：改成打开着它、
    /// 不共享删除，同被杀毒软件、同步工具占着
    #[cfg(windows)]
    fn hold_undeletable(dir: &Path) -> impl Sized {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(dir.join(MARKER_FILE)).unwrap()
    }

    #[test]
    fn undeletable_marker_is_not_taken() {
        let dir = temp_dir("undeletable");
        write_marker(&dir, &Marker { from: "0.1.2".into(), to: "0.1.3".into() }).unwrap();
        let held = hold_undeletable(&dir);
        // 删不掉：不当作刚更新过，不然每次启动都强制显示主窗口、提示一遍；标记留着
        assert_eq!(take_outcome(&dir, "0.1.3"), None);
        assert_eq!(take_outcome(&dir, "0.1.3"), None);
        assert!(dir.join(MARKER_FILE).exists());
        drop(held);
        // 以后哪次启动删掉了：还是那个版本，照常提示一次
        assert_eq!(
            take_outcome(&dir, "0.1.3"),
            Some(Outcome { from: "0.1.2".into(), to: "0.1.3".into(), done: true })
        );
        assert!(!dir.join(MARKER_FILE).exists());
        assert_eq!(take_outcome(&dir, "0.1.3"), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn leftover_marker_of_other_versions_is_dropped() {
        let dir = temp_dir("leftover");
        write_marker(&dir, &Marker { from: "0.1.2".into(), to: "0.1.3".into() }).unwrap();
        // 现在的版本既不是更新前的、也不是要更新到的：标记是以前留下的（当时删不掉，之后又装过别的版本），不提示、删掉
        assert_eq!(take_outcome(&dir, "0.1.5"), None);
        assert!(!dir.join(MARKER_FILE).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
