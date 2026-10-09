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
//!       {子项目}/            项目文件夹里的子文件夹是子项目，里面同样是 .todos.json 和 .md（只有一层子项目）
//!   .state.json              界面状态：上次的位置、各待办的编辑位置等，内容由前端决定
//!   .recycle/                软件的回收站：删除的工作区、项目、待办先放在这里，可以恢复
//!     {条目 id}/entry.json   原来在哪里、标题和完成状态等
//!     {条目 id}/{原名}       删除的 .md 文件或目录
//! ```
//!
//! 接口里的项目用路径表示：顶层项目是它的名字，子项目是「父项目/子项目」（名字里不能有 /，不会混淆）。
//!
//! Markdown 文件是“待办是否存在”的唯一依据：元数据里有但文件不在的条目会被清理，
//! 文件在但元数据里没有的（例如用户手动拷进来的 .md）会被自动补登记。
//!
//! 正文一律按 UTF-8 写入；拷进来的文件可能是 GBK 或带 BOM 的 UTF-16，读取时识别编码，
//! 认不出来的只读，不允许在软件里保存，免得把原文件覆盖成乱码。
//!
//! 左侧列表显示的正文开头（预览）要读每个 .md 的开头，待办多了很慢（窗口每次获得焦点都要重新加载），
//! 所以缓存在内存里，按文件的修改时间和大小判断是否失效；全文搜索用的正文全文同样缓存在内存里。
//! 都不写进任何文件（数据目录可能用网盘同步，多写一个文件就多一次同步冲突的机会）。

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
pub const RECYCLE_DIR: &str = ".recycle";
const ENTRY_FILE: &str = "entry.json";
/// 软件回收站里放了这么多天的，移到系统回收站
pub const RECYCLE_KEEP_DAYS: i64 = 30;
const PREVIEW_CHARS: usize = 200;
const PREVIEW_READ_BYTES: u64 = 4096;
const MAX_NAME_CHARS: usize = 64;
const MAX_TITLE_CHARS: usize = 200;
/// 全文搜索最多返回这么多条
const MAX_SEARCH_HITS: usize = 2000;
/// 全文搜索的结果里，命中处前后各带多少个字
const SNIPPET_BEFORE: usize = 16;
const SNIPPET_AFTER: usize = 60;

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
    /// 置顶：在列表里排在最前面（已完成的仍排在未完成的后面）
    #[serde(default, skip_serializing_if = "is_false")]
    pinned: bool,
    /// 手动排序时的位置（从小到大）；没拖动排过的（新建的、移过来的）没有，手动排序时排在最前面
    #[serde(default, skip_serializing_if = "Option::is_none")]
    order: Option<i64>,
}

fn is_false(v: &bool) -> bool {
    !v
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
    pub pinned: bool,
    /// 手动排序时的位置，没排过的为 null
    pub order: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNode {
    /// 项目路径：顶层项目是名字，子项目是「父项目/子项目」
    pub name: String,
    /// 只是这个项目自己的待办，不含子项目的
    pub todos: Vec<TodoSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTree {
    pub name: String,
    /// 全部项目：每个顶层项目后面跟着它的子项目
    pub projects: Vec<ProjectNode>,
}

/// 一个工作区里的项目路径（快速记录选择存到哪里时用，不读待办），子项目跟在它的父项目后面
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjects {
    pub name: String,
    pub projects: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub name: String,
    /// 顶层项目的个数（子项目不另算）
    pub project_count: usize,
    /// 待办数，包括子项目里的
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

/// 全文搜索命中的一条待办（正文里有关键字）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub workspace: String,
    pub project: String,
    pub id: String,
    /// 正文里第一处命中附近的一段，合并成一行，前后被截掉的地方加省略号
    pub snippet: String,
}

/// 软件回收站里一项是什么
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecycleKind {
    Todo,
    Project,
    Workspace,
}

/// 回收站里每一项的说明（entry.json）
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecycleFile {
    kind: RecycleKind,
    /// 原来在哪个工作区（删除的是工作区时是它自己）
    workspace: String,
    /// 原来在哪个项目（项目路径，子项目是「父项目/子项目」；删除的是项目时是它自己；删除工作区时没有）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    /// 删除的文件 / 目录在这一项里的名字（原来的名字；子项目是它自己的名字，不带父项目）
    name: String,
    deleted_at: i64,
    /// 删除的待办的标题、完成状态等，恢复时还原
    #[serde(default, skip_serializing_if = "Option::is_none")]
    todo: Option<TodoMeta>,
    /// 删除的待办的正文开头，没有标题时显示
    #[serde(default)]
    preview: String,
    /// 删除的项目、工作区里有几条待办
    #[serde(default)]
    todo_count: usize,
    /// 移到系统回收站的时间：从系统回收站还原回来的，按它重新算 30 天，不按删除时间（否则下次启动又被移走）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    purged_at: Option<i64>,
}

impl RecycleFile {
    fn new(kind: RecycleKind, workspace: &str, project: Option<&str>, name: &str, todo_count: usize) -> Self {
        Self {
            kind,
            workspace: workspace.into(),
            project: project.map(Into::into),
            name: name.into(),
            deleted_at: now_ms(),
            todo: None,
            preview: String::new(),
            todo_count,
            purged_at: None,
        }
    }
}

/// 回收站列表里的一项
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecycleEntry {
    pub id: String,
    pub kind: RecycleKind,
    pub workspace: String,
    pub project: Option<String>,
    /// 待办的标题（没有标题时为空，显示 preview）、项目名或工作区名
    pub title: String,
    pub preview: String,
    pub done: bool,
    pub deleted_at: i64,
    /// 项目、工作区里有几条待办
    pub todo_count: usize,
}

/// 恢复到了哪里
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub kind: RecycleKind,
    pub workspace: String,
    pub project: Option<String>,
    /// 恢复的待办现在的 id（文件名被占用时换了一个）
    pub todo_id: Option<String>,
    /// 项目、工作区原来的名字被占用了，改了名（加「（恢复）」）
    pub renamed: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored: Vec<Restored>,
    /// 没恢复成的原因
    pub errors: Vec<String>,
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
    // 所有读写串行化：操作都很快，且元数据文件需要读-改-写。预览和全文的缓存也由这把锁保护
    lock: Mutex<MemCache>,
}

impl Store {
    pub fn new(root: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            lock: Mutex::new(MemCache::default()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn guard(&self) -> MutexGuard<'_, MemCache> {
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

    /// 项目（或子项目，路径是「父项目/子项目」）的目录
    fn project_dir(&self, ws: &str, project: &str) -> Result<PathBuf> {
        let ws_dir = self.ws_dir(ws)?;
        let dir = project_parts(project)?.iter().fold(ws_dir, |d, p| d.join(p));
        if !dir.is_dir() {
            return Err(format!("项目「{}」不存在", project_label(project)));
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
            for (project, pdir) in project_dirs(&dir)? {
                info.project_count += !project.contains(PROJECT_SEP) as usize;
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

    /// 全部工作区和其中的项目路径（包括子项目），只列目录
    pub fn list_projects(&self) -> Result<Vec<WorkspaceProjects>> {
        let _g = self.guard();
        list_subdirs(&self.root)?
            .into_iter()
            .map(|(name, dir)| {
                let projects = project_dirs(&dir)?.into_iter().map(|(p, _)| p).collect();
                Ok(WorkspaceProjects { name, projects })
            })
            .collect()
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

    /// 放进软件的回收站，返回回收站里这一项的 id（撤销删除时用）
    pub fn delete_workspace(&self, name: &str) -> Result<String> {
        let mut g = self.guard();
        let dir = self.ws_dir(name)?;
        let mut count = 0;
        for (_, pdir) in project_dirs(&dir)? {
            count += markdown_files(&pdir)?.len();
        }
        let id = self.recycle(&dir, RecycleFile::new(RecycleKind::Workspace, name, None, name, count))?;
        g.forget_under(&dir);
        Ok(id)
    }

    pub fn load_workspace(&self, ws: &str) -> Result<WorkspaceTree> {
        let mut g = self.guard();
        let dir = self.ws_dir(ws)?;
        let mut projects = Vec::new();
        let mut scanned = HashSet::new();
        for (name, pdir) in project_dirs(&dir)? {
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

    /// 在顶层项目 parent 里新建子项目，返回子项目的路径（「父项目/子项目」）
    pub fn create_sub_project(&self, ws: &str, parent: &str, name: &str) -> Result<String> {
        let _g = self.guard();
        if parent.contains(PROJECT_SEP) {
            return Err("子项目里不能再建子项目".into());
        }
        let dir = self.project_dir(ws, parent)?;
        let name = normalize_name(name, "子项目")?;
        create_child_dir(&dir, &name, "子项目")?;
        Ok(format!("{parent}{PROJECT_SEP}{name}"))
    }

    /// 改项目（或子项目）自己的名字，返回改名后的路径；子项目改名后还在原来的父项目里
    pub fn rename_project(&self, ws: &str, project: &str, new_name: &str) -> Result<String> {
        let _g = self.guard();
        let pdir = self.project_dir(ws, project)?;
        let (parent, name) = split_project(project);
        let what = if parent.is_some() { "子项目" } else { "项目" };
        let new_name = normalize_name(new_name, what)?;
        let parent_dir = pdir.parent().ok_or("无效的项目名称")?;
        rename_dir(&pdir, parent_dir, name, &new_name, what)?;
        Ok(join_project(parent, &new_name))
    }

    /// 放进软件的回收站（顶层项目连同它的子项目），返回回收站里这一项的 id
    pub fn delete_project(&self, ws: &str, project: &str) -> Result<String> {
        let mut g = self.guard();
        let pdir = self.project_dir(ws, project)?;
        let (parent, name) = split_project(project);
        let mut count = markdown_files(&pdir)?.len();
        if parent.is_none() {
            for (_, sdir) in list_subdirs(&pdir)? {
                count += markdown_files(&sdir)?.len();
            }
        }
        let id = self.recycle(&pdir, RecycleFile::new(RecycleKind::Project, ws, Some(project), name, count))?;
        g.forget_under(&pdir);
        Ok(id)
    }

    /// 把项目（或子项目）连同其中的待办移到工作区 target 的顶层（parent 为 None），或者放进它的顶层项目 parent 里
    /// 成为子项目；名字不变，返回移过去后的路径。只有一层子项目：有子项目的项目不能放进别的项目。
    /// 那里已有同名项目时不移动
    pub fn move_project(&self, ws: &str, project: &str, target: &str, parent: Option<&str>) -> Result<String> {
        let _g = self.guard();
        let pdir = self.project_dir(ws, project)?;
        let (_, name) = split_project(project);
        let dst_parent = match parent {
            None => self.ws_dir(target)?,
            Some(p) if p.contains(PROJECT_SEP) => return Err("子项目里不能再放项目".into()),
            Some(p) => self.project_dir(target, p)?,
        };
        if dst_parent.starts_with(&pdir) {
            return Err("不能移到它自己里面".into());
        }
        if Some(dst_parent.as_path()) == pdir.parent() {
            return Err(if parent.is_some() { "已经在该项目中" } else { "已经在该工作区中" }.into());
        }
        if parent.is_some() && !list_subdirs(&pdir)?.is_empty() {
            return Err(format!("「{name}」里有子项目，不能放进别的项目（子项目里不能再有子项目）"));
        }
        // Windows 不区分大小写，exists 也会认出只差大小写的同名项目
        let dst = dst_parent.join(name);
        if dst.exists() {
            return Err(match parent {
                Some(p) => format!("项目「{p}」中已有同名子项目「{name}」"),
                None => format!("工作区「{target}」中已有同名项目「{name}」"),
            });
        }
        fs::rename(&pdir, &dst).map_err(|e| format!("移动失败，可能有文件正被其他程序占用：{e}"))?;
        Ok(join_project(parent, name))
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
            pinned: false,
            order: None,
        };
        meta.todos.push(entry.clone());
        write_meta(&dir, &meta)?;
        Ok(summary_of(&entry, now, make_preview(content)))
    }

    /// 快速记录：第一行当标题、其余当正文，存成工作区 ws 的项目 project（可以是子项目）里的一条新待办；
    /// 工作区、项目不在时先建
    pub fn quick_capture(&self, ws: &str, project: &str, text: &str) -> Result<TodoSummary> {
        let (title, content) = split_quick_note(text);
        if title.is_empty() && content.is_empty() {
            return Err("没有要记的内容".into());
        }
        let ws = normalize_name(ws, "工作区")?;
        let project = normalize_project_path(project)?;
        {
            let _g = self.guard();
            let dir = project.split(PROJECT_SEP).fold(self.root.join(&ws), |d, p| d.join(p));
            if !dir.is_dir() {
                fs::create_dir_all(&dir)
                    .map_err(|e| format!("创建项目「{}」失败：{e}", project_label(&project)))?;
            }
        }
        self.create_todo(&ws, &project, &title, &content)
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
        let mut g = self.guard();
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
        // 很快地连着保存两次、长度又一样时，修改时间和大小可能都没变，缓存认不出来，这里直接丢掉
        g.forget_todo(&dir, id);
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

    /// 置顶 / 取消置顶。只是在列表里的位置，不算修改了这条待办，修改时间不变
    pub fn set_todo_pinned(&self, ws: &str, project: &str, id: &str, pinned: bool) -> Result<TodoSummary> {
        self.change_meta(ws, project, id, false, |m| {
            let changed = m.pinned != pinned;
            m.pinned = pinned;
            changed
        })
    }

    /// 手动排序：ids 是项目里待办从前到后的顺序，依次记下位置；没列出的（排序期间新建的）去掉位置，排在最前面。
    /// 不算修改，修改时间不变
    pub fn reorder_todos(&self, ws: &str, project: &str, ids: &[String]) -> Result<()> {
        let _g = self.guard();
        let dir = self.project_dir(ws, project)?;
        let mut meta = read_meta(&dir)?;
        let index: HashMap<&str, i64> = ids.iter().enumerate().map(|(i, id)| (id.as_str(), i as i64)).collect();
        let mut changed = false;
        for m in &mut meta.todos {
            let order = index.get(m.id.as_str()).copied();
            changed |= m.order != order;
            m.order = order;
        }
        if changed {
            write_meta(&dir, &meta)?;
        }
        Ok(())
    }

    /// 修改一条元数据；`f` 返回 true 表示确有改动，此时刷新修改时间并落盘
    fn update_meta(
        &self,
        ws: &str,
        project: &str,
        id: &str,
        f: impl FnOnce(&mut TodoMeta) -> bool,
    ) -> Result<TodoSummary> {
        self.change_meta(ws, project, id, true, f)
    }

    /// 修改一条元数据；`f` 返回 true 表示确有改动，此时落盘，touch 为 true 时同时刷新修改时间
    fn change_meta(
        &self,
        ws: &str,
        project: &str,
        id: &str,
        touch: bool,
        f: impl FnOnce(&mut TodoMeta) -> bool,
    ) -> Result<TodoSummary> {
        let _g = self.guard();
        let dir = self.project_dir(ws, project)?;
        let path = Self::todo_file(&dir, id)?;
        let (mut meta, idx) = meta_with_entry(&dir, id)?;
        let entry = &mut meta.todos[idx];
        if f(entry) {
            if touch {
                entry.updated_at = now_ms();
            }
            write_meta(&dir, &meta)?;
        }
        Ok(summary_of(
            &meta.todos[idx],
            mtime_ms(&path).unwrap_or(0),
            read_preview(&path),
        ))
    }

    /// 放进软件的回收站（连同标题、完成状态等，恢复时还原），返回回收站里这一项的 id
    pub fn delete_todo(&self, ws: &str, project: &str, id: &str) -> Result<String> {
        let mut g = self.guard();
        let dir = self.project_dir(ws, project)?;
        let path = Self::todo_file(&dir, id)?;
        let (mut meta, idx) = meta_with_entry(&dir, id)?;
        let mut file = RecycleFile::new(RecycleKind::Todo, ws, Some(project), &format!("{id}.md"), 0);
        file.todo = Some(meta.todos[idx].clone());
        file.preview = read_preview(&path);
        let rid = self.recycle(&path, file)?;
        meta.todos.remove(idx);
        write_meta(&dir, &meta)?;
        g.forget_todo(&dir, id);
        Ok(rid)
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
        // 在目标项目里还没排过位置，手动排序时排在最前面
        entry.order = None;
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

    // ----- 全文搜索 -----

    /// 在正文全文里查找关键字（不区分大小写），返回正文里有关键字的待办和命中处附近的一段。
    /// workspaces 为 None 时查全部工作区；不存在的工作区跳过。标题由前端自己匹配，这里只查正文
    pub fn search(&self, workspaces: Option<&[String]>, keyword: &str) -> Result<Vec<SearchHit>> {
        let needle = fold(keyword.trim());
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let mut g = self.guard();
        let list = match workspaces {
            Some(names) => names.iter().filter_map(|ws| Some((ws.clone(), self.ws_dir(ws).ok()?))).collect(),
            None => list_subdirs(&self.root)?,
        };
        let mut hits = Vec::new();
        // 读不了的工作区、项目（正在外部被删、被占用）跳过，不让整个搜索失败
        for (workspace, ws_dir) in list {
            let Ok(projects) = project_dirs(&ws_dir) else { continue };
            for (project, pdir) in projects {
                let Ok(texts) = g.project_texts(&pdir) else { continue };
                for (id, text) in texts {
                    if hits.len() >= MAX_SEARCH_HITS {
                        return Ok(hits);
                    }
                    if let Some(at) = text.folded.find(&needle) {
                        hits.push(SearchHit {
                            workspace: workspace.clone(),
                            project: project.clone(),
                            id,
                            snippet: snippet(&text, at, needle.chars().count()),
                        });
                    }
                }
            }
        }
        Ok(hits)
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

    // ----- 软件的回收站 -----

    fn recycle_root(&self) -> PathBuf {
        self.root.join(RECYCLE_DIR)
    }

    /// 把 path（待办的 .md、项目或工作区的目录）连同说明放进回收站，返回这一项的 id。
    /// 先写说明再移文件，移不动（被别的程序占用）时什么都不留
    fn recycle(&self, path: &Path, file: RecycleFile) -> Result<String> {
        let root = self.recycle_root();
        fs::create_dir_all(&root).map_err(|e| format!("删除失败：{e}"))?;
        let base = Local::now().format("%Y%m%d-%H%M%S-%3f").to_string();
        let id = (1..)
            .map(|n| if n == 1 { base.clone() } else { format!("{base}-{n}") })
            .find(|id| !root.join(id).exists())
            .expect("infinite iterator");
        let dir = root.join(&id);
        let json = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        let written = fs::create_dir(&dir).and_then(|_| fs::write(dir.join(ENTRY_FILE), json));
        if let Err(e) = written {
            let _ = fs::remove_dir_all(&dir);
            return Err(format!("删除失败：{e}"));
        }
        if let Err(e) = fs::rename(path, dir.join(&file.name)) {
            let _ = fs::remove_dir_all(&dir);
            return Err(format!("删除失败，可能有文件正被其他程序占用：{e}"));
        }
        Ok(id)
    }

    /// 回收站里的东西，最近删除的在前
    pub fn list_recycle(&self) -> Result<Vec<RecycleEntry>> {
        let _g = self.guard();
        let mut out: Vec<RecycleEntry> = self
            .recycle_entries()?
            .into_iter()
            .map(|(id, f)| RecycleEntry {
                title: match &f.todo {
                    Some(t) => t.title.clone(),
                    None => f.name.clone(),
                },
                done: f.todo.as_ref().is_some_and(|t| t.done),
                id,
                kind: f.kind,
                workspace: f.workspace,
                project: f.project,
                preview: f.preview,
                deleted_at: f.deleted_at,
                todo_count: f.todo_count,
            })
            .collect();
        out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then_with(|| b.id.cmp(&a.id)));
        Ok(out)
    }

    /// 回收站里的各项（id 和说明）；说明读不出来、删除的东西已经不在的跳过
    fn recycle_entries(&self) -> Result<Vec<(String, RecycleFile)>> {
        let root = self.recycle_root();
        if !root.is_dir() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in fs::read_dir(&root).map_err(|e| format!("读取回收站失败：{e}"))?.flatten() {
            let Some(id) = entry.file_name().to_str().map(str::to_string) else { continue };
            if let Some(f) = read_recycle_file(&entry.path()) {
                out.push((id, f));
            }
        }
        Ok(out)
    }

    /// 恢复到原来的位置。原来的工作区、项目已经不在时重新建；项目、工作区原来的名字被占用时改名（加「（恢复）」）；
    /// 待办的 id（文件名）被占用时换一个。一项失败不影响其他的
    pub fn restore(&self, ids: &[String]) -> RestoreResult {
        let mut g = self.guard();
        let mut result = RestoreResult::default();
        for id in ids {
            match self.restore_one(&mut g, id) {
                Ok(r) => result.restored.push(r),
                Err(e) => result.errors.push(e),
            }
        }
        result
    }

    fn restore_one(&self, g: &mut MemCache, id: &str) -> Result<Restored> {
        check_component(id, "回收站里的项")?;
        let dir = self.recycle_root().join(id);
        let gone = || "回收站里已经没有这一项，可能已经恢复或彻底删除了".to_string();
        let f = read_recycle_file(&dir).ok_or_else(gone)?;
        let payload = dir.join(&f.name);
        check_component(&f.workspace, "工作区")?;
        let restored = match f.kind {
            RecycleKind::Todo => {
                let project = f.project.clone().ok_or_else(gone)?;
                let pdir = project_parts(&project)?.iter().fold(self.root.join(&f.workspace), |d, p| d.join(p));
                fs::create_dir_all(&pdir).map_err(|e| format!("恢复失败：{e}"))?;
                let mut meta = read_meta(&pdir)?;
                let stem = f.name.strip_suffix(".md").unwrap_or(&f.name).to_string();
                let mut todo = f.todo.clone().unwrap_or_else(|| {
                    let now = now_ms();
                    TodoMeta {
                        id: stem.clone(),
                        title: if is_generated_id(&stem) { String::new() } else { stem.clone() },
                        done: false,
                        created_at: now,
                        updated_at: now,
                        done_at: None,
                        pinned: false,
                        order: None,
                    }
                });
                let mut new_id = stem;
                if pdir.join(format!("{new_id}.md")).exists() || meta.find(&new_id).is_some() {
                    new_id = unique_id(&pdir, &meta);
                }
                fs::rename(&payload, pdir.join(format!("{new_id}.md"))).map_err(|e| format!("恢复失败：{e}"))?;
                todo.id = new_id.clone();
                // 原来排的位置在别的待办调整过顺序后不一定还对，当成新来的排在最前面
                todo.order = None;
                meta.todos.push(todo);
                write_meta(&pdir, &meta)?;
                g.forget_todo(&pdir, &new_id);
                Restored {
                    kind: f.kind,
                    workspace: f.workspace.clone(),
                    project: Some(project),
                    todo_id: Some(new_id),
                    renamed: false,
                }
            }
            RecycleKind::Project => {
                // 子项目恢复到原来的父项目里（父项目不在了重新建）；以前的版本记的项目没有父项目
                let parent = match f.project.as_deref().map(split_project) {
                    Some((Some(p), _)) => Some(p),
                    _ => None,
                };
                let mut dir = self.root.join(&f.workspace);
                if let Some(p) = parent {
                    check_component(p, "项目")?;
                    dir = dir.join(p);
                }
                fs::create_dir_all(&dir).map_err(|e| format!("恢复失败：{e}"))?;
                let (name, renamed) = free_name(&dir, &f.name);
                fs::rename(&payload, dir.join(&name)).map_err(|e| format!("恢复失败：{e}"))?;
                g.forget_under(&dir.join(&name));
                let project = Some(join_project(parent, &name));
                Restored { kind: f.kind, workspace: f.workspace.clone(), project, todo_id: None, renamed }
            }
            RecycleKind::Workspace => {
                let (name, renamed) = free_name(&self.root, &f.name);
                fs::rename(&payload, self.root.join(&name)).map_err(|e| format!("恢复失败：{e}"))?;
                g.forget_under(&self.root.join(&name));
                Restored { kind: f.kind, workspace: name, project: None, todo_id: None, renamed }
            }
        };
        let _ = fs::remove_dir_all(&dir);
        Ok(restored)
    }

    /// 彻底删除：从软件的回收站移到系统回收站，返回移走了几项
    pub fn purge(&self, ids: &[String]) -> Result<usize> {
        let _g = self.guard();
        let mut n = 0;
        for id in ids {
            check_component(id, "回收站里的项")?;
            let dir = self.recycle_root().join(id);
            if self.purge_dir(&dir)? {
                n += 1;
            }
        }
        Ok(n)
    }

    /// 清空软件的回收站（都移到系统回收站）
    pub fn empty_recycle(&self) -> Result<usize> {
        let ids: Vec<String> = {
            let _g = self.guard();
            self.recycle_entries()?.into_iter().map(|(id, _)| id).collect()
        };
        self.purge(&ids)
    }

    /// 放了超过 days 天的移到系统回收站（启动时调用），返回移走了几项
    pub fn purge_expired(&self, days: i64) -> Result<usize> {
        let cutoff = now_ms() - days * 86_400_000;
        let ids: Vec<String> = {
            let _g = self.guard();
            self.recycle_entries()?
                .into_iter()
                .filter(|(_, f)| f.purged_at.unwrap_or(f.deleted_at) < cutoff)
                .map(|(id, _)| id)
                .collect()
        };
        self.purge(&ids)
    }

    /// 把回收站里的一项连同说明整个移到系统回收站：从系统回收站还原时回到软件的回收站，还能从那里恢复到原来的位置。
    /// 先把目录改成看得懂的名字（标题或名称加上 id），在系统回收站里认得出是什么；这一项不在时返回 false
    fn purge_dir(&self, dir: &Path) -> Result<bool> {
        let Some(mut f) = read_recycle_file(dir) else {
            return Ok(false);
        };
        f.purged_at = Some(now_ms());
        if let Ok(json) = serde_json::to_vec_pretty(&f) {
            let _ = fs::write(dir.join(ENTRY_FILE), json);
        }
        let id = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let readable = dir.with_file_name(readable_entry_name(&f, &id));
        let target = if readable != dir && !readable.exists() && fs::rename(dir, &readable).is_ok() {
            readable
        } else {
            dir.to_path_buf()
        };
        self.move_to_trash(&target)?;
        Ok(true)
    }

    // ----- 删除 -----

    /// 优先放进系统回收站；回收站不可用时退而移到数据目录下的 .trash。
    /// 单元测试里不碰系统回收站（Linux 上会真的放进用户的回收站），直接移到 .trash
    fn move_to_trash(&self, path: &Path) -> Result<()> {
        let target = path.to_path_buf();
        // trash 在 Windows 上会初始化 COM，放到全新线程里做，避免和当前线程的 COM 模式冲突
        let recycled = !cfg!(test)
            && std::thread::spawn(move || trash::delete(&target))
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

/// 全文缓存里的一条：文件的修改时间和大小都没变就直接用
struct CachedText {
    stamp: FileStamp,
    /// 正文（按识别出的编码解码，换行统一成 \n）
    text: String,
    /// 逐字转成小写的正文，字数和 text 一样，用来不区分大小写地查找
    folded: String,
}

/// 内存缓存。dirs：正文开头（预览），项目目录 → 待办 id → 预览；texts：全文搜索用的正文全文，项目目录 → 待办 id → 全文。
/// 每次扫描（搜索）一个项目目录后，这个目录只留这次扫到的文件；工作区改名、删除时整个丢掉
#[derive(Default)]
struct MemCache {
    dirs: HashMap<PathBuf, HashMap<String, CachedPreview>>,
    texts: HashMap<PathBuf, HashMap<String, CachedText>>,
}

impl MemCache {
    fn forget_under(&mut self, dir: &Path) {
        self.dirs.retain(|d, _| !d.starts_with(dir));
        self.texts.retain(|d, _| !d.starts_with(dir));
    }

    /// 项目目录 dir 里的一条待办的正文变了
    fn forget_todo(&mut self, dir: &Path, id: &str) {
        if let Some(m) = self.dirs.get_mut(dir) {
            m.remove(id);
        }
        if let Some(m) = self.texts.get_mut(dir) {
            m.remove(id);
        }
    }

    /// 项目里每条待办的正文全文（待办 id → 全文）：文件没变的用缓存，变了的、新的重新读，多的时候并行读
    fn project_texts(&mut self, dir: &Path) -> Result<Vec<(String, &CachedText)>> {
        let files = markdown_files(dir)?;
        let mut cached = self.texts.remove(dir).unwrap_or_default();
        let mut fresh: HashMap<String, CachedText> = HashMap::with_capacity(files.len());
        let mut missing = Vec::new();
        for (id, path, md) in &files {
            let stamp = FileStamp::of(md);
            match cached.remove(id) {
                Some(c) if c.stamp == stamp => {
                    fresh.insert(id.clone(), c);
                }
                _ => missing.push((id, path.as_path(), stamp)),
            }
        }
        let paths: Vec<&Path> = missing.iter().map(|(_, p, _)| *p).collect();
        for ((id, _, stamp), text) in missing.iter().zip(read_all(&paths, read_text)) {
            let folded = fold(&text);
            fresh.insert((*id).clone(), CachedText { stamp: *stamp, text, folded });
        }
        let texts = self.texts.entry(dir.to_path_buf()).or_insert(fresh);
        Ok(files.into_iter().filter_map(|(id, _, _)| texts.get(&id).map(|t| (id, t))).collect())
    }
}

/// 扫描项目目录，把元数据和实际的 .md 文件对齐，返回全部待办摘要。
/// 给了预览缓存时带上正文开头（文件没变就用缓存的，不重新读），否则预览为空
fn scan_project(dir: &Path, previews: Option<&mut MemCache>) -> Result<Vec<TodoSummary>> {
    let mut meta = read_meta(dir)?;
    let files = markdown_files(dir)?;
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
            pinned: false,
            order: None,
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

/// 读回收站里一项的说明；读不出来，或删除的东西已经不在时返回 None
fn read_recycle_file(dir: &Path) -> Option<RecycleFile> {
    let bytes = fs::read(dir.join(ENTRY_FILE)).ok()?;
    let f: RecycleFile = serde_json::from_slice(strip_bom(&bytes)).ok()?;
    // 名字是原来的文件 / 目录名，不能带路径
    check_component(&f.name, "回收站里的项").ok()?;
    dir.join(&f.name).exists().then_some(f)
}

/// 回收站里一项移到系统回收站时用的目录名：待办的标题（没有时用正文开头）、项目名或工作区名，加上 id（保证不重名）。
/// 不能用在文件名里的字符换成 _，太长的截短
fn readable_entry_name(f: &RecycleFile, id: &str) -> String {
    let label = match &f.todo {
        Some(t) if !t.title.trim().is_empty() => t.title.clone(),
        Some(_) if !f.preview.is_empty() => f.preview.clone(),
        Some(_) => "空白待办".into(),
        None => f.name.clone(),
    };
    let label: String = label
        .chars()
        .map(|c| if INVALID_CHARS.contains(&c) || c.is_control() { '_' } else { c })
        .take(40)
        .collect();
    let label = label.trim().trim_start_matches('.').trim_end_matches(['.', ' ']);
    if label.is_empty() {
        id.to_string()
    } else {
        format!("{label}（{id}）")
    }
}

/// 在 parent 里恢复名为 name 的目录用的名字：被占用时加「（恢复）」「（恢复 2）」…；返回名字和是否改了名
fn free_name(parent: &Path, name: &str) -> (String, bool) {
    if !parent.join(name).exists() {
        return (name.to_string(), false);
    }
    let name = (1..)
        .map(|n| if n == 1 { format!("{name}（恢复）") } else { format!("{name}（恢复 {n}）") })
        .find(|n| !parent.join(n).exists())
        .expect("infinite iterator");
    (name, true)
}

/// 项目目录里的正文文件：(待办 id, 路径, 文件信息)；跳过 . 开头的（保存时的临时文件等）
fn markdown_files(dir: &Path) -> Result<Vec<(String, PathBuf, fs::Metadata)>> {
    let mut files = Vec::new();
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
    Ok(files)
}

/// 读一批文件的开头生成预览
fn read_previews(paths: &[&Path]) -> Vec<String> {
    read_all(paths, read_preview)
}

/// 逐个文件调用 read，结果和 paths 一一对应。打开、读文件的时间主要花在等系统（和杀毒软件扫描）上，
/// 刚启动、缓存还是空的时候要读几千个，所以多的时候分给几个线程一起读
fn read_all<T: Send + Clone + Default>(paths: &[&Path], read: fn(&Path) -> T) -> Vec<T> {
    const PARALLEL_MIN: usize = 16;
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(2, 8);
    if paths.len() < PARALLEL_MIN {
        return paths.iter().map(|p| read(p)).collect();
    }
    let chunk = paths.len().div_ceil(threads);
    std::thread::scope(|s| {
        let handles: Vec<_> = paths
            .chunks(chunk)
            .map(|part| (part.len(), s.spawn(move || part.iter().map(|p| read(p)).collect::<Vec<_>>())))
            .collect();
        handles
            .into_iter()
            .flat_map(|(len, h)| h.join().unwrap_or_else(|_| vec![T::default(); len]))
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
        pinned: m.pinned,
        order: m.order,
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

/// 全文搜索用：读整个正文（识别编码），读不了的当成空的
fn read_text(path: &Path) -> String {
    fs::read(path).map(|b| decode_text(&b, true).text).unwrap_or_default()
}

/// 不区分大小写地比较时用的写法：逐字转成小写。转小写后变成好几个字的（极少见）保持原样，
/// 这样转换前后字数一样，查到的位置能对回原文
fn fold(text: &str) -> String {
    text.chars()
        .map(|c| {
            let mut lower = c.to_lowercase();
            match (lower.next(), lower.next()) {
                (Some(l), None) => l,
                _ => c,
            }
        })
        .collect()
}

/// 全文搜索的结果里显示的一段：命中处（folded 里的字节位置 at，关键字 len 个字）前后各带一些字，
/// 空白（含换行）合并成一个空格，前后被截掉的地方加省略号
fn snippet(t: &CachedText, at: usize, len: usize) -> String {
    let start = t.folded[..at].chars().count();
    let from = start.saturating_sub(SNIPPET_BEFORE);
    let to = start + len + SNIPPET_AFTER;
    let mut out = String::new();
    if from > 0 {
        out.push('…');
    }
    let mut space = false;
    for c in t.text.chars().skip(from).take(to - from) {
        if c.is_whitespace() {
            space = true;
            continue;
        }
        if space && !out.is_empty() && !out.ends_with('…') {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    if t.text.chars().nth(to).is_some() {
        out.push('…');
    }
    out
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

/// 快速记录的一段文字拆成标题和正文：第一行（跳过开头的空行）当标题，其余当正文（去掉开头的空行和结尾的空白）；
/// 第一行比标题的长度上限还长时，整段都当正文、标题留空（左侧显示正文开头）
pub fn split_quick_note(text: &str) -> (String, String) {
    let text = text.replace("\r\n", "\n");
    let mut lines = text.lines().skip_while(|l| l.trim().is_empty());
    let Some(first) = lines.next() else {
        return (String::new(), String::new());
    };
    let first = first.trim();
    if first.chars().count() > MAX_TITLE_CHARS {
        return (String::new(), text.trim().to_string());
    }
    let body: Vec<&str> = lines.skip_while(|l| l.trim().is_empty()).collect();
    (clean_title(first), body.join("\n").trim_end().to_string())
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
// 项目路径：顶层项目是名字，子项目是「父项目/子项目」（只有一层子项目）
// ---------------------------------------------------------------------------

/// 项目路径里父项目和子项目之间的分隔符；名字里不能有它，不会和名字混淆
pub const PROJECT_SEP: char = '/';

/// 访问已有项目时拆开路径：一级（顶层项目）或两级（子项目），每级只防路径穿越和非法字符
fn project_parts(project: &str) -> Result<Vec<&str>> {
    let parts: Vec<&str> = project.split(PROJECT_SEP).collect();
    if parts.len() > 2 {
        return Err("无效的项目名称".into());
    }
    for p in &parts {
        check_component(p, "项目")?;
    }
    Ok(parts)
}

/// 拆成父项目（顶层项目没有）和它自己的名字；不校验
fn split_project(project: &str) -> (Option<&str>, &str) {
    match project.split_once(PROJECT_SEP) {
        Some((parent, name)) => (Some(parent), name),
        None => (None, project),
    }
}

fn join_project(parent: Option<&str>, name: &str) -> String {
    match parent {
        Some(p) => format!("{p}{PROJECT_SEP}{name}"),
        None => name.to_string(),
    }
}

/// 提示里的项目路径：父项目 / 子项目
fn project_label(project: &str) -> String {
    project.replace(PROJECT_SEP, " / ")
}

/// 新建、设置（快速记录存到哪里）时的严格校验：每一级按 normalize_name，返回规整后的路径
pub fn normalize_project_path(raw: &str) -> Result<String> {
    let parts: Vec<&str> = raw.split(PROJECT_SEP).collect();
    if parts.len() > 2 {
        return Err("子项目里不能再有子项目".into());
    }
    let parts = parts.into_iter().map(|p| normalize_name(p, "项目")).collect::<Result<Vec<_>>>()?;
    Ok(parts.join(&PROJECT_SEP.to_string()))
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

/// 工作区里的全部项目（路径和目录）：每个顶层项目后面跟着它的子项目（项目文件夹里的子文件夹）。
/// 子项目里再有文件夹不算（只有一层子项目）
fn project_dirs(ws_dir: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    for (name, dir) in list_subdirs(ws_dir)? {
        let subs: Vec<_> = list_subdirs(&dir)?
            .into_iter()
            .map(|(sub, sdir)| (format!("{name}{PROJECT_SEP}{sub}"), sdir))
            .collect();
        out.push((name, dir));
        out.extend(subs);
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
    fn pin_keeps_updated_time_and_moves_along() {
        let (_tmp, s) = store("pin");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        s.create_project("w", "q").unwrap();
        let t = s.create_todo("w", "p", "置顶的", "").unwrap();
        assert!(!t.pinned);
        let pinned = s.set_todo_pinned("w", "p", &t.id, true).unwrap();
        assert!(pinned.pinned);
        // 置顶不算修改了这条待办
        assert_eq!(pinned.updated_at, t.updated_at);
        let text = fs::read_to_string(s.project_path("w", "p").unwrap().join(META_FILE)).unwrap();
        assert!(text.contains(r#""pinned": true"#), "{text}");
        // 移到别的项目后还是置顶的
        let moved = s.move_todo("w", "p", &t.id, "w", "q").unwrap();
        assert!(moved.pinned);
        assert!(!s.set_todo_pinned("w", "q", &moved.id, false).unwrap().pinned);
        // 没置顶的不写这一项，以前的 .todos.json 照样读
        let text = fs::read_to_string(s.project_path("w", "q").unwrap().join(META_FILE)).unwrap();
        assert!(!text.contains("pinned"), "{text}");
    }

    #[test]
    fn reorder_keeps_updated_time() {
        let (_tmp, s) = store("reorder");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        s.create_project("w", "q").unwrap();
        let a = s.create_todo("w", "p", "a", "").unwrap();
        let b = s.create_todo("w", "p", "b", "").unwrap();
        let c = s.create_todo("w", "p", "c", "").unwrap();
        s.reorder_todos("w", "p", &[c.id.clone(), a.id.clone()]).unwrap();
        let orders = |ws: &str, p: &str| {
            let tree = s.load_workspace(ws).unwrap();
            let todos = &tree.projects.iter().find(|x| x.name == p).unwrap().todos;
            todos.iter().map(|t| (t.title.clone(), t.order, t.updated_at)).collect::<Vec<_>>()
        };
        let p = orders("w", "p");
        let get = |title: &str| p.iter().find(|x| x.0 == title).unwrap().clone();
        assert_eq!(get("c").1, Some(0));
        assert_eq!(get("a").1, Some(1));
        // 没列出的没有位置
        assert_eq!(get("b").1, None);
        // 不改修改时间
        assert_eq!(get("a").2, a.updated_at);
        assert_eq!(get("b").2, b.updated_at);
        // 移到别的项目后没有位置
        let moved = s.move_todo("w", "p", &a.id, "w", "q").unwrap();
        assert_eq!(moved.order, None);
        assert!(s.reorder_todos("w", "不存在", &[]).is_err());
    }

    #[test]
    fn deleted_todo_is_restored_with_its_metadata() {
        let (_tmp, s) = store("recycle-todo");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let t = s.create_todo("w", "p", "周报", "# 正文\n内容").unwrap();
        s.set_todo_done("w", "p", &t.id, true).unwrap();
        s.set_todo_pinned("w", "p", &t.id, true).unwrap();
        let before = s.load_workspace("w").unwrap().projects[0].todos[0].clone();

        let rid = s.delete_todo("w", "p", &t.id).unwrap();
        assert!(s.load_workspace("w").unwrap().projects[0].todos.is_empty());
        // 在软件的回收站里，不会被当成工作区，也不会被搜到
        assert_eq!(s.list_workspaces().unwrap().len(), 1);
        assert!(s.search(None, "内容").unwrap().is_empty());
        let list = s.list_recycle().unwrap();
        assert_eq!(list.len(), 1);
        let e = &list[0];
        assert_eq!((e.id.as_str(), e.kind, e.title.as_str(), e.done), (rid.as_str(), RecycleKind::Todo, "周报", true));
        assert_eq!((e.workspace.as_str(), e.project.as_deref()), ("w", Some("p")));
        assert_eq!(e.preview, "正文 内容");

        let r = s.restore(std::slice::from_ref(&rid));
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(r.restored[0].todo_id.as_deref(), Some(t.id.as_str()));
        let after = &s.load_workspace("w").unwrap().projects[0].todos[0];
        assert_eq!((after.title.as_str(), after.done, after.pinned), ("周报", true, true));
        assert_eq!((after.created_at, after.done_at), (before.created_at, before.done_at));
        assert_eq!(s.read_todo("w", "p", &t.id).unwrap().content, "# 正文\n内容");
        assert!(s.list_recycle().unwrap().is_empty());
        // 已经恢复过的再恢复：说明没有了
        assert_eq!(s.restore(&[rid]).errors.len(), 1);
    }

    #[test]
    fn restore_todo_when_place_is_gone_or_taken() {
        let (_tmp, s) = store("recycle-gone");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let t = s.create_todo("w", "p", "旧的", "旧正文").unwrap();
        let rid = s.delete_todo("w", "p", &t.id).unwrap();
        // 同名文件又出现了（同一秒新建、外部拷进来）：换一个 id
        fs::write(s.project_path("w", "p").unwrap().join(format!("{}.md", t.id)), "新文件").unwrap();
        let r = s.restore(&[rid]);
        let new_id = r.restored[0].todo_id.clone().unwrap();
        assert_ne!(new_id, t.id);
        assert_eq!(s.read_todo("w", "p", &new_id).unwrap().content, "旧正文");
        assert_eq!(s.read_todo("w", "p", &t.id).unwrap().content, "新文件");

        // 原来的项目、工作区都删掉了：恢复时重新建
        let rid = s.delete_todo("w", "p", &new_id).unwrap();
        let pid = s.delete_project("w", "p").unwrap();
        let wid = s.delete_workspace("w").unwrap();
        let r = s.restore(&[rid]);
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let tree = s.load_workspace("w").unwrap();
        assert_eq!(tree.projects[0].name, "p");
        assert_eq!(tree.projects[0].todos[0].title, "旧的");
        // 再恢复原来的项目、工作区：名字被占用了，加「（恢复）」
        let r = s.restore(&[pid, wid]);
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(r.restored[0].project.as_deref(), Some("p（恢复）"));
        assert!(r.restored[0].renamed);
        assert_eq!(r.restored[1].workspace, "w（恢复）");
        let mut names: Vec<String> = s.list_workspaces().unwrap().into_iter().map(|w| w.name).collect();
        names.sort();
        assert_eq!(names, ["w", "w（恢复）"]);
        // 恢复的项目回到了 w 里（里面是后来外部放进去的那条），删工作区时它已经是空的
        let tree = s.load_workspace("w").unwrap();
        let restored = tree.projects.iter().find(|p| p.name == "p（恢复）").unwrap();
        assert_eq!(restored.todos.len(), 1);
        assert!(s.load_workspace("w（恢复）").unwrap().projects.is_empty());
    }

    #[test]
    fn deleted_project_and_workspace_come_back_whole() {
        let (_tmp, s) = store("recycle-dirs");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let t = s.create_todo("w", "p", "带着走", "").unwrap();
        s.set_todo_done("w", "p", &t.id, true).unwrap();
        s.create_todo("w", "p", "第二条", "").unwrap();

        let pid = s.delete_project("w", "p").unwrap();
        let e = &s.list_recycle().unwrap()[0];
        assert_eq!((e.kind, e.title.as_str(), e.todo_count), (RecycleKind::Project, "p", 2));
        assert!(s.load_workspace("w").unwrap().projects.is_empty());
        let r = s.restore(&[pid]);
        assert!(!r.restored[0].renamed);
        let todos = &s.load_workspace("w").unwrap().projects[0].todos;
        assert!(todos.iter().any(|x| x.title == "带着走" && x.done));

        let wid = s.delete_workspace("w").unwrap();
        assert!(s.list_workspaces().unwrap().is_empty());
        let e = &s.list_recycle().unwrap()[0];
        assert_eq!((e.kind, e.title.as_str(), e.todo_count), (RecycleKind::Workspace, "w", 2));
        s.restore(&[wid]);
        assert_eq!(s.load_workspace("w").unwrap().projects[0].todos.len(), 2);
    }

    #[test]
    fn purge_moves_to_system_trash() {
        let (_tmp, s) = store("recycle-purge");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let a = s.create_todo("w", "p", "a", "").unwrap();
        let b = s.create_todo("w", "p", "b", "").unwrap();
        let c = s.create_todo("w", "p", "c", "").unwrap();
        let ra = s.delete_todo("w", "p", &a.id).unwrap();
        let rb = s.delete_todo("w", "p", &b.id).unwrap();
        let rc = s.delete_todo("w", "p", &c.id).unwrap();
        // 列表里最近删除的在前
        let ids: Vec<String> = s.list_recycle().unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, [rc.clone(), rb.clone(), ra.clone()]);

        assert_eq!(s.purge(std::slice::from_ref(&ra)).unwrap(), 1);
        assert_eq!(s.list_recycle().unwrap().len(), 2);
        // 单元测试里「系统回收站」是数据目录下的 .trash。连同说明整个移过去，名字看得出是哪条
        let trashed: Vec<PathBuf> = fs::read_dir(s.root().join(TRASH_DIR)).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(trashed.len(), 1);
        let name = trashed[0].file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.contains(&format!("a（{ra}）")), "{name}");
        assert!(trashed[0].join(ENTRY_FILE).is_file());
        assert!(trashed[0].join(format!("{}.md", a.id)).is_file());
        // 从系统回收站还原（放回 .recycle）后，又出现在软件的回收站里，还能恢复到原来的位置
        let back = s.root().join(RECYCLE_DIR).join(&name[name.find('a').unwrap()..].replace('/', "_"));
        fs::rename(&trashed[0], &back).unwrap();
        let listed = s.list_recycle().unwrap();
        let again = listed.iter().find(|e| e.title == "a").unwrap();
        let r = s.restore(std::slice::from_ref(&again.id));
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(s.read_todo("w", "p", &a.id).is_ok());

        // 放了超过 30 天的移走
        let entry = s.root().join(RECYCLE_DIR).join(&rb).join(ENTRY_FILE);
        let mut f: RecycleFile = serde_json::from_slice(&fs::read(&entry).unwrap()).unwrap();
        f.deleted_at -= (RECYCLE_KEEP_DAYS + 1) * 86_400_000;
        fs::write(&entry, serde_json::to_vec(&f).unwrap()).unwrap();
        assert_eq!(s.purge_expired(RECYCLE_KEEP_DAYS).unwrap(), 1);
        let left: Vec<String> = s.list_recycle().unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(left, [rc]);

        assert_eq!(s.empty_recycle().unwrap(), 1);
        assert!(s.list_recycle().unwrap().is_empty());
        assert_eq!(fs::read_dir(s.root().join(TRASH_DIR)).unwrap().count(), 2);
        // 名字里带路径的不认
        assert!(s.purge(&["../w".into()]).is_err());
    }

    #[test]
    fn restored_from_system_trash_is_not_expired_again() {
        let (_tmp, s) = store("recycle-again");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let t = s.create_todo("w", "p", "老的", "").unwrap();
        let rid = s.delete_todo("w", "p", &t.id).unwrap();
        let entry = s.root().join(RECYCLE_DIR).join(&rid).join(ENTRY_FILE);
        let mut f: RecycleFile = serde_json::from_slice(&fs::read(&entry).unwrap()).unwrap();
        f.deleted_at -= (RECYCLE_KEEP_DAYS + 1) * 86_400_000;
        fs::write(&entry, serde_json::to_vec(&f).unwrap()).unwrap();
        assert_eq!(s.purge_expired(RECYCLE_KEEP_DAYS).unwrap(), 1);
        // 从系统回收站（单元测试里是 .trash）还原回 .recycle：记着移走的时间，下次启动不会又被移走
        let trashed = fs::read_dir(s.root().join(TRASH_DIR)).unwrap().next().unwrap().unwrap().path();
        fs::rename(&trashed, s.root().join(RECYCLE_DIR).join("还原回来的")).unwrap();
        assert_eq!(s.purge_expired(RECYCLE_KEEP_DAYS).unwrap(), 0);
        assert_eq!(s.list_recycle().unwrap()[0].title, "老的");
    }

    #[test]
    fn readable_names_for_system_trash() {
        let mut f = RecycleFile::new(RecycleKind::Project, "w", Some("需求: 开发?"), "需求: 开发?", 0);
        assert_eq!(readable_entry_name(&f, "1"), "需求_ 开发_（1）");
        f.todo = Some(TodoMeta {
            id: "x".into(),
            title: "  ".into(),
            done: false,
            created_at: 0,
            updated_at: 0,
            done_at: None,
            pinned: false,
            order: None,
        });
        f.preview = "正文开头".repeat(20);
        assert_eq!(readable_entry_name(&f, "2"), format!("{}（2）", "正文开头".repeat(10)));
        f.preview.clear();
        assert_eq!(readable_entry_name(&f, "3"), "空白待办（3）");
        let ws = RecycleFile::new(RecycleKind::Workspace, ".隐藏", None, "...", 0);
        assert_eq!(readable_entry_name(&ws, "4"), "4");
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

        assert!(s.move_project("甲", "项目", "甲", None).is_err());
        assert!(s.move_project("甲", "重名", "乙", None).is_err());
        assert!(s.move_project("甲", "不存在", "乙", None).is_err());
        assert!(s.move_project("甲", "项目", "丙", None).is_err());
        assert_eq!(s.move_project("甲", "项目", "乙", None).unwrap(), "项目");

        let names = |ws: &str| s.load_workspace(ws).unwrap().projects.into_iter().map(|p| p.name).collect::<Vec<_>>();
        assert_eq!(names("甲"), ["重名"]);
        let mut b = names("乙");
        b.sort();
        assert_eq!(b, ["重名", "项目"]);
        let moved = s.read_todo("乙", "项目", &t.id).unwrap();
        assert_eq!((moved.summary.title.as_str(), moved.summary.done), ("带着走", true));
    }

    fn project_names(s: &Store, ws: &str) -> Vec<String> {
        s.load_workspace(ws).unwrap().projects.into_iter().map(|p| p.name).collect()
    }

    #[test]
    fn sub_projects_are_folders_in_the_project() {
        let (_tmp, s) = store("sub-projects");
        s.create_workspace("w").unwrap();
        s.create_project("w", "需求").unwrap();
        s.create_project("w", "日常").unwrap();
        assert_eq!(s.create_sub_project("w", "需求", " 前端 ").unwrap(), "需求/前端");
        assert_eq!(s.create_sub_project("w", "需求", "后端").unwrap(), "需求/后端");
        // 只有一层子项目；重名（不分大小写）、父项目不在的建不了
        assert!(s.create_sub_project("w", "需求/前端", "组件").is_err());
        assert!(s.create_sub_project("w", "需求", "前端").is_err());
        assert!(s.create_sub_project("w", "不存在", "x").is_err());
        assert!(s.create_sub_project("w", "需求", "a/b").is_err());
        assert!(s.root().join("w/需求/前端").is_dir());

        // 父项目自己也能放待办；子项目的待办和读写、标记完成、移动都按路径
        let own = s.create_todo("w", "需求", "父项目自己的", "").unwrap();
        let t = s.create_todo("w", "需求/前端", "子项目的", "正文").unwrap();
        s.set_todo_done("w", "需求/前端", &t.id, true).unwrap();
        assert_eq!(s.read_todo("w", "需求/前端", &t.id).unwrap().content, "正文");
        assert!(s.root().join("w/需求/前端").join(format!("{}.md", t.id)).is_file());

        // 子项目跟在父项目后面；父项目只列自己的待办
        let mut names = project_names(&s, "w");
        names.sort();
        assert_eq!(names, ["日常", "需求", "需求/前端", "需求/后端"]);
        let tree = s.load_workspace("w").unwrap();
        let at = |n: &str| tree.projects.iter().position(|p| p.name == n).unwrap();
        assert!(at("需求") < at("需求/前端") && at("需求") < at("需求/后端"));
        let parent = &tree.projects[at("需求")];
        assert_eq!(parent.todos.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), [own.id.as_str()]);
        assert!(tree.projects[at("需求/前端")].todos[0].done);

        // 首页的卡片：项目数只算顶层项目，待办数包括子项目里的
        let info = &s.list_workspaces().unwrap()[0];
        assert_eq!((info.project_count, info.todo_count, info.done_count), (2, 2, 1));
        let listed = &s.list_projects().unwrap()[0].projects;
        assert!(listed.contains(&"需求/前端".to_string()) && listed.len() == 4);

        // 子项目里再有文件夹不算项目；不认的路径
        fs::create_dir_all(s.root().join("w/需求/前端/图片")).unwrap();
        assert_eq!(project_names(&s, "w").len(), 4);
        assert!(s.read_todo("w", "需求/前端/图片", "x").is_err());
        assert!(s.read_todo("w", "需求/../日常", &own.id).is_err());

        // 全文搜索也查子项目
        let hits = s.search(None, "正文").unwrap();
        assert_eq!((hits[0].project.as_str(), hits.len()), ("需求/前端", 1));

        let m = s.move_todo("w", "需求/前端", &t.id, "w", "日常").unwrap();
        s.move_todo("w", "日常", &m.id, "w", "需求/后端").unwrap();
        assert_eq!(s.load_workspace("w").unwrap().projects[at("需求/后端")].todos.len(), 1);
    }

    #[test]
    fn rename_and_delete_sub_projects() {
        let (_tmp, s) = store("sub-rename");
        s.create_workspace("w").unwrap();
        s.create_project("w", "需求").unwrap();
        s.create_sub_project("w", "需求", "前端").unwrap();
        s.create_sub_project("w", "需求", "后端").unwrap();
        let t = s.create_todo("w", "需求/前端", "子项目的", "").unwrap();
        s.create_todo("w", "需求", "父项目的", "").unwrap();

        // 子项目改名还在原来的父项目里；和同一父项目里的别的子项目重名不行
        assert_eq!(s.rename_project("w", "需求/前端", "界面").unwrap(), "需求/界面");
        assert!(s.rename_project("w", "需求/界面", "后端").is_err());
        assert!(s.read_todo("w", "需求/界面", &t.id).is_ok());
        // 父项目改名，子项目跟着
        assert_eq!(s.rename_project("w", "需求", "开发").unwrap(), "开发");
        assert!(s.read_todo("w", "开发/界面", &t.id).is_ok());

        // 删除子项目：回收站里记着在哪个父项目里，恢复回去
        let rid = s.delete_project("w", "开发/界面").unwrap();
        let e = &s.list_recycle().unwrap()[0];
        assert_eq!((e.title.as_str(), e.project.as_deref(), e.todo_count), ("界面", Some("开发/界面"), 1));
        assert!(!project_names(&s, "w").contains(&"开发/界面".to_string()));
        let r = s.restore(&[rid]);
        assert_eq!(r.restored[0].project.as_deref(), Some("开发/界面"));
        assert!(s.read_todo("w", "开发/界面", &t.id).is_ok());

        // 名字被占用了加「（恢复）」，还在父项目里
        let rid = s.delete_project("w", "开发/界面").unwrap();
        s.create_sub_project("w", "开发", "界面").unwrap();
        let r = s.restore(&[rid]);
        assert_eq!((r.restored[0].project.as_deref(), r.restored[0].renamed), (Some("开发/界面（恢复）"), true));

        // 删除父项目连同子项目，待办数一起算；父项目不在了时恢复子项目的待办会重新建
        let gone = s.create_todo("w", "开发/后端", "删掉的", "").unwrap();
        let tid = s.delete_todo("w", "开发/后端", &gone.id).unwrap();
        let pid = s.delete_project("w", "开发").unwrap();
        // 父项目自己的 1 条，子项目「界面（恢复）」里的 1 条
        assert_eq!(s.list_recycle().unwrap()[0].todo_count, 2);
        assert!(project_names(&s, "w").is_empty());
        let r = s.restore(&[tid]);
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(project_names(&s, "w"), ["开发", "开发/后端"]);
        let r = s.restore(&[pid]);
        assert_eq!(r.restored[0].project.as_deref(), Some("开发（恢复）"));
        let mut names = project_names(&s, "w");
        names.sort();
        assert_eq!(names, ["开发", "开发/后端", "开发（恢复）", "开发（恢复）/后端", "开发（恢复）/界面", "开发（恢复）/界面（恢复）"]);
    }

    #[test]
    fn move_projects_in_and_out_of_projects() {
        let (_tmp, s) = store("sub-move");
        s.create_workspace("甲").unwrap();
        s.create_workspace("乙").unwrap();
        s.create_project("甲", "需求").unwrap();
        s.create_project("甲", "日常").unwrap();
        s.create_project("甲", "零散").unwrap();
        s.create_sub_project("甲", "需求", "前端").unwrap();
        s.create_project("乙", "重名").unwrap();
        s.create_sub_project("乙", "重名", "零散").unwrap();
        let t = s.create_todo("甲", "日常", "带着走", "").unwrap();

        // 放进同一工作区的项目里，成为子项目
        assert_eq!(s.move_project("甲", "日常", "甲", Some("需求")).unwrap(), "需求/日常");
        assert!(s.read_todo("甲", "需求/日常", &t.id).is_ok());
        // 子项目移出来到顶层
        assert_eq!(s.move_project("甲", "需求/日常", "甲", None).unwrap(), "日常");
        // 子项目移到别的工作区的项目里
        assert_eq!(s.move_project("甲", "需求/前端", "乙", Some("重名")).unwrap(), "重名/前端");
        // 有子项目的项目整个移到别的工作区顶层，子项目跟着
        s.create_sub_project("甲", "需求", "后端").unwrap();
        assert_eq!(s.move_project("甲", "需求", "乙", None).unwrap(), "需求");
        assert!(project_names(&s, "乙").contains(&"需求/后端".to_string()));

        // 不行的：有子项目的放进别的项目、放进子项目、放进自己、已经在那里、重名
        assert!(s.move_project("乙", "需求", "乙", Some("重名")).is_err());
        assert!(s.move_project("甲", "日常", "乙", Some("需求/后端")).is_err());
        assert!(s.move_project("甲", "日常", "甲", Some("日常")).is_err());
        assert!(s.move_project("乙", "重名/前端", "乙", Some("重名")).is_err());
        assert!(s.move_project("甲", "日常", "甲", None).is_err());
        assert!(s.move_project("甲", "零散", "乙", Some("重名")).is_err());
        assert!(s.move_project("甲", "日常", "乙", Some("不存在")).is_err());
        assert!(s.read_todo("甲", "日常", &t.id).is_ok());
    }

    #[test]
    fn quick_capture_into_sub_project() {
        let (_tmp, s) = store("sub-quick");
        let t = s.quick_capture("收件箱", " 灵感 / 产品 ", "想法\n细节").unwrap();
        assert_eq!(t.title, "想法");
        assert!(s.read_todo("收件箱", "灵感/产品", &t.id).is_ok());
        assert!(s.quick_capture("收件箱", "a/b/c", "x").is_err());
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
    fn search_finds_whole_content() {
        let (_tmp, s) = store("search");
        s.create_workspace("工作").unwrap();
        s.create_workspace("生活").unwrap();
        s.create_project("工作", "周报").unwrap();
        s.create_project("生活", "购物").unwrap();
        // 关键字在正文很靠后的地方（预览只有开头 200 字）
        let long = format!("# 本周进展\n\n{}\n\n下周要和 Alice 对一下支付接口的联调\n\n{}", "铺垫".repeat(300), "结尾".repeat(100));
        let a = s.create_todo("工作", "周报", "第 40 周", &long).unwrap();
        let b = s.create_todo("生活", "购物", "超市", "牛奶\n面包").unwrap();
        s.create_todo("工作", "周报", "标题里有支付接口", "正文没有").unwrap();

        let hits = s.search(None, "支付接口").unwrap();
        assert_eq!(hits.len(), 1, "只查正文，标题由前端匹配");
        let h = &hits[0];
        assert_eq!((h.workspace.as_str(), h.project.as_str(), h.id.as_str()), ("工作", "周报", a.id.as_str()));
        // 命中处前后各带一些字，前后截掉的地方有省略号
        assert!(h.snippet.starts_with('…') && h.snippet.ends_with('…'), "{}", h.snippet);
        assert!(h.snippet.contains("下周要和 Alice 对一下支付接口的联调"), "{}", h.snippet);

        // 不区分大小写
        assert_eq!(s.search(None, "alice").unwrap().len(), 1);
        assert_eq!(s.search(None, "ALICE").unwrap().len(), 1);
        // 只查给出的工作区，不存在的跳过
        assert!(s.search(Some(&["生活".into(), "没有".into()]), "支付").unwrap().is_empty());
        let only = s.search(Some(&["生活".into()]), "面包").unwrap();
        assert_eq!(only.len(), 1);
        assert_eq!(only[0].id, b.id);
        // 换行合并成空格；关键字前后空白不算
        assert_eq!(only[0].snippet, "牛奶 面包");
        assert_eq!(s.search(None, "  面包 ").unwrap().len(), 1);
        assert!(s.search(None, "   ").unwrap().is_empty());
    }

    #[test]
    fn search_follows_file_changes() {
        let (_tmp, s) = store("search-cache");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let t = s.create_todo("w", "p", "", "第一版：苹果").unwrap();
        assert_eq!(s.search(None, "苹果").unwrap().len(), 1);
        // 在软件里保存、在外部改过，都按新的正文查
        s.save_todo_content("w", "p", &t.id, "第二版：香蕉", None, true).unwrap();
        assert!(s.search(None, "苹果").unwrap().is_empty());
        assert_eq!(s.search(None, "香蕉").unwrap().len(), 1);
        let dir = s.project_path("w", "p").unwrap();
        fs::write(dir.join(format!("{}.md", t.id)), "外部改的：橘子").unwrap();
        assert_eq!(s.search(None, "橘子").unwrap().len(), 1);
        // 直接放进来的 .md（还没登记过）、GBK 编码的也能查到；删掉的查不到，也不再占着缓存
        fs::write(dir.join("拷进来的.md"), encoding_rs::GBK.encode("会议纪要：西瓜").0).unwrap();
        assert_eq!(s.search(None, "西瓜").unwrap()[0].id, "拷进来的");
        fs::remove_file(dir.join("拷进来的.md")).unwrap();
        assert!(s.search(None, "西瓜").unwrap().is_empty());
        assert!(!s.guard().texts[&dir].contains_key("拷进来的"));
        // 工作区改名后旧目录的缓存丢掉，新名字下照样能查
        s.rename_workspace("w", "w2").unwrap();
        assert!(s.guard().texts.is_empty());
        assert_eq!(s.search(None, "橘子").unwrap()[0].workspace, "w2");
    }

    #[test]
    fn search_skips_unreadable_folders() {
        let (_tmp, s) = store("search-gone");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        s.create_todo("w", "p", "", "能搜到的正文").unwrap();
        // 列出的工作区里有一个不在了（刚在外部删掉）：跳过，其余照常搜
        let hits = s.search(Some(&["w".into(), "不在了".into()]), "正文").unwrap();
        assert_eq!(hits.len(), 1);
        // 项目目录是个文件（读不了目录）：也跳过
        fs::write(s.workspace_path("w").unwrap().join("坏的"), "x").unwrap();
        assert_eq!(s.search(None, "正文").unwrap().len(), 1);
    }

    #[test]
    fn search_reads_many_files_in_parallel() {
        let (_tmp, s) = store("search-many");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let dir = s.project_path("w", "p").unwrap();
        for i in 0..41 {
            fs::write(dir.join(format!("笔记{i:02}.md")), format!("开头\n第 {i} 条的关键字K{i}尾巴")).unwrap();
        }
        let hits = s.search(None, "关键字").unwrap();
        assert_eq!(hits.len(), 41);
        for h in hits {
            let i: u32 = h.id.trim_start_matches("笔记").parse().unwrap();
            assert_eq!(h.snippet, format!("开头 第 {i} 条的关键字K{i}尾巴"));
        }
    }

    #[test]
    fn snippet_cuts_around_the_match() {
        let text = |s: &str| CachedText { stamp: FileStamp { modified: None, len: 0 }, text: s.into(), folded: fold(s) };
        let t = text(&format!("{}关键字{}", "前".repeat(30), "后".repeat(100)));
        let at = t.folded.find("关键字").unwrap();
        let cut = snippet(&t, at, 3);
        assert_eq!(cut, format!("…{}关键字{}…", "前".repeat(SNIPPET_BEFORE), "后".repeat(SNIPPET_AFTER)));
        // 大小写不同的字母：位置按字数对回原文
        let t = text("ÀBC Kelvin \u{212A}elvin");
        assert_eq!(fold("KELVIN"), "kelvin");
        let at = t.folded.find("kelvin").unwrap();
        assert_eq!(snippet(&t, at, 6), "ÀBC Kelvin \u{212A}elvin");
    }

    #[test]
    fn quick_note_is_split_into_title_and_body() {
        assert_eq!(split_quick_note("买牛奶"), ("买牛奶".into(), "".into()));
        assert_eq!(
            split_quick_note("\n\n  周会  \r\n\r\n- 讨论排期\n  - 细节\n\n"),
            ("周会".into(), "- 讨论排期\n  - 细节".into())
        );
        assert_eq!(split_quick_note("  \n \n"), ("".into(), "".into()));
        let long = "字".repeat(MAX_TITLE_CHARS + 1);
        assert_eq!(split_quick_note(&format!("{long}\n第二行")), ("".into(), format!("{long}\n第二行")));
    }

    #[test]
    fn quick_capture_creates_missing_project() {
        let (_tmp, s) = store("quick");
        s.create_workspace("工作").unwrap();
        // 工作区、项目都不在：先建
        let t = s.quick_capture("收件箱", "快速记录", "回电话给张三\n号码在名片上").unwrap();
        assert_eq!(t.title, "回电话给张三");
        assert_eq!(s.read_todo("收件箱", "快速记录", &t.id).unwrap().content, "号码在名片上");
        // 已经在：直接加进去
        let t2 = s.quick_capture("收件箱", "快速记录", "第二条").unwrap();
        assert_eq!(s.load_workspace("收件箱").unwrap().projects[0].todos.len(), 2);
        assert_ne!(t.id, t2.id);
        // 空的不建
        assert!(s.quick_capture("收件箱", "快速记录", " \n ").is_err());
        // 不合法的项目名（「a/b」是子项目，可以）
        assert!(s.quick_capture("收件箱", "a\\b", "内容").is_err());

        let mut list = s.list_projects().unwrap();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<(&str, Vec<String>)> = list.iter().map(|w| (w.name.as_str(), w.projects.clone())).collect();
        assert_eq!(names, [("工作", vec![]), ("收件箱", vec!["快速记录".to_string()])]);
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
