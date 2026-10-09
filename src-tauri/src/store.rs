//! 数据存储层。
//!
//! 目录结构（根目录默认为 `~/TodoList`）：
//!
//! ```text
//! TodoList/
//!   {工作区}/
//!     {项目}/
//!       .todos.json          标题、完成状态、置顶、标签、优先级、创建/修改时间等元数据
//!       20260926-153012.md   待办正文（Markdown 纯文本）
//!       .assets/{待办 id}/   这条待办的图片（附件目录），正文里写成相对地址 `.assets/{待办 id}/{文件名}`
//!       .projects.json       父项目里子项目的顺序（手动排序时）
//!       {子项目}/            项目文件夹里的子文件夹是子项目，里面同样是 .todos.json、.md 和 .assets（只有一层子项目）
//!     .projects.json         顶层项目的顺序，和这个工作区的项目是不是手动排序
//!   .state.json              界面状态：上次的位置、各待办的编辑位置等，内容由前端决定
//!   .recycle/                软件的回收站：删除的工作区、项目、待办先放在这里，可以恢复
//!     {条目 id}/entry.json   原来在哪里、标题和完成状态等
//!     {条目 id}/{原名}       删除的 .md 文件或目录
//!     {条目 id}/.assets/{待办 id}/   删除的待办的图片，和在项目文件夹里时的相对位置一样
//!   .restoring-…/            恢复待办数据时的临时文件夹（data_backup.rs），恢复完就删掉
//! ```
//!
//! 接口里的项目用路径表示：顶层项目是它的名字，子项目是「父项目/子项目」（名字里不能有 /，不会混淆）。
//!
//! 项目的顺序（.projects.json，每一层一个）按项目的名字记、不分大小写。按名字排要用中文的拼音顺序，在前端排；
//! 这里只给出各项目在它那一层的顺序里排第几（没排过的没有）和工作区是不是手动排序，改名、移动、删除时跟着改。
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
//!
//! 运行期间监听数据目录（watch.rs），文件在外部变化时通知前端刷新；这里每次写完都记下写过的文件、文件夹现在的样子
//! （OwnWrites），监听到的变化和记下的一样就是软件自己写的，不引起刷新。
//!
//! 待办的图片放在项目文件夹的附件目录 `.assets` 里（`.` 开头，不算子项目，监听时也不看），每条待办一个子目录，
//! 跟着待办移动、进出回收站；待办换了 id（重名）时子目录跟着改名，正文里指向它的链接也改掉（relink_assets）。

use chrono::Local;
use encoding_rs::{DecoderResult, Encoding, GB18030, UTF_8};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::{Deserialize, Deserializer, Serialize};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const META_FILE: &str = ".todos.json";
/// 项目的顺序：工作区文件夹里的记着顶层项目的顺序和这个工作区是不是手动排序，父项目文件夹里的记着它的子项目的顺序
pub const ORDER_FILE: &str = ".projects.json";
pub const UI_STATE_FILE: &str = ".state.json";
const TRASH_DIR: &str = ".trash";
pub const RECYCLE_DIR: &str = ".recycle";
const ENTRY_FILE: &str = "entry.json";
/// 项目文件夹里放图片的附件目录（`.` 开头，不算子项目），每条待办一个子目录：`.assets/{待办 id}/{文件名}`
pub const ASSETS_DIR: &str = ".assets";
/// 能插入、显示的图片的扩展名（小写）
pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"];
/// 软件回收站里放了这么多天的，移到系统回收站
pub const RECYCLE_KEEP_DAYS: i64 = 30;
const PREVIEW_CHARS: usize = 200;
const PREVIEW_READ_BYTES: u64 = 4096;
const MAX_NAME_CHARS: usize = 64;
const MAX_TITLE_CHARS: usize = 200;
/// 标签名最多这么多个字
const MAX_TAG_CHARS: usize = 20;
/// 优先级：0 无、1 低、2 中、3 高
const MAX_PRIORITY: u8 = 3;
/// 全文搜索最多返回这么多条
const MAX_SEARCH_HITS: usize = 2000;
/// 全文搜索的结果里，命中处前后各带多少个字
const SNIPPET_BEFORE: usize = 16;
const SNIPPET_AFTER: usize = 60;
/// 软件自己写过的文件、文件夹，这么久之内监听到的变化才认成是自己写的（监听时一阵变化合起来最多攒 2 秒）
const OWN_WRITE_TTL: Duration = Duration::from_secs(10);

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
    /// 标签（clean_tag 规整过，同一条里不区分大小写地去了重，先加的在前）；没有时不写。
    /// 手改得不合规则的读的时候去掉，读不懂的整项当没有，不至于把整个元数据文件当成损坏的
    #[serde(default, skip_serializing_if = "Vec::is_empty", deserialize_with = "lenient_tags")]
    tags: Vec<String>,
    /// 优先级：3 高、2 中、1 低；无（0）时不写，读不懂的当无
    #[serde(default, skip_serializing_if = "is_zero", deserialize_with = "lenient_priority")]
    priority: u8,
}

fn is_false(v: &bool) -> bool {
    !v
}

fn is_zero(v: &u8) -> bool {
    *v == 0
}

/// 读 `tags`：一组文字里规整得了的留下（clean_tags），别的（不是文字、不合规则的）去掉；不是一组文字时当没有
fn lenient_tags<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<String>, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    let raw = v.as_array().map(Vec::as_slice).unwrap_or_default();
    Ok(clean_tags(raw.iter().filter_map(|t| clean_tag(t.as_str()?).ok())))
}

/// 读 `priority`：1～3 的整数照用，别的当无
fn lenient_priority<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u8, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(v.as_u64().filter(|p| (1..=MAX_PRIORITY as u64).contains(p)).map_or(0, |p| p as u8))
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

/// 一层项目（工作区的顶层，或一个父项目里的子项目）的顺序（ORDER_FILE）。手改得读不懂的项当没有，
/// 整个读不出来时当成没有这个文件（照常按名字排）
#[derive(Debug, Default, Serialize, Deserialize)]
struct ProjectOrder {
    #[serde(default)]
    version: u32,
    /// 这个工作区的项目手动排序（只看工作区文件夹里的）；换成按名称时顺序留着，换回手动排序时恢复
    #[serde(default, skip_serializing_if = "is_false", deserialize_with = "lenient_bool")]
    manual: bool,
    /// 这一层的项目（自己的名字）从前到后；没列出的排在后面
    #[serde(default, deserialize_with = "lenient_names")]
    order: Vec<String>,
}

impl ProjectOrder {
    /// 名字（小写）→ 排第几；同一个名字（不分大小写）写了几次的按第一次
    fn ranks(&self) -> HashMap<String, i64> {
        let mut out = HashMap::new();
        for (i, name) in self.order.iter().enumerate() {
            out.entry(name.to_lowercase()).or_insert(i as i64);
        }
        out
    }

    /// 名字是 name（不分大小写）的排在第几
    fn position(&self, name: &str) -> Option<usize> {
        let name = name.to_lowercase();
        self.order.iter().position(|n| n.to_lowercase() == name)
    }
}

/// 读 `manual`：不是 true / false 的当 false
fn lenient_bool<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<bool, D::Error> {
    Ok(serde_json::Value::deserialize(d)?.as_bool().unwrap_or(false))
}

/// 读 `order`：一组文字里的文字留下，别的去掉；不是一组时当没有
fn lenient_names<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<String>, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    let raw = v.as_array().map(Vec::as_slice).unwrap_or_default();
    Ok(raw.iter().filter_map(|n| n.as_str().map(str::to_string)).collect())
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
    /// 标签，按加上的先后
    pub tags: Vec<String>,
    /// 优先级：3 高、2 中、1 低、0 无
    pub priority: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNode {
    /// 项目路径：顶层项目是名字，子项目是「父项目/子项目」
    pub name: String,
    /// 只是这个项目自己的待办，不含子项目的
    pub todos: Vec<TodoSummary>,
    /// 手动排序时在它那一层（工作区的顶层，或父项目里）排第几（从小到大）；没排过的为 null，排在后面
    pub order: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTree {
    pub name: String,
    /// 全部项目：每个顶层项目后面跟着它的子项目（还没排序，前端按名字或手动排序的顺序排）
    pub projects: Vec<ProjectNode>,
    /// 这个工作区的项目手动排序；false 时按名字排
    pub manual_order: bool,
}

/// 一个工作区里的项目路径（快速记录选择存到哪里时用，不读待办），子项目跟在它的父项目后面
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjects {
    pub name: String,
    pub projects: Vec<String>,
    /// 这个工作区的项目手动排序
    pub manual_order: bool,
    /// 排过的项目（路径）在它那一层排第几，同 ProjectNode 的 order；没排过的不在里面
    pub order: BTreeMap<String, i64>,
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

/// 存进附件目录的一张图片（粘贴、拖进来的）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    /// 写进正文的地址：相对于 .md 文件，用 / 分隔，如 `.assets/20261010-101010/图片-20261010-101010.png`
    pub link: String,
    /// 存成的文件名
    pub name: String,
    /// 字节数（太大时前端提示一下）
    pub size: u64,
}

/// 正文里一张本地图片对应的文件
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile {
    /// 规整过（去掉了 . 和 ..）的绝对路径，前端经 asset 协议读
    pub path: String,
    /// 修改时间：图片在外部被替换后，前端用的地址跟着变，不用 WebView 缓存里旧的
    pub modified: i64,
}

/// 一条待办在哪里（另存为新待办时，从哪条复制附件目录）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoRef {
    pub workspace: String,
    pub project: String,
    pub id: String,
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

    /// 拿着锁执行 f：备份待办数据时每读一个文件拿一次，免得和保存、改名、移动同时进行
    /// （Windows 上文件夹里有文件开着时，这个文件夹改不了名）
    pub fn locked<T>(&self, f: impl FnOnce() -> T) -> T {
        let _g = self.guard();
        f()
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

    /// 建好文件夹 dir（连同不在的上级文件夹），记下新建的这些是软件自己建的
    fn create_dirs(&self, dir: &Path) -> io::Result<()> {
        let missing: Vec<PathBuf> = dir
            .ancestors()
            .take_while(|d| *d != self.root && !d.is_dir())
            .map(Path::to_path_buf)
            .collect();
        fs::create_dir_all(dir)?;
        for d in &missing {
            note_own(d);
        }
        Ok(())
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

    /// 全部工作区和其中的项目路径（包括子项目）和项目的顺序，只列目录
    pub fn list_projects(&self) -> Result<Vec<WorkspaceProjects>> {
        let _g = self.guard();
        list_subdirs(&self.root)?
            .into_iter()
            .map(|(name, dir)| {
                let dirs = project_dirs(&dir)?;
                let (manual_order, order) = project_ranks(&dir, &dirs);
                let projects = dirs.into_iter().map(|(p, _)| p).collect();
                Ok(WorkspaceProjects { name, projects, manual_order, order: order.into_iter().collect() })
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
        let id = self.recycle(&dir, None, RecycleFile::new(RecycleKind::Workspace, name, None, name, count))?;
        g.forget_under(&dir);
        Ok(id)
    }

    pub fn load_workspace(&self, ws: &str) -> Result<WorkspaceTree> {
        let mut g = self.guard();
        let dir = self.ws_dir(ws)?;
        let dirs = project_dirs(&dir)?;
        let (manual_order, ranks) = project_ranks(&dir, &dirs);
        let mut projects = Vec::new();
        let mut scanned = HashSet::new();
        for (name, pdir) in dirs {
            projects.push(ProjectNode {
                order: ranks.get(&name).copied(),
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
            manual_order,
        })
    }

    // ----- 项目 -----

    /// 新建项目。新建的是没排过的，手动排序时排在后面（项目的顺序里留着同名的旧名字时去掉）
    pub fn create_project(&self, ws: &str, name: &str) -> Result<String> {
        let _g = self.guard();
        let dir = self.ws_dir(ws)?;
        let name = normalize_name(name, "项目")?;
        create_child_dir(&dir, &name, "项目")?;
        let _ = forget_in_order(&dir, &name);
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
        let _ = forget_in_order(&dir, &name);
        Ok(format!("{parent}{PROJECT_SEP}{name}"))
    }

    /// 改项目（或子项目）自己的名字，返回改名后的路径；子项目改名后还在原来的父项目里。在项目的顺序里位置不变
    pub fn rename_project(&self, ws: &str, project: &str, new_name: &str) -> Result<String> {
        let _g = self.guard();
        let pdir = self.project_dir(ws, project)?;
        let (parent, name) = split_project(project);
        let what = if parent.is_some() { "子项目" } else { "项目" };
        let new_name = normalize_name(new_name, what)?;
        let parent_dir = pdir.parent().ok_or("无效的项目名称")?;
        rename_dir(&pdir, parent_dir, name, &new_name, what)?;
        if name != new_name {
            let _ = rename_in_order(parent_dir, name, &new_name);
        }
        Ok(join_project(parent, &new_name))
    }

    /// 放进软件的回收站（顶层项目连同它的子项目），返回回收站里这一项的 id；项目的顺序里去掉它
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
        let id = self.recycle(&pdir, None, RecycleFile::new(RecycleKind::Project, ws, Some(project), name, count))?;
        g.forget_under(&pdir);
        if let Some(level) = pdir.parent() {
            let _ = forget_in_order(level, name);
        }
        Ok(id)
    }

    /// 把项目（或子项目）连同其中的待办移到工作区 target 的顶层（parent 为 None），或者放进它的顶层项目 parent 里
    /// 成为子项目；名字不变，返回移过去后的路径。只有一层子项目：有子项目的项目不能放进别的项目。
    /// 那里已有同名项目时不移动。原来那一层的顺序里去掉它；order 是放下的位置：新的那一层从前到后的名字（含它），
    /// 记成那一层的顺序（同 reorder_projects，那个工作区改成手动排序），没给时它在那里是没排过的
    pub fn move_project(
        &self,
        ws: &str,
        project: &str,
        target: &str,
        parent: Option<&str>,
        order: Option<&[String]>,
    ) -> Result<String> {
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
        note_own(&pdir);
        note_own(&dst);
        // 顺序是附带的：已经移过去了，记不下时不报错（只是排在后面）
        if let Some(from) = pdir.parent() {
            let _ = forget_in_order(from, name);
        }
        if parent.is_some() {
            // 成了子项目：它原来记着的子项目的顺序用不着了（放得进去说明它没有子项目）
            let _ = clear_order(&dst);
        }
        if let Some(names) = order {
            let _ = self.place_projects(target, parent, names);
        }
        Ok(join_project(parent, name))
    }

    // ----- 项目的顺序 -----

    /// 手动排序项目：names 是工作区 ws 的顶层（parent 为 None）或顶层项目 parent 里的子项目从前到后的名字，
    /// 记成那一层的顺序，这个工作区改成手动排序。不算修改，修改时间不变
    pub fn reorder_projects(&self, ws: &str, parent: Option<&str>, names: &[String]) -> Result<()> {
        let _g = self.guard();
        self.place_projects(ws, parent, names)
    }

    /// 同 reorder_projects（调用方拿着锁）。本来按名称排时，别的层留着的旧顺序（上次手动排序留下的）也去掉：
    /// 调整前看到的是按名字的，调整后别的层还是那样
    fn place_projects(&self, ws: &str, parent: Option<&str>, names: &[String]) -> Result<()> {
        let ws_dir = self.ws_dir(ws)?;
        let dir = match parent {
            None => ws_dir.clone(),
            Some(p) if p.contains(PROJECT_SEP) => return Err("子项目里没有子项目".into()),
            Some(p) => self.project_dir(ws, p)?,
        };
        let mut top = read_order(&ws_dir);
        if !top.manual {
            top.order.clear();
            for (_, pdir) in list_subdirs(&ws_dir)? {
                if pdir != dir {
                    clear_order(&pdir)?;
                }
            }
        }
        top.manual = true;
        if parent.is_some() {
            write_order(&dir, ProjectOrder { order: names.to_vec(), ..Default::default() })?;
        } else {
            top.order = names.to_vec();
        }
        write_order(&ws_dir, top)
    }

    /// 工作区 ws 的项目改成手动排序（manual 为 true）或按名称。按名称时记下的顺序留着，换回手动排序时恢复
    pub fn set_projects_manual(&self, ws: &str, manual: bool) -> Result<()> {
        let _g = self.guard();
        let dir = self.ws_dir(ws)?;
        let mut o = read_order(&dir);
        if o.manual == manual {
            return Ok(());
        }
        o.manual = manual;
        write_order(&dir, o)
    }

    // ----- 待办 -----

    /// 同 create_todo_from，不复制附件目录（单元测试里用）
    #[cfg(test)]
    pub fn create_todo(&self, ws: &str, project: &str, title: &str, content: &str) -> Result<TodoSummary> {
        self.create_todo_from(ws, project, title, content, None)
    }

    /// 新建待办；content 是正文（新建空白待办时为空）。正文在同一次调用里写好，
    /// 不会出现先有一个空文件、再保存正文的中间状态（外部修改冲突时「另存为新待办」用）。
    /// 给了 from（另存为新待办时原来那条）时，复制一份它的附件目录给新的这条，正文里指向原来附件目录的链接改成新的 id，
    /// 免得以后删了原来那条图片就没了；复制失败时照常新建，链接不改。新的这条也带上原来那条现在的标签和优先级
    /// （原来那条已经不在了时没有）
    pub fn create_todo_from(
        &self,
        ws: &str,
        project: &str,
        title: &str,
        content: &str,
        from: Option<&TodoRef>,
    ) -> Result<TodoSummary> {
        let _g = self.guard();
        let dir = self.project_dir(ws, project)?;
        let mut meta = read_meta(&dir)?;
        let id = unique_id(&dir, &meta);
        let copied = from.filter(|f| self.copy_assets(f, &assets_dir(&dir, &id)));
        let content = match copied.and_then(|f| rewrite_asset_links(content, &f.id, &id)) {
            Some(relinked) => Cow::Owned(relinked),
            None => Cow::Borrowed(content),
        };
        let path = dir.join(format!("{id}.md"));
        let written = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("创建待办文件失败：{e}"))
            .and_then(|mut file| {
                let done = file.write_all(content.as_bytes()).and_then(|_| file.sync_all());
                drop(file);
                done.map_err(|e| {
                    let _ = fs::remove_file(&path);
                    format!("写入待办正文失败：{e}")
                })
            });
        if let Err(e) = written {
            if copied.is_some() {
                let _ = fs::remove_dir_all(assets_dir(&dir, &id));
                remove_empty_assets(&dir);
            }
            return Err(e);
        }
        note_own(&path);
        let now = now_ms();
        let (tags, priority) = from.and_then(|f| self.todo_meta(f)).map(|m| (m.tags, m.priority)).unwrap_or_default();
        let entry = TodoMeta {
            id,
            title: clean_title(title),
            done: false,
            created_at: now,
            updated_at: now,
            done_at: None,
            pinned: false,
            order: None,
            tags,
            priority,
        };
        meta.todos.push(entry.clone());
        write_meta(&dir, &meta)?;
        Ok(summary_of(&entry, now, make_preview(&content)))
    }

    /// 快速记录：第一行当标题、其余当正文，存成工作区 ws 的项目 project（可以是子项目）里的一条新待办；
    /// 工作区、项目不在时先建
    pub fn quick_capture(&self, ws: &str, project: &str, text: &str) -> Result<TodoSummary> {
        let (title, content) = split_quick_note(text);
        if title.is_empty() && content.is_empty() {
            return Err("没有要记的内容".into());
        }
        self.create_todo_creating_project(ws, project, &title, &content, None)
    }

    /// 同 create_todo_from，但工作区、项目（可以是子项目）不在时先建：快速记录，和离开一条待办时存不上、
    /// 原来的项目也不在了，另存到快速记录存到的项目里时用
    pub fn create_todo_creating_project(
        &self,
        ws: &str,
        project: &str,
        title: &str,
        content: &str,
        from: Option<&TodoRef>,
    ) -> Result<TodoSummary> {
        let ws = normalize_name(ws, "工作区")?;
        let project = normalize_project_path(project)?;
        {
            let _g = self.guard();
            let dir = project.split(PROJECT_SEP).fold(self.root.join(&ws), |d, p| d.join(p));
            self.create_dirs(&dir)
                .map_err(|e| format!("创建项目「{}」失败：{e}", project_label(&project)))?;
        }
        self.create_todo_from(&ws, &project, title, content, from)
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

    /// 设置标签，tags 是全部标签（按先后）：逐个规整（clean_tag），有不合规则的什么都不改、返回原因；不区分大小写地去重，
    /// 保留先出现的写法。和置顶一样不算修改，修改时间不变
    pub fn set_todo_tags(&self, ws: &str, project: &str, id: &str, tags: &[String]) -> Result<TodoSummary> {
        let tags = clean_tags(tags.iter().map(|t| clean_tag(t)).collect::<Result<Vec<_>>>()?);
        self.change_meta(ws, project, id, false, |m| {
            let changed = m.tags != tags;
            m.tags = tags;
            changed
        })
    }

    /// 设置优先级（0 无、1 低、2 中、3 高）。不算修改，修改时间不变
    pub fn set_todo_priority(&self, ws: &str, project: &str, id: &str, priority: u8) -> Result<TodoSummary> {
        if priority > MAX_PRIORITY {
            return Err("无效的优先级".into());
        }
        self.change_meta(ws, project, id, false, |m| {
            let changed = m.priority != priority;
            m.priority = priority;
            changed
        })
    }

    /// 工作区 workspaces（不在的跳过）里所有带标签 from（不区分大小写）的待办，这个标签改名成 to（先规整，不合规则时
    /// 什么都不改、返回原因）；已经有 to（不区分大小写）的去掉 from，就是合并。不算修改，修改时间不变。返回改了几条
    pub fn rename_tag(&self, workspaces: &[String], from: &str, to: &str) -> Result<usize> {
        let to = clean_tag(to)?;
        self.edit_tags(workspaces, |tags| rename_tag_in(tags, from, &to))
    }

    /// 工作区 workspaces（不在的跳过）里所有待办上去掉标签 tag（不区分大小写），待办本身不动。不算修改。返回改了几条
    pub fn remove_tag(&self, workspaces: &[String], tag: &str) -> Result<usize> {
        self.edit_tags(workspaces, |tags| {
            let before = tags.len();
            tags.retain(|t| !same_tag(t, tag));
            tags.len() != before
        })
    }

    /// 逐个项目改 workspaces 里的待办的标签（f 返回 true 表示改了这一条），有改动的项目写一次元数据；返回改了几条
    fn edit_tags(&self, workspaces: &[String], mut f: impl FnMut(&mut Vec<String>) -> bool) -> Result<usize> {
        let _g = self.guard();
        let mut n = 0;
        for ws in workspaces {
            let Ok(ws_dir) = self.ws_dir(ws) else { continue };
            for (_, dir) in project_dirs(&ws_dir)? {
                let mut meta = read_meta(&dir)?;
                let mut changed = 0;
                for m in &mut meta.todos {
                    changed += f(&mut m.tags) as usize;
                }
                if changed > 0 {
                    write_meta(&dir, &meta)?;
                    n += changed;
                }
            }
        }
        Ok(n)
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

    /// 放进软件的回收站（连同标题、完成状态等，恢复时还原；图片的附件目录放在同一项里），返回回收站里这一项的 id
    pub fn delete_todo(&self, ws: &str, project: &str, id: &str) -> Result<String> {
        let mut g = self.guard();
        let dir = self.project_dir(ws, project)?;
        let path = Self::todo_file(&dir, id)?;
        let (mut meta, idx) = meta_with_entry(&dir, id)?;
        let mut file = RecycleFile::new(RecycleKind::Todo, ws, Some(project), &format!("{id}.md"), 0);
        file.todo = Some(meta.todos[idx].clone());
        file.preview = read_preview(&path);
        let rid = self.recycle(&path, Some(&assets_dir(&dir, id)), file)?;
        meta.todos.remove(idx);
        write_meta(&dir, &meta)?;
        g.forget_todo(&dir, id);
        remove_empty_assets(&dir);
        Ok(rid)
    }

    /// 把待办移动到另一个项目（可以在别的工作区里），图片的附件目录跟着过去。目标项目里若有同名文件会换一个新 id，
    /// 这时附件目录改成新 id，正文里指向它的链接跟着改（relink_assets）
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
        if id_taken(&dst_dir, &dst_meta, &new_id) {
            new_id = unique_id(&dst_dir, &dst_meta);
        }
        let dst_path = dst_dir.join(format!("{new_id}.md"));
        // 图片先移过去：移不动（被别的程序占用）时这条待办整个不移
        let (src_assets, dst_assets) = (assets_dir(&src_dir, id), assets_dir(&dst_dir, &new_id));
        let moved_assets = move_assets(&src_assets, &dst_assets)
            .map_err(|e| format!("移动失败，图片可能正被其他程序占用：{e}"))?;
        if let Err(e) = fs::rename(&src_path, &dst_path) {
            if moved_assets {
                let _ = fs::rename(&dst_assets, &src_assets);
                remove_empty_assets(&dst_dir);
            }
            return Err(format!("移动失败，文件可能正被其他程序占用：{e}"));
        }
        note_own(&src_path);
        note_own(&dst_path);
        if new_id != id {
            relink_assets(&dst_path, id, &new_id);
        }
        remove_empty_assets(&src_dir);

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

    // ----- 图片（附件目录） -----

    /// 粘贴的图片（data，扩展名 ext）存进待办 id 的附件目录，名字是「图片-年月日-时分秒.扩展名」，同名时加 -2、-3…
    pub fn save_image(&self, ws: &str, project: &str, id: &str, ext: &str, data: &[u8]) -> Result<SavedImage> {
        let _g = self.guard();
        let dir = self.project_dir(ws, project)?;
        Self::todo_file(&dir, id)?;
        let ext = ext.to_ascii_lowercase();
        if !is_image_ext(&ext) {
            return Err(format!("不能插入 .{ext} 格式的图片"));
        }
        let assets = assets_dir(&dir, id);
        self.create_dirs(&assets).map_err(|e| format!("保存图片失败：{e}"))?;
        let stem = format!("图片-{}", Local::now().format("%Y%m%d-%H%M%S"));
        for name in numbered_names(&stem, &ext) {
            let path = assets.join(&name);
            let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(f) => f,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("保存图片失败：{e}")),
            };
            if let Err(e) = file.write_all(data).and_then(|_| file.sync_all()) {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(format!("保存图片失败：{e}"));
            }
            return Ok(SavedImage { link: asset_link(id, &name), name, size: data.len() as u64 });
        }
        unreachable!("numbered_names 不会结束")
    }

    /// 拖进来的图片文件 source 复制一份到待办 id 的附件目录（原文件不动），保留原名（不能用在文件名里的字符换成 _）；
    /// 附件目录里已有同名文件时，内容一样的直接用它，不一样的加 -2、-3…
    pub fn import_image(&self, ws: &str, project: &str, id: &str, source: &Path) -> Result<SavedImage> {
        let _g = self.guard();
        let dir = self.project_dir(ws, project)?;
        Self::todo_file(&dir, id)?;
        let shown = source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = source.extension().and_then(|e| e.to_str()).unwrap_or_default();
        if !is_image_ext(&ext.to_ascii_lowercase()) {
            return Err(format!("「{shown}」不是图片"));
        }
        let size = match fs::metadata(source) {
            Ok(md) if md.is_file() => md.len(),
            _ => return Err(format!("找不到「{shown}」")),
        };
        let stem = clean_file_stem(&source.file_stem().map(|s| s.to_string_lossy()).unwrap_or_default());
        let assets = assets_dir(&dir, id);
        self.create_dirs(&assets).map_err(|e| format!("复制图片失败：{e}"))?;
        for name in numbered_names(&stem, ext) {
            let path = assets.join(&name);
            if path.exists() {
                if same_content(source, &path) {
                    return Ok(SavedImage { link: asset_link(id, &name), name, size });
                }
                continue;
            }
            fs::copy(source, &path).map_err(|e| format!("复制「{shown}」失败：{e}"))?;
            return Ok(SavedImage { link: asset_link(id, &name), name, size });
        }
        unreachable!("numbered_names 不会结束")
    }

    /// 正文里本地图片的地址 src（已经去掉了 Markdown 的转义）指向的文件：相对地址相对于项目文件夹（.md 所在的
    /// 文件夹），也可以是绝对路径。只认图片扩展名的、在的文件
    pub fn image_file(&self, ws: &str, project: &str, src: &str) -> Result<ImageFile> {
        let dir = {
            let _g = self.guard();
            self.project_dir(ws, project)?
        };
        let path = normalize_path(&dir.join(src));
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
        if !is_image_ext(&ext) {
            return Err("不是图片文件".into());
        }
        let md = fs::metadata(&path).ok().filter(|m| m.is_file()).ok_or("找不到图片")?;
        Ok(ImageFile {
            path: path.to_string_lossy().into_owned(),
            modified: to_ms(md.modified()).unwrap_or(0),
        })
    }

    /// 待办 r 现在的元数据（另存为新待办时带上原来那条的标签、优先级）；它或所在的项目已经不在时返回 None
    fn todo_meta(&self, r: &TodoRef) -> Option<TodoMeta> {
        let dir = self.project_dir(&r.workspace, &r.project).ok()?;
        let meta = read_meta(&dir).ok()?;
        meta.find(&r.id).map(|i| meta.todos[i].clone())
    }

    /// 另存为新待办：待办 from 的附件目录复制一份到 to；复制成了返回 true。没有附件目录、复制失败（删掉复制了一半的）
    /// 时返回 false，那时新的那条的正文还指向原来那条的图片
    fn copy_assets(&self, from: &TodoRef, to: &Path) -> bool {
        let Ok(dir) = self.project_dir(&from.workspace, &from.project) else { return false };
        if check_component(&from.id, "待办").is_err() {
            return false;
        }
        let src = assets_dir(&dir, &from.id);
        if !src.is_dir() || to.exists() {
            return false;
        }
        if copy_dir(&src, to).is_err() {
            let _ = fs::remove_dir_all(to);
            return false;
        }
        true
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

    // ----- 恢复待办数据（data_backup.rs） -----

    /// 用 staged 里的工作区和 .state.json 换掉数据目录里现在的。拿着锁做，期间别的操作（保存、快速记录等）等着：
    /// 先调 before（把现在的数据备份一份，失败了就什么都不动），再把现在的移进 old、staged 里的移过来。
    /// 中途失败时换回原来的；换不回来的留在 old 里。软件的回收站和数据目录里别的文件（设置等）不动
    pub fn replace_data<T>(&self, staged: &Path, old: &Path, before: impl FnOnce() -> Result<T>) -> Result<T> {
        let mut g = self.guard();
        let done = before()?;
        let current = data_items(&self.root)?;
        let incoming = data_items(staged)?;
        fs::create_dir_all(old).map_err(|e| format!("恢复失败：{e}"))?;
        let mut moved_out = Vec::new();
        for name in &current {
            if let Err(e) = fs::rename(self.root.join(name), old.join(name)) {
                let back = move_items(&moved_out, old, &self.root);
                return Err(rollback_error(name, e, back, old));
            }
            moved_out.push(name.clone());
        }
        let mut moved_in = Vec::new();
        for name in &incoming {
            let target = self.root.join(name);
            // 数据目录里还有同名的（不是工作区的文件）：不覆盖它（Windows 上文件夹改名能把同名的文件顶掉）
            let moved = match fs::symlink_metadata(&target) {
                Ok(_) => Err(io::Error::new(io::ErrorKind::AlreadyExists, "数据目录里已有同名的文件")),
                Err(_) => fs::rename(staged.join(name), &target),
            };
            if let Err(e) = moved {
                let back = move_items(&moved_in, &self.root, staged).and(move_items(&moved_out, old, &self.root));
                return Err(rollback_error(name, e, back, old));
            }
            moved_in.push(name.clone());
        }
        // 路径没变、内容全换了：缓存整个丢掉
        *g = MemCache::default();
        let _ = fs::remove_dir_all(old);
        Ok(done)
    }

    // ----- 软件的回收站 -----

    fn recycle_root(&self) -> PathBuf {
        self.root.join(RECYCLE_DIR)
    }

    /// 把 path（待办的 .md、项目或工作区的目录）连同说明放进回收站，返回这一项的 id；assets 是待办的附件目录（图片），
    /// 在的话放进这一项的 `.assets` 里，和在项目文件夹里时的相对位置一样（在系统回收站里打开 .md 也看得到图片）。
    /// 先写说明再移文件，移不动（被别的程序占用）时什么都不留
    fn recycle(&self, path: &Path, assets: Option<&Path>, file: RecycleFile) -> Result<String> {
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
        let mut moved_assets = None;
        if let Some(from) = assets {
            let to = dir.join(ASSETS_DIR).join(from.file_name().unwrap_or_default());
            match move_assets(from, &to) {
                Ok(true) => moved_assets = Some((from, to)),
                Ok(false) => {}
                Err(e) => {
                    let _ = fs::remove_dir_all(&dir);
                    return Err(format!("删除失败，图片可能正被其他程序占用：{e}"));
                }
            }
        }
        if let Err(e) = fs::rename(path, dir.join(&file.name)) {
            // 图片移回去；万一移不回去，这一项留着（里面有图片），不能连同图片一起删掉
            if moved_assets.as_ref().is_none_or(|(from, to)| fs::rename(to, from).is_ok()) {
                let _ = fs::remove_dir_all(&dir);
            }
            return Err(format!("删除失败，可能有文件正被其他程序占用：{e}"));
        }
        note_own(path);
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
                self.create_dirs(&pdir).map_err(|e| format!("恢复失败：{e}"))?;
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
                        tags: Vec::new(),
                        priority: 0,
                    }
                });
                let mut new_id = stem.clone();
                if id_taken(&pdir, &meta, &new_id) {
                    new_id = unique_id(&pdir, &meta);
                }
                let path = pdir.join(format!("{new_id}.md"));
                // 图片（这一项里的 .assets）一起回去
                let (from_assets, to_assets) = (assets_dir(&dir, &stem), assets_dir(&pdir, &new_id));
                let moved_assets = move_assets(&from_assets, &to_assets).map_err(|e| format!("恢复失败：{e}"))?;
                if let Err(e) = fs::rename(&payload, &path) {
                    if moved_assets {
                        let _ = fs::rename(&to_assets, &from_assets);
                        remove_empty_assets(&pdir);
                    }
                    return Err(format!("恢复失败：{e}"));
                }
                note_own(&path);
                if new_id != stem {
                    relink_assets(&path, &stem, &new_id);
                }
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
                self.create_dirs(&dir).map_err(|e| format!("恢复失败：{e}"))?;
                let (name, renamed) = free_name(&dir, &f.name);
                fs::rename(&payload, dir.join(&name)).map_err(|e| format!("恢复失败：{e}"))?;
                note_own(&dir.join(&name));
                g.forget_under(&dir.join(&name));
                // 恢复的是没排过的，手动排序时排在后面
                let _ = forget_in_order(&dir, &name);
                let project = Some(join_project(parent, &name));
                Restored { kind: f.kind, workspace: f.workspace.clone(), project, todo_id: None, renamed }
            }
            RecycleKind::Workspace => {
                let (name, renamed) = free_name(&self.root, &f.name);
                fs::rename(&payload, self.root.join(&name)).map_err(|e| format!("恢复失败：{e}"))?;
                note_own(&self.root.join(&name));
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
            tags: Vec::new(),
            priority: 0,
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

/// 数据目录（或解压出来的备份）里算待办数据的：工作区文件夹（点开头的不算）和 .state.json
fn data_items(dir: &Path) -> Result<Vec<String>> {
    let mut items: Vec<String> = list_subdirs(dir)?.into_iter().map(|(name, _)| name).collect();
    if dir.join(UI_STATE_FILE).is_file() {
        items.push(UI_STATE_FILE.into());
    }
    Ok(items)
}

/// 把 names 从 from 移回 to；有没移成的返回错误
fn move_items(names: &[String], from: &Path, to: &Path) -> io::Result<()> {
    let mut result = Ok(());
    for name in names {
        if let Err(e) = fs::rename(from.join(name), to.join(name)) {
            result = Err(e);
        }
    }
    result
}

/// 替换数据时移不动 name（多半正被其他程序占用）的提示；back 是换回原来的数据成没成
fn rollback_error(name: &str, e: io::Error, back: io::Result<()>, old: &Path) -> String {
    match back {
        Ok(()) => format!("恢复失败，「{name}」可能有文件正被其他程序占用：{e}。现在的数据没有改动"),
        Err(back) => format!(
            "恢复失败，「{name}」可能有文件正被其他程序占用：{e}；而且没能把原来的数据全部换回来（{back}）。\
             原来的数据在自动备份目录里恢复前的备份中，没换回来的部分在 {}",
            old.display()
        ),
    }
}

/// 数据目录（或解压出来的备份）里有几个工作区、几条待办（包括子项目里的），和左侧、首页的算法一样
pub fn count_data(root: &Path) -> Result<(usize, usize)> {
    let workspaces = list_subdirs(root)?;
    let mut todos = 0;
    for (_, dir) in &workspaces {
        for (_, pdir) in project_dirs(dir)? {
            todos += markdown_files(&pdir)?.len();
        }
    }
    Ok((workspaces.len(), todos))
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
            if fs::rename(&path, backup).is_ok() {
                note_own(&path);
            }
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

// ---------------------------------------------------------------------------
// 项目的顺序：每一层（工作区的顶层、父项目里的子项目）一个 ORDER_FILE，放在那一层的文件夹（工作区、父项目）里
// ---------------------------------------------------------------------------

/// 读文件夹 dir 里记着的那一层项目的顺序；没有、读不出来、手改坏了（不是 JSON、格式不对）的当成没有
fn read_order(dir: &Path) -> ProjectOrder {
    fs::read(dir.join(ORDER_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(strip_bom(&bytes)).ok())
        .unwrap_or_default()
}

/// 写那一层项目的顺序：先去掉已经没有对应项目（dir 里的文件夹）的名字和重复的；什么都不用记（没有顺序、
/// 不是手动排序）时删掉这个文件
fn write_order(dir: &Path, mut o: ProjectOrder) -> Result<()> {
    let present: HashSet<String> = list_subdirs(dir)?.into_iter().map(|(n, _)| n.to_lowercase()).collect();
    let mut seen = HashSet::new();
    o.order.retain(|n| {
        let key = n.to_lowercase();
        present.contains(&key) && seen.insert(key)
    });
    if !o.manual && o.order.is_empty() {
        return clear_order(dir);
    }
    o.version = 1;
    let json = serde_json::to_vec_pretty(&o).map_err(|e| e.to_string())?;
    atomic_write(&dir.join(ORDER_FILE), &json).map_err(|e| format!("保存项目的顺序失败：{e}"))
}

/// 删掉文件夹 dir 里记着的项目的顺序；没有时什么都不做
fn clear_order(dir: &Path) -> Result<()> {
    let path = dir.join(ORDER_FILE);
    match fs::remove_file(&path) {
        Ok(()) => {
            note_own(&path);
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("保存项目的顺序失败：{e}")),
    }
}

/// 那一层的顺序里去掉名字是 name（不分大小写）的项目：删掉、移走了，或者新建、恢复了同名的（没排过，排在后面）。
/// 没记着它时什么都不写
fn forget_in_order(dir: &Path, name: &str) -> Result<()> {
    let mut o = read_order(dir);
    let Some(i) = o.position(name) else { return Ok(()) };
    o.order.remove(i);
    write_order(dir, o)
}

/// 项目改名后，在那一层的顺序里的位置不变；没记着它时什么都不写
fn rename_in_order(dir: &Path, old: &str, new: &str) -> Result<()> {
    let mut o = read_order(dir);
    let Some(i) = o.position(old) else { return Ok(()) };
    o.order[i] = new.to_string();
    write_order(dir, o)
}

/// 工作区 ws_dir 里的项目（project_dirs 列出的）在各自那一层的顺序里排第几（路径 → 位置，没排过的不在里面），
/// 和这个工作区的项目是不是手动排序。父项目的顺序只在它有子项目时才读
fn project_ranks(ws_dir: &Path, projects: &[(String, PathBuf)]) -> (bool, HashMap<String, i64>) {
    let top = read_order(ws_dir);
    let top_ranks = top.ranks();
    let mut sub_ranks: HashMap<&str, HashMap<String, i64>> = HashMap::new();
    let mut out = HashMap::new();
    for (path, _) in projects {
        let (parent, name) = split_project(path);
        let ranks = match parent {
            None => &top_ranks,
            Some(p) => &*sub_ranks.entry(p).or_insert_with(|| read_order(&ws_dir.join(p)).ranks()),
        };
        if let Some(&r) = ranks.get(&name.to_lowercase()) {
            out.insert(path.clone(), r);
        }
    }
    (top.manual, out)
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
        tags: m.tags.clone(),
        priority: m.priority,
    }
}

/// 生成形如 `20260926-153012` 的 id，同一秒内重复则追加 `-2`、`-3`…
fn unique_id(dir: &Path, meta: &MetaFile) -> String {
    let base = Local::now().format("%Y%m%d-%H%M%S").to_string();
    if !id_taken(dir, meta, &base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|id| !id_taken(dir, meta, id))
        .expect("infinite iterator")
}

/// 项目目录 dir 里 id 已经有人用了：元数据里有、有这个 .md，或者有这个附件目录（外部留下的、没有对应待办的）
fn id_taken(dir: &Path, meta: &MetaFile, id: &str) -> bool {
    meta.find(id).is_some() || dir.join(format!("{id}.md")).exists() || assets_dir(dir, id).exists()
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
// 标签
// ---------------------------------------------------------------------------

/// 规整一个标签名：去掉首尾空白和开头的 #（全角的 ＃ 也算，「#工作」就是「工作」）；不能为空、不超过 20 个字，
/// 不能有逗号（半角、全角）和换行
pub fn clean_tag(raw: &str) -> Result<String> {
    let tag = raw.trim().trim_start_matches(['#', '＃']).trim();
    if tag.is_empty() {
        return Err("标签不能为空".into());
    }
    if tag.chars().count() > MAX_TAG_CHARS {
        return Err(format!("标签不能超过 {MAX_TAG_CHARS} 个字"));
    }
    if tag.chars().any(|c| c == ',' || c == '，' || c.is_control()) {
        return Err("标签里不能有逗号和换行".into());
    }
    Ok(tag.to_string())
}

/// 两个标签算同一个：不区分大小写
fn same_tag(a: &str, b: &str) -> bool {
    a == b || a.to_lowercase() == b.to_lowercase()
}

/// 不区分大小写地去重，保留先出现的（和它的写法），顺序不变
fn clean_tags(tags: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        if !out.iter().any(|x| same_tag(x, &t)) {
            out.push(t);
        }
    }
    out
}

/// 一条待办的标签里的 from（不区分大小写）改名成 to：已经有 to 的（不区分大小写，不是 from 自己）去掉 from，
/// 就是合并到 to；只改大小写的换成新的写法。返回改了没有
fn rename_tag_in(tags: &mut Vec<String>, from: &str, to: &str) -> bool {
    let Some(i) = tags.iter().position(|t| same_tag(t, from)) else {
        return false;
    };
    if tags.iter().enumerate().any(|(j, t)| j != i && same_tag(t, to)) {
        tags.remove(i);
        return true;
    }
    if tags[i] == to {
        return false;
    }
    tags[i] = to.to_string();
    true
}

// ---------------------------------------------------------------------------
// 名称校验（Windows 文件名规则）
// ---------------------------------------------------------------------------

const INVALID_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// 访问已有条目时的宽松校验：只防路径穿越和非法字符
pub(crate) fn check_component(name: &str, what: &str) -> Result<()> {
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
    if is_reserved_name(name) {
        return Err(format!("“{name}”是 Windows 保留名称，请换一个"));
    }
    Ok(name.to_string())
}

/// Windows 的保留名称（CON、NUL、COM1 等，带扩展名的也算），不能用作文件名
pub(crate) fn is_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end().to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit())
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
    fs::create_dir(&dir).map_err(|e| format!("创建{what}失败：{e}"))?;
    note_own(&dir);
    Ok(())
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
        .map_err(|e| format!("重命名失败，可能有文件正被其他程序占用：{e}"))?;
    note_own(dir);
    note_own(&target);
    Ok(())
}

/// 先写临时文件再替换，避免写到一半崩溃留下残缺文件；
/// 目标被其他程序以不允许替换的方式打开时退回直接覆盖写。写好后记下是软件自己写的（临时文件监听时本来就不算）
pub(crate) fn atomic_write(path: &Path, data: &[u8]) -> io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    fs::write(&tmp, data)?;
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
        fs::write(path, data)?;
    }
    note_own(path);
    Ok(())
}

// ---------------------------------------------------------------------------
// 图片（附件目录）
// ---------------------------------------------------------------------------

/// 项目目录 dir 里待办 id 的附件目录
fn assets_dir(dir: &Path, id: &str) -> PathBuf {
    dir.join(ASSETS_DIR).join(id)
}

/// 附件目录里的图片写进正文的地址：相对于 .md 文件，用 /（Typora、VS Code 都认）
fn asset_link(id: &str, name: &str) -> String {
    format!("{ASSETS_DIR}/{id}/{name}")
}

fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}

/// 把附件目录 from 移到 to（to 的上级 `.assets` 不在时先建）；from 不在时什么都不做，返回 false
fn move_assets(from: &Path, to: &Path) -> io::Result<bool> {
    if !from.is_dir() {
        return Ok(false);
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(from, to)?;
    Ok(true)
}

/// 项目目录 dir 里的 `.assets` 空了（待办移走、删除了）时删掉，不在资源管理器里留个空文件夹；不空时什么都不做
fn remove_empty_assets(dir: &Path) {
    let _ = fs::remove_dir(dir.join(ASSETS_DIR));
}

/// 复制整个文件夹（另存为新待办时复制附件目录）
fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// 两个文件的内容一样（拖进来的图片和附件目录里已有的同名文件）
fn same_content(a: &Path, b: &Path) -> bool {
    let len = |p: &Path| fs::metadata(p).map(|m| m.len()).ok();
    len(a).is_some() && len(a) == len(b) && fs::read(a).ok().is_some_and(|x| fs::read(b).ok() == Some(x))
}

/// stem.ext、stem-2.ext、stem-3.ext…（ext 为空时没有扩展名）
fn numbered_names<'a>(stem: &'a str, ext: &'a str) -> impl Iterator<Item = String> + 'a {
    (1..).map(move |n| {
        let stem = if n == 1 { stem.to_string() } else { format!("{stem}-{n}") };
        if ext.is_empty() { stem } else { format!("{stem}.{ext}") }
    })
}

/// 拖进来的文件的名字（不含扩展名）用作附件目录里的文件名：Windows 文件名里不能用的字符、控制字符和 #（Markdown
/// 里会被当成网址的锚点）换成 _，去掉首尾的空白和点；是保留名称（CON 等）的后面加 _，空了的叫「图片」
fn clean_file_stem(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|c| if INVALID_CHARS.contains(&c) || c == '#' || c.is_control() { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() {
        return "图片".into();
    }
    if is_reserved_name(cleaned) {
        return format!("{cleaned}_");
    }
    cleaned.to_string()
}

/// 去掉路径里的 . 和 ..（不碰磁盘，不解析快捷方式）；.. 到了根目录就不再往上
fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// 百分号转义 id 时不转的字符（同网址里的 unreserved）
const LINK_SAFE: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');

/// 正文 text 里地址以 `.assets/{old}/`（或 `./.assets/{old}/`）开头的改成 `.assets/{new}/`，别处不动；没有要改的返回 None。
/// 地址的开头：前面是 `(`、`<`（`![](…)`、`![](<…>)`）、引号（HTML 的 `src="…"`）、空白（`[引用]: 地址`）或正文开头。
/// id 里有空格、中文时别的程序可能写成 %20 之类的转义，也认；写成 \ 分隔的也认
pub(crate) fn rewrite_asset_links(text: &str, old: &str, new: &str) -> Option<String> {
    if old == new {
        return None;
    }
    let encode = |id: &str| utf8_percent_encode(id, LINK_SAFE).to_string();
    let mut pairs: Vec<(String, String)> = Vec::new();
    for (from, to) in [
        (format!("{ASSETS_DIR}/{old}/"), format!("{ASSETS_DIR}/{new}/")),
        (format!("{ASSETS_DIR}/{}/", old.replace(' ', "%20")), format!("{ASSETS_DIR}/{}/", new.replace(' ', "%20"))),
        (format!("{ASSETS_DIR}/{}/", encode(old)), format!("{ASSETS_DIR}/{}/", encode(new))),
        (format!("{ASSETS_DIR}\\{old}\\"), format!("{ASSETS_DIR}\\{new}\\")),
    ] {
        if !pairs.iter().any(|(f, _)| *f == from) {
            pairs.push((from, to));
        }
    }
    let at_link_start = |before: &str| {
        let before = before.strip_suffix("./").or_else(|| before.strip_suffix(".\\")).unwrap_or(before);
        before.chars().next_back().is_none_or(|c| matches!(c, '(' | '<' | '"' | '\'') || c.is_whitespace())
    };
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for (at, _) in text.match_indices(ASSETS_DIR) {
        if at < copied || !at_link_start(&text[..at]) {
            continue;
        }
        if let Some((from, to)) = pairs.iter().find(|(f, _)| text[at..].starts_with(f.as_str())) {
            out.push_str(&text[copied..at]);
            out.push_str(to);
            copied = at + from.len();
        }
    }
    if copied == 0 {
        return None;
    }
    out.push_str(&text[copied..]);
    Some(out)
}

/// 待办换了 id（移动、恢复时重名）后，正文 path 里指向原来附件目录的地址改成新的 id（rewrite_asset_links）。
/// 是软件自己的写入：.md 的修改时间留着原来的（移动、恢复不算修改），记进 OwnWrites。只改 UTF-8 的正文，
/// 换行和开头的 BOM 原样留着；读写失败时不改（图片显示不出来，正文不受影响）
fn relink_assets(path: &Path, old: &str, new: &str) {
    const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
    let Ok(bytes) = fs::read(path) else { return };
    let body = bytes.strip_prefix(BOM).unwrap_or(&bytes);
    let Ok(text) = std::str::from_utf8(body) else { return };
    let Some(relinked) = rewrite_asset_links(text, old, new) else { return };
    let modified = fs::metadata(path).and_then(|m| m.modified()).ok();
    let head: &[u8] = if body.len() < bytes.len() { BOM } else { &[] };
    if atomic_write(path, &[head, relinked.as_bytes()].concat()).is_err() {
        return;
    }
    if let Some(t) = modified {
        if let Ok(f) = File::options().write(true).open(path) {
            let _ = f.set_modified(t);
        }
    }
    note_own(path);
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
// 软件自己的写入：监听数据目录时据此认出自己写的，不引起刷新（见 watch.rs）
// ---------------------------------------------------------------------------

/// 一个路径现在的样子：文件看修改时间和大小，文件夹只看在不在（里面增删东西时它的修改时间也变）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PathState {
    File { modified: Option<SystemTime>, len: u64 },
    Dir,
    Absent,
}

impl PathState {
    pub(crate) fn of(path: &Path) -> Self {
        match fs::metadata(path) {
            Ok(md) if md.is_dir() => PathState::Dir,
            Ok(md) => PathState::File { modified: md.modified().ok(), len: md.len() },
            Err(_) => PathState::Absent,
        }
    }
}

/// 软件自己刚写过（新建、改写、改名、移走、删除）的文件和文件夹，写完时是什么样子。监听到某个路径变了、
/// 它现在的样子和这里记下的一样，就是自己写的；不一样（之后外部又改了）时忘掉，之后这个路径的变化都算外部的。
/// 只认 OWN_WRITE_TTL 之内写的
#[derive(Debug, Default)]
pub(crate) struct OwnWrites {
    /// 路径（统一了大小写和分隔符）→ 写过的路径、写完时的样子、什么时候写的
    seen: BTreeMap<String, (PathBuf, PathState, Instant)>,
}

/// 记得太多时清掉过期的
const OWN_WRITES_PRUNE: usize = 256;

impl OwnWrites {
    pub(crate) const fn new() -> Self {
        Self { seen: BTreeMap::new() }
    }

    /// 记下 path 在 at 时（刚写完）的样子。新建、改名、移走、删掉的是文件夹时，之前记下的它里面的文件、文件夹也跟着
    /// 变了样子，按现在的样子重新记：比如刚移进来的待办随即连同项目改了名、删掉又恢复了，那时移进来的变化还没报，
    /// 报的时候它已经不在原处、或者又回来了
    pub(crate) fn note(&mut self, path: &Path, state: PathState, at: Instant) {
        if self.seen.len() >= OWN_WRITES_PRUNE {
            self.seen.retain(|_, (_, _, t)| at.saturating_duration_since(*t) < OWN_WRITE_TTL);
        }
        let key = own_key(path);
        let inside = format!("{key}\\");
        for (k, (p, s, t)) in self.seen.range_mut(inside.clone()..) {
            if !k.starts_with(&inside) {
                break;
            }
            *s = PathState::of(p);
            *t = at;
        }
        self.seen.insert(key, (path.to_path_buf(), state, at));
    }

    /// path 在 at 时的样子 now 是不是软件自己写成的
    pub(crate) fn is_own(&mut self, path: &Path, now: PathState, at: Instant) -> bool {
        let key = own_key(path);
        let Some((_, state, t)) = self.seen.get(&key) else { return false };
        if *state == now && at.saturating_duration_since(*t) < OWN_WRITE_TTL {
            return true;
        }
        self.seen.remove(&key);
        false
    }
}

/// Windows 的路径不分大小写，/ 和 \ 都是分隔符
fn own_key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// 整个程序只有一个数据目录，所有写入（包括设置文件、界面状态）都记在这一份里，监听线程从这里查
static OWN_WRITES: Mutex<OwnWrites> = Mutex::new(OwnWrites::new());

pub(crate) fn own_writes() -> MutexGuard<'static, OwnWrites> {
    OWN_WRITES.lock().unwrap_or_else(|e| e.into_inner())
}

/// 记下软件自己刚写过 path（文件或文件夹；移走、删掉了的记成不在）
fn note_own(path: &Path) {
    let state = PathState::of(path);
    own_writes().note(path, state, Instant::now());
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
    fn tag_rules() {
        assert_eq!(clean_tag("  工作 ").unwrap(), "工作");
        // 开头的 #（全角的也算）去掉
        assert_eq!(clean_tag("#等回复").unwrap(), "等回复");
        assert_eq!(clean_tag("＃ 等回复").unwrap(), "等回复");
        assert_eq!(clean_tag("C#").unwrap(), "C#");
        assert!(clean_tag("").is_err());
        assert!(clean_tag(" # ").is_err());
        assert_eq!(clean_tag(&"字".repeat(20)).unwrap().chars().count(), 20);
        assert!(clean_tag(&"字".repeat(21)).is_err());
        for bad in ["a,b", "a，b", "第一行\n第二行", "a\tb"] {
            assert!(clean_tag(bad).is_err(), "{bad}");
        }
        // 不区分大小写地去重，保留先加的写法
        let tags = clean_tags(["work", "工作", "Work", "WORK", "工作"].map(String::from));
        assert_eq!(tags, ["work", "工作"]);
    }

    #[test]
    fn tags_and_priority_keep_updated_time_and_move_along() {
        let (_tmp, s) = store("tags");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        s.create_project("w", "q").unwrap();
        let t = s.create_todo("w", "p", "周报", "").unwrap();
        assert!(t.tags.is_empty() && t.priority == 0);
        let tagged = s.set_todo_tags("w", "p", &t.id, &[" #工作".into(), "等回复".into(), "工作".into()]).unwrap();
        assert_eq!(tagged.tags, ["工作", "等回复"]);
        // 改标签、优先级不算修改了这条待办
        assert_eq!(tagged.updated_at, t.updated_at);
        let high = s.set_todo_priority("w", "p", &t.id, 3).unwrap();
        assert_eq!((high.priority, high.updated_at), (3, t.updated_at));
        let text = fs::read_to_string(s.project_path("w", "p").unwrap().join(META_FILE)).unwrap();
        assert!(text.contains(r#""priority": 3"#) && text.contains("等回复"), "{text}");
        // 有不合规则的标签时什么都不改
        assert!(s.set_todo_tags("w", "p", &t.id, &["新的".into(), "a,b".into()]).is_err());
        assert!(s.set_todo_priority("w", "p", &t.id, 4).is_err());
        let now = &s.load_workspace("w").unwrap().projects[0].todos[0];
        assert_eq!((now.tags.clone(), now.priority), (vec!["工作".to_string(), "等回复".to_string()], 3));
        // 移到别的项目后还在
        let moved = s.move_todo("w", "p", &t.id, "w", "q").unwrap();
        assert_eq!((moved.tags.clone(), moved.priority), (vec!["工作".to_string(), "等回复".to_string()], 3));
        // 去掉后不写这两项
        s.set_todo_tags("w", "q", &moved.id, &[]).unwrap();
        s.set_todo_priority("w", "q", &moved.id, 0).unwrap();
        let text = fs::read_to_string(s.project_path("w", "q").unwrap().join(META_FILE)).unwrap();
        assert!(!text.contains("tags") && !text.contains("priority"), "{text}");
    }

    #[test]
    fn hand_edited_tags_and_priority_are_read_leniently() {
        let (_tmp, s) = store("tags-lenient");
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        let dir = s.project_path("w", "p").unwrap();
        for id in ["a", "b", "c"] {
            fs::write(dir.join(format!("{id}.md")), "").unwrap();
        }
        let meta = r##"{"version":1,"todos":[
            {"id":"a","title":"甲","tags":["#工作"," 工作 ",3,"a,b","","等回复"],"priority":2},
            {"id":"b","title":"乙","tags":"工作","priority":"高"},
            {"id":"c","title":"丙","priority":7}
        ]}"##;
        fs::write(dir.join(META_FILE), meta).unwrap();
        let todos = s.load_workspace("w").unwrap().projects.remove(0).todos;
        let get = |id: &str| todos.iter().find(|t| t.id == id).unwrap();
        // 不是当成损坏的元数据重建：标题都还在
        assert_eq!(get("a").title, "甲");
        assert_eq!((get("a").tags.clone(), get("a").priority), (vec!["工作".to_string(), "等回复".to_string()], 2));
        assert_eq!((get("b").title.as_str(), get("b").tags.len(), get("b").priority), ("乙", 0, 0));
        assert_eq!((get("c").title.as_str(), get("c").priority), ("丙", 0));
        assert!(!fs::read_dir(&dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("broken")));
    }

    #[test]
    fn rename_and_remove_tags_in_shown_workspaces() {
        let (_tmp, s) = store("tags-rename");
        for ws in ["甲", "乙", "丙"] {
            s.create_workspace(ws).unwrap();
            s.create_project(ws, "p").unwrap();
        }
        s.create_sub_project("甲", "p", "子").unwrap();
        let tag = |ws: &str, p: &str, tags: &[&str]| {
            let t = s.create_todo(ws, p, "", "").unwrap();
            s.set_todo_tags(ws, p, &t.id, &tags.iter().map(|x| x.to_string()).collect::<Vec<_>>()).unwrap()
        };
        let a = tag("甲", "p", &["工作", "急"]);
        let b = tag("甲", "p/子", &["Work"]);
        let c = tag("乙", "p", &["work", "办公"]);
        let d = tag("丙", "p", &["工作"]);
        let tags_of = |ws: &str, p: &str, id: &str| {
            let tree = s.load_workspace(ws).unwrap();
            let t = tree.projects.iter().find(|x| x.name == p).unwrap().todos.iter().find(|x| x.id == id).unwrap().clone();
            (t.tags, t.updated_at)
        };
        let shown = ["甲".to_string(), "乙".to_string(), "不在的".to_string()];
        // 不区分大小写地找，改成新名字；已经有新名字的（乙）去掉旧的，就是合并
        assert_eq!(s.rename_tag(&shown, "WORK", "办公").unwrap(), 2);
        assert_eq!(tags_of("甲", "p/子", &b.id), (vec!["办公".to_string()], b.updated_at));
        assert_eq!(tags_of("乙", "p", &c.id).0, ["办公"]);
        assert_eq!(s.rename_tag(&shown, "工作", " #事务 ").unwrap(), 1);
        assert_eq!(tags_of("甲", "p", &a.id), (vec!["事务".to_string(), "急".to_string()], a.updated_at));
        // 改成一样的什么都不改；新名字不合规则时不改
        assert_eq!(s.rename_tag(&shown, "急", "急").unwrap(), 0);
        assert!(s.rename_tag(&shown, "急", "a,b").is_err());
        // 没显示在侧栏的工作区不动
        assert_eq!(tags_of("丙", "p", &d.id).0, ["工作"]);
        assert_eq!(s.remove_tag(&shown, "办公").unwrap(), 2);
        assert!(tags_of("甲", "p/子", &b.id).0.is_empty());
        assert!(tags_of("乙", "p", &c.id).0.is_empty());
        assert_eq!(tags_of("甲", "p", &a.id).0, ["事务", "急"]);
        assert_eq!(s.remove_tag(&shown, "没有的").unwrap(), 0);
    }

    #[test]
    fn renaming_a_tag_in_one_todo() {
        let mut tags = vec!["工作".to_string(), "急".to_string()];
        assert!(rename_tag_in(&mut tags, "工作", "Work"));
        assert_eq!(tags, ["Work", "急"]);
        // 只改大小写：换成新的写法
        assert!(rename_tag_in(&mut tags, "work", "WORK"));
        assert_eq!(tags, ["WORK", "急"]);
        // 改成已有的：合并，留着已有的那个（和它的位置）
        assert!(rename_tag_in(&mut tags, "work", "急"));
        assert_eq!(tags, ["急"]);
        assert!(!rename_tag_in(&mut tags, "没有的", "x"));
        assert!(!rename_tag_in(&mut tags, "急", "急"));
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
        s.set_todo_tags("w", "p", &t.id, &["工作".into(), "等回复".into()]).unwrap();
        s.set_todo_priority("w", "p", &t.id, 2).unwrap();
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
        // 标签、优先级也还原
        assert_eq!(after.tags, ["工作", "等回复"]);
        assert_eq!(after.priority, 2);
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
            tags: Vec::new(),
            priority: 0,
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

        assert!(s.move_project("甲", "项目", "甲", None, None).is_err());
        assert!(s.move_project("甲", "重名", "乙", None, None).is_err());
        assert!(s.move_project("甲", "不存在", "乙", None, None).is_err());
        assert!(s.move_project("甲", "项目", "丙", None, None).is_err());
        assert_eq!(s.move_project("甲", "项目", "乙", None, None).unwrap(), "项目");

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
        assert_eq!(s.move_project("甲", "日常", "甲", Some("需求"), None).unwrap(), "需求/日常");
        assert!(s.read_todo("甲", "需求/日常", &t.id).is_ok());
        // 子项目移出来到顶层
        assert_eq!(s.move_project("甲", "需求/日常", "甲", None, None).unwrap(), "日常");
        // 子项目移到别的工作区的项目里
        assert_eq!(s.move_project("甲", "需求/前端", "乙", Some("重名"), None).unwrap(), "重名/前端");
        // 有子项目的项目整个移到别的工作区顶层，子项目跟着
        s.create_sub_project("甲", "需求", "后端").unwrap();
        assert_eq!(s.move_project("甲", "需求", "乙", None, None).unwrap(), "需求");
        assert!(project_names(&s, "乙").contains(&"需求/后端".to_string()));

        // 不行的：有子项目的放进别的项目、放进子项目、放进自己、已经在那里、重名
        assert!(s.move_project("乙", "需求", "乙", Some("重名"), None).is_err());
        assert!(s.move_project("甲", "日常", "乙", Some("需求/后端"), None).is_err());
        assert!(s.move_project("甲", "日常", "甲", Some("日常"), None).is_err());
        assert!(s.move_project("乙", "重名/前端", "乙", Some("重名"), None).is_err());
        assert!(s.move_project("甲", "日常", "甲", None, None).is_err());
        assert!(s.move_project("甲", "零散", "乙", Some("重名"), None).is_err());
        assert!(s.move_project("甲", "日常", "乙", Some("不存在"), None).is_err());
        assert!(s.read_todo("甲", "日常", &t.id).is_ok());
    }

    /// 各项目在它那一层的顺序里排第几（没排过的是 None），和工作区是不是手动排序
    fn ranks(s: &Store, ws: &str) -> (bool, Vec<(String, Option<i64>)>) {
        let tree = s.load_workspace(ws).unwrap();
        let mut out: Vec<_> = tree.projects.into_iter().map(|p| (p.name, p.order)).collect();
        out.sort();
        (tree.manual_order, out)
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|n| n.to_string()).collect()
    }

    fn order_file(s: &Store, rel: &str) -> serde_json::Value {
        serde_json::from_slice(&fs::read(s.root().join(rel).join(ORDER_FILE)).unwrap()).unwrap()
    }

    // requirements.md「项目的顺序」：每层一个顺序，存在那一层的文件夹里；没排过的排在后面；改名后位置不变，
    // 移走、删除后去掉，移过去时按放下的位置，没指定位置的、恢复的、新建的是没排过的
    #[test]
    fn project_order_follows_renames_moves_and_deletes() {
        let (_tmp, s) = store("project-order");
        s.create_workspace("w").unwrap();
        for p in ["乙", "甲", "丙"] {
            s.create_project("w", p).unwrap();
        }
        // 没调整过：按名称，都没排过
        assert_eq!(ranks(&s, "w"), (false, vec![("丙".into(), None), ("乙".into(), None), ("甲".into(), None)]));
        assert!(!s.root().join("w").join(ORDER_FILE).exists());

        // 调整顶层的顺序：工作区改成手动排序，记在工作区文件夹的 .projects.json 里
        s.reorder_projects("w", None, &names(&["丙", "甲", "乙"])).unwrap();
        assert_eq!(ranks(&s, "w"), (true, vec![("丙".into(), Some(0)), ("乙".into(), Some(2)), ("甲".into(), Some(1))]));
        assert_eq!(order_file(&s, "w"), serde_json::json!({ "version": 1, "manual": true, "order": ["丙", "甲", "乙"] }));

        // 新建的没排过；改名后位置不变（只改大小写也是）
        s.create_project("w", "丁").unwrap();
        s.rename_project("w", "甲", "甲二").unwrap();
        s.create_project("w", "abc").unwrap();
        s.reorder_projects("w", None, &names(&["丙", "abc", "甲二", "乙", "丁"])).unwrap();
        s.rename_project("w", "abc", "ABC").unwrap();
        let (_, r) = ranks(&s, "w");
        assert_eq!(r, [("ABC".into(), Some(1)), ("丁".into(), Some(4)), ("丙".into(), Some(0)), ("乙".into(), Some(3)), ("甲二".into(), Some(2))]);

        // 子项目的顺序记在父项目文件夹里
        s.create_sub_project("w", "乙", "前端").unwrap();
        s.create_sub_project("w", "乙", "后端").unwrap();
        s.reorder_projects("w", Some("乙"), &names(&["后端", "前端"])).unwrap();
        assert_eq!(order_file(&s, "w/乙"), serde_json::json!({ "version": 1, "order": ["后端", "前端"] }));
        assert!(s.reorder_projects("w", Some("乙/前端"), &names(&["x"])).is_err());

        // 顶层项目放进父项目、放在指定的位置：原来那一层去掉它，新的那一层按给的顺序
        assert_eq!(s.move_project("w", "丁", "w", Some("乙"), Some(&names(&["后端", "丁", "前端"]))).unwrap(), "乙/丁");
        assert_eq!(order_file(&s, "w/乙")["order"], serde_json::json!(["后端", "丁", "前端"]));
        assert_eq!(order_file(&s, "w")["order"], serde_json::json!(["丙", "ABC", "甲二", "乙"]));
        // 没指定位置的（右键「移动到」）：在那里没排过
        s.move_project("w", "乙/前端", "w", None, None).unwrap();
        let (_, r) = ranks(&s, "w");
        assert!(r.contains(&("前端".into(), None)) && r.contains(&("乙/丁".into(), Some(1))), "{r:?}");
        assert_eq!(order_file(&s, "w/乙")["order"], serde_json::json!(["后端", "丁"]));

        // 删除后去掉；恢复的没排过
        let rid = s.delete_project("w", "丙").unwrap();
        assert_eq!(order_file(&s, "w")["order"], serde_json::json!(["ABC", "甲二", "乙"]));
        assert!(s.restore(&[rid]).errors.is_empty());
        assert!(ranks(&s, "w").1.contains(&("丙".into(), None)));

        // 父项目连同子项目的顺序移到别的工作区；那边还没调整过，移过去的没排过
        s.create_workspace("v").unwrap();
        s.move_project("w", "乙", "v", None, None).unwrap();
        assert_eq!(ranks(&s, "v"), (false, vec![("乙".into(), None), ("乙/丁".into(), Some(1)), ("乙/后端".into(), Some(0))]));
        // 列出项目（快速记录用）也带着顺序
        let listed = s.list_projects().unwrap().into_iter().find(|w| w.name == "v").unwrap();
        assert!(!listed.manual_order);
        assert_eq!(listed.order.into_iter().collect::<Vec<_>>(), [("乙/丁".to_string(), 1), ("乙/后端".to_string(), 0)]);
        // 放进那个项目、指定了位置：那个工作区改成手动排序
        s.move_project("w", "前端", "v", Some("乙"), Some(&names(&["前端", "后端", "丁"]))).unwrap();
        let (manual, r) = ranks(&s, "v");
        assert!(manual);
        assert!(r.contains(&("乙/前端".into(), Some(0))) && r.contains(&("乙/丁".into(), Some(2))), "{r:?}");

        // 成了子项目的，它原来记着的子项目的顺序去掉
        s.create_sub_project("w", "甲二", "x").unwrap();
        s.reorder_projects("w", Some("甲二"), &names(&["x"])).unwrap();
        s.move_project("w", "甲二/x", "w", None, None).unwrap();
        assert!(!s.root().join("w/甲二").join(ORDER_FILE).exists(), "没有要记的了，删掉文件");
        fs::write(s.root().join("w/ABC").join(ORDER_FILE), r#"{"order":["旧的"]}"#).unwrap();
        s.move_project("w", "ABC", "w", Some("甲二"), None).unwrap();
        assert!(!s.root().join("w/甲二/ABC").join(ORDER_FILE).exists());
    }

    #[test]
    fn project_order_by_name_and_back() {
        let (_tmp, s) = store("project-order-mode");
        s.create_workspace("w").unwrap();
        for p in ["甲", "乙", "丙"] {
            s.create_project("w", p).unwrap();
        }
        s.create_sub_project("w", "甲", "a").unwrap();
        s.create_sub_project("w", "甲", "b").unwrap();
        s.create_sub_project("w", "乙", "c").unwrap();
        s.create_sub_project("w", "乙", "d").unwrap();
        s.reorder_projects("w", None, &names(&["丙", "乙", "甲"])).unwrap();
        s.reorder_projects("w", Some("甲"), &names(&["b", "a"])).unwrap();
        s.reorder_projects("w", Some("乙"), &names(&["d", "c"])).unwrap();

        // 换成按名称：顺序留着；换回手动排序时恢复
        s.set_projects_manual("w", false).unwrap();
        let (manual, r) = ranks(&s, "w");
        assert!(!manual && r.contains(&("丙".into(), Some(0))) && r.contains(&("甲/b".into(), Some(0))), "{r:?}");
        s.set_projects_manual("w", true).unwrap();
        assert!(ranks(&s, "w").0);

        // 按名称时调整一层：从按名字的顺序重新排，别的层留着的旧顺序不再用
        s.set_projects_manual("w", false).unwrap();
        s.reorder_projects("w", Some("乙"), &names(&["c", "d"])).unwrap();
        let (manual, r) = ranks(&s, "w");
        assert!(manual);
        assert_eq!(
            r,
            [
                ("丙".into(), None),
                ("乙".into(), None),
                ("乙/c".into(), Some(0)),
                ("乙/d".into(), Some(1)),
                ("甲".into(), None),
                ("甲/a".into(), None),
                ("甲/b".into(), None),
            ]
        );
        assert!(!s.root().join("w/甲").join(ORDER_FILE).exists());
        assert_eq!(order_file(&s, "w"), serde_json::json!({ "version": 1, "manual": true, "order": [] }));
    }

    #[test]
    fn hand_edited_project_order_is_read_leniently() {
        let (_tmp, s) = store("project-order-lenient");
        s.create_workspace("w").unwrap();
        for p in ["甲", "乙"] {
            s.create_project("w", p).unwrap();
        }
        let file = s.root().join("w").join(ORDER_FILE);
        // 不是 JSON、不是对象：当成没有，照常按名称
        for bad in ["坏了", "[1, 2]", "", r#"{"order": "甲"}"#] {
            fs::write(&file, bad).unwrap();
            assert_eq!(ranks(&s, "w"), (false, vec![("乙".into(), None), ("甲".into(), None)]), "{bad}");
        }
        // 读不懂的项去掉，别的照用；没有对应项目的名字不算，名字不分大小写
        fs::write(&file, r#"{"manual": "是", "order": ["不在的", 3, "乙", "甲"]}"#).unwrap();
        assert_eq!(ranks(&s, "w"), (false, vec![("乙".into(), Some(1)), ("甲".into(), Some(2))]));
        fs::write(&file, "\u{feff}{\"manual\": true, \"order\": [\"甲\"]}").unwrap();
        assert_eq!(ranks(&s, "w"), (true, vec![("乙".into(), None), ("甲".into(), Some(0))]));
        // 写的时候去掉没有对应项目的名字和重复的
        fs::write(&file, r#"{"manual": true, "order": ["不在的", "乙", "乙"]}"#).unwrap();
        s.create_project("w", "丙").unwrap();
        s.rename_project("w", "乙", "乙二").unwrap();
        assert_eq!(order_file(&s, "w"), serde_json::json!({ "version": 1, "manual": true, "order": ["乙二"] }));
        // 新建的项目和记着的旧名字（外部删掉的）同名时，新建的没排过
        fs::write(&file, r#"{"manual": true, "order": ["丁", "乙二"]}"#).unwrap();
        s.create_project("w", "丁").unwrap();
        assert!(ranks(&s, "w").1.contains(&("丁".into(), None)));
        // .projects.json 不是项目、不是待办
        assert_eq!(project_names(&s, "w").len(), 4);
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
    fn create_todo_creating_missing_project() {
        let (_tmp, s) = store("create-creating");
        // 离开待办时存不上、原来的项目也不在了：另存到快速记录存到的项目，工作区、项目不在时先建；
        // 标题、正文原样存（不像快速记录那样拆第一行）
        let mine = "第一行\n\n第二段  \n";
        let t = s.create_todo_creating_project("收件箱", "快速记录", "周报（我的版本）", mine, None).unwrap();
        assert_eq!(t.title, "周报（我的版本）");
        assert_eq!(s.read_todo("收件箱", "快速记录", &t.id).unwrap().content, mine);
        // 已经在：直接加进去；子项目也行
        s.create_todo_creating_project("收件箱", "快速记录", "第二条", "", None).unwrap();
        assert_eq!(s.load_workspace("收件箱").unwrap().projects[0].todos.len(), 2);
        let sub = s.create_todo_creating_project("收件箱", "灵感/产品", "子项目里", "x", None).unwrap();
        assert_eq!(s.read_todo("收件箱", "灵感/产品", &sub.id).unwrap().content, "x");
        assert!(s.create_todo_creating_project("收件箱", "a\\b", "标题", "x", None).is_err());
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

    /// 恢复待办数据用的「备份里的内容」：一个工作区、一条待办，加上界面状态
    fn staged_backup(tmp: &TempRoot) -> PathBuf {
        let staged = tmp.0.join("staged");
        fs::create_dir_all(staged.join("备份的工作区").join("项目")).unwrap();
        fs::write(staged.join("备份的工作区").join("项目").join("备份的待办.md"), "备份里的正文").unwrap();
        fs::write(staged.join(UI_STATE_FILE), r#"{"from":"backup"}"#).unwrap();
        staged
    }

    #[test]
    fn replace_data_swaps_workspaces_and_state_only() {
        let (tmp, s) = store("replace");
        s.create_workspace("现在的").unwrap();
        s.create_project("现在的", "p").unwrap();
        let t = s.create_todo("现在的", "p", "要删的", "x").unwrap();
        s.delete_todo("现在的", "p", &t.id).unwrap();
        s.create_todo("现在的", "p", "留着的", "现在的正文").unwrap();
        s.write_ui_state(r#"{"from":"now"}"#).unwrap();
        fs::write(s.root().join(".settings.json"), "{}").unwrap();
        // 读一遍，缓存里有现在的
        assert_eq!(s.load_workspace("现在的").unwrap().projects[0].todos.len(), 1);
        let staged = staged_backup(&tmp);
        let old = s.root().join(".restoring-test").join("old");

        let mut seen = None;
        s.replace_data(&staged, &old, || {
            // 替换之前，现在的数据还在原处（这时把它备份一份）
            seen = Some(s.root().join("现在的").is_dir());
            Ok(())
        })
        .unwrap();
        assert_eq!(seen, Some(true));
        let names: Vec<String> = s.list_workspaces().unwrap().into_iter().map(|w| w.name).collect();
        assert_eq!(names, ["备份的工作区"]);
        let tree = s.load_workspace("备份的工作区").unwrap();
        assert_eq!(tree.projects[0].todos[0].preview, "备份里的正文");
        assert_eq!(s.read_ui_state().unwrap().as_deref(), Some(r#"{"from":"backup"}"#));
        // 回收站、设置文件不动；放原来数据的临时目录删掉了
        assert_eq!(s.list_recycle().unwrap().len(), 1);
        assert!(s.root().join(".settings.json").is_file());
        assert!(!old.exists());
        assert_eq!(count_data(s.root()).unwrap(), (1, 1));
    }

    #[test]
    fn replace_data_without_state_removes_current_state() {
        let (tmp, s) = store("replace-nostate");
        s.create_workspace("现在的").unwrap();
        s.write_ui_state("{}").unwrap();
        let staged = staged_backup(&tmp);
        fs::remove_file(staged.join(UI_STATE_FILE)).unwrap();
        s.replace_data(&staged, &tmp.0.join("old"), || Ok(())).unwrap();
        assert_eq!(s.read_ui_state().unwrap(), None);
    }

    #[test]
    fn replace_data_keeps_everything_when_it_fails() {
        let (tmp, s) = store("replace-fail");
        s.create_workspace("现在的").unwrap();
        s.create_project("现在的", "p").unwrap();
        s.create_todo("现在的", "p", "t", "现在的正文").unwrap();
        s.write_ui_state(r#"{"from":"now"}"#).unwrap();
        let staged = staged_backup(&tmp);
        let old = tmp.0.join("old");

        // 先备份现在的数据失败：什么都不动
        let err = s.replace_data(&staged, &old, || Err::<(), _>("磁盘满了".to_string())).unwrap_err();
        assert_eq!(err, "磁盘满了");
        assert!(s.root().join("现在的").is_dir() && staged.join("备份的工作区").is_dir());

        // 换到一半移不过去（数据目录里有个同名的文件挡着）：换回原来的
        fs::create_dir_all(staged.join("挡着的")).unwrap();
        fs::write(s.root().join("挡着的"), "不是文件夹").unwrap();
        let err = s.replace_data(&staged, &old, || Ok(())).unwrap_err();
        assert!(err.contains("「挡着的」") && err.contains("现在的数据没有改动"), "{err}");
        let names: Vec<String> = s.list_workspaces().unwrap().into_iter().map(|w| w.name).collect();
        assert_eq!(names, ["现在的"]);
        assert_eq!(s.read_ui_state().unwrap().as_deref(), Some(r#"{"from":"now"}"#));
        assert!(staged.join("备份的工作区").join("项目").join("备份的待办.md").is_file());
        assert!(fs::read_dir(&old).map_or(true, |mut d| d.next().is_none()));
        assert_eq!(fs::read_to_string(s.root().join("挡着的")).unwrap(), "不是文件夹");
    }

    /// Windows 上工作区里有文件正被别的程序独占打开时，这个工作区移不走：换回原来的，什么都不丢
    #[cfg(windows)]
    #[test]
    fn replace_data_when_a_file_is_in_use() {
        use std::os::windows::fs::OpenOptionsExt;
        let (tmp, s) = store("replace-locked");
        for ws in ["甲", "乙"] {
            s.create_workspace(ws).unwrap();
            s.create_project(ws, "p").unwrap();
            s.create_todo(ws, "p", "t", "现在的正文").unwrap();
        }
        let staged = staged_backup(&tmp);
        let busy = s.project_path("乙", "p").unwrap().join(META_FILE);
        let lock = OpenOptions::new().read(true).share_mode(0).open(&busy).unwrap();
        let err = s.replace_data(&staged, &tmp.0.join("old"), || Ok(())).unwrap_err();
        drop(lock);
        assert!(err.contains("正被其他程序占用") && err.contains("现在的数据没有改动"), "{err}");
        let mut names: Vec<String> = s.list_workspaces().unwrap().into_iter().map(|w| w.name).collect();
        names.sort();
        assert_eq!(names, ["乙", "甲"]);
        assert_eq!(s.load_workspace("甲").unwrap().projects[0].todos.len(), 1);
    }

    #[test]
    fn counts_workspaces_and_todos_like_the_home_page() {
        let (_tmp, s) = store("count");
        assert_eq!(count_data(s.root()).unwrap(), (0, 0));
        s.create_workspace("w").unwrap();
        s.create_workspace("空的").unwrap();
        s.create_project("w", "p").unwrap();
        s.create_sub_project("w", "p", "sub").unwrap();
        s.create_todo("w", "p", "a", "").unwrap();
        s.create_todo("w", "p/sub", "b", "").unwrap();
        // 不算：回收站、点开头的文件夹、临时文件、子项目里的文件夹
        let t = s.create_todo("w", "p", "c", "").unwrap();
        s.delete_todo("w", "p", &t.id).unwrap();
        let pdir = s.project_path("w", "p").unwrap();
        fs::create_dir_all(pdir.join(".assets")).unwrap();
        fs::write(pdir.join(".assets").join("x.md"), "").unwrap();
        fs::write(pdir.join(".x.md.tmp"), "").unwrap();
        fs::create_dir_all(pdir.join("sub").join("深").join("d.md")).unwrap();
        assert_eq!(count_data(s.root()).unwrap(), (2, 2));
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

    // ----- 图片（附件目录） -----

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n fake png";

    /// 工作区 w、项目 p（和 q）、p 里一条待办，返回它的 id
    fn with_todo(s: &Store, content: &str) -> String {
        s.create_workspace("w").unwrap();
        s.create_project("w", "p").unwrap();
        s.create_project("w", "q").unwrap();
        s.create_todo("w", "p", "有图的", content).unwrap().id
    }

    /// 在数据目录以外放一个文件（拖进来的图片），返回路径
    fn outside(tmp: &TempRoot, name: &str, data: &[u8]) -> PathBuf {
        let dir = tmp.0.join("桌面");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(name), data).unwrap();
        dir.join(name)
    }

    #[test]
    fn pasted_images_are_saved_in_the_todos_assets_folder() {
        let (_tmp, s) = store("img-paste");
        let id = with_todo(&s, "");
        let a = s.save_image("w", "p", &id, "PNG", PNG).unwrap();
        // 相对于 .md 的地址，名字是「图片-年月日-时分秒」，扩展名按格式（小写）
        let prefix = format!(".assets/{id}/图片-");
        assert!(a.link.starts_with(&prefix) && a.link.ends_with(".png"), "{}", a.link);
        assert_eq!((a.size, a.link.rsplit('/').next().unwrap()), (PNG.len() as u64, a.name.as_str()));
        let dir = s.project_path("w", "p").unwrap();
        assert_eq!(fs::read(dir.join(&a.link)).unwrap(), PNG);
        // 同一秒里再粘贴一张：不覆盖，名字后面加序号
        let b = s.save_image("w", "p", &id, "png", b"second").unwrap();
        assert_ne!(a.name, b.name);
        assert_eq!(fs::read(dir.join(&a.link)).unwrap(), PNG);
        assert_eq!(fs::read(dir.join(&b.link)).unwrap(), b"second");
        assert_eq!(numbered_names("图片-1", "png").take(3).collect::<Vec<_>>(), ["图片-1.png", "图片-1-2.png", "图片-1-3.png"]);
        // 不是图片的格式、不在的待办
        assert!(s.save_image("w", "p", &id, "exe", PNG).is_err());
        assert!(s.save_image("w", "p", "不在", "png", PNG).is_err());
        assert!(s.save_image("w", "p", "../x", "png", PNG).is_err());
    }

    #[test]
    fn dropped_images_are_copied_with_their_names() {
        let (tmp, s) = store("img-drop");
        let id = with_todo(&s, "");
        let src = outside(&tmp, "会议 截图#1.PNG", PNG);
        let a = s.import_image("w", "p", &id, &src).unwrap();
        // 保留原名，# 换成 _；原文件不动
        assert_eq!(a.link, format!(".assets/{id}/会议 截图_1.PNG"));
        assert!(src.is_file());
        let dir = s.project_path("w", "p").unwrap();
        assert_eq!(fs::read(dir.join(&a.link)).unwrap(), PNG);
        // 同一个文件再拖一次：内容一样，用已有的那个
        assert_eq!(s.import_image("w", "p", &id, &src).unwrap().link, a.link);
        // 同名、内容不一样：加序号
        let other = outside(&tmp, "会议 截图#1.PNG", b"different");
        assert_eq!(s.import_image("w", "p", &id, &other).unwrap().name, "会议 截图_1-2.PNG");
        // 不是图片、不在的
        let txt = outside(&tmp, "说明.txt", b"x");
        assert!(s.import_image("w", "p", &id, &txt).unwrap_err().contains("不是图片"));
        assert!(s.import_image("w", "p", &id, &tmp.0.join("没有.png")).unwrap_err().contains("找不到"));
        // 名字的规整
        assert_eq!(clean_file_stem("a<b>:c\"d|e?f*g"), "a_b__c_d_e_f_g");
        assert_eq!(clean_file_stem(" ..隐藏. "), "隐藏");
        assert_eq!(clean_file_stem("CON"), "CON_");
        assert_eq!(clean_file_stem("..."), "图片");
    }

    #[test]
    fn assets_folder_is_not_a_project_or_todo() {
        let (_tmp, s) = store("img-hidden");
        let id = with_todo(&s, "正文");
        s.save_image("w", "p", &id, "png", PNG).unwrap();
        s.create_sub_project("w", "p", "子").unwrap();
        let sub = s.create_todo("w", "p/子", "", "").unwrap();
        s.save_image("w", "p/子", &sub.id, "png", PNG).unwrap();
        // 附件目录里放一个 .md：不是待办，搜不到
        let dir = s.project_path("w", "p").unwrap();
        fs::write(dir.join(ASSETS_DIR).join(&id).join("笔记.md"), "独角兽").unwrap();
        let mut names = project_names(&s, "w");
        names.sort();
        assert_eq!(names, ["p", "p/子", "q"]);
        let tree = s.load_workspace("w").unwrap();
        assert_eq!(tree.projects.iter().map(|p| p.todos.len()).sum::<usize>(), 2);
        assert!(s.search(None, "独角兽").unwrap().is_empty());
        // 有附件目录的项目照样能放进别的项目（附件目录不算子项目）
        let in_q = s.create_todo("w", "q", "", "").unwrap();
        s.save_image("w", "q", &in_q.id, "png", PNG).unwrap();
        assert_eq!(s.move_project("w", "q", "w", Some("p"), None).unwrap(), "p/q");
        assert!(s.project_path("w", "p/q").unwrap().join(ASSETS_DIR).join(&in_q.id).is_dir());
        // 已经有附件目录（外部留下的）的 id 不再用
        let meta = MetaFile::default();
        assert!(id_taken(&dir, &meta, &id));
        fs::create_dir_all(dir.join(ASSETS_DIR).join("留下的")).unwrap();
        assert!(id_taken(&dir, &meta, "留下的") && !id_taken(&dir, &meta, "没有的"));
    }

    #[test]
    fn image_file_resolves_relative_and_absolute_paths() {
        let (tmp, s) = store("img-file");
        let id = with_todo(&s, "");
        let a = s.save_image("w", "p", &id, "png", PNG).unwrap();
        let dir = s.project_path("w", "p").unwrap();
        // 相对于项目文件夹（.md 所在的文件夹），去掉 . 和 ..
        let f = s.image_file("w", "p", &a.link).unwrap();
        assert_eq!(PathBuf::from(&f.path), dir.join(ASSETS_DIR).join(&id).join(&a.name));
        assert!(f.modified > 0);
        let messy = format!("./x/../{}", a.link);
        assert_eq!(s.image_file("w", "p", &messy).unwrap().path, f.path);
        // .assets 以外的：别的项目里的、数据目录以外的（绝对路径）
        fs::write(s.project_path("w", "q").unwrap().join("图.gif"), "gif").unwrap();
        let q = s.image_file("w", "p", "../q/图.gif").unwrap();
        assert_eq!(PathBuf::from(&q.path), s.project_path("w", "q").unwrap().join("图.gif"));
        let abs = outside(&tmp, "外面.JPG", b"jpg");
        assert_eq!(PathBuf::from(s.image_file("w", "p", &abs.to_string_lossy()).unwrap().path), abs);
        // 不在的、不是图片的
        assert_eq!(s.image_file("w", "p", ".assets/x/没有.png").unwrap_err(), "找不到图片");
        let txt = outside(&tmp, "说明.txt", b"x");
        assert_eq!(s.image_file("w", "p", &txt.to_string_lossy()).unwrap_err(), "不是图片文件");
        assert!(s.image_file("w", "没有的项目", &a.link).is_err());
        // .. 到了根目录不再往上
        let root = normalize_path(&tmp.0.join(format!("a/{}b.png", "../".repeat(40))));
        assert!(root.ends_with("b.png") && !root.components().any(|c| c == Component::ParentDir));
    }

    #[test]
    fn asset_links_are_rewritten_only_at_link_starts() {
        let text = [
            "![图](.assets/OLD/a.png) 和 ![有空格](<.assets/OLD/b c.png>)",
            "<img src=\"./.assets/OLD/c.png\" style=\"zoom:50%\">",
            "[ref]: .assets/OLD/d.png",
            ".assets/OLD/开头.png",
            "Windows 写法 ![](.assets\\OLD\\e.png)",
            "不动的：x.assets/OLD/1 other/.assets/OLD/2 ![](.assets/OLDER/3.png) ![](assets/OLD/4.png)",
        ]
        .join("\n");
        let out = rewrite_asset_links(&text, "OLD", "NEW").unwrap();
        let expected = [
            "![图](.assets/NEW/a.png) 和 ![有空格](<.assets/NEW/b c.png>)",
            "<img src=\"./.assets/NEW/c.png\" style=\"zoom:50%\">",
            "[ref]: .assets/NEW/d.png",
            ".assets/NEW/开头.png",
            "Windows 写法 ![](.assets\\NEW\\e.png)",
            "不动的：x.assets/OLD/1 other/.assets/OLD/2 ![](.assets/OLDER/3.png) ![](assets/OLD/4.png)",
        ]
        .join("\n");
        assert_eq!(out, expected);
        // 没有要改的
        assert_eq!(rewrite_asset_links("![](.assets/别的/a.png)", "OLD", "NEW"), None);
        assert_eq!(rewrite_asset_links("![](.assets/OLD/a.png)", "OLD", "OLD"), None);
        // id 里有空格、中文：别的程序写成转义的也认，换成同样写法的新 id
        let encoded = "![](.assets/会议%20纪要/a.png) ![](.assets/%E4%BC%9A%E8%AE%AE%20%E7%BA%AA%E8%A6%81/b.png)";
        assert_eq!(
            rewrite_asset_links(encoded, "会议 纪要", "会议 纪要-2").unwrap(),
            "![](.assets/会议%20纪要-2/a.png) ![](.assets/%E4%BC%9A%E8%AE%AE%20%E7%BA%AA%E8%A6%81-2/b.png)"
        );
    }

    #[test]
    fn assets_follow_moved_todos() {
        let (_tmp, s) = store("img-move");
        let id = with_todo(&s, "");
        let a = s.save_image("w", "p", &id, "png", PNG).unwrap();
        let content = format!("看图 ![]({})\n\r\n代码里的 `.assets/{id}/` 不是地址", a.link);
        s.save_todo_content("w", "p", &id, &content, None, false).unwrap();
        let p_dir = s.project_path("w", "p").unwrap();
        let q_dir = s.project_path("w", "q").unwrap();

        // 移到别的项目：附件目录一起过去，原来的 .assets 空了就删掉，正文不动
        let moved = s.move_todo("w", "p", &id, "w", "q").unwrap();
        assert_eq!(moved.id, id);
        assert!(!p_dir.join(ASSETS_DIR).exists());
        assert_eq!(fs::read(q_dir.join(&a.link)).unwrap(), PNG);
        assert_eq!(s.read_todo("w", "q", &id).unwrap().content, content.replace("\r\n", "\n"));

        // 那里重名、换了 id：附件目录改成新 id，正文里的地址跟着改（只改地址），修改时间不变
        fs::write(p_dir.join(format!("{id}.md")), "占着这个 id").unwrap();
        let before = fs::metadata(q_dir.join(format!("{id}.md"))).unwrap().modified().unwrap();
        let back = s.move_todo("w", "q", &id, "w", "p").unwrap();
        assert_ne!(back.id, id);
        let new_link = asset_link(&back.id, &a.name);
        assert_eq!(fs::read(p_dir.join(&new_link)).unwrap(), PNG);
        assert!(!q_dir.join(ASSETS_DIR).exists());
        let path = p_dir.join(format!("{}.md", back.id));
        // 换行原样留着（不把 \r\n 换成 \n）
        let raw = fs::read_to_string(&path).unwrap();
        assert_eq!(raw, format!("看图 ![]({new_link})\n\r\n代码里的 `.assets/{id}/` 不是地址"));
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
        assert_eq!(s.read_todo("w", "p", &back.id).unwrap().summary.updated_at, moved.updated_at);
        // 占着 id 的那个文件不受影响
        assert_eq!(fs::read_to_string(p_dir.join(format!("{id}.md"))).unwrap(), "占着这个 id");

        // 没有图片的待办照常移动
        let plain = s.create_todo("w", "p", "没图的", "").unwrap();
        s.move_todo("w", "p", &plain.id, "w", "q").unwrap();
        assert!(!q_dir.join(ASSETS_DIR).exists());
    }

    #[test]
    fn assets_go_to_the_recycle_bin_with_the_todo() {
        let (_tmp, s) = store("img-recycle");
        let id = with_todo(&s, "");
        let a = s.save_image("w", "p", &id, "png", PNG).unwrap();
        s.save_todo_content("w", "p", &id, &format!("![]({})", a.link), None, false).unwrap();
        let p_dir = s.project_path("w", "p").unwrap();

        // 删除：附件目录放进回收站的同一项里，和在项目文件夹里时的相对位置一样
        let rid = s.delete_todo("w", "p", &id).unwrap();
        assert!(!p_dir.join(ASSETS_DIR).exists());
        let entry = s.root().join(RECYCLE_DIR).join(&rid);
        assert!(entry.join(format!("{id}.md")).is_file());
        assert_eq!(fs::read(entry.join(&a.link)).unwrap(), PNG);
        // 恢复：一起回来
        let r = s.restore(std::slice::from_ref(&rid));
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(fs::read(p_dir.join(&a.link)).unwrap(), PNG);

        // 恢复时 id 被占了：附件目录改成新 id，正文里的地址跟着改
        let rid = s.delete_todo("w", "p", &id).unwrap();
        fs::write(p_dir.join(format!("{id}.md")), "新来的").unwrap();
        let r = s.restore(&[rid]);
        let new_id = r.restored[0].todo_id.clone().unwrap();
        assert_ne!(new_id, id);
        let new_link = asset_link(&new_id, &a.name);
        assert_eq!(fs::read(p_dir.join(&new_link)).unwrap(), PNG);
        assert_eq!(s.read_todo("w", "p", &new_id).unwrap().content, format!("![]({new_link})"));

        // 彻底删除：连同图片一起进系统回收站（单元测试里是 .trash）
        let rid = s.delete_todo("w", "p", &new_id).unwrap();
        s.purge(&[rid]).unwrap();
        let trashed = fs::read_dir(s.root().join(TRASH_DIR)).unwrap().next().unwrap().unwrap().path();
        assert_eq!(fs::read(trashed.join(&new_link)).unwrap(), PNG);
        assert!(trashed.join(format!("{new_id}.md")).is_file());
    }

    #[test]
    fn save_as_new_copies_the_original_assets() {
        let (_tmp, s) = store("img-copy");
        let id = with_todo(&s, "");
        let a = s.save_image("w", "p", &id, "png", PNG).unwrap();
        let mine = format!("我的版本 ![]({})", a.link);
        let from = TodoRef { workspace: "w".into(), project: "p".into(), id: id.clone() };
        s.set_todo_tags("w", "p", &id, &["等回复".into()]).unwrap();
        s.set_todo_priority("w", "p", &id, 3).unwrap();
        // 同一项目里另存：复制一份附件目录，正文里的地址改成新的 id；带上原来那条的标签、优先级
        let copy = s.create_todo_from("w", "p", "有图的（我的版本）", &mine, Some(&from)).unwrap();
        assert_eq!((copy.tags.clone(), copy.priority), (vec!["等回复".to_string()], 3));
        let p_dir = s.project_path("w", "p").unwrap();
        let copied = asset_link(&copy.id, &a.name);
        assert_eq!(fs::read(p_dir.join(&copied)).unwrap(), PNG);
        assert_eq!(s.read_todo("w", "p", &copy.id).unwrap().content, format!("我的版本 ![]({copied})"));
        // 原来那条的图片还在；删掉原来那条，新的那条的图片也还在
        s.delete_todo("w", "p", &id).unwrap();
        assert!(p_dir.join(&copied).is_file());
        // 原来的项目不在了时存到别的项目（快速记录存到的）：复制到那里
        let rescued = s.create_todo_creating_project("收件箱", "快速记录", "x", &mine, Some(&from)).unwrap();
        let there = s.project_path("收件箱", "快速记录").unwrap();
        assert!(!there.join(asset_link(&rescued.id, &a.name)).exists(), "原来那条已经删了，没有可复制的");
        assert_eq!(s.read_todo("收件箱", "快速记录", &rescued.id).unwrap().content, mine);
        assert!(rescued.tags.is_empty() && rescued.priority == 0, "原来那条已经删了，没有可带上的标签");
        let from_copy = TodoRef { id: copy.id.clone(), ..from };
        let again = s.create_todo_creating_project("收件箱", "快速记录", "y", &format!("![]({copied})"), Some(&from_copy)).unwrap();
        assert_eq!(fs::read(there.join(asset_link(&again.id, &a.name))).unwrap(), PNG);
    }
}
