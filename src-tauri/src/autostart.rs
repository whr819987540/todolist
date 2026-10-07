//! 开机自启：在注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 里写一项启动命令。
//!
//! - 项名用产品名（「待办清单」）：Tauri 的卸载程序在不是升级时会删掉同名的这一项，卸载后不会再开机启动
//! - 程序路径加引号（路径里可能有空格），后面带上 `--autostart`，启动时据此知道是开机自启的
//! - 在任务管理器的「启动应用」里禁用后，`...\Explorer\StartupApproved\Run` 里同名的一项标成禁用，这时算没开；
//!   在软件里重新打开时改回启用
//! - 开没开以注册表为准，不写进设置文件：这是这台电脑上的设置，不随设置备份恢复，也不随数据目录同步

use std::path::Path;

/// 开机自启时带的命令行参数
pub const ARG: &str = "--autostart";

/// 写进 Run 的启动命令
pub fn command(exe: &Path) -> String {
    format!("\"{}\" {ARG}", exe.display())
}

/// StartupApproved 里的值：第一个字节是偶数（2、6）表示启用，奇数（3、7）表示在任务管理器里禁用了；
/// 没有这一项（从没在任务管理器里改过）也算启用
pub fn approved(bytes: Option<&[u8]>) -> bool {
    bytes.and_then(|b| b.first()).is_none_or(|b| b % 2 == 0)
}

/// 这次是不是开机自启的（命令行里带着 --autostart）
pub fn launched_at_login<I: IntoIterator<Item = String>>(args: I) -> bool {
    args.into_iter().skip(1).any(|a| a == ARG)
}

#[cfg(windows)]
mod imp {
    use super::{approved, command};
    use std::path::Path;
    use windows_registry::{Type, CURRENT_USER};

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    /// StartupApproved 里「启用」的值
    pub(super) const ENABLED: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    pub fn is_enabled(name: &str) -> bool {
        is_enabled_at(RUN, APPROVED, name)
    }

    pub fn set(name: &str, exe: &Path, enabled: bool) -> Result<(), String> {
        set_at(RUN, APPROVED, name, exe, enabled)
    }

    /// run_at、approved_at 是 HKCU 下 Run 和 StartupApproved\Run 的位置（单元测试换成别的位置，不碰真正的启动项）
    pub(super) fn is_enabled_at(run_at: &str, approved_at: &str, name: &str) -> bool {
        let listed = CURRENT_USER.open(run_at).and_then(|k| k.get_value(name)).is_ok();
        let state = CURRENT_USER.open(approved_at).and_then(|k| k.get_value(name)).ok();
        listed && approved(state.as_deref())
    }

    pub(super) fn set_at(run_at: &str, approved_at: &str, name: &str, exe: &Path, enabled: bool) -> Result<(), String> {
        let run = CURRENT_USER.create(run_at).map_err(|e| format!("无法修改开机启动项：{e}"))?;
        // StartupApproved 不一定有（从没在任务管理器里改过），没有就不建
        let state = CURRENT_USER.options().read().write().open(approved_at).ok();
        if enabled {
            run.set_string(name, command(exe)).map_err(|e| format!("无法设置开机启动：{e}"))?;
            // 以前在任务管理器里禁用过的改回启用
            if let Some(k) = &state {
                if k.get_value(name).is_ok() {
                    let _ = k.set_bytes(name, Type::Bytes, &ENABLED);
                }
            }
        } else {
            // 本来就没有时删除会报错，不算失败
            let _ = run.remove_value(name);
            if let Some(k) = &state {
                let _ = k.remove_value(name);
            }
        }
        if is_enabled_at(run_at, approved_at, name) != enabled {
            return Err(if enabled { "开机启动没有设置成功" } else { "开机启动没有关掉" }.into());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::Path;

    pub fn is_enabled(_name: &str) -> bool {
        false
    }

    pub fn set(_name: &str, _exe: &Path, _enabled: bool) -> Result<(), String> {
        Err("只有 Windows 版支持开机自启".into())
    }
}

/// 是否已设置开机自启（name 是启动项的名字，即产品名）
pub fn is_enabled(name: &str) -> bool {
    imp::is_enabled(name)
}

/// 打开 / 关闭开机自启，exe 是现在这个程序的路径
pub fn set(name: &str, exe: &Path, enabled: bool) -> Result<(), String> {
    imp::set(name, exe, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_quotes_path_and_marks_autostart() {
        let exe = Path::new(r"C:\Users\Zhang San\AppData\Local\待办清单\todo-list.exe");
        assert_eq!(command(exe), r#""C:\Users\Zhang San\AppData\Local\待办清单\todo-list.exe" --autostart"#);
    }

    #[test]
    fn launched_at_login_only_with_flag() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(launched_at_login(args(&["todo-list.exe", "--autostart"])));
        assert!(!launched_at_login(args(&["todo-list.exe"])));
        // 程序本身的路径不算
        assert!(!launched_at_login(args(&["--autostart"])));
    }

    #[test]
    fn task_manager_state() {
        assert!(approved(None));
        assert!(approved(Some(&[])));
        assert!(approved(Some(&[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
        assert!(approved(Some(&[6, 0, 0, 0])));
        // 在任务管理器里禁用了
        assert!(!approved(Some(&[3, 0, 0, 0, 0x8a, 0x1f, 0, 0, 0, 0, 0, 0])));
        assert!(!approved(Some(&[7])));
    }

    /// 在 HKCU\Software 下一个临时的位置实际读写注册表（不碰真正的启动项），测完删掉
    #[cfg(windows)]
    #[test]
    fn registry_follows_task_manager_state() {
        use windows_registry::{Type, CURRENT_USER};
        struct Scratch(String);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = CURRENT_USER.remove_tree(&self.0);
            }
        }
        let base = Scratch(format!(r"Software\TodoListAutostartTest-{}", std::process::id()));
        let run = format!(r"{}\Run", base.0);
        let approved_at = format!(r"{}\StartupApproved\Run", base.0);
        let (name, exe) = ("待办清单", Path::new(r"C:\Users\Zhang San\AppData\Local\待办清单\todo-list.exe"));
        let state = || CURRENT_USER.open(&approved_at).and_then(|k| k.get_value(name)).ok().map(|v| v.to_vec());

        assert!(!imp::is_enabled_at(&run, &approved_at, name));
        imp::set_at(&run, &approved_at, name, exe, true).unwrap();
        assert!(imp::is_enabled_at(&run, &approved_at, name));
        assert_eq!(CURRENT_USER.open(&run).unwrap().get_string(name).unwrap(), command(exe));
        // 从没在任务管理器里改过：不建 StartupApproved
        assert!(CURRENT_USER.open(&approved_at).is_err());

        // 在任务管理器里禁用了：算关闭
        let disabled = [3, 0, 0, 0, 0x8a, 0x1f, 0x3c, 0x52, 0x10, 0x2b, 0xdc, 0x01];
        CURRENT_USER.create(&approved_at).unwrap().set_bytes(name, Type::Bytes, &disabled).unwrap();
        assert!(!imp::is_enabled_at(&run, &approved_at, name));
        // 在软件里重新打开：改回启用
        imp::set_at(&run, &approved_at, name, exe, true).unwrap();
        assert_eq!(state(), Some(imp::ENABLED.to_vec()));
        assert!(imp::is_enabled_at(&run, &approved_at, name));

        // 关闭：两处都删掉；本来就关着时再关不算失败
        imp::set_at(&run, &approved_at, name, exe, false).unwrap();
        assert!(CURRENT_USER.open(&run).unwrap().get_value(name).is_err());
        assert_eq!(state(), None);
        imp::set_at(&run, &approved_at, name, exe, false).unwrap();
        assert!(!imp::is_enabled_at(&run, &approved_at, name));
    }
}
