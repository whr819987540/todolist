//! 备份包：设置备份把 `.settings.json` 打成 zip，文件名带备份时间（年月日时分秒），
//! 例如 `TodoList-settings-20260926-153012.zip`；待办数据的备份见 data_backup.rs（`TodoList-data-….zip`）。
//!
//! 两种备份包里都有说明文件 `backup.json`（类型、软件版本、备份时间），恢复时据此认出拿错了的备份；
//! 以前的设置备份没有它，只有 `.settings.json`，也认。

use crate::settings::{Settings, SETTINGS_FILE};
use crate::store::strip_bom;
use crate::webdav::RemoteFile;
use chrono::{DateTime, Datelike, Local, NaiveDateTime, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Cursor, Read, Seek, Write};
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const PREFIX: &str = "TodoList-settings-";
/// 待办数据备份的文件名开头（data_backup.rs）
pub const DATA_PREFIX: &str = "TodoList-data-";
const TIME_FORMAT: &str = "%Y%m%d-%H%M%S";
/// 备份包里的说明文件
pub const MANIFEST_FILE: &str = "backup.json";
/// 设置文件的大小上限，超过说明不是本软件的备份
const MAX_SETTINGS_BYTES: u64 = 256 * 1024;
/// 说明文件的大小上限：数据备份的说明里有各文件的修改时间，几万个文件也远不到这么大
const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
/// 本地设置备份包的大小上限；设置备份只有几 KB
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// 恢复数据时选了设置备份、恢复设置时选了数据备份的提示
pub const SETTINGS_BACKUP_HINT: &str = "这是设置的备份，不是待办数据的备份；要恢复设置请用「从本地文件恢复设置」";
pub const DATA_BACKUP_HINT: &str = "这是待办数据的备份，不是设置的备份；要恢复待办数据请用「从本地文件恢复数据」";

type Result<T> = std::result::Result<T, String>;

/// 备份包是哪一种
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupKind {
    Settings,
    Data,
}

/// 备份包里的说明文件 backup.json
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub kind: BackupKind,
    #[serde(default)]
    pub app_version: String,
    /// 备份时间（毫秒）
    #[serde(default)]
    pub created_at: i64,
    /// 数据备份：有几个工作区、几条待办
    #[serde(default)]
    pub workspaces: usize,
    #[serde(default)]
    pub todos: usize,
    /// 数据备份：按各文件的路径、大小、修改时间算出的指纹，自动备份据此判断数据有没有变
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub fingerprint: String,
    /// 数据备份：各文件、文件夹的修改时间（毫秒），键是包里的路径；恢复时照着改回去
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mtimes: BTreeMap<String, i64>,
}

impl Manifest {
    pub fn new(kind: BackupKind, time: DateTime<Local>) -> Self {
        Self {
            kind,
            app_version: env!("CARGO_PKG_VERSION").into(),
            created_at: time.timestamp_millis(),
            workspaces: 0,
            todos: 0,
            fingerprint: String::new(),
            mtimes: BTreeMap::new(),
        }
    }
}

/// 读备份包里的说明；没有时返回 None（以前的设置备份，或者不是本软件的备份）
pub fn read_manifest<R: Read + Seek>(zip: &mut ZipArchive<R>) -> Result<Option<Manifest>> {
    let Ok(file) = zip.by_name(MANIFEST_FILE) else { return Ok(None) };
    if file.size() > MAX_MANIFEST_BYTES {
        return Err("压缩包里的备份说明 backup.json 过大，不是本软件的备份".into());
    }
    let mut buf = Vec::new();
    file.take(MAX_MANIFEST_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取压缩包失败：{e}"))?;
    serde_json::from_slice(strip_bom(&buf))
        .map(Some)
        .map_err(|_| "压缩包里的备份说明 backup.json 内容无效，不是本软件的备份".into())
}

/// 备份包里文件的修改时间（zip 里记的是本地时间、精确到 2 秒；数据备份恢复时用说明里记的）
pub fn zip_time(time: DateTime<Local>) -> zip::DateTime {
    zip::DateTime::from_date_and_time(
        time.year() as u16,
        time.month() as u8,
        time.day() as u8,
        time.hour() as u8,
        time.minute() as u8,
        time.second() as u8,
    )
    .unwrap_or_default()
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBackup {
    pub name: String,
    pub size: Option<u64>,
    /// 备份时间（从文件名解析）
    pub time: i64,
    pub kind: BackupKind,
}

pub fn file_name(time: DateTime<Local>) -> String {
    format!("{PREFIX}{}.zip", time.format(TIME_FORMAT))
}

/// 从文件名解析备份时间（毫秒）；不是本软件的设置备份文件名时返回 None
fn parse_file_name(name: &str) -> Option<i64> {
    parse_stamp(name.strip_prefix(PREFIX)?.strip_suffix(".zip")?)
}

/// 文件名里的 `年月日-时分秒`
pub fn stamp(time: DateTime<Local>) -> String {
    time.format(TIME_FORMAT).to_string()
}

/// `年月日-时分秒` 按本地时间解析成毫秒
fn parse_stamp(stamp: &str) -> Option<i64> {
    let time = NaiveDateTime::parse_from_str(stamp, TIME_FORMAT).ok()?;
    Some(Local.from_local_datetime(&time).earliest()?.timestamp_millis())
}

/// 待办数据备份的文件名 `TodoList-data-年月日-时分秒.zip`（同一秒里已有一份时是 `…-2.zip`），返回备份时间；
/// 恢复前自动备份的那份（`…-恢复前.zip`）和别的文件返回 None
pub fn parse_data_file_name(name: &str) -> Option<i64> {
    let rest = name.strip_prefix(DATA_PREFIX)?.strip_suffix(".zip")?;
    let stamp = rest.get(..15)?;
    let tail = &rest[15..];
    let numbered = tail.strip_prefix('-').is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    if !tail.is_empty() && !numbered {
        return None;
    }
    parse_stamp(stamp)
}

/// 从远程目录的文件里挑出备份（设置的和待办数据的），新的在前
pub fn backups(files: Vec<RemoteFile>) -> Vec<RemoteBackup> {
    let mut list: Vec<_> = files
        .into_iter()
        .filter_map(|f| {
            let (time, kind) = match parse_file_name(&f.name) {
                Some(t) => (t, BackupKind::Settings),
                None => (parse_data_file_name(&f.name)?, BackupKind::Data),
            };
            Some(RemoteBackup { time, kind, name: f.name, size: f.size })
        })
        .collect();
    list.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| b.name.cmp(&a.name)));
    list
}

pub fn pack(settings: &Settings, time: DateTime<Local>) -> Result<Vec<u8>> {
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    let manifest = serde_json::to_vec_pretty(&Manifest::new(BackupKind::Settings, time)).map_err(|e| e.to_string())?;
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .last_modified_time(zip_time(time));
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in [(MANIFEST_FILE, &manifest), (SETTINGS_FILE, &json)] {
        zip.start_file(name, options).map_err(|e| format!("打包失败：{e}"))?;
        zip.write_all(content).map_err(|e| format!("打包失败：{e}"))?;
    }
    let cursor = zip.finish().map_err(|e| format!("打包失败：{e}"))?;
    Ok(cursor.into_inner())
}

/// 从备份包里读出设置；`.settings.json` 在子目录里也认（解压后连同文件夹重新压缩的情况）。
/// 待办数据的备份不认（工作区里可能碰巧有个 `.settings.json`），提示拿错了
pub fn unpack(data: &[u8]) -> Result<Settings> {
    let mut zip = ZipArchive::new(Cursor::new(data)).map_err(|_| "不是有效的 zip 压缩包".to_string())?;
    if read_manifest(&mut zip)?.is_some_and(|m| m.kind == BackupKind::Data) {
        return Err(DATA_BACKUP_HINT.into());
    }
    let name = zip
        .file_names()
        .find(|n| n.rsplit(['/', '\\']).next() == Some(SETTINGS_FILE))
        .map(str::to_owned)
        .ok_or_else(|| format!("压缩包里没有找到设置文件 {SETTINGS_FILE}，请确认选择的是本软件的设置备份"))?;
    let file = zip.by_name(&name).map_err(|e| format!("读取压缩包失败：{e}"))?;
    if file.size() > MAX_SETTINGS_BYTES {
        return Err("压缩包里的设置文件过大，不是本软件的设置备份".into());
    }
    let mut buf = Vec::new();
    file.take(MAX_SETTINGS_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取压缩包失败：{e}"))?;
    serde_json::from_slice(strip_bom(&buf)).map_err(|e| format!("备份里的设置文件内容无效：{e}"))
}

/// 从本地的备份包读出设置
pub fn read_file(path: &Path) -> Result<Settings> {
    let len = std::fs::metadata(path).map_err(|e| format!("读取备份文件失败：{e}"))?.len();
    if len > MAX_FILE_BYTES {
        // 数据备份一般比设置备份大得多：看一眼说明，认出来了就提示拿错了
        let is_data = std::fs::File::open(path)
            .ok()
            .and_then(|f| ZipArchive::new(f).ok())
            .and_then(|mut zip| read_manifest(&mut zip).ok().flatten())
            .is_some_and(|m| m.kind == BackupKind::Data);
        return Err(if is_data { DATA_BACKUP_HINT.into() } else { "文件超过 1 MB，不是本软件的设置备份".into() });
    }
    let data = std::fs::read(path).map_err(|e| format!("读取备份文件失败：{e}"))?;
    unpack(&data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{EditorBackground, StartupView, Theme};

    fn time() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 9, 26, 15, 30, 12).unwrap()
    }

    fn zip_with(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in files {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(content).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn name_has_full_timestamp() {
        let name = file_name(time());
        assert_eq!(name, "TodoList-settings-20260926-153012.zip");
        assert_eq!(parse_file_name(&name), Some(time().timestamp_millis()));
        assert_eq!(parse_file_name("TodoList-settings-2026.zip"), None);
        assert_eq!(parse_file_name("other.zip"), None);
    }

    #[test]
    fn data_backup_names() {
        let t = time().timestamp_millis();
        assert_eq!(parse_data_file_name("TodoList-data-20260926-153012.zip"), Some(t));
        // 同一秒里的第二份
        assert_eq!(parse_data_file_name("TodoList-data-20260926-153012-2.zip"), Some(t));
        // 恢复前自动备份的那份、别的文件不算
        for name in [
            "TodoList-data-20260926-153012-恢复前.zip",
            "TodoList-data-20260926-153012-.zip",
            "TodoList-data-20260926.zip",
            "TodoList-data-20260926-153012.zip.tmp",
            "TodoList-settings-20260926-153012.zip",
        ] {
            assert_eq!(parse_data_file_name(name), None, "{name}");
        }
    }

    #[test]
    fn pack_unpack_roundtrip() {
        let settings = Settings {
            toggle_shortcut: Some("Ctrl+Alt+Y".into()),
            open_external_shortcut: None,
            editor_font_size: 20,
            editor_background: EditorBackground::Custom,
            editor_custom_color: "#112233".into(),
            save_delay_secs: 45,
            auto_save: true,
            startup_view: StartupView::LastPosition,
            theme: Theme::Dark,
            auto_backup: false,
            auto_backup_dir: r"D:\备份".into(),
            auto_backup_keep: 30,
            auto_backup_webdav: true,
            ..Default::default()
        };
        let data = pack(&settings, time()).unwrap();
        let back = unpack(&data).unwrap();
        assert_eq!(back.toggle_shortcut.as_deref(), Some("Ctrl+Alt+Y"));
        assert_eq!(back.toggle_done_shortcut.as_deref(), Some("Ctrl+Alt+D"));
        assert_eq!(back.open_external_shortcut, None);
        assert_eq!(back.editor_font_size, 20);
        assert_eq!(back.sidebar_font_size, 14);
        assert_eq!(back.editor_background, EditorBackground::Custom);
        assert_eq!(back.editor_custom_color, "#112233");
        assert_eq!(back.save_delay_secs, 45);
        assert!(back.auto_save);
        assert_eq!(back.startup_view, StartupView::LastPosition);
        assert_eq!(back.theme, Theme::Dark);
        // 自动备份的设置随设置一起备份
        assert!(!back.auto_backup);
        assert_eq!(back.auto_backup_dir, r"D:\备份");
        assert_eq!(back.auto_backup_keep, 30);
        assert!(back.auto_backup_webdav);
        // 说明里写着是设置备份
        let mut zip = ZipArchive::new(Cursor::new(data)).unwrap();
        let m = read_manifest(&mut zip).unwrap().unwrap();
        assert_eq!(m.kind, BackupKind::Settings);
        assert_eq!(m.created_at, time().timestamp_millis());
        assert_eq!(m.app_version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn unpack_finds_nested_file_and_rejects_others() {
        // 以前没有说明文件的设置备份，解压后连同文件夹重新压缩的也认
        let nested = zip_with(&[("备份/.settings.json", br#"{"toggleShortcut":"Ctrl+Alt+K"}"#)]);
        assert_eq!(unpack(&nested).unwrap().toggle_shortcut.as_deref(), Some("Ctrl+Alt+K"));
        assert!(unpack(&zip_with(&[("readme.txt", b"hi")])).unwrap_err().contains("没有找到"));
        assert!(unpack(&zip_with(&[(".settings.json", b"not json")])).unwrap_err().contains("内容无效"));
        assert!(unpack(b"not a zip").unwrap_err().contains("不是有效的 zip"));
        // 待办数据的备份：即使工作区里碰巧有 .settings.json，也提示拿错了
        let data = zip_with(&[
            (MANIFEST_FILE, br#"{"kind":"data","createdAt":1}"#),
            ("工作/需求/.settings.json", br#"{"toggleShortcut":"Ctrl+Alt+K"}"#),
        ]);
        assert_eq!(unpack(&data).unwrap_err(), DATA_BACKUP_HINT);
        assert!(unpack(&zip_with(&[(MANIFEST_FILE, b"{oops")])).unwrap_err().contains("backup.json"));
    }

    #[test]
    fn reads_local_file_and_rejects_large_ones() {
        let dir = std::env::temp_dir().join(format!("todolist-backup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(file_name(time()));
        let settings = Settings {
            editor_font_size: 22,
            ..Default::default()
        };
        std::fs::write(&file, pack(&settings, time()).unwrap()).unwrap();
        assert_eq!(read_file(&file).unwrap().editor_font_size, 22);

        let big = dir.join("big.zip");
        std::fs::write(&big, vec![0u8; MAX_FILE_BYTES as usize + 1]).unwrap();
        assert!(read_file(&big).unwrap_err().contains("超过 1 MB"));
        // 很大的数据备份：认出来是数据备份
        let filler: Vec<u8> = (0..MAX_FILE_BYTES as usize + 1024).map(|i| (i * 7919 % 251) as u8).collect();
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(MANIFEST_FILE, SimpleFileOptions::default()).unwrap();
        zip.write_all(br#"{"kind":"data"}"#).unwrap();
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("工作/需求/图.bin", stored).unwrap();
        zip.write_all(&filler).unwrap();
        let big_data = dir.join("TodoList-data-20260926-153012.zip");
        std::fs::write(&big_data, zip.finish().unwrap().into_inner()).unwrap();
        assert_eq!(read_file(&big_data).unwrap_err(), DATA_BACKUP_HINT);
        assert!(read_file(&dir.join("missing.zip")).unwrap_err().contains("读取备份文件失败"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lists_backups_newest_first() {
        let file = |name: &str| RemoteFile {
            name: name.into(),
            size: Some(1),
        };
        let list = backups(vec![
            file("TodoList-settings-20260101-080000.zip"),
            file("notes.txt"),
            file("TodoList-data-20260801-090000.zip"),
            file("TodoList-data-20260801-090000-恢复前.zip"),
            file("TodoList-settings-20260926-153012.zip"),
        ]);
        let names: Vec<_> = list.iter().map(|b| (b.name.as_str(), b.kind)).collect();
        assert_eq!(
            names,
            [
                ("TodoList-settings-20260926-153012.zip", BackupKind::Settings),
                ("TodoList-data-20260801-090000.zip", BackupKind::Data),
                ("TodoList-settings-20260101-080000.zip", BackupKind::Settings),
            ]
        );
    }
}
