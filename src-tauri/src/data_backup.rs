//! 待办数据的备份与恢复（设置的备份见 backup.rs）。
//!
//! 备份包是 zip，文件名 `TodoList-data-年月日-时分秒.zip`：数据目录里的各工作区文件夹（项目、子项目、待办正文、
//! `.todos.json`，项目里点开头的附件目录等，保存时的临时文件除外）和 `.state.json`，外加说明文件 `backup.json`
//! （类型、软件版本、备份时间、工作区数和待办数、指纹、各文件和文件夹的修改时间）。
//! 不含软件的回收站 `.recycle`、`.trash`、设置文件、WebDAV 设置，也不含数据目录里工作区文件夹以外的别的文件。
//!
//! 自动备份存在备份目录（默认是数据目录旁边的「数据目录名-backups」）里，文件名同上，只留最近几份；
//! 恢复前先把现在的数据备份成 `…-恢复前.zip`，不算在「最近几份」里，也不会被删。

use crate::backup::{self, BackupKind, Manifest, RemoteBackup, DATA_PREFIX, MANIFEST_FILE, SETTINGS_BACKUP_HINT};
use crate::settings::SETTINGS_FILE;
use crate::store::{self, Store, UI_STATE_FILE};
use crate::webdav::WebDav;
use chrono::{DateTime, Local, TimeZone};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

type Result<T> = std::result::Result<T, String>;

/// 自动备份：距上次满这么久（24 小时）才再备份
pub const AUTO_INTERVAL_MS: i64 = 24 * 3600 * 1000;
/// 恢复前自动备份的那份，文件名里带着它
const BEFORE_RESTORE: &str = "恢复前";
/// 恢复时解压、放原来数据的临时文件夹（在数据目录里，点开头，不会被当成工作区，也不会被备份）
const STAGING_PREFIX: &str = ".restoring-";

fn io_err(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

fn to_ms(t: Option<SystemTime>) -> Option<i64> {
    Some(t?.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}

// ---------------------------------------------------------------------------
// 备份目录
// ---------------------------------------------------------------------------

/// 默认的备份目录：数据目录旁边的「数据目录名-backups」（默认的数据目录时是 %USERPROFILE%\TodoList-backups；
/// 测试时用 TODOLIST_DATA_DIR 换了数据目录，备份也跟着到它旁边，不会写进真实的备份目录）
pub fn default_dir(root: &Path) -> PathBuf {
    let name = root.file_name().map_or("TodoList".into(), |n| n.to_string_lossy().into_owned());
    root.parent().unwrap_or(root).join(format!("{name}-backups"))
}

/// 设置里的备份目录，空的是默认的
pub fn backup_dir(setting: &str, root: &Path) -> PathBuf {
    match setting.trim() {
        "" => default_dir(root),
        dir => PathBuf::from(dir),
    }
}

/// 比较路径用的写法：存在的部分换成真实的路径（去掉 ..、统一写法），Windows 上不分大小写
fn comparable(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut cur = path;
    let base = loop {
        if let Ok(real) = cur.canonicalize() {
            break real;
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_owned());
                cur = parent;
            }
            _ => break cur.to_path_buf(),
        }
    };
    let full = rest.into_iter().rev().fold(base, |p, n| p.join(n));
    if cfg!(windows) {
        PathBuf::from(full.to_string_lossy().to_lowercase())
    } else {
        full
    }
}

/// path 在数据目录 root 里面（或者就是它）
fn inside(path: &Path, root: &Path) -> bool {
    comparable(path).starts_with(comparable(root))
}

/// 备份目录要是完整的路径，不能在数据目录里面（也不能是数据目录本身）
pub fn check_backup_dir(dir: &Path, root: &Path) -> Result<()> {
    if !dir.is_absolute() {
        return Err(format!("备份目录要写完整的路径（如 D:\\备份），「{}」不行", dir.display()));
    }
    if inside(dir, root) {
        return Err("备份目录不能在数据目录里面（会被下次备份一起打包进去），请换一个".into());
    }
    Ok(())
}

/// 手动备份存到的文件不能在数据目录里面
pub fn check_target(path: &Path, root: &Path) -> Result<()> {
    if inside(path, root) {
        return Err("备份不能存在数据目录里面（下次备份时会被一起打包进去），请换个位置".into());
    }
    Ok(())
}

pub fn file_name(time: DateTime<Local>) -> String {
    format!("{DATA_PREFIX}{}.zip", backup::stamp(time))
}

/// dir 里还没有的文件名：`{base}.zip`，有了就 `{base}-2.zip`、`{base}-3.zip`…
fn unique_path(dir: &Path, base: &str) -> PathBuf {
    (1..)
        .map(|n| dir.join(if n == 1 { format!("{base}.zip") } else { format!("{base}-{n}.zip") }))
        .find(|p| !p.exists())
        .expect("infinite iterator")
}

/// 备份目录里的一份自动备份
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackup {
    pub name: String,
    /// 备份时间，从文件名看
    pub time: i64,
    #[serde(skip)]
    pub path: PathBuf,
}

/// 备份目录里按自动备份命名的（包括手动存到这里的；恢复前的那份不算），新的在前；目录还不在时是空的
pub fn local_backups(dir: &Path) -> Vec<LocalBackup> {
    let mut list: Vec<LocalBackup> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let time = backup::parse_data_file_name(&name)?;
            Some(LocalBackup { name, time, path: e.path() })
        })
        .collect();
    list.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| b.name.cmp(&a.name)));
    list
}

/// 只留最近 keep 份，多的删掉最旧的
fn prune(dir: &Path, keep: usize) {
    for old in local_backups(dir).into_iter().skip(keep) {
        let _ = fs::remove_file(old.path);
    }
}

/// WebDAV 上要删掉的旧的数据备份：只留最近 keep 份（list 是 backup::backups 排好的，新的在前；设置备份不算）
pub fn remote_to_prune(list: &[RemoteBackup], keep: usize) -> Vec<String> {
    list.iter()
        .filter(|b| b.kind == BackupKind::Data)
        .skip(keep)
        .map(|b| b.name.clone())
        .collect()
}

// ---------------------------------------------------------------------------
// 打包
// ---------------------------------------------------------------------------

/// 备份里的一项：文件或文件夹
struct Item {
    /// 包里的路径，用 / 分隔；文件夹以 / 结尾
    name: String,
    path: PathBuf,
    dir: bool,
    len: u64,
    modified: Option<SystemTime>,
}

/// 保存时的临时文件（store.rs 的 atomic_write：`.名字.tmp`）
fn is_temp_file(name: &str) -> bool {
    name.starts_with('.') && name.ends_with(".tmp")
}

/// 数据目录里要备份的：工作区文件夹（里面的全部，保存时的临时文件除外）和 .state.json，按路径排好。
/// 符号链接、目录联接不跟进去
fn collect(root: &Path) -> io::Result<Vec<Item>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        let kind = entry.file_type()?;
        if kind.is_dir() && !name.starts_with('.') {
            collect_dir(&mut out, entry.path(), format!("{name}/"), &entry.metadata()?)?;
        } else if kind.is_file() && name == UI_STATE_FILE {
            out.push(item(entry.path(), name, &entry.metadata()?, false));
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn collect_dir(out: &mut Vec<Item>, path: PathBuf, name: String, md: &fs::Metadata) -> io::Result<()> {
    out.push(item(path.clone(), name.clone(), md, true));
    for entry in fs::read_dir(&path)? {
        let entry = entry?;
        let Some(child) = entry.file_name().to_str().map(str::to_string) else { continue };
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect_dir(out, entry.path(), format!("{name}{child}/"), &entry.metadata()?)?;
        } else if kind.is_file() && !is_temp_file(&child) {
            out.push(item(entry.path(), format!("{name}{child}"), &entry.metadata()?, false));
        }
    }
    Ok(())
}

fn item(path: PathBuf, name: String, md: &fs::Metadata, dir: bool) -> Item {
    Item { name, path, dir, len: if dir { 0 } else { md.len() }, modified: md.modified().ok() }
}

/// 数据的指纹：各文件的路径、大小、修改时间，文件夹的路径（FNV-1a）。`.state.json` 只是界面状态，不算。
/// 修改时间精确到毫秒，和说明里记的、恢复时改回去的一样：刚从备份恢复的数据和那份备份的指纹相同，不会马上又备份一份
fn fingerprint(items: &[Item]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
    };
    for it in items.iter().filter(|it| it.name != UI_STATE_FILE) {
        feed(it.name.as_bytes());
        feed(&[0, it.dir as u8]);
        if !it.dir {
            feed(&it.len.to_le_bytes());
            feed(&to_ms(it.modified).unwrap_or(0).to_le_bytes());
        }
    }
    format!("{h:016x}")
}

/// 包里的修改时间（本地时间，精确到 2 秒；1980 年以前的记成 1980 年）
fn zip_mtime(t: Option<SystemTime>) -> zip::DateTime {
    to_ms(t)
        .and_then(|ms| Local.timestamp_millis_opt(ms).single())
        .map(backup::zip_time)
        .unwrap_or_default()
}

/// 备份完的结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Packed {
    /// 本地的是完整路径，WebDAV 上的是文件名
    pub path: String,
    pub name: String,
    pub workspaces: usize,
    pub todos: usize,
}

/// 拿着存储层的锁做一步；已经拿着锁时（恢复前先备份）直接做
type Locked<'a> = &'a dyn Fn(&mut dyn FnMut() -> io::Result<()>) -> io::Result<()>;

/// 把数据目录里的待办数据打包成 dest（先写到同一目录里的 `.名字.tmp`，写完再改名，中途失败不留下半个备份）。
/// 列目录、读每个文件时拿一下存储层的锁，免得和保存、改名、移动同时进行；读的时候文件没了
/// （刚被改名、移走、删掉），说明数据在变，从头再来，最后一次整个拿着锁做
pub fn pack(store: &Store, dest: &Path, time: DateTime<Local>) -> Result<Packed> {
    for attempt in 0.. {
        let result = if attempt < 2 {
            pack_once(store.root(), dest, time, &|f| store.locked(f))
        } else {
            store.locked(|| pack_once(store.root(), dest, time, &|f| f()))
        };
        match result {
            Err(e) if e.kind() == io::ErrorKind::NotFound && attempt < 2 => continue,
            r => return r.map_err(|e| format!("备份失败：{e}")),
        }
    }
    unreachable!()
}

/// 已经拿着存储层的锁时打包（恢复前先把现在的数据备份一份）
fn pack_held(root: &Path, dest: &Path, time: DateTime<Local>) -> Result<Packed> {
    pack_once(root, dest, time, &|f| f()).map_err(|e| e.to_string())
}

fn pack_once(root: &Path, dest: &Path, time: DateTime<Local>, locked: Locked) -> io::Result<Packed> {
    let mut items = Vec::new();
    let mut counts = (0, 0);
    locked(&mut || {
        items = collect(root)?;
        counts = store::count_data(root).map_err(io_err)?;
        Ok(())
    })?;
    let mut manifest = Manifest::new(BackupKind::Data, time);
    (manifest.workspaces, manifest.todos) = counts;
    manifest.fingerprint = fingerprint(&items);
    manifest.mtimes = items.iter().filter_map(|it| Some((it.name.clone(), to_ms(it.modified)?))).collect();

    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dest.with_file_name(format!(".{name}.tmp"));
    let written = (|| -> io::Result<()> {
        let mut zip = ZipWriter::new(BufWriter::new(File::create(&tmp)?));
        let base = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file(MANIFEST_FILE, base.last_modified_time(backup::zip_time(time)))?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
        for it in &items {
            let options = base.last_modified_time(zip_mtime(it.modified)).large_file(it.len >= u32::MAX as u64);
            if it.dir {
                zip.add_directory(it.name.as_str(), options)?;
                continue;
            }
            locked(&mut || {
                let mut file = File::open(&it.path)?;
                zip.start_file(it.name.as_str(), options)?;
                io::copy(&mut file, &mut zip)?;
                Ok(())
            })?;
        }
        let file = zip.finish()?.into_inner().map_err(|e| e.into_error())?;
        file.sync_all()
    })();
    if let Err(e) = written.and_then(|_| fs::rename(&tmp, dest)) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(Packed {
        path: dest.to_string_lossy().into_owned(),
        name,
        workspaces: counts.0,
        todos: counts.1,
    })
}

// ---------------------------------------------------------------------------
// 读备份、解压
// ---------------------------------------------------------------------------

/// 备份文件的说明（恢复前确认时显示）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    /// 备份时间
    pub time: i64,
    pub workspaces: usize,
    pub todos: usize,
    pub app_version: String,
}

/// 打开数据备份，读出说明；设置备份、不是本软件的备份时说清楚
fn open_data_zip(path: &Path) -> Result<(ZipArchive<File>, Manifest)> {
    let file = File::open(path).map_err(|e| format!("读取备份文件失败：{e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|_| "不是有效的 zip 压缩包".to_string())?;
    match backup::read_manifest(&mut zip)? {
        Some(m) if m.kind == BackupKind::Data => Ok((zip, m)),
        Some(_) => Err(SETTINGS_BACKUP_HINT.into()),
        // 以前的设置备份没有说明，只有 .settings.json
        None if zip.file_names().any(|n| n.rsplit(['/', '\\']).next() == Some(SETTINGS_FILE)) => {
            Err(SETTINGS_BACKUP_HINT.into())
        }
        None => Err("不是本软件的待办数据备份（压缩包里没有备份说明 backup.json）".into()),
    }
}

pub fn inspect(path: &Path) -> Result<BackupInfo> {
    let (_, m) = open_data_zip(path)?;
    Ok(BackupInfo {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        time: m.created_at,
        workspaces: m.workspaces,
        todos: m.todos,
        app_version: m.app_version,
    })
}

/// 读出数据备份里记着的指纹；读不出来时返回 None（当成数据变了）
fn read_fingerprint(path: &Path) -> Option<String> {
    open_data_zip(path).ok().map(|(_, m)| m.fingerprint).filter(|f| !f.is_empty())
}

/// 包里的一级路径是否安全：不能是空的、`.`、`..`，不能有盘符（`:`）和 Windows 文件名不允许的字符，
/// 不能以 `.`、空格结尾（Windows 会悄悄去掉，变成别的名字），不能是保留名称
fn safe_component(part: &str) -> bool {
    store::check_component(part, "").is_ok() && !part.ends_with(['.', ' ']) && !store::is_reserved_name(part)
}

/// 包里的路径拆成各级；有不安全的（绝对路径、`..`、盘符等）返回 None
fn safe_parts(name: &str) -> Option<Vec<&str>> {
    if name.starts_with(['/', '\\']) {
        return None;
    }
    let parts: Vec<&str> = name.strip_suffix('/').unwrap_or(name).split(['/', '\\']).collect();
    parts.iter().all(|p| safe_component(p)).then_some(parts)
}

/// 解压到 dest（空的临时文件夹）：先把每一项的路径检查一遍，有不安全的整个不解压；
/// 第一级只要工作区文件夹和 .state.json，别的不要。文件、文件夹的修改时间照着说明改回去
fn extract(zip: &mut ZipArchive<File>, manifest: &Manifest, dest: &Path) -> Result<()> {
    let unsafe_path = |name: &str| format!("备份里有不安全的路径「{name}」，备份文件可能损坏或被改过，没有恢复");
    // (序号, 包里的路径, 解压到哪里, 是不是文件夹)
    let mut plan = Vec::new();
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| format!("读取压缩包失败：{e}"))?;
        let name = f.name().to_string();
        if f.is_symlink() {
            return Err(unsafe_path(&name));
        }
        let parts = safe_parts(&name).ok_or_else(|| unsafe_path(&name))?;
        let top_dir = parts.len() > 1 || f.is_dir();
        let wanted = if top_dir { !parts[0].starts_with('.') } else { parts[0] == UI_STATE_FILE };
        if wanted {
            let path = parts.iter().fold(dest.to_path_buf(), |p, part| p.join(part));
            plan.push((i, name, path, f.is_dir()));
        }
    }
    let failed = |e: io::Error| format!("解压备份失败：{e}");
    for (i, _, path, dir) in &plan {
        if *dir {
            fs::create_dir_all(path).map_err(failed)?;
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(failed)?;
        }
        let mut f = zip.by_index(*i).map_err(|e| format!("读取压缩包失败：{e}"))?;
        let mut out = File::create(path).map_err(failed)?;
        io::copy(&mut f, &mut out).map_err(failed)?;
    }
    // 先改文件的，再从深到浅改文件夹的：往文件夹里放东西会改掉它的修改时间
    plan.sort_by_key(|(_, name, _, dir)| (*dir, std::cmp::Reverse(name.matches('/').count())));
    for (_, name, path, dir) in &plan {
        if let Some(ms) = manifest.mtimes.get(name) {
            let _ = set_modified(path, *ms, *dir);
        }
    }
    Ok(())
}

fn set_modified(path: &Path, ms: i64, dir: bool) -> io::Result<()> {
    let time = UNIX_EPOCH + Duration::from_millis(ms.max(0) as u64);
    let mut options = OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // 只要改属性的权限（只读文件也能改）；打开文件夹要带 FILE_FLAG_BACKUP_SEMANTICS
        const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        options.access_mode(FILE_WRITE_ATTRIBUTES);
        if dir {
            options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
        }
    }
    #[cfg(not(windows))]
    {
        options.read(true);
        let _ = dir;
    }
    options.open(path)?.set_modified(time)
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

/// 恢复完的结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub workspaces: usize,
    pub todos: usize,
    /// 备份的时间
    pub time: i64,
    /// 恢复前的数据备份到了哪里（完整路径）
    pub before: String,
}

/// 恢复用的临时文件夹（在数据目录里，和数据在同一个盘上，替换时只是改名）
pub fn staging_dir(root: &Path, time: DateTime<Local>) -> Result<PathBuf> {
    let dir = (1..)
        .map(|n| {
            let suffix = if n == 1 { String::new() } else { format!("-{n}") };
            root.join(format!("{STAGING_PREFIX}{}{suffix}", backup::stamp(time)))
        })
        .find(|p| !p.exists())
        .expect("infinite iterator");
    fs::create_dir_all(&dir).map_err(|e| format!("恢复失败，无法创建临时文件夹：{e}"))?;
    Ok(dir)
}

/// 删掉临时文件夹；替换失败、没能换回来的原来的数据（在 old 里）留着
pub fn clean_staging(staging: &Path) {
    let _ = fs::remove_dir_all(staging.join("new"));
    let _ = fs::remove_file(staging.join("download.zip"));
    let _ = fs::remove_dir(staging.join("old"));
    let _ = fs::remove_dir(staging);
}

/// 用本地的备份文件恢复（staging 是 staging_dir 建的临时文件夹）：先解压到临时文件夹里、检查好，
/// 再拿着存储层的锁把现在的数据备份到 backup_dir（`…-恢复前.zip`，备份不了就不恢复），然后换成备份里的
pub fn restore_at(store: &Store, staging: &Path, zip_path: &Path, backup_dir: &Path, time: DateTime<Local>) -> Result<Restored> {
    let (mut zip, manifest) = open_data_zip(zip_path)?;
    let new = staging.join("new");
    fs::create_dir_all(&new).map_err(|e| format!("恢复失败，无法创建临时文件夹：{e}"))?;
    extract(&mut zip, &manifest, &new)?;
    drop(zip);
    let (workspaces, todos) = store::count_data(&new)?;
    let not_backed_up = |e: String| format!("无法先把现在的数据备份一份（{e}），没有恢复");
    check_backup_dir(backup_dir, store.root()).map_err(not_backed_up)?;
    fs::create_dir_all(backup_dir).map_err(|e| not_backed_up(format!("无法创建备份目录 {}：{e}", backup_dir.display())))?;
    let before = unique_path(backup_dir, &format!("{DATA_PREFIX}{}-{BEFORE_RESTORE}", backup::stamp(time)));
    store.replace_data(&new, &staging.join("old"), || pack_held(store.root(), &before, time).map_err(not_backed_up))?;
    Ok(Restored { workspaces, todos, time: manifest.created_at, before: before.to_string_lossy().into_owned() })
}

/// 用本地的备份文件恢复，临时文件夹用完删掉
pub fn restore_file(store: &Store, zip_path: &Path, backup_dir: &Path, time: DateTime<Local>) -> Result<Restored> {
    let staging = staging_dir(store.root(), time)?;
    let result = restore_at(store, &staging, zip_path, backup_dir, time);
    clean_staging(&staging);
    result
}

// ---------------------------------------------------------------------------
// 自动备份
// ---------------------------------------------------------------------------

/// 检查一次自动备份的结果
#[derive(Debug)]
pub enum AutoLocal {
    /// 距上次还不到 24 小时
    NotYet,
    /// 数据自上次备份后没有变化
    Unchanged,
    Done(Packed),
}

/// 检查一次：距备份目录里最新的一份满 24 小时、数据有变化时备份到 dir（备份前调 started），然后只留最近 keep 份。
/// 最新的一份时间在将来的（系统时间被往回调过）不算
pub fn run_auto(store: &Store, dir: &Path, keep: usize, now: DateTime<Local>, started: impl FnOnce()) -> Result<AutoLocal> {
    check_backup_dir(dir, store.root())?;
    let now_ms = now.timestamp_millis();
    let list = local_backups(dir);
    let latest = list.iter().find(|b| b.time <= now_ms + 60_000);
    if latest.is_some_and(|b| now_ms - b.time < AUTO_INTERVAL_MS) {
        return Ok(AutoLocal::NotYet);
    }
    let current = store
        .locked(|| collect(store.root()))
        .map(|items| fingerprint(&items))
        .map_err(|e| format!("读取数据目录失败：{e}"))?;
    if latest.and_then(|b| read_fingerprint(&b.path)).is_some_and(|f| f == current) {
        return Ok(AutoLocal::Unchanged);
    }
    started();
    fs::create_dir_all(dir).map_err(|e| format!("无法创建备份目录 {}：{e}", dir.display()))?;
    let dest = unique_path(dir, &format!("{DATA_PREFIX}{}", backup::stamp(now)));
    let packed = pack(store, &dest, now)?;
    prune(dir, keep);
    Ok(AutoLocal::Done(packed))
}

/// 把本地的备份上传到 WebDAV，然后远程目录里的数据备份只留最近 keep 份
pub async fn upload(dav: &WebDav, path: &Path, name: &str, keep: Option<usize>) -> Result<()> {
    let data = fs::read(path).map_err(|e| format!("读取备份文件失败：{e}"))?;
    dav.upload(name, data).await?;
    if let Some(keep) = keep {
        let list = backup::backups(dav.list().await?);
        for old in remote_to_prune(&list, keep) {
            dav.delete(&old).await?;
        }
    }
    Ok(())
}

/// 自动备份的一次结果是什么
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Done,
    Unchanged,
    Failed,
}

/// 这次运行期间最近一次自动备份的结果（设置里显示）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRun {
    pub time: i64,
    pub outcome: Outcome,
    /// 备份的文件名
    pub name: Option<String>,
    /// 失败的原因
    pub error: Option<String>,
    /// 本地备份好了、上传 WebDAV 失败的原因
    pub webdav_error: Option<String>,
}

impl AutoRun {
    pub fn new(outcome: Outcome) -> Self {
        Self { time: now_ms(), outcome, name: None, error: None, webdav_error: None }
    }
}

/// 备份、恢复在做的事（Tauri 管理的状态）：同一时间只做一件（自动备份、手动备份、恢复）；
/// 记着这次运行期间最近一次自动备份的结果；可以叫醒定时检查的线程（改了自动备份的设置后马上检查）
#[derive(Default)]
pub struct BackupJobs {
    busy: Mutex<()>,
    running: AtomicBool,
    last: Mutex<Option<AutoRun>>,
    waker: Mutex<Option<Sender<()>>>,
}

impl BackupJobs {
    /// 拿着它的时候别的备份、恢复等着
    pub fn exclusive(&self) -> MutexGuard<'_, ()> {
        self.busy.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 正在自动备份
    pub fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn set_running(&self, running: bool) {
        self.running.store(running, Ordering::SeqCst);
    }

    pub fn last(&self) -> Option<AutoRun> {
        self.last.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set_last(&self, run: AutoRun) {
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(run);
    }

    pub fn set_waker(&self, tx: Sender<()>) {
        *self.waker.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    }

    /// 叫醒定时检查的线程，马上检查一次
    pub fn wake(&self) {
        if let Some(tx) = self.waker.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = tx.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use zip::write::SimpleFileOptions;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("todolist-databackup-{tag}-{}-{}", std::process::id(), now_ms()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// 测试数据：数据目录 data（两个工作区，一个空的；项目、子项目、附件目录；回收站里一条；设置文件），
    /// 备份目录 data-backups（默认的位置）
    fn setup(tag: &str) -> (TempRoot, Store) {
        let tmp = TempRoot::new(tag);
        let s = Store::new(tmp.0.join("data")).unwrap();
        s.create_workspace("工作").unwrap();
        s.create_workspace("空的").unwrap();
        s.create_project("工作", "需求").unwrap();
        s.create_sub_project("工作", "需求", "前端").unwrap();
        s.create_project("工作", "空项目").unwrap();
        s.create_todo("工作", "需求", "写文档", "# 文档\n正文").unwrap();
        s.create_todo("工作", "需求/前端", "页面", "页面正文").unwrap();
        let gone = s.create_todo("工作", "需求", "删掉的", "回收站里的").unwrap();
        s.delete_todo("工作", "需求", &gone.id).unwrap();
        let pdir = s.project_path("工作", "需求").unwrap();
        fs::create_dir_all(pdir.join(".assets")).unwrap();
        fs::write(pdir.join(".assets").join("图.png"), [0u8, 1, 2, 3]).unwrap();
        fs::write(pdir.join(".写文档.md.tmp"), "保存到一半").unwrap();
        s.write_ui_state(r#"{"openTodos":[]}"#).unwrap();
        fs::write(s.root().join(SETTINGS_FILE), "{}").unwrap();
        fs::write(s.root().join(".webdav.json"), "{}").unwrap();
        fs::write(s.root().join("TodoList-settings-20260101-000000.zip"), "x").unwrap();
        (tmp, s)
    }

    fn time(h: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, 9, h, 30, 12).unwrap()
    }

    fn entries(path: &Path) -> BTreeSet<String> {
        let zip = ZipArchive::new(File::open(path).unwrap()).unwrap();
        zip.file_names().map(str::to_string).collect()
    }

    #[test]
    fn default_dir_is_next_to_the_data_dir() {
        let home = Path::new("Users").join("me");
        let root = home.join("TodoList");
        assert_eq!(default_dir(&root), home.join("TodoList-backups"));
        assert_eq!(default_dir(&home.join("todolist-test")), home.join("todolist-test-backups"));
        assert_eq!(backup_dir("", &root), default_dir(&root));
        assert_eq!(backup_dir("  D:\\备份 ", &root), Path::new("D:\\备份"));
    }

    #[test]
    fn backup_dir_must_be_outside_the_data_dir() {
        let (tmp, s) = setup("dir");
        let root = s.root();
        assert!(check_backup_dir(&default_dir(root), root).is_ok());
        assert!(check_backup_dir(&tmp.0.join("别处").join("还没建"), root).is_ok());
        // 名字以数据目录名开头的别的目录不算在里面
        assert!(check_backup_dir(&tmp.0.join("data2"), root).is_ok());
        for bad in [root.to_path_buf(), root.join("工作"), root.join("还没建").join("子目录"), root.join("工作").join("..").join("空的")] {
            assert!(check_backup_dir(&bad, root).unwrap_err().contains("数据目录里面"), "{}", bad.display());
        }
        if cfg!(windows) {
            let upper = PathBuf::from(root.to_string_lossy().to_uppercase()).join("x");
            assert!(check_backup_dir(&upper, root).is_err(), "Windows 上不分大小写");
        }
        assert!(check_backup_dir(Path::new("相对路径"), root).unwrap_err().contains("完整的路径"));
        assert!(check_target(&root.join("工作").join("x.zip"), root).is_err());
        assert!(check_target(&tmp.0.join("x.zip"), root).is_ok());
    }

    #[test]
    fn backup_contains_workspaces_and_state_only() {
        let (tmp, s) = setup("pack");
        let dest = tmp.0.join("TodoList-data-20261009-153012.zip");
        let packed = pack(&s, &dest, time(15)).unwrap();
        assert_eq!((packed.workspaces, packed.todos), (2, 2));
        assert_eq!(packed.name, "TodoList-data-20261009-153012.zip");
        let names = entries(&dest);
        for want in [
            MANIFEST_FILE,
            UI_STATE_FILE,
            "工作/",
            "空的/",
            "工作/需求/.todos.json",
            "工作/需求/前端/",
            "工作/需求/前端/.todos.json",
            "工作/需求/.assets/图.png",
            "工作/空项目/",
        ] {
            assert!(names.contains(want), "缺 {want}：{names:?}");
        }
        assert_eq!(names.iter().filter(|n| n.ends_with(".md")).count(), 2, "{names:?}");
        for n in &names {
            assert!(
                !n.starts_with(".recycle") && !n.starts_with(".trash") && !n.ends_with(".tmp") && !n.contains("settings")
                    && !n.contains("webdav"),
                "不该有 {n}"
            );
        }
        // 写完改了名，不留临时文件
        assert!(!tmp.0.join(".TodoList-data-20261009-153012.zip.tmp").exists());
        let info = inspect(&dest).unwrap();
        assert_eq!((info.time, info.workspaces, info.todos), (time(15).timestamp_millis(), 2, 2));
        assert_eq!(info.app_version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn fingerprint_ignores_ui_state_but_sees_data_changes() {
        let (_tmp, s) = setup("fingerprint");
        let fp = || fingerprint(&collect(s.root()).unwrap());
        let first = fp();
        assert_eq!(fp(), first);
        s.write_ui_state(r#"{"openTodos":[{"workspace":"工作"}]}"#).unwrap();
        assert_eq!(fp(), first, "界面状态不算");
        s.create_project("工作", "新项目").unwrap();
        let second = fp();
        assert_ne!(second, first, "新建的空项目也算");
        let t = s.create_todo("工作", "新项目", "", "").unwrap();
        let third = fp();
        assert_ne!(third, second);
        // 正文改了（大小变了）
        s.save_todo_content("工作", "新项目", &t.id, "改过的正文", None, true).unwrap();
        assert_ne!(fp(), third);
    }

    #[test]
    fn restore_replaces_data_and_keeps_the_rest() {
        let (tmp, s) = setup("restore");
        let backups = default_dir(s.root());
        fs::create_dir_all(&backups).unwrap();
        let zip = backups.join(file_name(time(10)));
        let pdir = s.project_path("工作", "需求").unwrap();
        let md = fs::read_dir(&pdir).unwrap().flatten().find(|e| e.path().extension().is_some_and(|x| x == "md")).unwrap().path();
        let original_mtime = to_ms(fs::metadata(&md).unwrap().modified().ok()).unwrap();
        let ws_mtime = to_ms(fs::metadata(s.root().join("工作")).unwrap().modified().ok()).unwrap();
        pack(&s, &zip, time(10)).unwrap();

        // 备份之后：改正文、新建工作区、删掉空的工作区、界面状态变了
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&md, "备份之后改的").unwrap();
        s.create_workspace("后来建的").unwrap();
        fs::remove_dir(s.root().join("空的")).unwrap();
        s.write_ui_state(r#"{"later":true}"#).unwrap();
        let recycled = s.list_recycle().unwrap().len();

        let r = restore_file(&s, &zip, &backups, time(11)).unwrap();
        assert_eq!((r.workspaces, r.todos, r.time), (2, 2, time(10).timestamp_millis()));
        let mut names: Vec<String> = s.list_workspaces().unwrap().into_iter().map(|w| w.name).collect();
        names.sort();
        assert_eq!(names, ["工作", "空的"]);
        assert_eq!(fs::read_to_string(&md).unwrap(), "# 文档\n正文");
        assert!(pdir.join(".assets").join("图.png").is_file() && s.project_path("工作", "空项目").is_ok());
        assert_eq!(s.read_ui_state().unwrap().as_deref(), Some(r#"{"openTodos":[]}"#));
        // 修改时间和原来一样（左侧的修改时间、首页的最近更新时间不变）
        assert_eq!(to_ms(fs::metadata(&md).unwrap().modified().ok()), Some(original_mtime));
        assert_eq!(to_ms(fs::metadata(s.root().join("工作")).unwrap().modified().ok()), Some(ws_mtime));
        // 回收站、设置文件不动；保存时的临时文件本来就不在备份里
        assert_eq!(s.list_recycle().unwrap().len(), recycled);
        assert!(s.root().join(SETTINGS_FILE).is_file() && s.root().join(".webdav.json").is_file());
        // 恢复前的数据备份了一份，不算自动备份
        let before = PathBuf::from(&r.before);
        assert_eq!(before.file_name().unwrap().to_string_lossy(), "TodoList-data-20261009-113012-恢复前.zip");
        let before_names = entries(&before);
        assert!(before_names.contains("后来建的/") && !before_names.contains("空的/"), "{before_names:?}");
        assert_eq!(local_backups(&backups).iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), [zip.file_name().unwrap().to_str().unwrap()]);
        // 临时文件夹删掉了
        let left: Vec<_> = fs::read_dir(s.root()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert!(!left.iter().any(|n| n.to_string_lossy().starts_with(STAGING_PREFIX)), "{left:?}");
        drop(tmp);
    }

    /// 自己拼一个数据备份包
    fn zip_with(path: &Path, files: &[(&str, &[u8])]) {
        let mut zip = ZipWriter::new(File::create(path).unwrap());
        for (name, content) in files {
            if name.ends_with('/') {
                zip.add_directory(*name, SimpleFileOptions::default()).unwrap();
            } else {
                zip.start_file(*name, SimpleFileOptions::default()).unwrap();
                zip.write_all(content).unwrap();
            }
        }
        zip.finish().unwrap();
    }

    const DATA_MANIFEST: &[u8] = br#"{"kind":"data","createdAt":1}"#;

    #[test]
    fn rejects_unsafe_paths_and_wrong_backups() {
        let (tmp, s) = setup("unsafe");
        let backups = default_dir(s.root());
        let before = fs::read_to_string(s.root().join(UI_STATE_FILE)).unwrap();
        for bad in [
            "../逃出去.md",
            "工作/../../逃出去.md",
            "/绝对路径.md",
            "\\绝对路径.md",
            "C:/Windows/逃出去.md",
            "C:逃出去.md",
            "工作/需求/a:b.md",
            "工作/CON/a.md",
            "工作/nul.md",
            "工作/末尾有点./a.md",
            "工作//a.md",
        ] {
            let zip = tmp.0.join("bad.zip");
            zip_with(&zip, &[(MANIFEST_FILE, DATA_MANIFEST), ("工作/需求/a.md", b"a"), (bad, b"x")]);
            let err = restore_file(&s, &zip, &backups, time(12)).unwrap_err();
            assert!(err.contains("不安全的路径"), "{bad}：{err}");
        }
        assert!(!tmp.0.join("逃出去.md").exists());
        // 没有动现在的数据，也没有先备份
        assert_eq!(fs::read_to_string(s.root().join(UI_STATE_FILE)).unwrap(), before);
        assert!(s.root().join("空的").is_dir());
        assert!(!backups.exists());

        // 拿错了的、不是本软件的备份
        let settings = tmp.0.join("settings.zip");
        fs::write(&settings, backup::pack(&Default::default(), time(9)).unwrap()).unwrap();
        assert_eq!(inspect(&settings).unwrap_err(), SETTINGS_BACKUP_HINT);
        zip_with(&settings, &[(".settings.json", b"{}")]);
        assert_eq!(inspect(&settings).unwrap_err(), SETTINGS_BACKUP_HINT, "以前没有说明文件的设置备份");
        zip_with(&settings, &[("readme.txt", b"hi")]);
        assert!(inspect(&settings).unwrap_err().contains("不是本软件的待办数据备份"));
        fs::write(&settings, "not a zip").unwrap();
        assert!(inspect(&settings).unwrap_err().contains("不是有效的 zip"));
    }

    #[test]
    fn restore_ignores_other_top_level_files() {
        let (tmp, s) = setup("toplevel");
        let zip = tmp.0.join("odd.zip");
        // 第一级只要工作区文件夹和 .state.json：设置文件、回收站、别的文件不解压
        zip_with(
            &zip,
            &[
                (MANIFEST_FILE, DATA_MANIFEST),
                ("新的/项目/a.md", b"a"),
                ("新的/项目/.assets/", b""),
                (".settings.json", br#"{"theme":"dark"}"#),
                (".recycle/x/entry.json", b"{}"),
                ("说明.txt", b"hi"),
            ],
        );
        let r = restore_file(&s, &zip, &default_dir(s.root()), time(12)).unwrap();
        assert_eq!((r.workspaces, r.todos), (1, 1));
        assert_eq!(fs::read_to_string(s.root().join(SETTINGS_FILE)).unwrap(), "{}");
        assert!(!s.root().join("说明.txt").exists());
        assert!(s.root().join("新的").join("项目").join(".assets").is_dir());
        // 备份里没有 .state.json：去掉现在的
        assert_eq!(s.read_ui_state().unwrap(), None);
        assert_eq!(s.list_recycle().unwrap().len(), 1);
    }

    #[test]
    fn restore_needs_a_usable_backup_dir() {
        let (tmp, s) = setup("nodir");
        let zip = tmp.0.join(file_name(time(10)));
        pack(&s, &zip, time(10)).unwrap();
        s.create_workspace("恢复不了也还在").unwrap();
        let err = restore_file(&s, &zip, &s.root().join("备份"), time(11)).unwrap_err();
        assert!(err.contains("没有恢复"), "{err}");
        assert!(s.root().join("恢复不了也还在").is_dir());
    }

    #[test]
    fn auto_backup_once_a_day_when_data_changed() {
        let (tmp, s) = setup("auto");
        let dir = tmp.0.join("备份");
        let mut started = 0;
        // 还没有备份：马上备份
        let r = run_auto(&s, &dir, 10, time(8), || started += 1).unwrap();
        assert!(matches!(r, AutoLocal::Done(ref p) if p.name == "TodoList-data-20261009-083012.zip"), "{r:?}");
        assert_eq!(started, 1);
        // 不到 24 小时：不备份
        s.create_workspace("改了").unwrap();
        let next_day = |h| time(h) + chrono::Duration::days(1);
        assert!(matches!(run_auto(&s, &dir, 10, next_day(8) - chrono::Duration::minutes(1), || ()).unwrap(), AutoLocal::NotYet));
        // 满 24 小时、有变化：备份
        assert!(matches!(run_auto(&s, &dir, 10, next_day(8), || ()).unwrap(), AutoLocal::Done(_)));
        // 又过了一天，数据没变：跳过（只改界面状态也算没变）
        s.write_ui_state(r#"{"x":1}"#).unwrap();
        let mut called = false;
        assert!(matches!(run_auto(&s, &dir, 10, next_day(8) + chrono::Duration::days(1), || called = true).unwrap(), AutoLocal::Unchanged));
        assert!(!called);
        assert_eq!(local_backups(&dir).len(), 2);
        // 最新的一份在将来（系统时间被往回调过）：不算
        fs::copy(dir.join("TodoList-data-20261009-083012.zip"), dir.join("TodoList-data-20991231-000000.zip")).unwrap();
        s.create_workspace("又改了").unwrap();
        assert!(matches!(run_auto(&s, &dir, 10, next_day(8) + chrono::Duration::days(2), || ()).unwrap(), AutoLocal::Done(_)));
        // 不能备份到数据目录里面
        assert!(run_auto(&s, &s.root().join("x"), 10, time(8), || ()).is_err());
    }

    #[test]
    fn restored_data_is_not_backed_up_again() {
        let (tmp, s) = setup("restored");
        let dir = tmp.0.join("备份");
        assert!(matches!(run_auto(&s, &dir, 10, time(8), || ()).unwrap(), AutoLocal::Done(_)));
        let zip = dir.join("TodoList-data-20261009-083012.zip");
        s.create_workspace("后来建的").unwrap();
        restore_file(&s, &zip, &dir, time(9)).unwrap();
        // 恢复出来的和那份备份一样（修改时间也改回去了）：过了一天也不再备份一份一样的
        let later = time(9) + chrono::Duration::days(2);
        assert!(matches!(run_auto(&s, &dir, 10, later, || ()).unwrap(), AutoLocal::Unchanged));
    }

    #[test]
    fn keeps_only_the_newest_backups() {
        let (tmp, s) = setup("prune");
        let dir = tmp.0.join("备份");
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "TodoList-data-20200101-000000.zip",
            "TodoList-data-20200102-000000.zip",
            "TodoList-data-20200103-000000.zip",
            "TodoList-data-20200101-000000-恢复前.zip",
            "TodoList-settings-20200101-000000.zip",
            "别的文件.zip",
        ] {
            fs::write(dir.join(name), "旧的").unwrap();
        }
        // 最新的一份读不出指纹：当成数据变了
        assert!(matches!(run_auto(&s, &dir, 2, time(8), || ()).unwrap(), AutoLocal::Done(_)));
        let mut left: Vec<String> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(
            left,
            [
                "TodoList-data-20200101-000000-恢复前.zip",
                "TodoList-data-20200103-000000.zip",
                "TodoList-data-20261009-083012.zip",
                "TodoList-settings-20200101-000000.zip",
                "别的文件.zip",
            ]
        );
    }

    #[test]
    fn same_second_gets_a_new_name() {
        let (tmp, _s) = setup("unique");
        let base = format!("{DATA_PREFIX}20261009-153012");
        assert_eq!(unique_path(&tmp.0, &base), tmp.0.join(format!("{base}.zip")));
        fs::write(tmp.0.join(format!("{base}.zip")), "").unwrap();
        assert_eq!(unique_path(&tmp.0, &base), tmp.0.join(format!("{base}-2.zip")));
    }

    #[test]
    fn uploads_to_webdav_and_keeps_the_newest_there() {
        use crate::webdav::fake;
        let (tmp, s) = setup("upload");
        let server = fake::Server::start();
        let dav = fake::client(&server, "TodoList");
        use tauri::async_runtime::block_on as run;
        for name in ["TodoList-data-20200101-000000.zip", "TodoList-data-20200102-000000.zip", "TodoList-settings-20200101-000000.zip"] {
            run(dav.upload(name, b"old".to_vec())).unwrap();
        }
        let dest = tmp.0.join(file_name(time(8)));
        let packed = pack(&s, &dest, time(8)).unwrap();
        run(upload(&dav, &dest, &packed.name, Some(2))).unwrap();
        // 数据备份只留最近 2 份，设置备份不算、不删
        assert_eq!(
            server.names("TodoList"),
            ["TodoList-data-20200102-000000.zip", "TodoList-data-20261009-083012.zip", "TodoList-settings-20200101-000000.zip"]
        );
        assert_eq!(server.state.lock().unwrap().files["/dav/TodoList/TodoList-data-20261009-083012.zip"], fs::read(&dest).unwrap());
        // 手动上传的不删别的
        run(upload(&dav, &dest, "TodoList-data-20261010-000000.zip", None)).unwrap();
        assert_eq!(server.names("TodoList").len(), 4);
        // 从 WebDAV 下载下来恢复
        s.create_workspace("后来建的").unwrap();
        let staging = staging_dir(s.root(), time(9)).unwrap();
        let zip = staging.join("download.zip");
        run(dav.download_to("TodoList-data-20261009-083012.zip", &zip)).unwrap();
        let r = restore_at(&s, &staging, &zip, &default_dir(s.root()), time(9)).unwrap();
        clean_staging(&staging);
        assert_eq!((r.workspaces, r.todos), (2, 2));
        assert!(!s.root().join("后来建的").exists() && !staging.exists());
    }

    #[test]
    fn remote_keeps_newest_data_backups() {
        let b = |name: &str, kind| RemoteBackup { name: name.into(), size: None, time: 0, kind };
        let list = [
            b("TodoList-data-3.zip", BackupKind::Data),
            b("TodoList-settings-2.zip", BackupKind::Settings),
            b("TodoList-data-2.zip", BackupKind::Data),
            b("TodoList-data-1.zip", BackupKind::Data),
        ];
        assert_eq!(remote_to_prune(&list, 2), ["TodoList-data-1.zip"]);
        assert!(remote_to_prune(&list, 3).is_empty());
    }
}
