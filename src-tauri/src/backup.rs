//! 设置备份包：把 `.settings.json` 打成 zip，文件名带备份时间（年月日时分秒），
//! 例如 `TodoList-settings-20260926-153012.zip`。

use crate::settings::{Settings, SETTINGS_FILE};
use crate::store::strip_bom;
use crate::webdav::RemoteFile;
use chrono::{DateTime, Datelike, Local, NaiveDateTime, TimeZone, Timelike};
use serde::Serialize;
use std::io::{Cursor, Read, Write};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const PREFIX: &str = "TodoList-settings-";
const TIME_FORMAT: &str = "%Y%m%d-%H%M%S";
/// 设置文件的大小上限，超过说明不是本软件的备份
const MAX_SETTINGS_BYTES: u64 = 256 * 1024;

type Result<T> = std::result::Result<T, String>;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBackup {
    pub name: String,
    pub size: Option<u64>,
    /// 备份时间（从文件名解析）
    pub time: i64,
}

pub fn file_name(time: DateTime<Local>) -> String {
    format!("{PREFIX}{}.zip", time.format(TIME_FORMAT))
}

/// 从文件名解析备份时间（毫秒）；不是本软件的备份文件名时返回 None
fn parse_file_name(name: &str) -> Option<i64> {
    let stamp = name.strip_prefix(PREFIX)?.strip_suffix(".zip")?;
    let time = NaiveDateTime::parse_from_str(stamp, TIME_FORMAT).ok()?;
    Some(Local.from_local_datetime(&time).earliest()?.timestamp_millis())
}

/// 从远程目录的文件里挑出备份，新的在前
pub fn backups(files: Vec<RemoteFile>) -> Vec<RemoteBackup> {
    let mut list: Vec<_> = files
        .into_iter()
        .filter_map(|f| {
            Some(RemoteBackup {
                time: parse_file_name(&f.name)?,
                name: f.name,
                size: f.size,
            })
        })
        .collect();
    list.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| b.name.cmp(&a.name)));
    list
}

pub fn pack(settings: &Settings, time: DateTime<Local>) -> Result<Vec<u8>> {
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    let mtime = zip::DateTime::from_date_and_time(
        time.year() as u16,
        time.month() as u8,
        time.day() as u8,
        time.hour() as u8,
        time.minute() as u8,
        time.second() as u8,
    )
    .unwrap_or_default();
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .last_modified_time(mtime);
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file(SETTINGS_FILE, options).map_err(|e| format!("打包失败：{e}"))?;
    zip.write_all(&json).map_err(|e| format!("打包失败：{e}"))?;
    let cursor = zip.finish().map_err(|e| format!("打包失败：{e}"))?;
    Ok(cursor.into_inner())
}

/// 从备份包里读出设置；`.settings.json` 在子目录里也认（解压后连同文件夹重新压缩的情况）
pub fn unpack(data: &[u8]) -> Result<Settings> {
    let mut zip = ZipArchive::new(Cursor::new(data)).map_err(|_| "不是有效的 zip 压缩包".to_string())?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::EditorBackground;

    fn time() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 9, 26, 15, 30, 12).unwrap()
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
    fn pack_unpack_roundtrip() {
        let settings = Settings {
            toggle_shortcut: Some("Ctrl+Alt+Y".into()),
            open_external_shortcut: None,
            editor_font_size: 20,
            editor_background: EditorBackground::Custom,
            editor_custom_color: "#112233".into(),
            save_delay_secs: 45,
            auto_save: true,
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
    }

    #[test]
    fn unpack_finds_nested_file_and_rejects_others() {
        let zip_with = |name: &str, content: &[u8]| {
            let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(content).unwrap();
            zip.finish().unwrap().into_inner()
        };
        let nested = zip_with("备份/.settings.json", br#"{"toggleShortcut":"Ctrl+Alt+K"}"#);
        assert_eq!(unpack(&nested).unwrap().toggle_shortcut.as_deref(), Some("Ctrl+Alt+K"));
        assert!(unpack(&zip_with("readme.txt", b"hi")).unwrap_err().contains("没有找到"));
        assert!(unpack(&zip_with(".settings.json", b"not json")).unwrap_err().contains("内容无效"));
        assert!(unpack(b"not a zip").unwrap_err().contains("不是有效的 zip"));
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
            file("TodoList-settings-20260926-153012.zip"),
        ]);
        let names: Vec<_> = list.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(
            names,
            ["TodoList-settings-20260926-153012.zip", "TodoList-settings-20260101-080000.zip"]
        );
    }
}
