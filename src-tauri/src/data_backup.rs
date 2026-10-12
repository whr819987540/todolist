//! 待办数据的备份与恢复（设置的备份见 backup.rs）。
//!
//! 备份包是 zip，文件名 `TodoList-data-年月日-时分秒.zip`：数据目录里的各工作区文件夹里的全部（任意深度：各级项目、
//! 子项目的文件夹，待办正文，各级的 `.todos.json` 和项目的顺序 `.projects.json`，项目里点开头的图片附件目录 `.assets` 等，
//! 保存时的临时文件除外）和 `.state.json`，外加说明文件 `backup.json`
//! （类型、软件版本、备份时间、工作区数和待办数、指纹、各文件和文件夹的修改时间）。
//! 不含软件的回收站 `.recycle`、`.trash`、设置文件、WebDAV 设置，也不含数据目录里工作区文件夹以外的别的文件。
//!
//! 自动备份存在备份目录（默认是数据目录旁边的「数据目录名-backups」）里，文件名同上，只留最近几份；
//! 恢复前先把现在的数据备份成 `…-恢复前.zip`，不算在「最近几份」里，也不会被删。
//!
//! 恢复时解压到数据目录里的临时文件夹 `.restoring-…\new`，换下来的放进 `old`，换之前在那里写下记录 `journal.json`
//! （store.rs 的 replace_data）；程序在换的中途退出时，下次启动先 recover_leftovers 换回原来的数据（或者做完收尾），
//! 结果交给前端提示一次（BackupJobs::take_recovered）。

use crate::backup::{self, BackupKind, Manifest, RemoteBackup, DATA_PREFIX, MANIFEST_FILE, SETTINGS_BACKUP_HINT};
use crate::settings::SETTINGS_FILE;
use crate::store::{self, Store, SwapRecovery, MAX_PATH_CHARS, STAGED_NEW, STAGED_OLD, SWAP_JOURNAL, UI_STATE_FILE};
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
/// 自动备份：监听着数据目录时，数据目录没再变也隔这么久（6 小时）重扫一遍（兜底：监听可能悄悄停了、漏了一些）
pub const RESCAN_WATCHED_MS: i64 = 6 * 3600 * 1000;
/// 自动备份：没在监听数据目录时（建不起来，如网络盘上的）看不到外部的改动，隔这么久（1 小时）重扫一遍
pub const RESCAN_UNWATCHED_MS: i64 = 3600 * 1000;
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
    /// 同一秒里的第几份（`…-2.zip`；没有编号的是 1）
    #[serde(skip)]
    pub seq: u64,
    #[serde(skip)]
    pub path: PathBuf,
}

/// 备份目录里按自动备份命名的（包括手动存到这里的；恢复前的那份不算），新的在前（同一秒里的按编号，见 backup::newest_first）；
/// 目录还不在时是空的
pub fn local_backups(dir: &Path) -> Vec<LocalBackup> {
    let mut list: Vec<LocalBackup> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let (time, seq) = backup::parse_data_file_name(&name)?;
            Some(LocalBackup { name, time, seq, path: e.path() })
        })
        .collect();
    list.sort_by(|a, b| backup::newest_first((a.time, a.seq, &a.name), (b.time, b.seq, &b.name)));
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

/// 数据目录里要备份的：工作区文件夹里的全部（任意深度：各级项目文件夹、待办正文、各级的 .todos.json 和 .projects.json、
/// 附件目录 .assets 等，保存时的临时文件除外）和 .state.json，按路径排好。符号链接、目录联接不跟进去。
/// 用栈不用递归：外部建的文件夹再深也不会栈溢出（同 store.rs 列项目的 project_dirs）
fn collect(root: &Path) -> io::Result<Vec<Item>> {
    let mut out = Vec::new();
    // 还要列里面的文件夹：(路径, 包里的路径, 文件信息)
    let mut dirs = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        let kind = entry.file_type()?;
        if kind.is_dir() && !name.starts_with('.') {
            dirs.push((entry.path(), format!("{name}/"), entry.metadata()?));
        } else if kind.is_file() && name == UI_STATE_FILE {
            out.push(item(entry.path(), name, &entry.metadata()?, false));
        }
    }
    while let Some((path, name, md)) = dirs.pop() {
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            let Some(child) = entry.file_name().to_str().map(str::to_string) else { continue };
            let kind = entry.file_type()?;
            if kind.is_dir() {
                dirs.push((entry.path(), format!("{name}{child}/"), entry.metadata()?));
            } else if kind.is_file() && !is_temp_file(&child) {
                out.push(item(entry.path(), format!("{name}{child}"), &entry.metadata()?, false));
            }
        }
        out.push(item(path, name, &md, true));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
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

/// 备份里的东西恢复到数据目录 root 后最长的路径超过了 MAX_PATH_CHARS 时的提示：item 是包里的路径、n 是它恢复后的长度，
/// count 是一共有几项超过
fn too_long_to_restore(root: &Path, item: &str, n: usize, count: usize) -> String {
    let more = if count > 1 { format!("（共有 {count} 个文件、文件夹超过）") } else { String::new() };
    format!(
        "备份里的「{}」恢复到这里后路径会有 {n} 个字符{more}，超过了 Windows 的上限（{MAX_PATH_CHARS} 个），\
         资源管理器、用默认程序打开时的编辑器和系统回收站都打不开，没有恢复。数据目录 {} 的路径要再短 {} 个字符以上才放得下这份备份",
        item.trim_end_matches('/'),
        root.display(),
        n - MAX_PATH_CHARS
    )
}

/// 解压到 dest（空的临时文件夹）：先把每一项的路径检查一遍，有不安全的、恢复到数据目录 root 后路径会超过 MAX_PATH_CHARS 的
/// （这里的数据目录比备份时的长）整个不解压；第一级只要工作区文件夹和 .state.json，别的不要。文件、文件夹的修改时间照着说明改回去。
/// 解压到的临时文件夹在数据目录里、路径比 root 长 30 多个字符，可以超过 260：std 在 Windows 上打开、新建、改名时
/// 都会把长路径换成 `\\?\` 开头的写法
fn extract(zip: &mut ZipArchive<File>, manifest: &Manifest, dest: &Path, root: &Path) -> Result<()> {
    let unsafe_path = |name: &str| format!("备份里有不安全的路径「{name}」，备份文件可能损坏或被改过，没有恢复");
    // (序号, 包里的路径, 解压到哪里, 是不是文件夹)
    let mut plan = Vec::new();
    // 恢复到数据目录后超过上限的：(包里的路径, 恢复后的长度)
    let mut too_long = Vec::new();
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
            let n = store::path_len(&parts.iter().fold(root.to_path_buf(), |p, part| p.join(part)));
            if n > MAX_PATH_CHARS {
                too_long.push((name.clone(), n));
            }
            let path = parts.iter().fold(dest.to_path_buf(), |p, part| p.join(part));
            plan.push((i, name, path, f.is_dir()));
        }
    }
    if let Some((item, n)) = too_long.iter().max_by_key(|(_, n)| *n) {
        return Err(too_long_to_restore(root, item, *n, too_long.len()));
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

/// 删掉临时文件夹。替换失败、没能全部换回来时（记录 journal.json 还在）只删下载的备份，解压出来的（new）、换下来的原来的
/// 数据（old）和记录都留着，下次启动时 recover_leftovers 凭记录接着换回
pub fn clean_staging(staging: &Path) {
    let _ = fs::remove_file(staging.join("download.zip"));
    if staging.join(SWAP_JOURNAL).exists() {
        return;
    }
    let _ = fs::remove_dir_all(staging.join(STAGED_NEW));
    let _ = fs::remove_dir(staging.join(STAGED_OLD));
    let _ = fs::remove_dir(staging);
}

/// 用本地的备份文件恢复（staging 是 staging_dir 建的临时文件夹）：先解压到临时文件夹里、检查好，
/// 再拿着存储层的锁把现在的数据备份到 backup_dir（`…-恢复前.zip`，备份不了就不恢复），然后换成备份里的
pub fn restore_at(store: &Store, staging: &Path, zip_path: &Path, backup_dir: &Path, time: DateTime<Local>) -> Result<Restored> {
    // 上次恢复没能全部换回来的临时文件夹还在（有记录）：再恢复一次的话，下次启动换回上次的时会把这次换进来的当成上次的
    if let Some(left) = unfinished_restore(store.root(), staging) {
        return Err(format!(
            "上次恢复待办数据没能全部换回来，临时文件夹 {} 还在。请先关掉占用文件的程序、重新打开软件让它换回来，再恢复",
            left.display()
        ));
    }
    let (mut zip, manifest) = open_data_zip(zip_path)?;
    let new = staging.join(STAGED_NEW);
    fs::create_dir_all(&new).map_err(|e| format!("恢复失败，无法创建临时文件夹：{e}"))?;
    extract(&mut zip, &manifest, &new, store.root())?;
    drop(zip);
    let (workspaces, todos) = store::count_data(&new)?;
    let not_backed_up = |e: String| format!("无法先把现在的数据备份一份（{e}），没有恢复");
    check_backup_dir(backup_dir, store.root()).map_err(not_backed_up)?;
    fs::create_dir_all(backup_dir).map_err(|e| not_backed_up(format!("无法创建备份目录 {}：{e}", backup_dir.display())))?;
    let before = unique_path(backup_dir, &format!("{DATA_PREFIX}{}-{BEFORE_RESTORE}", backup::stamp(time)));
    store.replace_data(staging, &before, || pack_held(store.root(), &before, time).map_err(not_backed_up))?;
    Ok(Restored { workspaces, todos, time: manifest.created_at, before: before.to_string_lossy().into_owned() })
}

/// 数据目录里还没处理完的恢复（别的 `.restoring-…` 里有记录 journal.json）
fn unfinished_restore(root: &Path, except: &Path) -> Option<PathBuf> {
    fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(STAGING_PREFIX) && e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .find(|dir| dir != except && dir.join(SWAP_JOURNAL).exists())
}

/// 用本地的备份文件恢复，临时文件夹用完删掉
pub fn restore_file(store: &Store, zip_path: &Path, backup_dir: &Path, time: DateTime<Local>) -> Result<Restored> {
    let staging = staging_dir(store.root(), time)?;
    let result = restore_at(store, &staging, zip_path, backup_dir, time);
    clean_staging(&staging);
    result
}

/// 上次恢复待办数据时中途退出、这次启动时处理掉的结果（还没开始换、直接删掉了的不算），前端启动时提示一次
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRecovery {
    pub outcome: RecoveryOutcome,
    /// 临时文件夹（完整路径）
    pub staging: String,
    /// 恢复前的数据备份（完整路径；没有记录时不知道）
    pub before: Option<String>,
    /// 留着没处理的原因
    pub reason: Option<String>,
    /// 换回时留着没删的换进来过的备份内容（交还给用户后在数据目录里待过、可能改过）
    pub used: Option<String>,
    /// 恢复前的数据备份读得出来（原样留着的：没有因为它对不上才留着）；不是时 old 里的可能是原来的数据仅有的一份
    pub backup_ok: bool,
    /// 原样留着的：下次启动时会再试着处理
    pub retry: bool,
    /// 原样留着的：old 里有东西（换下来的原来的数据）
    pub old_data: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryOutcome {
    /// 换到一半：换回了恢复前的数据
    RolledBack,
    /// 已经换完：收了尾，现在是备份里的数据
    Finished,
    /// 处理不了：临时文件夹原样留着
    Kept,
}

/// 恢复前的数据备份 zip 还在、读得出说明；给了 old（恢复时换下来的原来的数据）时还要 old 的指纹和说明里记的一样，
/// 即备份里正是这些（恢复前先备份、再改名移进 old，中间拿着存储层的锁，文件的大小、修改时间都不变）
fn backup_holds(zip: &Path, old: Option<&Path>) -> bool {
    let Some(recorded) = read_fingerprint(zip) else { return false };
    old.is_none_or(|dir| collect(dir).is_ok_and(|items| fingerprint(&items) == recorded))
}

/// 启动时（用到存储层、开始监听数据目录、自动备份之前）找出数据目录里恢复待办数据时留下的临时文件夹（`.restoring-…`），
/// 交给 Store::recover_restore 处理：还没开始换的删掉，换到一半的换回原来的数据，已经换完的收尾，说不清的原样留着。
/// 换完了要删掉换下来的原来的数据时，恢复前的数据备份里要正是这些（backup_holds）
pub fn recover_leftovers(store: &Store) -> Vec<RestoreRecovery> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(store.root())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(STAGING_PREFIX) && e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    // 新的先处理（同撤销，后恢复的先换回）：文件夹名里是恢复的时间
    dirs.sort();
    dirs.reverse();
    let mut out = Vec::new();
    for dir in dirs {
        let staging = dir.to_string_lossy().into_owned();
        let readable = |before: &Option<String>| before.as_deref().is_some_and(|b| read_fingerprint(Path::new(b)).is_some());
        let found = match store.recover_restore(&dir, backup_holds) {
            SwapRecovery::Discarded => continue,
            SwapRecovery::RolledBack { before, used } => RestoreRecovery {
                outcome: RecoveryOutcome::RolledBack,
                staging,
                before: Some(before),
                reason: None,
                used,
                backup_ok: true,
                retry: false,
                old_data: false,
            },
            SwapRecovery::Finished { before } => RestoreRecovery {
                outcome: RecoveryOutcome::Finished,
                staging,
                before: Some(before),
                reason: None,
                used: None,
                backup_ok: true,
                retry: false,
                old_data: false,
            },
            SwapRecovery::Kept { reason, before, backup_bad, retry } => {
                eprintln!("恢复待办数据时留下的临时文件夹 {staging} 没有处理：{reason}");
                let backup_ok = !backup_bad && readable(&before);
                let old_data = fs::read_dir(dir.join(STAGED_OLD)).is_ok_and(|mut d| d.next().is_some());
                RestoreRecovery { outcome: RecoveryOutcome::Kept, staging, before, reason: Some(reason), used: None, backup_ok, retry, old_data }
            }
        };
        out.push(found);
    }
    out
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

/// 一个文件是哪一个：路径、大小、修改时间（读不出来时大小是 0、没有修改时间）
type FileId = (PathBuf, u64, Option<SystemTime>);

fn file_id(path: &Path) -> FileId {
    let md = fs::metadata(path).ok();
    (path.to_path_buf(), md.as_ref().map_or(0, |m| m.len()), md.and_then(|m| m.modified().ok()))
}

/// 上次扫数据目录算指纹、数据和最新的一份一样（跳过了）时的情况
#[derive(Debug, Clone, PartialEq)]
struct Scanned {
    /// 扫之前数据目录变了几次（store::change_count）
    changes: u64,
    /// 备份目录里最新的一份
    latest: FileId,
    /// 什么时候扫的（毫秒）
    at: i64,
}

/// 自动备份上次扫数据目录的情况（这次运行期间，BackupJobs 里的）：之后数据目录没再变、最新的一份还是那个文件、离上次扫不太久，
/// 数据就还是和最新的一份一样，不用每 10 分钟都拿着存储层的锁把整个数据目录读一遍。刚启动时是空的，第一次检查总要扫
#[derive(Debug, Default)]
pub struct AutoScan(Mutex<Option<Scanned>>);

impl AutoScan {
    fn get(&self) -> Option<Scanned> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, scanned: Option<Scanned>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = scanned;
    }
}

/// 检查一次：距备份目录里最新的一份满 24 小时、数据有变化时备份到 dir（备份前调 started），然后只留最近 keep 份。
/// 最新的一份时间在将来的（系统时间被往回调过）不算。
/// 数据有没有变化要扫一遍数据目录算指纹；上次扫过、数据和最新的一份一样之后，数据目录没再变（软件自己写的、监听到外部改的
/// 都会记一次，store::change_count）、最新的一份还是那个文件、离上次扫不到 RESCAN_WATCHED_MS（watching 为 false，没在监听
/// 数据目录时是 RESCAN_UNWATCHED_MS）的，沿用上次的结果，不再扫
pub fn run_auto(
    store: &Store,
    dir: &Path,
    keep: usize,
    now: DateTime<Local>,
    scan: &AutoScan,
    watching: bool,
    started: impl FnOnce(),
) -> Result<AutoLocal> {
    check_backup_dir(dir, store.root())?;
    let now_ms = now.timestamp_millis();
    let list = local_backups(dir);
    let latest = list.iter().find(|b| b.time <= now_ms + 60_000);
    if latest.is_some_and(|b| now_ms - b.time < AUTO_INTERVAL_MS) {
        return Ok(AutoLocal::NotYet);
    }
    let latest_id = latest.map(|b| file_id(&b.path));
    // 扫之前先记下变了几次：扫的时候又变了的，下次一定重扫
    let changes = store::change_count(store.root());
    let every = if watching { RESCAN_WATCHED_MS } else { RESCAN_UNWATCHED_MS };
    let fresh = |s: &Scanned| s.changes == changes && Some(&s.latest) == latest_id.as_ref() && (0..every).contains(&(now_ms - s.at));
    if scan.get().is_some_and(|s| fresh(&s)) {
        return Ok(AutoLocal::Unchanged);
    }
    let current = store
        .locked(|| collect(store.root()))
        .map(|items| fingerprint(&items))
        .map_err(|e| format!("读取数据目录失败：{e}"))?;
    if latest.and_then(|b| read_fingerprint(&b.path)).is_some_and(|f| f == current) {
        scan.set(latest_id.map(|latest| Scanned { changes, latest, at: now_ms }));
        return Ok(AutoLocal::Unchanged);
    }
    scan.set(None);
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
/// 记着这次运行期间最近一次自动备份的结果和上次扫数据目录的情况；可以叫醒定时检查的线程（改了自动备份的设置后马上检查）；
/// 记着启动时处理掉的恢复中途留下的临时文件夹（recover_leftovers），等前端取走
#[derive(Default)]
pub struct BackupJobs {
    busy: Mutex<()>,
    running: AtomicBool,
    last: Mutex<Option<AutoRun>>,
    scan: AutoScan,
    waker: Mutex<Option<Sender<()>>>,
    recovered: Mutex<Vec<RestoreRecovery>>,
}

impl BackupJobs {
    /// 自动备份上次扫数据目录的情况（run_auto 用）
    pub fn scan(&self) -> &AutoScan {
        &self.scan
    }

    pub fn with_recovered(recovered: Vec<RestoreRecovery>) -> Self {
        Self { recovered: Mutex::new(recovered), ..Self::default() }
    }

    /// 启动时处理掉的恢复中途留下的临时文件夹，只给一次（前端提示过就不再给）
    pub fn take_recovered(&self) -> Vec<RestoreRecovery> {
        std::mem::take(&mut *self.recovered.lock().unwrap_or_else(|e| e.into_inner()))
    }

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
    use std::collections::{BTreeMap, BTreeSet};
    use zip::write::SimpleFileOptions;

    /// 检查一次自动备份，每次都像刚启动时一样扫数据目录（监听着数据目录）
    fn auto(s: &Store, dir: &Path, keep: usize, now: DateTime<Local>, started: impl FnOnce()) -> Result<AutoLocal> {
        run_auto(s, dir, keep, now, &AutoScan::default(), true, started)
    }

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

    /// 各工作区文件夹里（任意深度）的文件、文件夹：包里的路径 → 文件的内容（文件夹是 None）；保存时的临时文件不算
    fn snapshot(root: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
        let mut out = BTreeMap::new();
        let mut stack: Vec<(PathBuf, String)> = fs::read_dir(root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_type().unwrap().is_dir() && !e.file_name().to_string_lossy().starts_with('.'))
            .map(|e| (e.path(), format!("{}/", e.file_name().to_string_lossy())))
            .collect();
        while let Some((dir, name)) = stack.pop() {
            out.insert(name.clone(), None);
            for e in fs::read_dir(&dir).unwrap().flatten() {
                let child = e.file_name().to_string_lossy().into_owned();
                if e.file_type().unwrap().is_dir() {
                    stack.push((e.path(), format!("{name}{child}/")));
                } else if !is_temp_file(&child) {
                    out.insert(format!("{name}{child}"), Some(fs::read(e.path()).unwrap()));
                }
            }
        }
        out
    }

    /// 一棵多级的项目树：工作/A/B/C/D 四级，每一级都有两个子项目、手动排过序（各级的 .projects.json），
    /// 每一级都有待办（各级的 .todos.json），最深的 D 里的待办有粘贴的图片（D/.assets/{待办 id}/），还有保存到一半的临时文件
    fn deep_tree(s: &Store) -> (String, String) {
        s.create_project("工作", "A").unwrap();
        s.reorder_projects("工作", None, &["A".into(), "需求".into(), "空项目".into()]).unwrap();
        let mut parent = String::from("A");
        for name in ["B", "C", "D"] {
            s.create_sub_project("工作", &parent, name).unwrap();
            s.create_sub_project("工作", &parent, &format!("{name}2")).unwrap();
            s.reorder_projects("工作", Some(&parent), &[format!("{name}2"), name.into()]).unwrap();
            s.create_todo("工作", &parent, &format!("{parent} 里的"), "正文").unwrap();
            parent = format!("{parent}/{name}");
        }
        let todo = s.create_todo("工作", &parent, "截图", "").unwrap();
        let img = s.save_image("工作", &parent, &todo.id, "png", &[137, 80, 78, 71]).unwrap();
        s.save_todo_content("工作", &parent, &todo.id, &format!("![截图]({})", img.link), None, true).unwrap();
        let ddir = s.project_path("工作", &parent).unwrap();
        fs::write(ddir.join(format!(".{}.md.tmp", todo.id)), "保存到一半").unwrap();
        (parent, img.link)
    }

    /// docs/requirements.md「数据备份 → 备份的内容」：子项目层数不限，每一级的项目文件夹、待办正文、.todos.json、
    /// 项目的顺序 .projects.json 和图片的附件目录 .assets 都在备份里，恢复后和备份时一模一样
    #[test]
    fn deep_project_tree_is_backed_up_and_restored_whole() {
        let (tmp, s) = setup("deep");
        let (deep, link) = deep_tree(&s);
        let backups = default_dir(s.root());
        fs::create_dir_all(&backups).unwrap();
        let zip = backups.join(file_name(time(10)));
        let before = snapshot(s.root());
        pack(&s, &zip, time(10)).unwrap();

        let names = entries(&zip);
        let image = format!("工作/{deep}/{link}");
        for want in [
            "工作/.projects.json",
            "工作/A/.projects.json",
            "工作/A/B/.projects.json",
            "工作/A/B/C/.projects.json",
            "工作/A/.todos.json",
            "工作/A/B/C/.todos.json",
            "工作/A/B/C/D/.todos.json",
            "工作/A/B/C/D2/",
            image.as_str(),
        ] {
            assert!(names.contains(want), "缺 {want}：{names:?}");
        }
        assert!(!names.iter().any(|n| n.ends_with(".tmp")), "保存时的临时文件不在备份里：{names:?}");
        // 包里的文件就是数据目录里各工作区的全部（临时文件除外）
        let packed: BTreeSet<String> = names.iter().filter(|n| *n != MANIFEST_FILE && *n != UI_STATE_FILE).cloned().collect();
        assert_eq!(packed, before.keys().cloned().collect::<BTreeSet<_>>());
        let info = inspect(&zip).unwrap();
        assert_eq!((info.workspaces, info.todos), (2, 6), "各级子项目里的待办都算");

        // 备份之后：深处子项目的顺序在外部改了、图片删了、一个子项目删了、又建了一个更深的子项目
        let cdir = s.project_path("工作", "A/B/C").unwrap();
        fs::write(cdir.join(store::ORDER_FILE), r#"{"order":["D","D2"]}"#).unwrap();
        fs::remove_dir_all(s.project_path("工作", &deep).unwrap().join(store::ASSETS_DIR)).unwrap();
        fs::remove_dir_all(s.project_path("工作", "A/B/C/D2").unwrap()).unwrap();
        s.create_sub_project("工作", &deep, "E").unwrap();
        assert_ne!(snapshot(s.root()), before);

        restore_file(&s, &zip, &backups, time(11)).unwrap();
        assert_eq!(snapshot(s.root()), before, "恢复后各级的文件和备份时一样");
        assert!(s.image_file("工作", &deep, &link).is_ok(), "深处的图片恢复了");
        let tree = s.load_workspace("工作").unwrap();
        let rank = |p: &str| tree.projects.iter().find(|n| n.name == p).unwrap().order;
        assert_eq!((rank("A/B/C/D2"), rank("A/B/C/D")), (Some(0), Some(1)), "深处的顺序和备份时一样");
        // 恢复出来的和那份备份一样，指纹相同：过了一天也不再备份一份一样的
        let later = time(11) + chrono::Duration::days(2);
        assert!(matches!(auto(&s, &backups, 10, later, || ()).unwrap(), AutoLocal::Unchanged));
        drop(tmp);
    }

    /// 自动备份的「数据有没有变」：只改了深处子项目的顺序、只在深处的附件目录里加了图片也算变了
    #[test]
    fn fingerprint_sees_deep_project_order_and_images() {
        let (_tmp, s) = setup("fingerprint-deep");
        let (deep, _) = deep_tree(&s);
        let fp = || fingerprint(&collect(s.root()).unwrap());
        let first = fp();
        s.reorder_projects("工作", Some("A/B/C"), &["D".into(), "D2".into()]).unwrap();
        let second = fp();
        assert_ne!(second, first, "调整了第四级子项目的顺序（A/B/C 里的 .projects.json）");
        let todo = s.load_workspace("工作").unwrap().projects.into_iter().find(|p| p.name == deep).unwrap().todos[0].id.clone();
        s.save_image("工作", &deep, &todo, "png", &[137, 80, 78, 71, 1]).unwrap();
        let third = fp();
        assert_ne!(third, second, "深处的附件目录里加了图片");
        // 保存时的临时文件、界面状态不算
        let ddir = s.project_path("工作", &deep).unwrap();
        fs::write(ddir.join(".别的.md.tmp"), "x").unwrap();
        s.write_ui_state("{}").unwrap();
        assert_eq!(fp(), third);
    }

    /// 自动备份的「数据有没有变」（docs/requirements.md「数据备份 → 自动备份」）：只调整了顶层项目的顺序（工作区里的
    /// .projects.json）、只有父项目里的 .projects.json 在外部变了（网盘同步来的）、只换成了按名称、只在顶层项目的附件目录里
    /// 加了图片，指纹都变
    #[test]
    fn fingerprint_sees_top_level_order_parent_order_and_images() {
        let (_tmp, s) = setup("fingerprint-order");
        let fp = || fingerprint(&collect(s.root()).unwrap());
        let first = fp();
        s.reorder_projects("工作", None, &["空项目".into(), "需求".into()]).unwrap();
        let second = fp();
        assert_ne!(second, first, "调整了顶层项目的顺序");
        let pdir = s.project_path("工作", "需求").unwrap();
        fs::write(pdir.join(store::ORDER_FILE), r#"{"order":["前端"]}"#).unwrap();
        let third = fp();
        assert_ne!(third, second, "父项目里的 .projects.json 在外部变了");
        s.set_projects_manual("工作", false).unwrap();
        let fourth = fp();
        assert_ne!(fourth, third, "换成了按名称");
        let todo = s.load_workspace("工作").unwrap().projects.into_iter().find(|p| p.name == "需求").unwrap().todos[0].id.clone();
        s.save_image("工作", "需求", &todo, "png", &[137, 80, 78, 71]).unwrap();
        assert_ne!(fp(), fourth, "顶层项目的附件目录里加了图片");
    }

    /// 恢复时解压出来的、换下来的、从 WebDAV 下载的都在数据目录里的临时文件夹（点开头）里：监听数据目录时不算
    /// （watch.rs 的 classify），恢复中途不会把那里的一大批变化报给前端
    #[test]
    fn staging_is_ignored_by_the_watcher() {
        use crate::store::PathState;
        let (_tmp, s) = setup("staging-watch");
        let staging = staging_dir(s.root(), time(12)).unwrap();
        let name = staging.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with('.') && staging.parent() == Some(s.root()), "{}", staging.display());
        let file = PathState::File { modified: None, len: 1 };
        for rel in [
            vec![name.as_str()],
            vec![&name, "new", "工作"],
            vec![&name, "new", "工作", "需求", "A.md"],
            vec![&name, "old", "工作", "需求", ".todos.json"],
            vec![&name, "old", ".state.json"],
            vec![&name, "download.zip"],
        ] {
            for now in [PathState::Dir, PathState::Absent, file] {
                assert_eq!(crate::watch::classify(&rel, true, now), None, "{rel:?}");
                assert_eq!(crate::watch::classify(&rel, false, now), None, "{rel:?}");
            }
        }
        clean_staging(&staging);
        assert!(!staging.exists());
    }

    /// 恢复中途退出时临时文件夹里的样子：zip 解压到 new，现在的数据备份成 before（恢复前的数据备份），写下记录（同 store.rs 的
    /// replace_data），然后做前 k 步改名（先把现在的都移进 old，再把 new 里的移过来）；k 是 None 时全部做完
    fn crashed_restore(s: &Store, zip: &Path, before: &Path, at: DateTime<Local>, k: Option<usize>) -> PathBuf {
        let staging = staging_dir(s.root(), at).unwrap();
        let (mut archive, manifest) = open_data_zip(zip).unwrap();
        extract(&mut archive, &manifest, &staging.join(STAGED_NEW), s.root()).unwrap();
        pack(s, before, at).unwrap();
        let items = |dir: &Path| {
            let mut names: Vec<String> = fs::read_dir(dir)
                .unwrap()
                .flatten()
                .filter(|e| e.file_type().unwrap().is_dir() && !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            if dir.join(UI_STATE_FILE).is_file() {
                names.push(UI_STATE_FILE.into());
            }
            names
        };
        let (current, incoming) = (items(s.root()), items(&staging.join(STAGED_NEW)));
        let journal = serde_json::json!({
            "version": 1, "phase": "swapping", "current": current, "incoming": incoming, "before": before.to_string_lossy()
        });
        fs::create_dir_all(staging.join(STAGED_OLD)).unwrap();
        fs::write(staging.join(SWAP_JOURNAL), journal.to_string()).unwrap();
        let moves = current.iter().map(|n| (s.root().join(n), staging.join(STAGED_OLD).join(n)));
        let moves = moves.chain(incoming.iter().map(|n| (staging.join(STAGED_NEW).join(n), s.root().join(n))));
        for (from, to) in moves.take(k.unwrap_or(usize::MAX)) {
            fs::rename(from, to).unwrap();
        }
        staging
    }

    /// docs/requirements.md「恢复数据」：替换中途程序退出了（崩溃、断电、被结束），下次启动时（用到存储层之前）换回恢复前的数据，
    /// 已经换完的收尾（恢复前的数据备份读得出时才删掉换下来的），还没开始换的悄悄删掉，说不清的（以前的版本留下的）原样留着；
    /// 除了悄悄删掉的，结果都交给前端提示一次
    #[test]
    fn leftovers_are_recovered_on_startup() {
        let (_tmp, s) = setup("leftovers");
        let backups = default_dir(s.root());
        fs::create_dir_all(&backups).unwrap();
        let zip = backups.join(file_name(time(10)));
        pack(&s, &zip, time(10)).unwrap();
        let in_backup = snapshot(s.root());
        s.create_workspace("后来建的").unwrap();
        s.write_ui_state(r#"{"later":true}"#).unwrap();
        let original = (snapshot(s.root()), s.read_ui_state().unwrap());

        // 换到一半（现在的前两项已经移进 old）；还没开始换（只有下载到一半的）；以前的版本留下的（没有记录，old 里有东西）
        let before = backups.join("TodoList-data-20261009-113012-恢复前.zip");
        let halfway = crashed_restore(&s, &zip, &before, time(11), Some(2));
        let downloading = staging_dir(s.root(), time(12)).unwrap();
        fs::write(downloading.join("download.zip"), "下载到一半").unwrap();
        let ancient = s.root().join(".restoring-20200101-000000");
        fs::create_dir_all(ancient.join(STAGED_OLD).join("以前的")).unwrap();
        fs::write(ancient.join(STAGED_OLD).join("以前的").join("a.md"), "以前的正文").unwrap();

        let found = recover_leftovers(&s);
        let path = |p: &Path| p.to_string_lossy().into_owned();
        // 新的先处理：halfway（11 点的）在 ancient（2020 年的）前面
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(
            found[0],
            RestoreRecovery {
                outcome: RecoveryOutcome::RolledBack,
                staging: path(&halfway),
                before: Some(path(&before)),
                reason: None,
                used: None,
                backup_ok: true,
                retry: false,
                old_data: false
            }
        );
        assert_eq!((found[1].outcome, found[1].staging.as_str(), found[1].before.as_deref()), (RecoveryOutcome::Kept, path(&ancient).as_str(), None));
        assert!(found[1].reason.as_deref().is_some_and(|r| r.contains("没有记录")), "{found:?}");
        assert!(!found[1].backup_ok && !found[1].retry && found[1].old_data, "以前的版本留下的：不知道恢复前的数据备份是哪份，也不会再试");
        assert_eq!((snapshot(s.root()), s.read_ui_state().unwrap()), original, "换回了恢复前的数据");
        assert!(!halfway.exists() && !downloading.exists());
        assert_eq!(fs::read_to_string(ancient.join(STAGED_OLD).join("以前的").join("a.md")).unwrap(), "以前的正文", "什么都没删");

        // 全部换完了才退出（还没删 old）：恢复前的数据备份读不出来、里面的和换下来的对不上时留着，正是它们时收尾，是备份里的数据
        let before = backups.join("TodoList-data-20261009-133012-恢复前.zip");
        let done = crashed_restore(&s, &zip, &before, time(13), None);
        let packed = fs::read(&before).unwrap();
        for wrong in ["坏了".as_bytes().to_vec(), fs::read(&zip).unwrap()] {
            fs::write(&before, wrong).unwrap();
            let found = recover_leftovers(&s);
            assert_eq!(found.len(), 2, "{found:?}");
            assert!(found[0].outcome == RecoveryOutcome::Kept && found[0].reason.as_deref().is_some_and(|r| r.contains("对不上")), "{found:?}");
            assert!(!found[0].backup_ok && found[0].retry && found[0].old_data, "恢复前的数据备份对不上：old 里的可能是仅有的一份；下次启动再试");
            assert!(done.join(STAGED_OLD).join("后来建的").is_dir(), "换下来的原来的数据留着");
        }
        // 留着期间再恢复：先要处理好上次的
        let err = restore_file(&s, &zip, &backups, time(14)).unwrap_err();
        assert!(err.contains("没能全部换回来") && err.contains(&path(&done)), "{err}");
        fs::write(&before, packed).unwrap();
        let found = recover_leftovers(&s);
        assert_eq!(
            found[0],
            RestoreRecovery {
                outcome: RecoveryOutcome::Finished,
                staging: path(&done),
                before: Some(path(&before)),
                reason: None,
                used: None,
                backup_ok: true,
                retry: false,
                old_data: false
            }
        );
        assert_eq!(snapshot(s.root()), in_backup, "是备份里的数据");
        assert!(!done.exists());

        // 前端只取得到一次
        let jobs = BackupJobs::with_recovered(found);
        assert_eq!(jobs.take_recovered().len(), 2);
        assert!(jobs.take_recovered().is_empty());
    }

    /// 替换失败、没能全部换回来时（记录还在）用完的临时文件夹只删下载的备份：解压出来的、换下来的和记录留给下次启动时换回
    #[test]
    fn clean_staging_keeps_what_recovery_needs() {
        let (_tmp, s) = setup("clean");
        let staging = staging_dir(s.root(), time(12)).unwrap();
        for dir in [STAGED_NEW, STAGED_OLD] {
            fs::create_dir_all(staging.join(dir).join("工作")).unwrap();
        }
        fs::write(staging.join("download.zip"), "x").unwrap();
        fs::write(staging.join(SWAP_JOURNAL), "{}").unwrap();
        clean_staging(&staging);
        assert!(!staging.join("download.zip").exists());
        assert!(staging.join(STAGED_NEW).join("工作").is_dir() && staging.join(STAGED_OLD).join("工作").is_dir());
        assert!(staging.join(SWAP_JOURNAL).is_file());
        // 没有记录时整个删掉
        fs::remove_file(staging.join(SWAP_JOURNAL)).unwrap();
        fs::remove_dir(staging.join(STAGED_OLD).join("工作")).unwrap();
        clean_staging(&staging);
        assert!(!staging.exists());
    }

    /// 工作区是不是手动排序，和各项目在它那一层里排第几
    fn project_ranks(s: &Store, ws: &str) -> (bool, Vec<(String, Option<i64>)>) {
        let tree = s.load_workspace(ws).unwrap();
        let mut ranks: Vec<(String, Option<i64>)> = tree.projects.iter().map(|p| (p.name.clone(), p.order)).collect();
        ranks.sort();
        (tree.manual_order, ranks)
    }

    /// docs/requirements.md「数据备份 → 备份的内容」：备份之后工作区换回了按名称、父项目里的顺序在外部改了，
    /// 恢复后又是手动排序，顶层项目、子项目的顺序和备份时一样
    #[test]
    fn switching_to_by_name_after_backup_is_restored() {
        let (tmp, s) = setup("order");
        s.create_sub_project("工作", "需求", "后端").unwrap();
        s.reorder_projects("工作", None, &["需求".into(), "空项目".into()]).unwrap();
        s.reorder_projects("工作", Some("需求"), &["后端".into(), "前端".into()]).unwrap();
        let ordered = project_ranks(&s, "工作");
        assert!(ordered.0 && ordered.1.iter().any(|(p, o)| p == "需求/后端" && *o == Some(0)), "{ordered:?}");

        let backups = default_dir(s.root());
        fs::create_dir_all(&backups).unwrap();
        let zip = backups.join(file_name(time(10)));
        pack(&s, &zip, time(10)).unwrap();
        let names = entries(&zip);
        for want in ["工作/.projects.json", "工作/需求/.projects.json"] {
            assert!(names.contains(want), "缺 {want}：{names:?}");
        }

        s.set_projects_manual("工作", false).unwrap();
        let pdir = s.project_path("工作", "需求").unwrap();
        fs::write(pdir.join(store::ORDER_FILE), r#"{"order":["前端","后端"]}"#).unwrap();
        assert_ne!(project_ranks(&s, "工作"), ordered);

        restore_file(&s, &zip, &backups, time(11)).unwrap();
        assert_eq!(project_ranks(&s, "工作"), ordered, "又是手动排序，项目的顺序和备份时一样");
        drop(tmp);
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
            "工作/COM¹/a.md",
            "工作/需求/lpt³.md",
            "工作/CONIN$/a.md",
            "工作/需求/conout$.md",
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

    /// 在数据目录 root 的工作区「工作」里建一级级很深的子项目，最深处放两条待办，它们的路径相对 root（含开头的分隔符）
    /// 正好 rel 个字符；返回两条待办在包里的路径
    fn deep_files(root: &Path, rel: usize) -> [String; 2] {
        let mut parts = vec!["工作".to_string()];
        let mut used = 1 + 2;
        while rel - used > 1 + 40 + 1 + 10 {
            parts.push("层".repeat(40));
            used += 1 + 40;
        }
        let folder = parts.iter().fold(root.to_path_buf(), |p, part| p.join(part));
        fs::create_dir_all(&folder).unwrap();
        ["x", "y"].map(|c| {
            let file = format!("{}.md", c.repeat(rel - used - 1 - 3));
            fs::write(folder.join(&file), "深处的正文").unwrap();
            format!("{}/{file}", parts.join("/"))
        })
    }

    /// base 里一个路径正好 len 个字符的数据目录
    fn root_of_len(base: &Path, len: usize) -> PathBuf {
        let root = base.join("d".repeat(len - store::path_len(base) - 1));
        assert_eq!(store::path_len(&root), len);
        root
    }

    /// docs/requirements.md「恢复数据 → 路径长度」：备份里的东西恢复到这里的数据目录后路径会超过 259 个字符时（这里的数据目录
    /// 比备份时的长）整个不恢复，说明是哪一项、会有多长、数据目录要再短多少；现在的数据不动，也不先备份。正好 259 个的照常恢复：
    /// 解压到数据目录里的临时文件夹时路径比这还长 30 多个字符、超过 260（Windows 上 std 换成 \\?\ 开头的长路径）
    #[test]
    fn restore_refuses_paths_too_long_for_this_data_dir() {
        let tmp = TempRoot::new("long");
        // 备份时的数据目录很短，最深的两条待办相对它 150 个字符
        let short = Store::new(tmp.0.join("s")).unwrap();
        let items = deep_files(short.root(), 150);
        let zip = tmp.0.join(file_name(time(10)));
        pack(&short, &zip, time(10)).unwrap();
        let names = entries(&zip);
        assert!(items.iter().all(|i| names.contains(i)), "{names:?}");

        // 这里的数据目录长了 110 - 1 - 1 个字符：恢复后最深的两条待办有 260 个字符
        let long = Store::new(root_of_len(&tmp.0, 110)).unwrap();
        long.create_workspace("现在的").unwrap();
        let backups = default_dir(long.root());
        let err = restore_file(&long, &zip, &backups, time(11)).unwrap_err();
        assert!(items.iter().any(|i| err.contains(i.as_str())), "说明是哪一项：{err}");
        assert!(err.contains("260 个字符") && err.contains("共有 2 个") && err.contains("259"), "{err}");
        assert!(err.contains(&long.root().display().to_string()) && err.contains("要再短 1 个字符"), "{err}");
        // 现在的数据不动，没有先备份，临时文件夹删掉了
        let workspaces = |s: &Store| s.list_workspaces().unwrap().into_iter().map(|w| w.name).collect::<Vec<_>>();
        assert_eq!(workspaces(&long), ["现在的"]);
        assert!(!backups.exists(), "没有先备份");
        assert!(!fs::read_dir(long.root()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(STAGING_PREFIX)));

        // 正好 259 个字符：照常恢复，恢复出来的打得开
        let fits = Store::new(root_of_len(&tmp.0, 109)).unwrap();
        fits.create_workspace("现在的").unwrap();
        let r = restore_file(&fits, &zip, &default_dir(fits.root()), time(11)).unwrap();
        assert_eq!((r.workspaces, r.todos), (1, 2));
        for item in &items {
            let restored = item.split('/').fold(fits.root().to_path_buf(), |p, part| p.join(part));
            assert_eq!(store::path_len(&restored), MAX_PATH_CHARS);
            assert_eq!(fs::read_to_string(&restored).unwrap(), "深处的正文");
        }
        assert_eq!(workspaces(&fits), ["工作"]);
        assert!(!fs::read_dir(fits.root()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(STAGING_PREFIX)));
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
        let r = auto(&s, &dir, 10, time(8), || started += 1).unwrap();
        assert!(matches!(r, AutoLocal::Done(ref p) if p.name == "TodoList-data-20261009-083012.zip"), "{r:?}");
        assert_eq!(started, 1);
        // 不到 24 小时：不备份
        s.create_workspace("改了").unwrap();
        let next_day = |h| time(h) + chrono::Duration::days(1);
        assert!(matches!(auto(&s, &dir, 10, next_day(8) - chrono::Duration::minutes(1), || ()).unwrap(), AutoLocal::NotYet));
        // 满 24 小时、有变化：备份
        assert!(matches!(auto(&s, &dir, 10, next_day(8), || ()).unwrap(), AutoLocal::Done(_)));
        // 又过了一天，数据没变：跳过（只改界面状态也算没变）
        s.write_ui_state(r#"{"x":1}"#).unwrap();
        let mut called = false;
        assert!(matches!(auto(&s, &dir, 10, next_day(8) + chrono::Duration::days(1), || called = true).unwrap(), AutoLocal::Unchanged));
        assert!(!called);
        assert_eq!(local_backups(&dir).len(), 2);
        // 最新的一份在将来（系统时间被往回调过）：不算
        fs::copy(dir.join("TodoList-data-20261009-083012.zip"), dir.join("TodoList-data-20991231-000000.zip")).unwrap();
        s.create_workspace("又改了").unwrap();
        assert!(matches!(auto(&s, &dir, 10, next_day(8) + chrono::Duration::days(2), || ()).unwrap(), AutoLocal::Done(_)));
        // 不能备份到数据目录里面
        assert!(auto(&s, &s.root().join("x"), 10, time(8), || ()).is_err());
    }

    /// 在数据目录里外部加一个文件、不经软件也不经监听（模拟监听漏了）：只有重扫数据目录才看得出数据变了
    fn sneak_in(s: &Store, name: &str) {
        fs::write(s.project_path("工作", "需求").unwrap().join(name), "外面加的").unwrap();
    }

    /// docs/requirements.md「自动备份」：扫过一遍、数据和最新的一份一样之后，数据目录没再变、最新的一份还是那个文件时不再扫；
    /// 软件里改了、监听到外部改了（附件目录里的图片也算）就重扫。界面状态、回收站这些不在备份里的变了不算。
    /// 启动后第一次检查总是扫
    #[test]
    fn auto_backup_rescans_only_when_something_changed() {
        let (tmp, s) = setup("rescan");
        let dir = tmp.0.join("备份");
        let scan = AutoScan::default();
        let at = |days: i64, minutes: i64| time(8) + chrono::Duration::days(days) + chrono::Duration::minutes(minutes);
        let check = |scan: &AutoScan, now| run_auto(&s, &dir, 10, now, scan, true, || ()).unwrap();
        assert!(matches!(check(&scan, at(0, 0)), AutoLocal::Done(_)));
        // 满 24 小时、数据没变：扫一遍，跳过
        assert!(matches!(check(&scan, at(1, 0)), AutoLocal::Unchanged));
        // 之后数据目录没再变（只是没经软件、监听也没报的外部改动）：不重扫，还是跳过——说明没有扫
        sneak_in(&s, "漏掉的.md");
        assert!(matches!(check(&scan, at(1, 10)), AutoLocal::Unchanged));
        // 界面状态、回收站、设置文件变了：不在备份里，还是不扫
        s.write_ui_state(r#"{"x":2}"#).unwrap();
        store::note_change(&s.root().join(store::RECYCLE_DIR).join("x"));
        store::note_change(&s.root().join(SETTINGS_FILE));
        assert!(matches!(check(&scan, at(1, 20)), AutoLocal::Unchanged));
        // 监听报来了附件目录里的变化（不刷新界面，但在备份里）：重扫，看出数据变了，备份
        store::note_change(&s.project_path("工作", "需求").unwrap().join(store::ASSETS_DIR).join("图.png"));
        assert!(matches!(check(&scan, at(1, 30)), AutoLocal::Done(_)));
        // 又过了一天：扫一遍、跳过；软件里改了（新建项目）：重扫，备份
        assert!(matches!(check(&scan, at(2, 40)), AutoLocal::Unchanged));
        sneak_in(&s, "又漏掉的.md");
        assert!(matches!(check(&scan, at(2, 50)), AutoLocal::Unchanged));
        s.create_project("工作", "新项目").unwrap();
        assert!(matches!(check(&scan, at(2, 60)), AutoLocal::Done(_)));
        // 启动后第一次检查（新的 AutoScan）总是扫
        assert!(matches!(check(&scan, at(3, 70)), AutoLocal::Unchanged));
        sneak_in(&s, "第三个.md");
        assert!(matches!(check(&scan, at(3, 80)), AutoLocal::Unchanged));
        assert!(matches!(check(&AutoScan::default(), at(3, 90)), AutoLocal::Done(_)));
    }

    /// 数据目录没再变也隔一阵重扫一遍：监听着时 6 小时（监听可能悄悄停了），没在监听时（如网络盘）1 小时；
    /// 备份目录里最新的一份换了（被替换、删掉、多了更新的）时也重扫
    #[test]
    fn auto_backup_rescans_after_a_while_or_when_the_latest_backup_changed() {
        let (tmp, s) = setup("rescan-time");
        let dir = tmp.0.join("备份");
        let scan = AutoScan::default();
        let at = |minutes: i64| time(8) + chrono::Duration::days(1) + chrono::Duration::minutes(minutes);
        let check = |now, watching| run_auto(&s, &dir, 10, now, &scan, watching, || ()).unwrap();
        assert!(matches!(check(time(8), true), AutoLocal::Done(_)));
        // 没在监听：1 小时后重扫
        assert!(matches!(check(at(0), false), AutoLocal::Unchanged));
        sneak_in(&s, "一.md");
        assert!(matches!(check(at(59), false), AutoLocal::Unchanged));
        assert!(matches!(check(at(60), false), AutoLocal::Done(_)));
        // 监听着：6 小时后重扫
        let later = |minutes: i64| at(60 + 24 * 60 + minutes);
        assert!(matches!(check(later(0), true), AutoLocal::Unchanged));
        sneak_in(&s, "二.md");
        assert!(matches!(check(later(6 * 60 - 1), true), AutoLocal::Unchanged));
        assert!(matches!(check(later(6 * 60), true), AutoLocal::Done(_)));
        // 最新的一份被换了（同名、修改时间不同）：重扫
        let next = |minutes: i64| later(6 * 60 + 24 * 60 + minutes);
        assert!(matches!(check(next(0), true), AutoLocal::Unchanged));
        sneak_in(&s, "三.md");
        let newest = local_backups(&dir)[0].path.clone();
        File::options().write(true).open(&newest).unwrap().set_modified(UNIX_EPOCH + Duration::from_secs(1_600_000_000)).unwrap();
        assert!(matches!(check(next(10), true), AutoLocal::Done(_)));
    }

    #[test]
    fn restored_data_is_not_backed_up_again() {
        let (tmp, s) = setup("restored");
        let dir = tmp.0.join("备份");
        assert!(matches!(auto(&s, &dir, 10, time(8), || ()).unwrap(), AutoLocal::Done(_)));
        let zip = dir.join("TodoList-data-20261009-083012.zip");
        s.create_workspace("后来建的").unwrap();
        restore_file(&s, &zip, &dir, time(9)).unwrap();
        // 恢复出来的和那份备份一样（修改时间也改回去了）：过了一天也不再备份一份一样的
        let later = time(9) + chrono::Duration::days(2);
        assert!(matches!(auto(&s, &dir, 10, later, || ()).unwrap(), AutoLocal::Unchanged));
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
        assert!(matches!(auto(&s, &dir, 2, time(8), || ()).unwrap(), AutoLocal::Done(_)));
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

    /// docs/requirements.md「数据备份 → 自动备份」：同一秒里备份了几份时（后存的是 `…-2.zip`、`…-3.zip`…），编号大的是后备份的：
    /// 设置里的「上次自动备份」、判断数据变没变时比的最新一份、「保留最近 N 份」删掉的最旧的都按这个顺序
    #[test]
    fn same_second_backups_sort_by_their_number() {
        let (tmp, s) = setup("same-second");
        let dir = tmp.0.join("备份");
        fs::create_dir_all(&dir).unwrap();
        let base = format!("{DATA_PREFIX}20261009-083012");
        // 同一秒里的第一份是改动之前的数据，第二份（-2）是现在的
        pack(&s, &dir.join(format!("{base}.zip")), time(8)).unwrap();
        s.create_workspace("改了").unwrap();
        let second = unique_path(&dir, &base);
        assert_eq!(second, dir.join(format!("{base}-2.zip")));
        pack(&s, &second, time(8)).unwrap();
        fs::write(dir.join(format!("{DATA_PREFIX}20261009-083011.zip")), "更早的").unwrap();
        let names = |dir: &Path| local_backups(dir).into_iter().map(|b| b.name).collect::<Vec<_>>();
        assert_eq!(
            names(&dir),
            [format!("{base}-2.zip"), format!("{base}.zip"), format!("{DATA_PREFIX}20261009-083011.zip")]
        );
        // 最新的一份是 -2，数据和它一样：过了一天也不备份
        let later = time(8) + chrono::Duration::days(1);
        assert!(matches!(auto(&s, &dir, 10, later, || ()).unwrap(), AutoLocal::Unchanged));
        // 编号按数比，-10 比 -9、-3 新；只留 2 份时删掉的是没有编号的和更早的
        for n in [3, 9, 10] {
            fs::write(dir.join(format!("{base}-{n}.zip")), "x").unwrap();
        }
        assert_eq!(names(&dir)[..3], [format!("{base}-10.zip"), format!("{base}-9.zip"), format!("{base}-3.zip")]);
        prune(&dir, 4);
        assert_eq!(
            names(&dir),
            [format!("{base}-10.zip"), format!("{base}-9.zip"), format!("{base}-3.zip"), format!("{base}-2.zip")]
        );
    }

    /// WebDAV 上的数据备份同样按编号：同一秒里的几份只留最近 1 份时留下编号最大的
    #[test]
    fn remote_same_second_keeps_the_numbered_one() {
        use crate::webdav::RemoteFile;
        let file = |name: &str| RemoteFile { name: name.into(), size: None };
        let list = backup::backups(vec![
            file("TodoList-data-20261009-083012.zip"),
            file("TodoList-data-20261009-083012-2.zip"),
            file("TodoList-data-20261009-083012-10.zip"),
            file("TodoList-settings-20261009-083012.zip"),
        ]);
        assert_eq!(remote_to_prune(&list, 1), ["TodoList-data-20261009-083012-2.zip", "TodoList-data-20261009-083012.zip"]);
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
        let b = |name: &str, kind| RemoteBackup { name: name.into(), size: None, time: 0, seq: 1, kind };
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
