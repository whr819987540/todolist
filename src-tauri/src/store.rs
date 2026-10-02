//! 数据存储层。
//!
//! 目录结构（根目录默认为 `~/TodoList`）：
//!
//! ```text
//! TodoList/
//!   {工作区}/
//!     {项目}/
//!       .todos.json          标题、完成状态、创建/修改时间等元数据
//!       20260926-153012.md   待办正文（Markdown 纯文本）
//!   .state.json              界面状态：上次的位置、各待办的编辑位置等，内容由前端决定
//! ```
//!
//! Markdown 文件是“待办是否存在”的唯一依据：元数据里有但文件不在的条目会被清理，
//! 文件在但元数据里没有的（例如用户手动拷进来的 .md）会被自动补登记。
//!
//! 正文一律按 UTF-8 写入；拷进来的文件可能是 GBK 或带 BOM 的 UTF-16，读取时识别编码，
//! 认不出来的只读，不允许在软件里保存，免得把原文件覆盖成乱码。
//!
//! 左侧列表显示的正文开头（预览）要读每个 .md 的开头，待办多了很慢（窗口每次获得焦点都要重新加载），
//! 所以缓存在内存里，按文件的修改时间和大小判断是否失效；不写进任何文件（数据目录可能用网盘同步，
//! 多写一个文件就多一次同步冲突的机会）。

use chrono::Local;
use encoding_rs::{DecoderResult, Encoding, GB18030, UTF_8};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

pub const META_FILE: &str = ".todos.json";
pub const UI_STATE_FILE: &str = ".state.json";
const TRASH_DIR: &str = ".trash";
const PREVIEW_CHARS: usize = 200;
const PREVIEW_READ_BYTES: u64 = 4096;
const MAX_NAME_CHARS: usize = 64;
const MAX_TITLE_CHARS: usize = 200;

pub type Result<T> = std::result::Result<T, String>;

// ---------------------------------------------------------------------------
// 持久化结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TodoMeta {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    done: bool,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    done_at: Option<i64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct MetaFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    todos: Vec<TodoMeta>,
}

impl MetaFile {
    fn find(&self, id: &str) -> Option<usize> {
        self.todos.iter().position(|t| t.id == id)
    }
}

// ---------------------------------------------------------------------------
// 返回给前端的结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoSummary {
    pub id: String,
    pub title: String,
    /// 正文开头（去掉 Markdown 标记、合并成一行），标题为空时在左侧显示
    pub preview: String,
    pub done: bool,
    pub created_at: i64,
    /// 元数据修改时间与 .md 文件修改时间中较新的一个（外部编辑器改过也能体现）
    pub updated_at: i64,
    pub done_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNode {
    pub name: String,
    pub todos: Vec<TodoSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTree {
    pub name: String,
    pub projects: Vec<ProjectNode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub name: String,
    pub project_count: usize,
    pub todo_count: usize,
    pub done_count: usize,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoDetail {
    pub summary: TodoSummary,
    pub content: String,
    pub path: String,
    /// .md 文件的修改时间，保存时回传用于检测外部修改冲突
    pub mtime: i64,
    /// .md 文件现在的编码；保存后一律变成 UTF-8
    pub encoding: TextEncoding,
}

/// 正文文件的编码
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum TextEncoding {
    #[serde(rename = "UTF-8")]
    Utf8,
    /// 带 BOM 的 UTF-16（记事本里的“Unicode”）
    #[serde(rename = "UTF-16")]
    Utf16,
    /// 中文 Windows 的 ANSI 编码（按兼容 GBK 的 GB18030 解码）
    #[serde(rename = "GBK")]
    Gbk,
    /// 认不出来：尽量显示，但不能在软件里保存
    #[serde(rename = "unknown")]
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    /// false 表示文件在外部被修改过、本次没有写入
    pub saved: bool,
    pub summary: TodoSummary,
    pub mtime: i64,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

pub struct Store {
    root: PathBuf,
    // 所有读写串行化：操作都很快，且元数据文件需要读-改-写。预览缓存也由这把锁保护
    lock: Mutex<PreviewCache>,
}

impl Store {
    pub fn new(root: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            lock: Mutex::new(PreviewCache::default()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn guard(&self) -> MutexGuard<'_, PreviewCache> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ws_dir(&self, ws: &str) -> Result<PathBuf> {
        check_component(ws, "工作区")?;
        let dir = self.root.join(ws);
        if !dir.is_dir() {
            return Err(format!("工作区「{ws}」不存在"));
        }
        Ok(dir)
    }

    fn project_dir(&self, ws: &str, project: &str) -> Result<PathBuf> {
        let ws_dir = self.ws_dir(ws)?;
        check_component(project, "项目")?;
        let dir = ws_dir.join(project);
        if !dir.is_dir() {
            return Err(format!("项目「{project}」不存在"));
        }
        Ok(dir)
    }

    fn todo_file(dir: &Path, id: &str) -> Result<PathBuf> {
        check_component(id, "待办")?;
        let path = dir.join(format!("{id}.md"));
        if !path.is_file() {
            return Err("待办不存在，可能已被删除或移动".into());
        }
        Ok(path)
    }

    // ----- 路径（给“打开 / 在资源管理器中显示”用） -----

    pub fn workspace_path(&self, ws: &str) -> Result<PathBuf> {
        self.ws_dir(ws)
    }

    pub fn project_path(&self, ws: &str, project: &str) -> Result<PathBuf> {
        self.project_dir(ws, project)
    }

    pub fn todo_path(&self, ws: &str, project: &str, id: &str) -> Result<PathBuf> {
        Self::todo_file(&self.project_dir(ws, project)?, id)
    }

    // ----- 工作区 -----

    pub fn list_workspaces(&self) -> Result<Vec<WorkspaceInfo>> {
        let _g = self.guard();
        let mut out = Vec::new();
        for (name, dir) in list_subdirs(&self.root)? {
            let mut info = WorkspaceInfo {
                name,
                project_count: 0,
                todo_count: 0,
                done_count: 0,
                updated_at: mtime_ms(&dir).unwrap_or(0),
            };
            for (_, pdir) in list_subdirs(&dir)? {
                info.project_count += 1;
                for t in scan_project(&pdir, None)? {
                    info.todo_count += 1;
                    info.done_count += t.done as usize;
                    info.updated_at = info.updated_at.max(t.updated_at);
                }
            }
            out.push(info);
        }
        Ok(out)
    }

    pub fn create_workspace(&self, name: &str) -> Result<String> {
        let _g = self.guard();
        let name = normalize_name(name, "工作区")?;
        create_child_dir(&self.root, &name, "工作区")?;
        Ok(name)
    }

    pub fn rename_workspace(&self, name: &str, new_name: &str) -> Result<String> {
        let mut g = self.guard();
        let dir = self.ws_dir(name)?;
        let new_name = normalize_name(new_name, "工作区")?;
        rename_dir(&dir, &self.root, name, &new_name, "工作区")?;
        g.forget_under(&dir);
        Ok(new_name)
    }

    pub fn delete_workspace(&self, name: &str) -> Result<()> {
        let mut g = self.guard();
        let dir = self.ws_dir(name)?;
        self.move_to_trash(&dir)?;
        g.forget_under(&dir);
        Ok(())
    }

    pub fn load_workspace(&self, ws: &str) -> Result<WorkspaceTree> {
        let mut g = self.guard();
        let dir = self.ws_dir(ws)?;
        let mut projects = Vec::new();
        let mut scanned = HashSet::new();
        for (name, pdir) in list_subdirs(&dir)? {
            projects.push(ProjectNode {
                name,
                todos: scan_project(&pdir, Some(&mut g))?,
            });
            scanned.insert(pdir);
        }
        // 已经不在的项目（删除、改名、移走了）不再占着缓存
        g.dirs.retain(|d, _| !d.starts_with(&dir) || scanned.contains(d));
        Ok(WorkspaceTree {
            name: ws.to_string(),
            projects,
        })
    }

    // ----- 项目 -----

    pub fn create_project(&self, ws: &str, name: &str) -> Result<String> {
        let _g = self.guard();
        let dir = self.ws_dir(ws)?;
        let name = normalize_name(name, "项目")?;
        create_child_dir(&dir, &name, "项目")?;
        Ok(name)
    }

    pub fn rename_project(&self, ws: &str, name: &str, new_name: &str) -> Result<String> {
        let _g = self.guard();
        let pdir = self.project_dir(ws, name)?;
        let new_name = normalize_name(new_name, "项目")?;
        rename_dir(&pdir, &self.ws_dir(ws)?, name, &new_name, "项目")?;
        Ok(new_name)
    }

    pub fn delete_project(&self, ws: &str, name: &str) -> Result<()> {
        let _g = self.guard();
        let pdir = self.project_dir(ws, name)?;
        self.move_to_trash(&pdir)
    }

    /// 把项目连同其中的待办移到另一个工作区，项目名不变；目标工作区里已有同名项目时不移动
    pub fn move_project(&self, ws: &str, name: &str, target: &str) -> Result<()> {
        let _g = self.guard();
        let pdir = self.project_dir(ws, name)?;
        let dst_ws = self.ws_dir(target)?;
        if dst_ws == self.ws_dir(ws)? {
            return Err("已经在该工作区中".into());
        }
        // Windows 不区分大小写，exists 也会认出只差大小写的同名项目
        let dst = dst_ws.join(name);
        if dst.exists() {
            return Err(format!("工作区「{target}」中已有同名项目「{name}」"));
        }
        fs::rename(&pdir, &dst).map_err(|e| format!("移动失败，可能有文件正被其他程序占用：{e}"))
    }

    // ----- 待办 -----

    /// 新建待办；content 是正文（新建空白待办时为空）。正文在同一次调用里写好，
    /// 不会出现先有一个空文件、再保存正文的中间状态（外部修改冲突时「另存为新待办」用）
    pub fn create_todo(&self, ws: &str, project: &str, title: &str, content: &str) -> Result<TodoSummary> {
        let _g = self.guard();
        let dir = self.project_dir(ws, project)?;
        let mut meta = read_meta(&dir)?;
        let id = unique_id(&dir, &meta);
        let path = dir.join(format!("{id}.md"));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("创建待办文件失败：{e}"))?;
        if let Err(e) = file.write_all(content.as_bytes()).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(format!("写入待办正文失败：{e}"));
        }
        drop(file);
        let now = now_ms();
        let entry = TodoMeta {
            id,
            title: clean_title(title),
            done: false,
            created_at: now,
            updated_at: now,
            done_at: None,
        };
        meta.todos.push(entry.clone());
        write_meta(&dir, &meta)?;
        Ok(summary_of(&entry, now, make_preview(content)))
    }

    pub fn read_todo(&self, ws: &str, project: &str, id: &str) -> Result<TodoDetail> {
        let _g = self.guard();
        let dir = self.project_dir(ws, project)?;
        let path = Self::todo_file(&dir, id)?;
        let (meta, idx) = meta_with_entry(&dir, id)?;
        let bytes = fs::read(&path).map_err(|e| format!("读取待办失败：{e}"))?;
        let Decoded { text: content, encoding } = decode_text(&bytes, true);
        let mtime = mtime_ms(&path).unwrap_or(0);
        Ok(TodoDetail {
            summary: summary_of(&meta.todos[idx], mtime, make_preview(&content)),
            content,
            path: path.to_string_lossy().into_owned(),
            mtime,
            encoding,
        })
    }

    pub fn save_todo_content(
        &self,
        ws: &str,
        project: &str,
        id: &str,
        content: &str,
        base_mtime: Option<i64>,
        force: bool,
    ) -> Result<SaveResult> {
        let _g = self.guard();
        let dir = self.project_dir(ws, project)?;
        let path = Self::todo_file(&dir, id)?;
        let (meta, idx) = meta_with_entry(&dir, id)?;
        let current = mtime_ms(&path).unwrap_or(0);
        if let (Some(base), false) = (base_mtime, force) {
            if base != current {
                return Ok(SaveResult {
                    saved: false,
                    summary: summary_of(&meta.todos[idx], current, read_preview(&path)),
                    mtime: current,
                });
            }
        }
        // 认不出编码的文件界面上是只读的，这里再挡一次；force 是用户在冲突对话框里明确选了覆盖
        let unknown = fs::read(&path).is_ok_and(|b| decode_text(&b, true).encoding == TextEncoding::Unknown);
        if unknown && !force {
            return Err("正文文件不是 UTF-8 或 GBK 编码，为免损坏原文件不能在这里保存，请用默认程序打开编辑".into());
        }
        atomic_write(&path, content.as_bytes()).map_err(|e| format!("保存失败：{e}"))?;
        let mtime = mtime_ms(&path).unwrap_or_else(now_ms);
        Ok(SaveResult {
            saved: true,
            summary: summary_of(&meta.todos[idx], mtime, make_preview(content)),
            mtime,
        })
    }

    pub fn set_todo_title(
        &self,
        ws: &str,
        project: &str,
        id: &str,
        title: &str,
    ) -> Result<TodoSummary> {
        self.update_meta(ws, project, id, |m| {
            let title = clean_title(title);
            if m.title == title {
                return false;
            }
            m.title = title;
            true
        })
    }

    pub fn set_todo_done(&self, ws: &str, project: &str, id: &str, done: bool) -> Result<TodoSummary> {
        self.update_meta(ws, project, id, |m| {
            if m.done == done {
                return false;
            }
            m.done = done;
            m.done_at = done.then(now_ms);
            true
        })
    }

    /// 修改一条元数据；`f` 返回 true 表示确有改动，此时刷新修改时间并落盘
    fn update_meta(
        &self,
        ws: &str,
        project: &str,
        id: &str,
        f: impl FnOnce(&mut TodoMeta) -> bool,
    ) -> Result<TodoSummary> {
        let _g = self.guard();
        let dir = self.project_dir(ws, project)?;
        let path = Self::todo_file(&dir, id)?;
        let (mut meta, idx) = meta_with_entry(&dir, id)?;
        let entry = &mut meta.todos[idx];
        if f(entry) {
            entry.updated_at = now_ms();
            write_meta(&dir, &meta)?;
        }
        Ok(summary_of(
            &meta.todos[idx],
            mtime_ms(&path).unwrap_or(0),
            read_preview(&path),
        ))
    }

    pub fn delete_todo(&self, ws: &str, project: &str, id: &str) -> Result<()> {
        let _g = self.guard();
        let dir = self.project_dir(ws, project)?;
        let path = Self::todo_file(&dir, id)?;
        self.move_to_trash(&path)?;
        let mut meta = read_meta(&dir)?;
        if let Some(idx) = meta.find(id) {
            meta.todos.remove(idx);
            write_meta(&dir, &meta)?;
        }
        Ok(())
    }

    /// 把待办移动到另一个项目（可以在别的工作区里）。目标项目里若有同名文件会换一个新 id。
    pub fn move_todo(
        &self,
        ws: &str,
        project: &str,
        id: &str,
        target_ws: &str,
        target: &str,
    ) -> Result<TodoSummary> {
        let _g = self.guard();
        let src_dir = self.project_dir(ws, project)?;
        let dst_dir = self.project_dir(target_ws, target)?;
        if src_dir == dst_dir {
            return Err("已经在该项目中".into());
        }
        let src_path = Self::todo_file(&src_dir, id)?;
        let (mut src_meta, idx) = meta_with_entry(&src_dir, id)?;
        let mut dst_meta = read_meta(&dst_dir)?;

        let mut entry = src_meta.todos.remove(idx);
        let mut new_id = entry.id.clone();
        if dst_dir.join(format!("{new_id}.md")).exists() || dst_meta.find(&new_id).is_some() {
            new_id = unique_id(&dst_dir, &dst_meta);
        }
        let dst_path = dst_dir.join(format!("{new_id}.md"));
        fs::rename(&src_path, &dst_path)
            .map_err(|e| format!("移动失败，文件可能正被其他程序占用：{e}"))?;

        entry.id = new_id;
        dst_meta.todos.push(entry.clone());
        // 先写目标再写源：中途失败时最多在目标里留一条重复元数据，下次扫描会自愈
        write_meta(&dst_dir, &dst_meta)?;
        write_meta(&src_dir, &src_meta)?;
        Ok(summary_of(
            &entry,
            mtime_ms(&dst_path).unwrap_or(0),
            read_preview(&dst_path),
        ))
    }

    // ----- 界面状态 -----

    /// 读界面状态文件（内容由前端决定，这里原样读写）；还没有时返回 None
    pub fn read_ui_state(&self) -> Result<Option<String>> {
        let _g = self.guard();
        match fs::read(self.root.join(UI_STATE_FILE)) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(strip_bom(&bytes)).into_owned())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("读取界面状态失败：{e}")),
        }
    }

    pub fn write_ui_state(&self, data: &str) -> Result<()> {
        let _g = self.guard();
        atomic_write(&self.root.join(UI_STATE_FILE), data.as_bytes()).map_err(|e| format!("保存界面状态失败：{e}"))
    }

    // ----- 删除 -----

    /// 优先放进系统回收站；回收站不可用时退而移到数据目录下的 .trash
    fn move_to_trash(&self, path: &Path) -> Result<()> {
        let target = path.to_path_buf();
        // trash 在 Windows 上会初始化 COM，放到全新线程里做，避免和当前线程的 COM 模式冲突
        let recycled = std::thread::spawn(move || trash::delete(&target))
            .join()
            .map(|r| r.is_ok())
            .unwrap_or(false);
        if recycled {
            return Ok(());
        }
        let trash_dir = self.root.join(TRASH_DIR);
        fs::create_dir_all(&trash_dir).map_err(|e| format!("删除失败：{e}"))?;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let dest = trash_dir.join(format!("{}-{name}", Local::now().format("%Y%m%d-%H%M%S%3f")));
        fs::rename(path, dest).map_err(|e| format!("删除失败，可能有文件正被其他程序占用：{e}"))
    }
}

// ---------------------------------------------------------------------------
// 项目扫描与元数据
// ---------------------------------------------------------------------------

/// 预览缓存里的一条：文件的修改时间和大小都没变就直接用
struct CachedPreview {
    stamp: FileStamp,
    preview: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    modified: Option<SystemTime>,
    len: u64,
}

impl FileStamp {
    fn of(md: &fs::Metadata) -> Self {
        Self {
            modified: md.modified().ok(),
            len: md.len(),
        }
    }
}

/// 正文开头（预览）的内存缓存：项目目录 → 待办 id → 预览。
/// 每次扫描一个项目目录后，这个目录只留这次扫到的文件；工作区改名、删除时整个丢掉
#[derive(Default)]
struct PreviewCache {
    dirs: HashMap<PathBuf, HashMap<String, CachedPreview>>,
}

impl PreviewCache {
    fn forget_under(&mut self, dir: &Path) {
        self.dirs.retain(|d, _| !d.starts_with(dir));
    }
}

/// 扫描项目目录，把元数据和实际的 .md 文件对齐，返回全部待办摘要。
/// 给了预览缓存时带上正文开头（文件没变就用缓存的，不重新读），否则预览为空
fn scan_project(dir: &Path, previews: Option<&mut PreviewCache>) -> Result<Vec<TodoSummary>> {
    let mut meta = read_meta(dir)?;

    let mut files: Vec<(String, PathBuf, fs::Metadata)> = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("读取项目目录失败：{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(md) = entry.metadata() else { continue };
        if !md.is_file() || !is_markdown(&path) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if stem.is_empty() || stem.starts_with('.') {
            continue;
        }
        files.push((stem.to_string(), path, md));
    }
    // id → 在 files 里的位置；待办多时逐个比对太慢
    let index: HashMap<String, usize> = files.iter().enumerate().map(|(i, (id, _, _))| (id.clone(), i)).collect();

    let mut changed = false;
    let before = meta.todos.len();
    let mut seen = HashSet::new();
    meta.todos
        .retain(|m| index.contains_key(&m.id) && seen.insert(m.id.clone()));
    changed |= meta.todos.len() != before;

    for (id, _, md) in &files {
        if !seen.insert(id.clone()) {
            continue;
        }
        let modified = to_ms(md.modified()).unwrap_or_else(now_ms);
        let created = to_ms(md.created()).unwrap_or(modified);
        meta.todos.push(TodoMeta {
            id: id.clone(),
            // 自己生成的 id 没有可读性，标题留空让左侧显示正文开头；外部拷进来的文件用文件名当标题
            title: if is_generated_id(id) { String::new() } else { id.clone() },
            done: false,
            created_at: created,
            updated_at: created,
            done_at: None,
        });
        changed = true;
    }
    if changed {
        write_meta(dir, &meta)?;
    }

    let entries: Vec<(&TodoMeta, &PathBuf, &fs::Metadata)> = meta
        .todos
        .iter()
        .map(|m| {
            let (_, path, md) = &files[index[&m.id]];
            (m, path, md)
        })
        .collect();
    let previews_of = match previews {
        None => vec![String::new(); entries.len()],
        Some(cache) => {
            // 这个目录原来缓存的预览；扫完后只留这次扫到的文件
            let mut cached = cache.dirs.remove(dir).unwrap_or_default();
            // 修改时间、大小取自列目录，在读开头之前：读的过程中文件又被改了的话，下次扫描对不上，会重新读
            let stamps: Vec<FileStamp> = entries.iter().map(|(_, _, md)| FileStamp::of(md)).collect();
            let mut out: Vec<Option<String>> = entries
                .iter()
                .zip(&stamps)
                .map(|((m, _, _), stamp)| match cached.remove(&m.id) {
                    Some(c) if c.stamp == *stamp => Some(c.preview),
                    _ => None,
                })
                .collect();
            let missing: Vec<usize> = (0..out.len()).filter(|&i| out[i].is_none()).collect();
            let paths: Vec<&Path> = missing.iter().map(|&i| entries[i].1.as_path()).collect();
            for (i, preview) in missing.into_iter().zip(read_previews(&paths)) {
                out[i] = Some(preview);
            }
            let out: Vec<String> = out.into_iter().map(Option::unwrap_or_default).collect();
            let fresh = entries
                .iter()
                .zip(stamps)
                .zip(&out)
                .map(|(((m, _, _), stamp), preview)| (m.id.clone(), CachedPreview { stamp, preview: preview.clone() }))
                .collect();
            cache.dirs.insert(dir.to_path_buf(), fresh);
            out
        }
    };
    Ok(entries
        .into_iter()
        .zip(previews_of)
        .map(|((m, _, md), preview)| summary_of(m, to_ms(md.modified()).unwrap_or(0), preview))
        .collect())
}

/// 读一批文件的开头生成预览。打开、读文件的时间主要花在等系统（和杀毒软件扫描）上，
/// 刚启动、缓存还是空的时候要读几千个，所以多的时候分给几个线程一起读
fn read_previews(paths: &[&Path]) -> Vec<String> {
    const PARALLEL_MIN: usize = 16;
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(2, 8);
    if paths.len() < PARALLEL_MIN {
        return paths.iter().map(|p| read_preview(p)).collect();
    }
    let chunk = paths.len().div_ceil(threads);
    std::thread::scope(|s| {
        let handles: Vec<_> = paths
            .chunks(chunk)
            .map(|part| s.spawn(move || part.iter().map(|p| read_preview(p)).collect::<Vec<_>>()))
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_else(|_| vec![String::new(); chunk]))
            .collect()
    })
}

/// 读取元数据并定位某条待办；元数据缺这一条时先扫描补登记
fn meta_with_entry(dir: &Path, id: &str) -> Result<(MetaFile, usize)> {
    let meta = read_meta(dir)?;
    if let Some(idx) = meta.find(id) {
        return Ok((meta, idx));
    }
    scan_project(dir, None)?;
    let meta = read_meta(dir)?;
    let idx = meta.find(id).ok_or("待办不存在，可能已被删除或移动")?;
    Ok((meta, idx))
}

fn read_meta(dir: &Path) -> Result<MetaFile> {
    let path = dir.join(META_FILE);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(MetaFile::default()),
        Err(e) => return Err(format!("读取元数据失败：{e}")),
    };
    match serde_json::from_slice::<MetaFile>(strip_bom(&bytes)) {
        Ok(m) => Ok(m),
        Err(_) => {
            // 损坏的元数据留档后重建（正文都在 .md 里，丢的只是标题/完成状态）
            let backup = dir.join(format!("{META_FILE}.broken-{}", Local::now().format("%Y%m%d%H%M%S")));
            let _ = fs::rename(&path, backup);
            Ok(MetaFile::default())
        }
    }
}

fn write_meta(dir: &Path, meta: &MetaFile) -> Result<()> {
    let data = MetaFile {
        version: 1,
        todos: meta.todos.clone(),
    };
    let json = serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?;
    atomic_write(&dir.join(META_FILE), &json).map_err(|e| format!("写入元数据失败：{e}"))
}

fn summary_of(m: &TodoMeta, file_mtime: i64, preview: String) -> TodoSummary {
    TodoSummary {
        id: m.id.clone(),
        title: m.title.clone(),
        preview,
        done: m.done,
        created_at: m.created_at,
        updated_at: m.updated_at.max(file_mtime),
        done_at: m.done_at,
    }
}

/// 生成形如 `20260926-153012` 的 id，同一秒内重复则追加 `-2`、`-3`…
fn unique_id(dir: &Path, meta: &MetaFile) -> String {
    let base = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let taken = |id: &str| meta.find(id).is_some() || dir.join(format!("{id}.md")).exists();
    if !taken(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|id| !taken(id))
        .expect("infinite iterator")
}

fn is_generated_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() >= 15
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'-'
        && b[9..15].iter().all(u8::is_ascii_digit)
        && (b.len() == 15 || (b[15] == b'-' && b.len() > 16 && b[16..].iter().all(u8::is_ascii_digit)))
}

// ---------------------------------------------------------------------------
// 文本处理
// ---------------------------------------------------------------------------

pub(crate) fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)
}

struct Decoded {
    text: String,
    encoding: TextEncoding,
}

/// 识别编码并解码正文：有 BOM 按 BOM，没有就先试 UTF-8、再试 GBK；都不行时尽量解出来并标记为 Unknown。
/// `complete` 为 false 表示 bytes 只是文件开头，末尾可能截在字符中间。
fn decode_text(bytes: &[u8], complete: bool) -> Decoded {
    let bom = Encoding::for_bom(bytes);
    let body = &bytes[bom.map_or(0, |(_, len)| len)..];
    let found = match bom {
        Some((enc, _)) => {
            let kind = if enc == UTF_8 { TextEncoding::Utf8 } else { TextEncoding::Utf16 };
            decode_strict(enc, body, complete).map(|t| (t, kind))
        }
        None => decode_strict(UTF_8, body, complete)
            .map(|t| (t, TextEncoding::Utf8))
            .or_else(|| decode_strict(GB18030, body, complete).map(|t| (t, TextEncoding::Gbk))),
    };
    let (text, encoding) = found.unwrap_or_else(|| {
        let enc = bom.map_or(UTF_8, |(enc, _)| enc);
        (enc.decode_without_bom_handling(body).0.into_owned(), TextEncoding::Unknown)
    });
    Decoded { text: text.replace("\r\n", "\n"), encoding }
}

/// 按指定编码严格解码：有非法字节，或解出了 NUL（正常文本不会有，多半是不带 BOM 的 UTF-16 或二进制文件，
/// GBK 也能把它们“解”成功）都返回 None
fn decode_strict(enc: &'static Encoding, bytes: &[u8], last: bool) -> Option<String> {
    let mut decoder = enc.new_decoder_without_bom_handling();
    let mut out = String::with_capacity(decoder.max_utf8_buffer_length_without_replacement(bytes.len())?);
    match decoder.decode_to_string_without_replacement(bytes, &mut out, last) {
        (DecoderResult::InputEmpty, _) if !out.contains('\0') => Some(out),
        _ => None,
    }
}

fn read_preview(path: &Path) -> String {
    let mut buf = Vec::new();
    if let Ok(f) = File::open(path) {
        let _ = f.take(PREVIEW_READ_BYTES).read_to_end(&mut buf);
    }
    // 读满了说明后面还有内容，截断位置可能落在多字节字符中间
    let text = decode_text(&buf, (buf.len() as u64) < PREVIEW_READ_BYTES).text;
    make_preview(text.trim_end_matches('\u{FFFD}'))
}

/// 取正文开头的若干字符：去掉标题/列表/引用等 Markdown 行首标记，多行合并为一行
pub fn make_preview(text: &str) -> String {
    let mut out = String::new();
    let mut count = 0;
    for line in text.lines() {
        let line = strip_line_marker(line.trim());
        if line.is_empty() || line.starts_with("```") || line.starts_with("---") {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
            count += 1;
        }
        for ch in line.chars() {
            if count >= PREVIEW_CHARS {
                return out;
            }
            out.push(ch);
            count += 1;
        }
    }
    out
}

fn strip_line_marker(mut s: &str) -> &str {
    s = s.trim_start_matches(['#', '>']).trim_start();
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = s.strip_prefix(marker) {
            s = rest.trim_start();
            break;
        }
    }
    let digits = s.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 {
        if let Some(rest) = s[digits..].strip_prefix(". ") {
            s = rest.trim_start();
        }
    }
    for marker in ["[ ] ", "[x] ", "[X] "] {
        if let Some(rest) = s.strip_prefix(marker) {
            s = rest.trim_start();
            break;
        }
    }
    s
}

fn clean_title(title: &str) -> String {
    let one_line: String = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    one_line.trim().chars().take(MAX_TITLE_CHARS).collect()
}

// ---------------------------------------------------------------------------
// 名称校验（Windows 文件名规则）
// ---------------------------------------------------------------------------

const INVALID_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// 访问已有条目时的宽松校验：只防路径穿越和非法字符
fn check_component(name: &str, what: &str) -> Result<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.chars().any(|c| INVALID_CHARS.contains(&c) || c.is_control())
    {
        return Err(format!("无效的{what}名称"));
    }
    Ok(())
}

/// 新建/重命名时的严格校验，返回去掉首尾空白后的名称
pub fn normalize_name(raw: &str, what: &str) -> Result<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(format!("{what}名称不能为空"));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("{what}名称不能超过 {MAX_NAME_CHARS} 个字符"));
    }
    if name.chars().any(|c| INVALID_CHARS.contains(&c) || c.is_control()) {
        return Err(format!("{what}名称不能包含下列字符：\\ / : * ? \" < > |"));
    }
    if name.starts_with('.') || name.ends_with('.') {
        return Err(format!("{what}名称不能以“.”开头或结尾"));
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        return Err(format!("“{name}”是 Windows 保留名称，请换一个"));
    }
    Ok(name.to_string())
}

// ---------------------------------------------------------------------------
// 文件系统辅助
// ---------------------------------------------------------------------------

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// 列出子目录（跳过 . 开头的隐藏目录，例如 .trash）
fn list_subdirs(dir: &Path) -> Result<Vec<(String, PathBuf)>> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败：{e}"))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        out.push((name, entry.path()));
    }
    Ok(out)
}

fn create_child_dir(parent: &Path, name: &str, what: &str) -> Result<()> {
    let dir = parent.join(name);
    if dir.exists() {
        return Err(format!("已存在同名{what}「{name}」"));
    }
    fs::create_dir(&dir).map_err(|e| format!("创建{what}失败：{e}"))
}

fn rename_dir(dir: &Path, parent: &Path, old: &str, new: &str, what: &str) -> Result<()> {
    if old == new {
        return Ok(());
    }
    let target = parent.join(new);
    // Windows 不区分大小写：只改大小写时目标“已存在”的就是自己
    if target.exists() && !old.eq_ignore_ascii_case(new) {
        return Err(format!("已存在同名{what}「{new}」"));
    }
    fs::rename(dir, &target)
        .map_err(|e| format!("重命名失败，可能有文件正被其他程序占用：{e}"))
}

/// 先写临时文件再替换，避免写到一半崩溃留下残缺文件；
/// 目标被其他程序以不允许替换的方式打开时退回直接覆盖写。
pub(crate) fn atomic_write(path: &Path, data: &[u8]) -> io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    fs::write(&tmp, data)?;
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = fs::remove_file(&tmp);
            fs::write(path, data)
        }
    }
}

fn now_ms() -> i64 {
    to_ms(Ok(SystemTime::now())).unwrap_or(0)
}

fn to_ms(t: io::Result<SystemTime>) -> Option<i64> {
    t.ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

fn mtime_ms(path: &Path) -> Option<i64> {
    to_ms(fs::metadata(path).and_then(|m| m.modified()))
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "todolist-test-{tag}-{}-{}",
                std::process::id(),
                now_ms()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn store(tag: &str) -> (TempRoot, Store) {
        let tmp = TempRoot::new(tag);
        let store = Store::new(tmp.0.join("数据")).unwrap();
        (tmp, store)
    }

    #[test]
    fn ui_state_roundtrip() {
        let (_tmp, s) = store("uistate");
        assert_eq!(s.read_ui_state().unwrap(), None);
        let json = r#"{"lastView":{"workspace":"工作"}}"#;
        s.write_ui_state(json).unwrap();
        assert_eq!(s.read_ui_state().unwrap().as_deref(), Some(json));
        // 带 BOM 的（被其他编辑器存过）也认
        fs::write(s.root().join(UI_STATE_FILE), [&[0xEF, 0xBB, 0xBF], json.as_bytes()].concat()).unwrap();
        assert_eq!(s.read_ui_state().unwrap().as_deref(), Some(json));
        // 不会被当成工作区
        assert!(s.list_workspaces().unwrap().is_empty());
    }

    #[test]
    fn workspace_project_todo_roundtrip() {
        let (_tmp, s) = store("roundtrip");
        assert_eq!(s.create_workspace("  工作 空间 ").unwrap(), "工作 空间");
        s.create_project("工作 空间", "项目A").unwrap();
        s.create_project("工作 空间", "项目B").unwrap();

        let t = s.create_todo("工作 空间", "项目A", "买牛奶", "").unwrap();
        assert!(is_generated_id(&t.id));
        assert_eq!(t.title, "买牛奶");

        let d = s.read_todo("工作 空间", "项目A", &t.id).unwrap();
        assert_eq!(d.content, "");
        let r = s
            .save_todo_content("工作 空间", "项目A", &t.id, "# 标题\n- 第一项\n正文", Some(d.mtime), false)
            .unwrap();
        assert!(r.saved);
        assert_eq!(r.summary.preview, "标题 第一项 正文");

        let done = s.set_todo_done("工作 空间", "项目A", &t.id, true).unwrap();
        assert!(done.done && done.done_at.is_some());

        let tree = s.load_workspace("工作 空间").unwrap();
        assert_eq!(tree.projects.len(), 2);
        let a = tree.projects.iter().find(|p| p.name == "项目A").unwrap();
        assert_eq!(a.todos.len(), 1);
        assert_eq!(a.todos[0].preview, "标题 第一项 正文");

        let infos = s.list_workspaces().unwrap();
        assert_eq!(infos.len(), 1);
        assert_eq!((infos[0].project_count, infos[0].todo_count, infos[0].done_count), (2, 1, 1));

        let moved = s.move_todo("工作 空间", "项目A", &t.id, "工作 空间", "项目B").unwrap();
        assert_eq!(moved.title, "买牛奶");
        assert!(moved.done);
        let d = s.read_todo("工作 空间", "项目B", &moved.id).unwrap();
        assert_eq!(d.content, "# 标题\n- 第一项\n正文");
        assert!(s.read_todo("工作 空间", "项目A", &t.id).is_err());
    }

    #[test]
    fn move_project_to_other_workspace() {
        let (_tmp, s) = store("move-project");
        s.create_workspace("甲").unwrap();
        s.create_workspace("乙").unwrap();
        s.create_project("甲", "项目").unwrap();
        s.create_project("甲", "重名").unwrap();
        s.create_project("乙", "重名").unwrap();
        let t = s.create_todo("甲", "项目", "带着走", "").unwrap();
        s.set_todo_done("甲", "项目", &t.id, true).unwrap();

        assert!(s.move_project("甲", "项目", "甲").is_err());
        assert!(s.move_project("甲", "重名", "乙").is_err());
        assert!(s.move_project("甲", "不存在", "乙").is_err());
        assert!(s.move_project("甲", "项目", "丙").is_err());
        s.move_project("甲", "项目", "乙").unwrap();

        let names = |ws: &str| s.load_workspace(ws).unwrap().projects.into_iter().map(|p| p.name).collect::<Vec<_>>();
        assert_eq!(names("甲"), ["重名"]);
        let mut b = names("乙");
        b.sort();
        assert_eq!(b, ["重名", "项目"]);
        let moved = s.read_todo("乙", "项目", &t.id).unwrap();
        assert_eq!((moved.summary.title.as_str(), moved.summary.done), ("带着走", true));
    }

    #[test]
    fn move_todo_to_other_workspace() {
        let (_tmp, s) = store("move-todo");
        s.create_workspace("甲").unwrap();
        s.create_workspace("乙").unwrap();
        s.create_project("甲", "p").unwrap();
        s.create_project("乙", "q").unwrap();
        let t = s.create_todo("甲", "p", "跨工作区", "").unwrap();
        s.save_todo_content("甲", "p", &t.id, "正文", None, false).unwrap();
        // 目标项目里已有同名文件：换一个新 id，标题和正文不变
        fs::write(s.project_path("乙", "q").unwrap().join(format!("{}.md", t.id)), "别的").unwrap();

        assert!(s.move_todo("甲", "p", &t.id, "甲", "p").is_err());
        let moved = s.move_todo("甲", "p", &t.id, "乙", "q").unwrap();
        assert_ne!(moved.id, t.id);
        assert_eq!(moved.title, "跨工作区");
        assert_eq!(s.read_todo("乙", "q", &moved.id).unwrap().content, "正文");
        assert_eq!(s.read_todo("乙", "q", &t.id).unwrap().content, "别的");
        assert!(s.load_workspace("甲").unwrap().projects[0].todos.is_empty());
    }

    #[test]
    fn save_detects_external_change() {
        let (_tmp, s) = store("conflict");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let t = s.create_todo("w", "p", "", "").unwrap();
        let d = s.read_todo("w", "p", &t.id).unwrap();
        let r = s.save_todo_content("w", "p", &t.id, "x", Some(d.mtime - 1000), false).unwrap();
        assert!(!r.saved);
        let r = s.save_todo_content("w", "p", &t.id, "x", Some(d.mtime - 1000), true).unwrap();
        assert!(r.saved);
        assert_eq!(s.read_todo("w", "p", &t.id).unwrap().content, "x");
    }

    #[test]
    fn create_todo_with_content() {
        let (_tmp, s) = store("create-content");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        // 外部修改冲突时「另存为新待办」：原来那条在外部被改了，我这边的正文存成新的一条
        let orig = s.create_todo("w", "p", "周报", "").unwrap();
        let d = s.read_todo("w", "p", &orig.id).unwrap();
        let path = s.todo_path("w", "p", &orig.id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&path, "外部改的").unwrap();
        let mine = "# 我改的\n- 第一项\n";
        assert!(!s.save_todo_content("w", "p", &orig.id, mine, Some(d.mtime), false).unwrap().saved);

        let copy = s.create_todo("w", "p", "周报（我的版本）", mine).unwrap();
        assert_ne!(copy.id, orig.id);
        assert_eq!(copy.title, "周报（我的版本）");
        assert_eq!(copy.preview, "我改的 第一项");
        let read = s.read_todo("w", "p", &copy.id).unwrap();
        assert_eq!(read.content, mine);
        assert_eq!(read.encoding, TextEncoding::Utf8);
        // 两份都在
        assert_eq!(s.read_todo("w", "p", &orig.id).unwrap().content, "外部改的");
        let tree = s.load_workspace("w").unwrap();
        let todos = &tree.projects[0].todos;
        assert_eq!(todos.len(), 2);
        assert!(todos.iter().any(|t| t.id == copy.id && t.title == "周报（我的版本）"));

        // 同一秒里再建一条也不会撞名
        let again = s.create_todo("w", "p", "", mine).unwrap();
        assert!(again.id != copy.id && again.id != orig.id);
        assert_eq!(s.read_todo("w", "p", &again.id).unwrap().content, mine);
    }

    #[test]
    fn create_todo_in_missing_project_writes_nothing() {
        let (_tmp, s) = store("create-missing");
        s.create_workspace("w").unwrap();
        assert!(s.create_todo("w", "不存在", "标题", "正文").is_err());
        assert!(s.list_workspaces().unwrap()[0].todo_count == 0);
    }

    #[test]
    fn scan_reconciles_external_files() {
        let (_tmp, s) = store("scan");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let t = s.create_todo("w", "p", "会被删", "").unwrap();
        let dir = s.project_path("w", "p").unwrap();
        fs::remove_file(dir.join(format!("{}.md", t.id))).unwrap();
        fs::write(dir.join("会议纪要.md"), "\u{feff}周会\r\n内容").unwrap();
        fs::write(dir.join("20250101-080000.md"), "旧文件").unwrap();

        let tree = s.load_workspace("w").unwrap();
        let todos = &tree.projects[0].todos;
        assert_eq!(todos.len(), 2);
        let ext = todos.iter().find(|t| t.id == "会议纪要").unwrap();
        assert_eq!(ext.title, "会议纪要");
        assert_eq!(ext.preview, "周会 内容");
        let gen = todos.iter().find(|t| t.id == "20250101-080000").unwrap();
        assert_eq!(gen.title, "");
        assert_eq!(s.read_todo("w", "p", "会议纪要").unwrap().content, "周会\n内容");
    }

    #[test]
    fn non_utf8_files_are_decoded_or_left_untouched() {
        let (_tmp, s) = store("encoding");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let dir = s.project_path("w", "p").unwrap();
        fs::write(dir.join("gbk.md"), encoding_rs::GBK.encode("# 周会\r\n讨论排期").0).unwrap();
        let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain("待办 A".encode_utf16().flat_map(u16::to_le_bytes)).collect();
        fs::write(dir.join("utf16.md"), utf16).unwrap();
        let broken = b"abc \xff\xfe\xff def".to_vec();
        fs::write(dir.join("broken.md"), &broken).unwrap();

        let tree = s.load_workspace("w").unwrap();
        let preview = |id: &str| tree.projects[0].todos.iter().find(|t| t.id == id).unwrap().preview.clone();
        assert_eq!(preview("gbk"), "周会 讨论排期");
        assert_eq!(preview("utf16"), "待办 A");

        // GBK：正常显示，保存后转成 UTF-8
        let d = s.read_todo("w", "p", "gbk").unwrap();
        assert_eq!((d.content.as_str(), d.encoding), ("# 周会\n讨论排期", TextEncoding::Gbk));
        assert!(s.save_todo_content("w", "p", "gbk", "# 周会\n改过了", Some(d.mtime), false).unwrap().saved);
        assert_eq!(fs::read(dir.join("gbk.md")).unwrap(), "# 周会\n改过了".as_bytes());
        assert_eq!(s.read_todo("w", "p", "gbk").unwrap().encoding, TextEncoding::Utf8);

        assert_eq!(s.read_todo("w", "p", "utf16").unwrap().encoding, TextEncoding::Utf16);

        // 认不出来的：不许覆盖，原文件保持原样
        let d = s.read_todo("w", "p", "broken").unwrap();
        assert_eq!(d.encoding, TextEncoding::Unknown);
        assert!(s.save_todo_content("w", "p", "broken", "x", Some(d.mtime), false).is_err());
        assert_eq!(fs::read(dir.join("broken.md")).unwrap(), broken);
    }

    #[test]
    fn truncated_preview_keeps_encoding() {
        // 预览只读文件开头，截断处落在字符中间时不能误判编码
        let (_tmp, s) = store("preview-cut");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let dir = s.project_path("w", "p").unwrap();
        fs::write(dir.join("utf8.md"), "字".repeat(2000)).unwrap();
        fs::write(dir.join("gbk.md"), encoding_rs::GBK.encode(&format!("a{}", "字".repeat(3000))).0).unwrap();
        let tree = s.load_workspace("w").unwrap();
        let preview = |id: &str| tree.projects[0].todos.iter().find(|t| t.id == id).unwrap().preview.clone();
        assert_eq!(preview("utf8"), "字".repeat(PREVIEW_CHARS));
        assert_eq!(preview("gbk"), format!("a{}", "字".repeat(PREVIEW_CHARS - 1)));
    }

    #[test]
    fn rename_and_name_rules() {
        let (_tmp, s) = store("rename");
        s.create_workspace("w").unwrap();
        assert!(s.create_workspace("w").is_err());
        assert!(s.create_workspace("a/b").is_err());
        assert!(s.create_workspace("CON").is_err());
        assert!(s.create_workspace("com1.txt").is_err());
        assert!(s.create_workspace(".hidden").is_err());
        assert!(s.create_workspace("   ").is_err());
        assert!(s.load_workspace("..").is_err());
        assert!(s.load_workspace("../x").is_err());
        s.create_project("w", "p").unwrap();
        s.rename_project("w", "p", "P").unwrap();
        assert_eq!(s.load_workspace("w").unwrap().projects[0].name, "P");
        s.rename_workspace("w", "新名字").unwrap();
        assert!(s.load_workspace("新名字").is_ok());
    }

    #[test]
    fn corrupt_meta_is_rebuilt() {
        let (_tmp, s) = store("corrupt");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let t = s.create_todo("w", "p", "标题", "").unwrap();
        let dir = s.project_path("w", "p").unwrap();
        fs::write(dir.join(META_FILE), "{ not json").unwrap();
        let tree = s.load_workspace("w").unwrap();
        assert_eq!(tree.projects[0].todos.len(), 1);
        assert_eq!(tree.projects[0].todos[0].id, t.id);
    }

    #[test]
    fn preview_cache_follows_external_changes() {
        let (_tmp, s) = store("preview-cache");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let t = s.create_todo("w", "p", "", "").unwrap();
        s.save_todo_content("w", "p", &t.id, "第一版", None, false).unwrap();
        let dir = s.project_path("w", "p").unwrap();
        let file = dir.join(format!("{}.md", t.id));
        let preview = |id: &str| {
            let tree = s.load_workspace("w").unwrap();
            tree.projects[0].todos.iter().find(|x| x.id == id).map(|x| x.preview.clone())
        };
        assert_eq!(preview(&t.id).as_deref(), Some("第一版"));

        // 外部编辑器改了正文（长度变了）
        fs::write(&file, "外部改过的第二版").unwrap();
        assert_eq!(preview(&t.id).as_deref(), Some("外部改过的第二版"));

        // 长度没变、只有修改时间变了，也要重新读
        let old_time = fs::metadata(&file).unwrap().modified().unwrap();
        fs::write(&file, "外部改过的第三版").unwrap();
        let f = File::options().write(true).open(&file).unwrap();
        f.set_modified(old_time + std::time::Duration::from_secs(5)).unwrap();
        drop(f);
        assert_eq!(preview(&t.id).as_deref(), Some("外部改过的第三版"));

        // 修改时间和大小都没变时用缓存，不重新读文件（证明缓存确实生效）
        let same_time = fs::metadata(&file).unwrap().modified().unwrap();
        fs::write(&file, "外部改过的第四版").unwrap();
        let f = File::options().write(true).open(&file).unwrap();
        f.set_modified(same_time).unwrap();
        drop(f);
        assert_eq!(preview(&t.id).as_deref(), Some("外部改过的第三版"));

        // 在软件里保存：文件变了，预览跟着变
        s.save_todo_content("w", "p", &t.id, "# 软件里保存的", None, true).unwrap();
        assert_eq!(preview(&t.id).as_deref(), Some("软件里保存的"));

        // 往项目文件夹里放进来的 .md 有预览；删掉的文件不再出现，也不再占着缓存
        fs::write(dir.join("拷进来的.md"), "新文件的内容").unwrap();
        assert_eq!(preview("拷进来的").as_deref(), Some("新文件的内容"));
        fs::remove_file(dir.join("拷进来的.md")).unwrap();
        assert_eq!(preview("拷进来的"), None);
        assert!(!s.guard().dirs[&dir].contains_key("拷进来的"));

        // 删掉后又放进来同名、内容不同的文件
        fs::write(dir.join("拷进来的.md"), "又放进来的").unwrap();
        assert_eq!(preview("拷进来的").as_deref(), Some("又放进来的"));
    }

    #[test]
    fn many_previews_are_read_in_parallel_and_matched() {
        // 缓存是空的、要读的文件多时分给几个线程读：每条待办拿到的是自己文件的预览
        let (_tmp, s) = store("preview-many");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let dir = s.project_path("w", "p").unwrap();
        for i in 0..53 {
            fs::write(dir.join(format!("笔记{i:02}.md")), format!("# 第 {i} 条\n正文 {i}")).unwrap();
        }
        let check = |s: &Store| {
            let tree = s.load_workspace("w").unwrap();
            assert_eq!(tree.projects[0].todos.len(), 53);
            for t in &tree.projects[0].todos {
                let i: u32 = t.id.trim_start_matches("笔记").parse().unwrap();
                assert_eq!(t.preview, format!("第 {i} 条 正文 {i}"));
            }
        };
        check(&s);
        // 改了其中一部分（超过一个线程的量）再读：改了的重新读，没改的用缓存
        for i in (0..53).step_by(2) {
            fs::write(dir.join(format!("笔记{i:02}.md")), format!("# 第 {i} 条\n正文 {i}（改过）")).unwrap();
        }
        let tree = s.load_workspace("w").unwrap();
        for t in &tree.projects[0].todos {
            let i: u32 = t.id.trim_start_matches("笔记").parse().unwrap();
            let suffix = if i % 2 == 0 { "（改过）" } else { "" };
            assert_eq!(t.preview, format!("第 {i} 条 正文 {i}{suffix}"));
        }
        // 新的 Store（刚启动）照样读得对
        let s2 = Store::new(s.root().to_path_buf()).unwrap();
        assert_eq!(s2.load_workspace("w").unwrap().projects[0].todos.len(), 53);
    }

    #[test]
    fn preview_cache_forgets_renamed_and_deleted() {
        let (_tmp, s) = store("preview-forget");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        s.create_project("w", "q").unwrap();
        let t = s.create_todo("w", "p", "", "").unwrap();
        s.save_todo_content("w", "p", &t.id, "正文", None, false).unwrap();
        s.load_workspace("w").unwrap();
        assert_eq!(s.guard().dirs.len(), 2);

        // 项目改名：新名字下照样有预览，旧目录不再占着缓存
        s.rename_project("w", "p", "p2").unwrap();
        let tree = s.load_workspace("w").unwrap();
        let p2 = tree.projects.iter().find(|p| p.name == "p2").unwrap();
        assert_eq!(p2.todos[0].preview, "正文");
        assert!(s.guard().dirs.keys().all(|d| !d.ends_with("p")));

        // 工作区改名：旧工作区下的都丢掉
        s.rename_workspace("w", "w2").unwrap();
        assert!(s.guard().dirs.is_empty());
        assert_eq!(s.load_workspace("w2").unwrap().projects.len(), 2);
        assert_eq!(s.guard().dirs.len(), 2);
    }

    /// 性能测量：`TODOLIST_BENCH_DIR=<测试数据目录> cargo test --profile release-fast --lib bench_scan -- --ignored --nocapture`。
    /// 只读不写（数据和元数据一致时扫描不会写盘）
    #[test]
    #[ignore]
    fn bench_scan() {
        use std::time::Instant;
        let dir = std::env::var("TODOLIST_BENCH_DIR").expect("TODOLIST_BENCH_DIR");
        let s = Store::new(PathBuf::from(dir)).unwrap();
        let time = |label: &str, f: &dyn Fn()| {
            let mut runs = Vec::new();
            for _ in 0..5 {
                let t = Instant::now();
                f();
                runs.push(t.elapsed().as_secs_f64() * 1000.0);
            }
            let rest = &runs[1..];
            let avg = rest.iter().sum::<f64>() / rest.len() as f64;
            println!("{label}: 第一次 {:.1} ms，之后平均 {avg:.1} ms（{runs:.1?}）", runs[0]);
        };
        let names: Vec<String> = s.list_workspaces().unwrap().into_iter().map(|w| w.name).collect();
        time("list_workspaces", &|| {
            s.list_workspaces().unwrap();
        });
        time(&format!("load_workspace ×{}", names.len()), &|| {
            for n in &names {
                s.load_workspace(n).unwrap();
            }
        });
        // 预览缓存是空的（刚启动）：每次换一个新的 Store
        let root = s.root().to_path_buf();
        time(&format!("load_workspace ×{}（缓存是空的）", names.len()), &|| {
            let fresh = Store::new(root.clone()).unwrap();
            for n in &names {
                fresh.load_workspace(n).unwrap();
            }
        });
        let tree = s.load_workspace(&names[0]).unwrap();
        let todos: usize = tree.projects.iter().map(|p| p.todos.len()).sum();
        let json = serde_json::to_vec(&tree).unwrap();
        println!("一个工作区：{} 个项目、{todos} 条待办，序列化后 {} KB", tree.projects.len(), json.len() / 1024);
    }

    #[test]
    fn preview_strips_markers() {
        assert_eq!(make_preview("## 计划\n\n1. 写代码\n- [x] 测试\n> 引用"), "计划 写代码 测试 引用");
        assert_eq!(make_preview(&"字".repeat(500)).chars().count(), PREVIEW_CHARS);
        assert!(is_generated_id("20260926-153012"));
        assert!(is_generated_id("20260926-153012-2"));
        assert!(!is_generated_id("20260926-153012-"));
        assert!(!is_generated_id("notes"));
    }
}
