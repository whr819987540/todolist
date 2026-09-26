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
//! ```
//!
//! Markdown 文件是“待办是否存在”的唯一依据：元数据里有但文件不在的条目会被清理，
//! 文件在但元数据里没有的（例如用户手动拷进来的 .md）会被自动补登记。

use chrono::Local;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

pub const META_FILE: &str = ".todos.json";
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
    // 所有读写串行化：操作都很快，且元数据文件需要读-改-写
    lock: Mutex<()>,
}

impl Store {
    pub fn new(root: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            lock: Mutex::new(()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
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
                for t in scan_project(&pdir, false)? {
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
        let _g = self.guard();
        let dir = self.ws_dir(name)?;
        let new_name = normalize_name(new_name, "工作区")?;
        rename_dir(&dir, &self.root, name, &new_name, "工作区")?;
        Ok(new_name)
    }

    pub fn delete_workspace(&self, name: &str) -> Result<()> {
        let _g = self.guard();
        let dir = self.ws_dir(name)?;
        self.move_to_trash(&dir)
    }

    pub fn load_workspace(&self, ws: &str) -> Result<WorkspaceTree> {
        let _g = self.guard();
        let dir = self.ws_dir(ws)?;
        let mut projects = Vec::new();
        for (name, pdir) in list_subdirs(&dir)? {
            projects.push(ProjectNode {
                name,
                todos: scan_project(&pdir, true)?,
            });
        }
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

    // ----- 待办 -----

    pub fn create_todo(&self, ws: &str, project: &str, title: &str) -> Result<TodoSummary> {
        let _g = self.guard();
        let dir = self.project_dir(ws, project)?;
        let mut meta = read_meta(&dir)?;
        let id = unique_id(&dir, &meta);
        let path = dir.join(format!("{id}.md"));
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("创建待办文件失败：{e}"))?;
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
        Ok(summary_of(&entry, now, String::new()))
    }

    pub fn read_todo(&self, ws: &str, project: &str, id: &str) -> Result<TodoDetail> {
        let _g = self.guard();
        let dir = self.project_dir(ws, project)?;
        let path = Self::todo_file(&dir, id)?;
        let (meta, idx) = meta_with_entry(&dir, id)?;
        let bytes = fs::read(&path).map_err(|e| format!("读取待办失败：{e}"))?;
        let content = decode_text(&bytes);
        let mtime = mtime_ms(&path).unwrap_or(0);
        Ok(TodoDetail {
            summary: summary_of(&meta.todos[idx], mtime, make_preview(&content)),
            content,
            path: path.to_string_lossy().into_owned(),
            mtime,
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

    /// 把待办移动到同一工作区下的另一个项目。目标项目里若有同名文件会换一个新 id。
    pub fn move_todo(
        &self,
        ws: &str,
        project: &str,
        id: &str,
        target: &str,
    ) -> Result<TodoSummary> {
        let _g = self.guard();
        let src_dir = self.project_dir(ws, project)?;
        let dst_dir = self.project_dir(ws, target)?;
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

/// 扫描项目目录，把元数据和实际的 .md 文件对齐，返回全部待办摘要
fn scan_project(dir: &Path, with_preview: bool) -> Result<Vec<TodoSummary>> {
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

    let mut changed = false;
    let before = meta.todos.len();
    let mut seen = std::collections::HashSet::new();
    meta.todos
        .retain(|m| files.iter().any(|(id, _, _)| *id == m.id) && seen.insert(m.id.clone()));
    changed |= meta.todos.len() != before;

    for (id, _, md) in &files {
        if meta.find(id).is_some() {
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

    Ok(meta
        .todos
        .iter()
        .map(|m| {
            let (_, path, md) = files.iter().find(|(id, _, _)| *id == m.id).expect("retained above");
            let mtime = to_ms(md.modified()).unwrap_or(0);
            let preview = if with_preview { read_preview(path) } else { String::new() };
            summary_of(m, mtime, preview)
        })
        .collect())
}

/// 读取元数据并定位某条待办；元数据缺这一条时先扫描补登记
fn meta_with_entry(dir: &Path, id: &str) -> Result<(MetaFile, usize)> {
    let meta = read_meta(dir)?;
    if let Some(idx) = meta.find(id) {
        return Ok((meta, idx));
    }
    scan_project(dir, false)?;
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

fn decode_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(strip_bom(bytes)).replace("\r\n", "\n")
}

fn read_preview(path: &Path) -> String {
    let mut buf = Vec::new();
    if let Ok(f) = File::open(path) {
        let _ = f.take(PREVIEW_READ_BYTES).read_to_end(&mut buf);
    }
    let text = String::from_utf8_lossy(strip_bom(&buf));
    // 截断位置可能落在多字节字符中间，丢掉末尾的替换字符
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
    fn workspace_project_todo_roundtrip() {
        let (_tmp, s) = store("roundtrip");
        assert_eq!(s.create_workspace("  工作 空间 ").unwrap(), "工作 空间");
        s.create_project("工作 空间", "项目A").unwrap();
        s.create_project("工作 空间", "项目B").unwrap();

        let t = s.create_todo("工作 空间", "项目A", "买牛奶").unwrap();
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

        let moved = s.move_todo("工作 空间", "项目A", &t.id, "项目B").unwrap();
        assert_eq!(moved.title, "买牛奶");
        assert!(moved.done);
        let d = s.read_todo("工作 空间", "项目B", &moved.id).unwrap();
        assert_eq!(d.content, "# 标题\n- 第一项\n正文");
        assert!(s.read_todo("工作 空间", "项目A", &t.id).is_err());
    }

    #[test]
    fn save_detects_external_change() {
        let (_tmp, s) = store("conflict");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let t = s.create_todo("w", "p", "").unwrap();
        let d = s.read_todo("w", "p", &t.id).unwrap();
        let r = s.save_todo_content("w", "p", &t.id, "x", Some(d.mtime - 1000), false).unwrap();
        assert!(!r.saved);
        let r = s.save_todo_content("w", "p", &t.id, "x", Some(d.mtime - 1000), true).unwrap();
        assert!(r.saved);
        assert_eq!(s.read_todo("w", "p", &t.id).unwrap().content, "x");
    }

    #[test]
    fn scan_reconciles_external_files() {
        let (_tmp, s) = store("scan");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let t = s.create_todo("w", "p", "会被删").unwrap();
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
        let t = s.create_todo("w", "p", "标题").unwrap();
        let dir = s.project_path("w", "p").unwrap();
        fs::write(dir.join(META_FILE), "{ not json").unwrap();
        let tree = s.load_workspace("w").unwrap();
        assert_eq!(tree.projects[0].todos.len(), 1);
        assert_eq!(tree.projects[0].todos[0].id, t.id);
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
