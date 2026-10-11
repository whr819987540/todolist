//! 把待办导出成 HTML：一个文件，本地图片嵌在里面，拿到别的电脑上也能看。导出 PDF 时 lib.rs 用 WebView2
//! 把同样的 HTML 打印出来（print_pdf）。
//!
//! - 导出哪些待办、什么顺序由前端给（侧栏的 sortTodos、sortProjects 排好的，连成一棵项目树），这里按给的顺序重新读出来，
//!   不再排一遍，免得两边的排序规则不一致；读的是磁盘上的（前端先存了盘）
//! - 项目、工作区按项目的层级递归分章：项目自己的待办在前，各级子项目依次作为下一级的章，层数不限
//! - 正文按 GFM 渲染（pulldown-cmark）；渲染结果连同正文里写的 HTML 一起交给 ammonia 做安全处理
//! - 本地图片（相对于 .md 所在的文件夹、绝对路径、file:///）读进来嵌成 data URI，找不到的显示占位；网上的图片原样留着
//! - 正文里的网址、邮箱按编辑器（lezer 的 GFM Autolink）同样的规则变成链接

use crate::store::{self, Store};
use base64::Engine as _;
use chrono::{Local, TimeZone};
use pulldown_cmark::{CowStr, Event, LinkType, Options, Parser, Tag, TagEnd, TextMergeStream};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::ops::Range;
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, String>;

/// 默认文件名最多这么多个字（不算扩展名）
const MAX_FILE_NAME_CHARS: usize = 80;
/// 没有标题时拿正文开头当标题，最多这么多个字
const UNTITLED_CHARS: usize = 60;
/// 文件名里什么都不剩时用的
const FALLBACK_NAME: &str = "待办";
/// 正文和标题都是空的待办（同侧栏）
const BLANK_TITLE: &str = "空白待办";
/// 正文里的 id（脚注）都加上这个前缀，不会和外面的目录锚点（todo-…、chapter-…）撞上
const ID_PREFIX: &str = "md-";
/// 章的标题最深用到 h6：更深的章也是 h6（样式见 STYLE 的 depth-…）
const MAX_HEADING: usize = 6;
/// GitHub 的提示块（`> [!NOTE]`），pulldown-cmark 渲染成 blockquote 的这些 class
const ALERT_CLASSES: [&str; 5] = [
    "markdown-alert-note",
    "markdown-alert-tip",
    "markdown-alert-important",
    "markdown-alert-warning",
    "markdown-alert-caution",
];

/// 导出成什么
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Html,
    Pdf,
}

impl Format {
    pub fn ext(self) -> &'static str {
        match self {
            Format::Html => "html",
            Format::Pdf => "pdf",
        }
    }

    /// 「另存为」对话框里文件类型的名字
    pub fn filter_name(self) -> &'static str {
        match self {
            Format::Html => "HTML 文件",
            Format::Pdf => "PDF 文件",
        }
    }
}

/// 导出的范围：一条待办、一个项目（连同各级子项目）、整个工作区
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Todo,
    Project,
    Workspace,
}

/// 前端交来的导出请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub format: Format,
    /// 存到哪里（pick_export_target 选的）
    pub path: String,
    pub scope: Scope,
    pub workspace: String,
    /// 包含已完成的待办；不含时封面上写明去掉了几条
    pub include_done: bool,
    /// 按侧栏的顺序排好的项目树：导出一条待办时是它所在的项目（只带这一条），导出项目时是这个项目，
    /// 导出工作区时是各个顶层项目
    pub groups: Vec<Group>,
}

/// 项目树上的一个项目：它自己排好序的待办和排好序的下一级子项目（各自也一样），层数不限
#[derive(Debug, Deserialize)]
pub struct Group {
    /// 项目路径：子项目是「父项目/子项目」，再往下一样用 / 连起来
    pub project: String,
    /// 项目自己的待办（不含子项目的），按侧栏的顺序
    pub ids: Vec<String>,
    /// 下一级子项目，按侧栏的顺序
    #[serde(default)]
    pub children: Vec<Group>,
}

/// 导出完的结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exported {
    pub path: String,
    /// 导出了几条待办
    pub count: usize,
}

/// 要导出的一条待办
#[derive(Debug, Clone)]
pub struct Item {
    pub workspace: String,
    pub project: String,
    pub title: String,
    /// 正文开头（同侧栏），没有标题时当标题
    pub preview: String,
    pub done: bool,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub done_at: Option<i64>,
    pub content: String,
    /// .md 文件所在的文件夹（哪一级的项目都是它自己的文件夹）：正文里的相对路径（如图片的 .assets/{id}/…）相对于它
    pub dir: PathBuf,
}

impl Item {
    fn read(store: &Store, ws: &str, project: &str, id: &str) -> Result<Item> {
        let d = store.read_todo(ws, project, id)?;
        let dir = Path::new(&d.path).parent().map(Path::to_path_buf).unwrap_or_default();
        let s = d.summary;
        Ok(Item {
            workspace: ws.to_string(),
            project: project.to_string(),
            title: s.title,
            preview: s.preview,
            done: s.done,
            pinned: s.pinned,
            created_at: s.created_at,
            updated_at: s.updated_at,
            done_at: s.done_at,
            content: d.content,
            dir,
        })
    }

    /// 显示的标题和它是不是取自正文开头
    fn heading(&self) -> (String, bool) {
        heading_of(&self.title, &self.preview)
    }
}

/// 标题：没有标题时是正文开头（太长的截短），正文也是空的时是「空白待办」；第二个值是不是取自正文
fn heading_of(title: &str, preview: &str) -> (String, bool) {
    let title = title.trim();
    if !title.is_empty() {
        return (title.to_string(), false);
    }
    let preview = preview.trim();
    if preview.is_empty() {
        return (BLANK_TITLE.to_string(), true);
    }
    let mut text: String = preview.chars().take(UNTITLED_CHARS).collect();
    if preview.chars().nth(UNTITLED_CHARS).is_some() {
        text.push('…');
    }
    (text, true)
}

/// 一个项目里要导出的待办，和它的各级子项目（每个是下一级的一章）
#[derive(Debug, Clone)]
pub struct Section {
    pub project: String,
    pub items: Vec<Item>,
    /// 不含已完成时从这个项目自己的待办里去掉了几条
    pub dropped: usize,
    /// 下一级子项目，按侧栏的顺序
    pub children: Vec<Section>,
}

impl Section {
    /// 导出了几条（连同各级子项目）
    fn count(&self) -> usize {
        self.items.len() + self.children.iter().map(Section::count).sum::<usize>()
    }

    /// 去掉了几条（连同各级子项目）
    fn dropped_all(&self) -> usize {
        self.dropped + self.children.iter().map(Section::dropped_all).sum::<usize>()
    }

    /// 导出的里面已完成几条（连同各级子项目）
    fn done(&self) -> usize {
        self.items.iter().filter(|i| i.done).count() + self.children.iter().map(Section::done).sum::<usize>()
    }

    /// 各级子项目一共几个
    fn descendants(&self) -> usize {
        self.children.iter().map(|c| 1 + c.descendants()).sum()
    }
}

/// 要导出的全部内容
#[derive(Debug, Clone)]
pub struct Document {
    pub scope: Scope,
    pub workspace: String,
    pub include_done: bool,
    /// 导出一条待办时是它所在的项目（只有这一条、没有子项目），导出项目时是这个项目；导出工作区时是工作区本身：
    /// project 是空的、没有自己的待办，各顶层项目是它的 children
    pub root: Section,
}

impl Document {
    /// 导出了几条
    pub fn count(&self) -> usize {
        self.root.count()
    }

    /// 范围里一共几条、其中已完成几条（连同各级子项目，包括不含已完成时去掉的）
    fn stats(&self) -> (usize, usize) {
        let dropped = self.root.dropped_all();
        (self.count() + dropped, self.root.done() + dropped)
    }

    /// 文档的标题：待办的标题、项目的路径（父项目 / 子项目 / …）、工作区名
    pub fn title(&self) -> String {
        match self.scope {
            Scope::Todo => self.root.items.first().map(|i| i.heading().0).unwrap_or_default(),
            Scope::Project => project_label(&self.root.project),
            Scope::Workspace => self.workspace.clone(),
        }
    }
}

/// 按前端给的顺序把要导出的待办读出来，项目树原样留着。导出一条时它不在了要报错；导出项目、工作区时，
/// 前端排好序之后才被删掉、移走的跳过
pub fn collect(store: &Store, req: &Request) -> Result<Document> {
    let root = match req.scope {
        Scope::Workspace => Section {
            project: String::new(),
            items: Vec::new(),
            dropped: 0,
            children: req.groups.iter().map(|g| read_group(store, req, g)).collect::<Result<_>>()?,
        },
        Scope::Project | Scope::Todo => match req.groups.as_slice() {
            [g] => read_group(store, req, g)?,
            // 前端读数据时这个项目已经不在了（刚被删掉、改名、移走）
            _ => return Err("项目不存在，可能已被删除或移动".into()),
        },
    };
    let doc = Document { scope: req.scope, workspace: req.workspace.clone(), include_done: req.include_done, root };
    if req.scope == Scope::Todo && doc.count() == 0 {
        return Err("待办不存在，可能已被删除或移动".into());
    }
    Ok(doc)
}

/// 读出项目树上的一个项目和它的各级子项目
fn read_group(store: &Store, req: &Request, g: &Group) -> Result<Section> {
    let mut section = Section { project: g.project.clone(), items: Vec::new(), dropped: 0, children: Vec::new() };
    for id in &g.ids {
        let item = match Item::read(store, &req.workspace, &g.project, id) {
            Ok(item) => item,
            Err(e) if req.scope == Scope::Todo => return Err(e),
            Err(_) => continue,
        };
        if item.done && !req.include_done {
            section.dropped += 1;
        } else {
            section.items.push(item);
        }
    }
    section.children = g.children.iter().map(|c| read_group(store, req, c)).collect::<Result<_>>()?;
    Ok(section)
}

// ---------------------------------------------------------------------------
// 文件名
// ---------------------------------------------------------------------------

/// 默认文件名的来源（还没去掉不能用的字符）：待办的标题（没有标题时正文开头）、项目的路径（见 project_base）、工作区名
pub fn default_name(store: &Store, workspace: &str, project: Option<&str>, todo: Option<&str>) -> String {
    match (project, todo) {
        (Some(p), Some(id)) => store
            .read_todo(workspace, p, id)
            .map(|d| {
                let title = d.summary.title.trim();
                if title.is_empty() { d.summary.preview } else { title.to_string() }
            })
            .unwrap_or_default(),
        (Some(p), None) => project_base(p),
        _ => workspace.to_string(),
    }
}

/// 项目的默认文件名：各级用「 - 」连起来（「需求 - 前端 - 组件」）；超过 80 个字时留下顶层项目和后面放得下的那几级，
/// 中间换成「…」（「需求 - … - 组件 - 按钮」），项目自己的名字总在；顶层项目和它自己也放不下时由 file_name 截短
fn project_base(project: &str) -> String {
    let parts: Vec<&str> = project.split(store::PROJECT_SEP).collect();
    let full = parts.join(" - ");
    if full.chars().count() <= MAX_FILE_NAME_CHARS || parts.len() <= 2 {
        return full;
    }
    // 留下最后 k 级（至少一级，最多到只折叠掉一级）
    let collapsed = |k: usize| format!("{} - … - {}", parts[0], parts[parts.len() - k..].join(" - "));
    let k = (1..=parts.len() - 2)
        .rev()
        .find(|&k| collapsed(k).chars().count() <= MAX_FILE_NAME_CHARS)
        .unwrap_or(1);
    collapsed(k)
}

/// 默认文件名：不能用在文件名里的字符换成「_」，去掉首尾的空格和「.」，截短，Windows 的保留名称后面加「_」，加上扩展名
pub fn file_name(base: &str, format: Format) -> String {
    let trim = |s: &str| s.trim_matches(|c: char| c.is_whitespace() || c == '.').to_string();
    let cleaned: String = base
        .chars()
        .map(|c| if store::INVALID_CHARS.contains(&c) || c.is_control() { '_' } else { c })
        .collect();
    let cut: String = trim(&cleaned).chars().take(MAX_FILE_NAME_CHARS).collect();
    let mut name = trim(&cut);
    if name.is_empty() {
        name = FALLBACK_NAME.to_string();
    }
    if store::is_reserved_name(&name) {
        // CON.txt 这样带扩展名的也算保留名称：加在第一个「.」前面
        let at = name.find('.').unwrap_or(name.len());
        name.insert(at, '_');
    }
    format!("{name}.{}", format.ext())
}

/// 「另存为」里输入的文件名没带扩展名（或带的不是这一种）时补上
pub fn with_extension(path: &Path, format: Format) -> PathBuf {
    let ok = path.extension().is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case(format.ext()));
    if ok {
        return path.to_path_buf();
    }
    let mut s = path.as_os_str().to_os_string();
    s.push(".");
    s.push(format.ext());
    PathBuf::from(s)
}

// ---------------------------------------------------------------------------
// 整个文档
// ---------------------------------------------------------------------------

/// HTML 里的文字、属性值转义
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// 年-月-日 时:分（本地时间）
fn time(ms: i64) -> String {
    Local
        .timestamp_millis_opt(ms)
        .earliest()
        .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

/// 显示用的项目路径：父项目 / 子项目 / …（导出的文件里地方够，不折叠）
fn project_label(project: &str) -> String {
    project.split(store::PROJECT_SEP).collect::<Vec<_>>().join(" / ")
}

fn leaf_name(project: &str) -> &str {
    project.rsplit(store::PROJECT_SEP).next().unwrap_or(project)
}

fn is_sub_project(project: &str) -> bool {
    project.contains(store::PROJECT_SEP)
}

fn percent(done: usize, total: usize) -> usize {
    if total == 0 { 0 } else { (done * 100 + total / 2) / total }
}

/// 目录、正文里的锚点：按在文档里出现的先后编号
fn item_anchor(n: usize) -> String {
    format!("todo-{n}")
}

fn chapter_anchor(n: usize) -> String {
    format!("chapter-{n}")
}

/// 文档里依次出现的东西：正文和目录按同一个顺序走，锚点的编号对得上
enum Block<'a> {
    /// 一章开始：第几章（锚点）、第几级（1 是导出的项目的子项目、导出工作区时的顶层项目，往下一级加一）、
    /// 它外面那几章的名字（从一级的章往下）
    Open { n: usize, depth: usize, section: &'a Section, trail: Vec<&'a str> },
    /// 一条待办：第几条（锚点）、所在的章是第几级（导出的项目自己的待办是 0）
    Todo { n: usize, depth: usize, item: &'a Item },
    /// 没有待办（也没有子项目）的一章写什么
    Empty(&'static str),
    /// 一章结束
    Close,
}

/// 按顺序列出文档里的东西：每个项目自己的待办在前，各级子项目依次作为下一级的章（递归，层数不限）
fn blocks(doc: &Document) -> Vec<Block<'_>> {
    fn walk<'a>(s: &'a Section, trail: &mut Vec<&'a str>, out: &mut Vec<Block<'a>>, counter: &mut (usize, usize)) {
        let depth = trail.len();
        for item in &s.items {
            out.push(Block::Todo { n: counter.1, depth, item });
            counter.1 += 1;
        }
        if s.items.is_empty() && s.children.is_empty() {
            out.push(Block::Empty(if s.dropped > 0 { "没有未完成的待办" } else { "没有待办" }));
        }
        for c in &s.children {
            out.push(Block::Open { n: counter.0, depth: depth + 1, section: c, trail: trail.clone() });
            counter.0 += 1;
            trail.push(leaf_name(&c.project));
            walk(c, trail, out, counter);
            trail.pop();
            out.push(Block::Close);
        }
    }
    let mut out = Vec::new();
    walk(&doc.root, &mut Vec::new(), &mut out, &mut (0, 0));
    out
}

/// 第 depth 级的章的标题用 h几：一级是 h1，越深越小，最深到 h6
fn chapter_heading(depth: usize) -> usize {
    depth.clamp(1, MAX_HEADING)
}

/// 第 depth 级的章里待办的标题用 h几：比章的标题低一级（导出的项目自己的和一级的章里的都是 h2），最深到 h6
fn todo_heading(depth: usize) -> usize {
    (depth + 1).clamp(2, MAX_HEADING)
}

/// 样式上分几档：一级、二级的章各一档，三级和更深的一档
fn depth_class(depth: usize) -> usize {
    depth.min(3)
}

/// 整个文档的 HTML；now 是导出时间
pub fn render(doc: &Document, now: chrono::DateTime<Local>) -> String {
    let single = doc.scope == Scope::Todo;
    let blocks = blocks(doc);
    let mut body = String::new();
    if !single {
        body.push_str("<div class=\"cover-page\">");
        body.push_str(&cover(doc, now));
        body.push_str(&toc(doc, &blocks));
        body.push_str("</div>");
    }
    // 导出的项目自己的待办（导出工作区时没有）在前，不另起一章
    let own = blocks.iter().take_while(|b| !matches!(b, Block::Open { .. })).count();
    let (head, rest) = blocks.split_at(own);
    if !head.is_empty() {
        body.push_str("<section class=\"own\">");
        head.iter().for_each(|b| push_block(&mut body, b, single));
        body.push_str("</section>");
    }
    rest.iter().for_each(|b| push_block(&mut body, b, single));
    let _ = write!(body, "<footer class=\"doc-foot\">由待办清单导出于 {}</footer>", now.format("%Y-%m-%d %H:%M"));
    format!(
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <meta name=\"color-scheme\" content=\"light\">\n<meta name=\"generator\" content=\"待办清单\">\n\
         <title>{}</title>\n<style>{STYLE}</style>\n</head>\n<body>\n<main class=\"page{}\">\n{body}\n</main>\n</body>\n</html>\n",
        esc(&doc.title()),
        if single { " single" } else { "" },
    )
}

/// 正文里的一处：一条待办、没有待办的说明、一章的开始（标题）和结束
fn push_block(body: &mut String, b: &Block, single: bool) {
    match b {
        Block::Todo { n, depth, item } => {
            let tag = if single { 1 } else { todo_heading(*depth) };
            body.push_str(&item_html(item, &item_anchor(*n), tag));
        }
        Block::Empty(note) => {
            let _ = write!(body, "<p class=\"empty\">{note}</p>");
        }
        Block::Open { n, depth, section, trail } => {
            let h = chapter_heading(*depth);
            // 二级和更深的章前面用灰色的小字写上它外面那几章，翻到哪一页都看得出在哪里
            let path = if trail.is_empty() {
                String::new()
            } else {
                format!("<span class=\"chapter-path\">{} / </span>", esc(&trail.join(" / ")))
            };
            let _ = write!(
                body,
                "<section class=\"chapter depth-{}\" id=\"{}\"><h{h} class=\"chapter-title\">{path}{}</h{h}>",
                depth_class(*depth),
                chapter_anchor(*n),
                esc(leaf_name(&section.project)),
            );
        }
        Block::Close => body.push_str("</section>"),
    }
}

/// 封面：项目 / 工作区名，路径和各级子项目数（项目）或项目数（工作区），待办数（连同各级子项目）、完成进度、导出时间，
/// 不含已完成时写明去掉了几条
fn cover(doc: &Document, now: chrono::DateTime<Local>) -> String {
    let (total, done) = doc.stats();
    let progress = percent(done, total);
    let mut info = String::new();
    let row = |info: &mut String, k: &str, v: &str| {
        let _ = write!(info, "<dt>{k}</dt><dd>{v}</dd>");
    };
    let subs = |top: usize| doc.root.descendants() - top;
    let kind = match doc.scope {
        Scope::Workspace => {
            let top = doc.root.children.len();
            let deeper = subs(top);
            let more = if deeper > 0 { format!("（另有各级子项目 {deeper} 个）") } else { String::new() };
            row(&mut info, "项目", &format!("{top} 个{more}"));
            "工作区"
        }
        _ => {
            let path = format!("{} / {}", doc.workspace, project_label(&doc.root.project));
            row(&mut info, "项目路径", &esc(&path));
            let deeper = subs(0);
            if deeper > 0 {
                row(&mut info, "子项目", &format!("{deeper} 个（含各级）"));
            }
            if is_sub_project(&doc.root.project) { "子项目" } else { "项目" }
        }
    };
    row(&mut info, "待办", &format!("{total} 条（已完成 {done} 条，未完成 {} 条）", total - done));
    row(
        &mut info,
        "完成进度",
        &format!("<span class=\"progress\"><span style=\"width: {progress}%\"></span></span>{progress}%"),
    );
    row(&mut info, "导出时间", &now.format("%Y-%m-%d %H:%M").to_string());
    let dropped = total - doc.count();
    if !doc.include_done && dropped > 0 {
        row(&mut info, "说明", &format!("不含已完成的 {dropped} 条待办"));
    }
    format!(
        "<header class=\"cover\"><div class=\"cover-kind\">{kind}</div><h1 class=\"cover-title\">{}</h1><dl class=\"cover-info\">{info}</dl></header>",
        esc(&doc.title()),
    )
}

/// 目录：每条待办一行（点了跳过去，已完成的标出来），各级子项目的章一层层缩进，章里是它自己的待办和下一级的章
fn toc(doc: &Document, blocks: &[Block]) -> String {
    let mut out = String::from("<nav class=\"toc\"><h2>目录</h2><ul>");
    for b in blocks {
        match b {
            Block::Todo { n, item, .. } => {
                let (text, untitled) = item.heading();
                let _ = write!(
                    out,
                    "<li class=\"toc-todo\"><a href=\"#{}\"{}>{}</a>{}</li>",
                    item_anchor(*n),
                    if untitled { " class=\"untitled\"" } else { "" },
                    esc(&text),
                    if item.done { "<span class=\"toc-done\">已完成</span>" } else { "" },
                );
            }
            Block::Open { n, section, .. } => {
                let _ = write!(
                    out,
                    "<li class=\"toc-chapter\"><a href=\"#{}\">{}</a><ul>",
                    chapter_anchor(*n),
                    esc(leaf_name(&section.project)),
                );
            }
            Block::Close => out.push_str("</ul></li>"),
            Block::Empty(_) => {}
        }
    }
    out.push_str("</ul>");
    if doc.count() == 0 && doc.root.children.is_empty() {
        // 同正文里那一句
        out.push_str(if doc.root.dropped > 0 { "<p class=\"empty\">没有未完成的待办</p>" } else { "<p class=\"empty\">没有待办</p>" });
    }
    out.push_str("</nav>");
    out
}

/// 一条待办：标题（h{tag}）、状态、置顶、所在的位置、时间，然后是渲染后的正文
fn item_html(item: &Item, anchor: &str, tag: usize) -> String {
    let (text, untitled) = item.heading();
    let mut meta = String::new();
    meta.push_str(if item.done { "<span class=\"tag done\">已完成</span>" } else { "<span class=\"tag doing\">进行中</span>" });
    if item.pinned {
        meta.push_str("<span class=\"tag pinned\">已置顶</span>");
    }
    let place = format!("{} / {}", item.workspace, project_label(&item.project));
    let _ = write!(meta, "<span class=\"todo-where\">{}</span>", esc(&place));
    let mut times = format!("<span>创建于 {}</span><span>最后修改 {}</span>", time(item.created_at), time(item.updated_at));
    if let (true, Some(at)) = (item.done, item.done_at) {
        let _ = write!(times, "<span>完成于 {}</span>", time(at));
    }
    let content = if item.content.trim().is_empty() {
        "<p class=\"empty\">（没有正文）</p>".to_string()
    } else {
        markdown(&item.content, &item.dir, &format!("{anchor}-"))
    };
    format!(
        "<article class=\"todo\" id=\"{anchor}\"><header class=\"todo-head\"><h{tag} class=\"todo-title{}\">{}</h{tag}>\
         <div class=\"todo-meta\">{meta}</div><div class=\"todo-times\">{times}</div></header>\
         <div class=\"todo-body md\">{content}</div></article>",
        if untitled { " untitled" } else { "" },
        esc(&text),
    )
}

// ---------------------------------------------------------------------------
// 正文：Markdown → 安全的 HTML
// ---------------------------------------------------------------------------

/// 正文渲染成 HTML（已做安全处理）。dir 是 .md 所在的文件夹（相对路径的图片相对于它），
/// key 加在脚注的 id 前面，一份文档里几条待办的脚注不会撞上
pub fn markdown(md: &str, dir: &Path, key: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_GFM;
    let events: Vec<Event> = TextMergeStream::new(Parser::new_ext(md, options)).collect();
    let html = with_footnotes(inline_pass(events, dir), key);
    sanitizer(dir.to_path_buf()).clean(&html).to_string()
}

/// 图片换成嵌进去的 &lt;img&gt;（或占位），正文里的网址、邮箱变成链接（代码块、链接里的不算）
fn inline_pass<'a>(events: Vec<Event<'a>>, dir: &Path) -> Vec<Event<'a>> {
    let mut out = Vec::with_capacity(events.len());
    let (mut code, mut link) = (0usize, 0usize);
    let mut it = events.into_iter();
    while let Some(e) = it.next() {
        match e {
            Event::Start(Tag::Image { dest_url, title, .. }) => {
                let alt = take_alt(&mut it);
                out.push(Event::InlineHtml(image_html(&dest_url, &title, &alt, dir).into()));
            }
            Event::Text(text) if code == 0 && link == 0 => linkify(text, &mut out),
            e => {
                match &e {
                    Event::Start(Tag::CodeBlock(_)) => code += 1,
                    Event::End(TagEnd::CodeBlock) => code = code.saturating_sub(1),
                    Event::Start(Tag::Link { .. }) => link += 1,
                    Event::End(TagEnd::Link) => link = link.saturating_sub(1),
                    _ => {}
                }
                out.push(e);
            }
        }
    }
    out
}

/// 图片的说明文字：一直读到这张图片结束（里面还可能有图片）
fn take_alt<'a>(it: &mut impl Iterator<Item = Event<'a>>) -> String {
    let mut alt = String::new();
    let mut depth = 0;
    for e in it {
        match e {
            Event::Start(Tag::Image { .. }) => depth += 1,
            Event::End(TagEnd::Image) if depth == 0 => break,
            Event::End(TagEnd::Image) => depth -= 1,
            Event::Text(t) | Event::Code(t) => alt.push_str(&t),
            Event::SoftBreak | Event::HardBreak => alt.push(' '),
            _ => {}
        }
    }
    alt
}

/// 一段文字里的网址、邮箱变成链接
fn linkify<'a>(text: CowStr<'a>, out: &mut Vec<Event<'a>>) {
    let links = autolinks(&text);
    if links.is_empty() {
        out.push(Event::Text(text));
        return;
    }
    let mut at = 0;
    for (range, href) in links {
        if range.start > at {
            out.push(Event::Text(text[at..range.start].to_string().into()));
        }
        // Email 类型的链接 pulldown-cmark 会自己加 mailto:，这里给的是完整的地址
        out.push(Event::Start(Tag::Link {
            link_type: LinkType::Autolink,
            dest_url: href.into(),
            title: "".into(),
            id: "".into(),
        }));
        out.push(Event::Text(text[range.clone()].to_string().into()));
        out.push(Event::End(TagEnd::Link));
        at = range.end;
    }
    if at < text.len() {
        out.push(Event::Text(text[at..].to_string().into()));
    }
}

/// 网址末尾不算在里面的中文标点
const TRAILING_CJK_PUNCTUATION: &str = "。，、；：！？…）】」』》〉”’";

/// 和正则的 \w 一样（只算 ASCII）
fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// 文字里的网址、邮箱和它们的链接地址，照编辑器用的 lezer 的 GFM Autolink：`www.`、`http://`、`https://` 开头的网址，
/// 邮箱和 `mailto:`；前面紧挨着字母、数字、下划线的不算；网址末尾的标点、多出来的右括号不算
fn autolinks(text: &str) -> Vec<(Range<usize>, String)> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii() || (i > 0 && is_word(b[i - 1])) {
            i += 1;
            continue;
        }
        if let Some((end, href)) = link_at(text, i) {
            out.push((i..end, href));
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

/// 从 i（ASCII 字符处）开始的网址、邮箱：结束的位置和链接地址
fn link_at(text: &str, i: usize) -> Option<(usize, String)> {
    let rest = &text[i..];
    if rest.starts_with("www.") {
        let end = url_end(text, i + 4)?;
        return Some((end, format!("http://{}", &text[i..end])));
    }
    for scheme in ["http://", "https://"] {
        if rest.starts_with(scheme) {
            let end = url_end(text, i + scheme.len())?;
            return Some((end, text[i..end].to_string()));
        }
    }
    let local = rest.bytes().take(101).take_while(|&c| is_word(c) || matches!(c, b'.' | b'+' | b'-')).count();
    if (1..=100).contains(&local) && rest.as_bytes().get(local) == Some(&b'@') {
        let end = email_end(text, i)?;
        return Some((end, format!("mailto:{}", &text[i..end])));
    }
    if rest.starts_with("mailto:") {
        let end = email_end(text, i + "mailto:".len())?;
        return Some((end, text[i..end].to_string()));
    }
    None
}

/// 网址（去掉了 www. / http:// 之后）在哪里结束：域名（至少两段，最后两段里不能有下划线）、端口、路径（到空白或 < 为止），
/// 再去掉末尾的标点 ?!.,:*_~ 和多出来的右括号。编辑器（lezer）只去掉这些英文标点，这里还去掉末尾的中文标点，
/// 「见 https://a.com/doc。」的句号不算在网址里
fn url_end(text: &str, from: usize) -> Option<usize> {
    let b = text.as_bytes();
    let label = |at: usize| (at..b.len()).find(|&j| !(is_word(b[j]) || b[j] == b'-')).unwrap_or(b.len());
    let mut j = label(from);
    if j == from {
        return None;
    }
    let mut labels = vec![from..j];
    while j < b.len() && b[j] == b'.' {
        let k = label(j + 1);
        if k == j + 1 {
            break;
        }
        labels.push(j + 1..k);
        j = k;
    }
    if labels.len() < 2 || labels[labels.len() - 2..].iter().any(|r| text[r.clone()].contains('_')) {
        return None;
    }
    if j < b.len() && b[j] == b':' {
        let k = (j + 1..b.len()).find(|&k| !b[k].is_ascii_digit()).unwrap_or(b.len());
        if k > j + 1 {
            j = k;
        }
    }
    if j < b.len() && b[j] == b'/' {
        j = text[j..].find(|c: char| c.is_whitespace() || c == '<').map_or(text.len(), |k| j + k);
    }
    let mut end = j;
    loop {
        let s = &text[from..end];
        match s.chars().last() {
            Some(c) if "?!.,:*_~".contains(c) => end -= 1,
            Some(c) if TRAILING_CJK_PUNCTUATION.contains(c) => end -= c.len_utf8(),
            Some(')') if s.matches(')').count() > s.matches('(').count() => end -= 1,
            _ => break,
        }
    }
    Some(end)
}

/// 邮箱（从 from 开始）在哪里结束：本地部分 @ 域名（至少有一个点）；末尾是 _ 或 - 的不算，末尾的点不算
fn email_end(text: &str, from: usize) -> Option<usize> {
    let b = text.as_bytes();
    let run = |at: usize, ok: &dyn Fn(u8) -> bool| (at..b.len()).find(|&j| !ok(b[j])).unwrap_or(b.len());
    let at = run(from, &|c| is_word(c) || matches!(c, b'.' | b'+' | b'-'));
    if at == from || b.get(at) != Some(&b'@') {
        return None;
    }
    let domain = run(at + 1, &|c| is_word(c) || c == b'-');
    if domain == at + 1 || b.get(domain) != Some(&b'.') {
        return None;
    }
    let end = run(domain + 1, &|c| is_word(c) || matches!(c, b'.' | b'-'));
    if end == domain + 1 {
        return None;
    }
    match b[end - 1] {
        b'_' | b'-' => None,
        b'.' => Some(end - 1),
        _ => Some(end),
    }
}

/// 脚注：引用处换成编号（按第一次引用的先后），定义挪到末尾，可以点过去、点回来；没被引用的定义不显示（同 GitHub）
fn with_footnotes(events: Vec<Event<'_>>, key: &str) -> String {
    let mut main = Vec::with_capacity(events.len());
    let mut defs: HashMap<String, Vec<Event>> = HashMap::new();
    let mut it = events.into_iter();
    while let Some(e) = it.next() {
        let Event::Start(Tag::FootnoteDefinition(label)) = e else {
            main.push(e);
            continue;
        };
        let mut body = Vec::new();
        let mut depth = 0;
        for e in it.by_ref() {
            match &e {
                Event::Start(Tag::FootnoteDefinition(_)) => depth += 1,
                Event::End(TagEnd::FootnoteDefinition) if depth == 0 => break,
                Event::End(TagEnd::FootnoteDefinition) => depth -= 1,
                _ => {}
            }
            body.push(e);
        }
        // 同名的定义以第一个为准
        defs.entry(label.to_string()).or_insert(body);
    }
    let mut notes = Footnotes { key, defs: &defs, order: Vec::new() };
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, notes.number(main).into_iter());
    if notes.order.is_empty() {
        return html;
    }
    html.push_str("<div class=\"footnotes\"><hr><ol>");
    // 脚注里还可能引用别的脚注，order 会边走边变长
    let mut i = 0;
    while i < notes.order.len() {
        let n = i + 1;
        let body = defs.get(&notes.order[i]).cloned().unwrap_or_default();
        let mut body = notes.number(body);
        let back = Event::InlineHtml(format!("<a href=\"#{ID_PREFIX}{key}fnref-{n}\" class=\"fn-back\">↩</a>").into());
        // 返回的链接放在最后一段的末尾
        match body.last() {
            Some(Event::End(TagEnd::Paragraph)) => body.insert(body.len() - 1, back),
            _ => body.push(back),
        }
        let _ = write!(html, "<li id=\"{key}fn-{n}\">");
        pulldown_cmark::html::push_html(&mut html, body.into_iter());
        html.push_str("</li>");
        i += 1;
    }
    html.push_str("</ol></div>");
    html
}

struct Footnotes<'k, 'd, 'a> {
    key: &'k str,
    defs: &'d HashMap<String, Vec<Event<'a>>>,
    /// 按第一次引用的先后排的脚注，编号是位置 + 1
    order: Vec<String>,
}

impl<'a> Footnotes<'_, '_, 'a> {
    /// 引用换成编号；没有定义的原样写成 [^名字]
    fn number(&mut self, events: Vec<Event<'a>>) -> Vec<Event<'a>> {
        let key = self.key;
        let mut out = Vec::with_capacity(events.len());
        for e in events {
            let Event::FootnoteReference(label) = e else {
                out.push(e);
                continue;
            };
            if !self.defs.contains_key(label.as_ref()) {
                out.push(Event::Text(format!("[^{label}]").into()));
                continue;
            }
            let (n, first) = match self.order.iter().position(|l| l == label.as_ref()) {
                Some(i) => (i + 1, false),
                None => {
                    self.order.push(label.to_string());
                    (self.order.len(), true)
                }
            };
            // 回来的链接指向第一次引用的地方
            let id = if first { format!(" id=\"{key}fnref-{n}\"") } else { String::new() };
            out.push(Event::InlineHtml(
                format!("<sup class=\"fn-ref\"><a href=\"#{ID_PREFIX}{key}fn-{n}\"{id}>{n}</a></sup>").into(),
            ));
        }
        out
    }
}

/// 正文渲染结果的安全处理：只留普通的排版标签和属性，去掉脚本、事件属性、style、javascript: 这类链接；
/// 任务框只能是只读的勾选框；表格单元格只留对齐方式。dir 用来把 HTML 写的本地 &lt;img&gt; 嵌进去
fn sanitizer(dir: PathBuf) -> ammonia::Builder<'static> {
    let mut b = ammonia::Builder::default();
    b.add_tags(&["input"])
        .add_tag_attributes("input", &["checked"])
        .set_tag_attribute_value("input", "type", "checkbox")
        .set_tag_attribute_value("input", "disabled", "")
        .add_tag_attributes("th", &["style"])
        .add_tag_attributes("td", &["style"])
        .filter_style_properties(HashSet::from(["text-align"]))
        // 脚注的锚点
        .add_tag_attributes("a", &["id"])
        .add_tag_attributes("li", &["id"])
        .id_prefix(Some(ID_PREFIX))
        .add_allowed_classes("sup", &["fn-ref"])
        .add_allowed_classes("a", &["fn-back"])
        .add_allowed_classes("div", &["footnotes"])
        .add_allowed_classes("span", &["img-missing"])
        .add_allowed_classes("blockquote", &ALERT_CLASSES)
        // 嵌进去的图片；别处的 data: 由下面的 filter_attribute 去掉
        .add_url_schemes(&["data"])
        .attribute_filter(move |element, attribute, value| filter_attribute(element, attribute, value, &dir));
    b
}

fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.get(..prefix.len()).is_some_and(|p| p.eq_ignore_ascii_case(prefix))
}

/// data: 只能用在 &lt;img&gt; 上、只能是图片；HTML 写的 &lt;img&gt; 里相对路径的本地图片嵌进去（找不到时原样留着）。
/// 绝对路径（盘符、`/` 或 `\` 开头的，包括 `\\服务器\共享` 这样的网络路径）、别的协议的不读，原样交给 ammonia
fn filter_attribute<'u>(element: &str, attribute: &str, value: &'u str, dir: &Path) -> Option<Cow<'u, str>> {
    let data = starts_with_ci(value.trim_start(), "data:");
    if element == "img" && attribute == "src" {
        if data {
            return starts_with_ci(value.trim_start(), "data:image/").then_some(Cow::Borrowed(value));
        }
        let v = value.trim();
        if v.starts_with(['/', '\\']) || v.contains(':') {
            return Some(Cow::Borrowed(value));
        }
        return Some(match load_image(value, dir) {
            Image::Embedded(uri) => Cow::Owned(uri),
            _ => Cow::Borrowed(value),
        });
    }
    (!data).then_some(Cow::Borrowed(value))
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

/// 一张图片怎么放进导出的文件
#[derive(Debug, PartialEq, Eq)]
enum Image {
    /// 网上的（http / https）、本来就是 data: 的：原样留着
    Remote,
    /// 本地的：读进来的 data URI
    Embedded(String),
    Missing,
    NotImage,
}

fn image_html(dest: &str, title: &str, alt: &str, dir: &Path) -> String {
    let src = match load_image(dest, dir) {
        Image::Remote => dest.to_string(),
        Image::Embedded(uri) => uri,
        Image::Missing => return format!("<span class=\"img-missing\">图片不存在：{}</span>", esc(dest)),
        Image::NotImage => return format!("<span class=\"img-missing\">不是图片：{}</span>", esc(dest)),
    };
    let title = if title.is_empty() { String::new() } else { format!(" title=\"{}\"", esc(title)) };
    format!("<img src=\"{}\" alt=\"{}\"{title}>", esc(&src), esc(alt))
}

fn load_image(src: &str, dir: &Path) -> Image {
    let src = src.trim();
    if starts_with_ci(src, "http://") || starts_with_ci(src, "https://") || starts_with_ci(src, "data:image/") {
        return Image::Remote;
    }
    let Some(path) = local_path(src, dir) else { return Image::Missing };
    let Ok(bytes) = std::fs::read(&path) else { return Image::Missing };
    match image_mime(&bytes, &path) {
        Some(mime) => Image::Embedded(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        )),
        None => Image::NotImage,
    }
}

/// 图片地址对应的本地文件：相对于 .md 所在文件夹的路径、绝对路径、file:/// 地址；路径里的 %20 这类转义也认。
/// 别的协议（ftp: 等）、找不到的返回 None
fn local_path(src: &str, dir: &Path) -> Option<PathBuf> {
    if src.is_empty() {
        return None;
    }
    if starts_with_ci(src, "file:") {
        return ammonia::Url::parse(src).ok()?.to_file_path().ok().filter(|p| p.is_file());
    }
    // 两个字母以上的 xxx: 是别的协议；C: 这样的是盘符
    let scheme = src.find(':').filter(|&i| i >= 2 && src[..i].bytes().all(|c| c.is_ascii_alphanumeric() || b"+.-".contains(&c)));
    if scheme.is_some() {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(src).decode_utf8().ok().map(Cow::into_owned);
    [Some(src.to_string()), decoded].into_iter().flatten().find_map(|p| {
        let p = Path::new(&p);
        let full = if p.is_absolute() { p.to_path_buf() } else { dir.join(p) };
        full.is_file().then_some(full)
    })
}

/// 图片的 MIME 类型：先看文件头，认不出时看扩展名（SVG 只看扩展名）；都不是图片时 None
fn image_mime(bytes: &[u8], path: &Path) -> Option<&'static str> {
    let at = |range: Range<usize>, sig: &[u8]| bytes.get(range) == Some(sig);
    let sniffed = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if at(0..4, b"RIFF") && at(8..12, b"WEBP") {
        Some("image/webp")
    } else if at(4..8, b"ftyp") && (at(8..12, b"avif") || at(8..12, b"avis")) {
        Some("image/avif")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else {
        None
    };
    sniffed.or_else(|| {
        let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
        Some(match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" | "jfif" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            "svg" => "image/svg+xml",
            _ => return None,
        })
    })
}

// ---------------------------------------------------------------------------
// 样式：总是浅色，适合阅读和打印
// ---------------------------------------------------------------------------

const STYLE: &str = r#"
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { background: #f2f3f5; }
body {
  margin: 0;
  color: #1f2329;
  font: 15px/1.75 "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "Segoe UI", sans-serif;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.page { max-width: 210mm; margin: 24px auto; padding: 18mm 18mm 12mm; background: #fff; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.08); }
a { color: #1664d9; text-decoration: none; }
a:hover { text-decoration: underline; }
.empty { color: #8f959e; }

.cover { padding: 24px 0 28px; margin-bottom: 28px; border-bottom: 2px solid #1664d9; }
.cover-kind { color: #1664d9; font-size: 14px; letter-spacing: 0.1em; }
.cover-title { margin: 6px 0 20px; font-size: 30px; line-height: 1.35; overflow-wrap: anywhere; }
.cover-info { display: grid; grid-template-columns: max-content 1fr; gap: 4px 24px; margin: 0; }
.cover-info dt { color: #646a73; }
.cover-info dd { margin: 0; overflow-wrap: anywhere; }
.progress { display: inline-block; width: 160px; height: 8px; margin-right: 10px; vertical-align: middle; background: #e5e6eb; border-radius: 4px; overflow: hidden; }
.progress > span { display: block; height: 100%; background: #52c41a; }

.toc h2 { margin: 0 0 8px; font-size: 20px; }
.toc ul { margin: 0; padding-left: 0; list-style: none; }
.toc ul ul { padding-left: 1.6em; }
.toc li { margin: 2px 0; }
.toc .toc-chapter { margin-top: 8px; }
.toc .toc-chapter > a { font-weight: 600; }
.toc .untitled { color: #646a73; }
.toc-done { margin-left: 8px; padding: 0 6px; font-size: 12px; color: #389e0d; background: #f6ffed; border-radius: 4px; }

.cover-page { margin-bottom: 36px; }
.chapter-title { margin: 40px 0 24px; padding-bottom: 8px; font-size: 24px; line-height: 1.4; border-bottom: 1px solid #dee0e3; overflow-wrap: anywhere; }
/* 各级子项目的章：越深字越小，下划线从实线、虚线到点线；三级和更深的一样 */
.chapter.depth-2 > .chapter-title { font-size: 21px; border-bottom-style: dashed; }
.chapter.depth-3 > .chapter-title { font-size: 19px; border-bottom-style: dotted; }
.chapter-path { font-size: 0.75em; font-weight: normal; color: #8f959e; }

.todo { margin: 0 0 36px; }
.todo + .todo { padding-top: 28px; border-top: 1px dashed #dee0e3; }
.todo-title { margin: 0 0 6px; font-size: 22px; line-height: 1.4; overflow-wrap: anywhere; }
/* 深的章里待办的标题跟着小一点，不比它的章的标题大 */
h3.todo-title { font-size: 20px; }
h4.todo-title, h5.todo-title, h6.todo-title { font-size: 18px; }
.single .todo-title { font-size: 28px; }
.todo-title.untitled { color: #646a73; }
.todo-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 13px; color: #646a73; }
.tag { display: inline-block; padding: 0 8px; font-size: 12px; line-height: 20px; border: 1px solid; border-radius: 4px; }
.tag.done { color: #389e0d; background: #f6ffed; border-color: #b7eb8f; }
.tag.doing { color: #0958d9; background: #e6f4ff; border-color: #91caff; }
.tag.pinned { color: #d46b08; background: #fff7e6; border-color: #ffd591; }
.todo-times { margin-top: 2px; font-size: 13px; color: #8f959e; }
.todo-times span + span::before { content: "·"; margin: 0 8px; }
.todo-body { margin-top: 14px; }
.doc-foot { margin-top: 40px; padding-top: 10px; font-size: 12px; color: #8f959e; border-top: 1px solid #dee0e3; }

.md { overflow-wrap: anywhere; }
.md > :first-child { margin-top: 0; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 1.2em 0 0.6em; line-height: 1.4; }
.md h1 { font-size: 1.6em; }
.md h2 { font-size: 1.4em; }
.md h3 { font-size: 1.2em; }
.md h4, .md h5, .md h6 { font-size: 1em; }
.md p, .md ul, .md ol, .md blockquote, .md table, .md pre, .md details { margin: 0 0 1em; }
.md ul, .md ol { padding-left: 2em; }
.md li > ul, .md li > ol { margin-bottom: 0; }
.md li:has(> input[type="checkbox"]) { list-style: none; }
.md li > input[type="checkbox"] { margin: 0 0.45em 0 -1.4em; vertical-align: -0.1em; }
.md code { padding: 0.1em 0.35em; font-family: "Cascadia Mono", Consolas, "Courier New", "Microsoft YaHei", monospace; font-size: 0.9em; background: #f2f3f5; border-radius: 3px; }
.md pre { padding: 12px 16px; background: #f6f7f9; border: 1px solid #e5e6eb; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.md pre code { padding: 0; font-size: 0.875em; background: none; }
.md blockquote { padding: 0 1em; color: #646a73; border-left: 4px solid #dee0e3; }
.md blockquote[class^="markdown-alert"] { padding: 6px 1em; color: inherit; }
.md blockquote[class^="markdown-alert"]::before { display: block; font-weight: 600; }
.md .markdown-alert-note { border-left-color: #1664d9; }
.md .markdown-alert-note::before { content: "注意"; color: #1664d9; }
.md .markdown-alert-tip { border-left-color: #389e0d; }
.md .markdown-alert-tip::before { content: "提示"; color: #389e0d; }
.md .markdown-alert-important { border-left-color: #722ed1; }
.md .markdown-alert-important::before { content: "重要"; color: #722ed1; }
.md .markdown-alert-warning { border-left-color: #d48806; }
.md .markdown-alert-warning::before { content: "警告"; color: #d48806; }
.md .markdown-alert-caution { border-left-color: #cf1322; }
.md .markdown-alert-caution::before { content: "小心"; color: #cf1322; }
.md table { border-collapse: collapse; max-width: 100%; }
.md th, .md td { padding: 6px 12px; border: 1px solid #d0d3d6; }
.md th { font-weight: 600; background: #f5f6f7; }
.md img { max-width: 100%; height: auto; }
.md hr { margin: 1.5em 0; border: 0; border-top: 1px solid #dee0e3; }
.md del { color: #8f959e; }
.md kbd { padding: 0 0.4em; font-family: inherit; font-size: 0.9em; border: 1px solid #d0d3d6; border-bottom-width: 2px; border-radius: 4px; }
.md mark { background: #fff1b8; }
.img-missing { display: inline-block; padding: 2px 8px; font-size: 13px; color: #cf1322; background: #fff1f0; border: 1px dashed #ffa39e; border-radius: 4px; }
.fn-ref { font-size: 0.75em; line-height: 0; }
.footnotes { margin-top: 1.5em; font-size: 13px; color: #646a73; }
.footnotes hr { margin: 0 0 0.8em; border: 0; border-top: 1px solid #dee0e3; }
.footnotes ol { padding-left: 1.6em; }
.fn-back { margin-left: 4px; }

@media print {
  html { background: #fff; }
  .page { max-width: none; margin: 0; padding: 0; box-shadow: none; }
  .cover { padding-top: 0; }
  .cover-page { margin-bottom: 0; break-after: page; }
  /* 一级的章（导出项目时的子项目、导出工作区时的顶层项目）从新的一页开始，更深的章接着排 */
  .chapter.depth-1 { break-before: page; }
  .chapter.depth-1 > .chapter-title { margin-top: 0; }
  .chapter-title, .todo-head { break-after: avoid; break-inside: avoid; }
  .md img, .md tr, .img-missing { break-inside: avoid; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { break-after: avoid; }
}
"#;

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("todolist-export-{tag}-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// 1×1 的 PNG
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49,
        0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0xF0, 0x1F, 0x00, 0x05, 0x00, 0x01, 0xFF, 0x89, 0x99, 0x3D,
        0x1D, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn md(text: &str) -> String {
        markdown(text, Path::new("."), "t-")
    }

    // ----- Markdown（GFM） -----

    #[test]
    fn renders_gfm() {
        let html = md("# 标题\n\n**粗** *斜* ~~删掉~~ <u>下划线</u> `code`\n\n> 引用\n\n1. 一\n2. 二\n\n---\n\n```rust\nfn main() {}\n```\n");
        for want in [
            "<h1>标题</h1>",
            "<strong>粗</strong>",
            "<em>斜</em>",
            "<del>删掉</del>",
            "<u>下划线</u>",
            "<code>code</code>",
            "<blockquote>",
            "<ol>",
            "<hr>",
            "<pre><code>fn main() {}",
        ] {
            assert!(html.contains(want), "缺 {want}：{html}");
        }
    }

    #[test]
    fn tables_have_alignment() {
        let html = md("| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| a | b | c |\n");
        assert!(html.contains("<table>") && html.contains("<th"), "{html}");
        let center = html.split("<td").nth(2).unwrap_or_default();
        assert!(center.contains("text-align") && center.contains("center") && center.contains(">b<"), "{html}");
        let right = html.split("<td").nth(3).unwrap_or_default();
        assert!(right.contains("right"), "{html}");
    }

    #[test]
    fn task_lists_are_read_only_checkboxes() {
        let html = md("- [x] 做完了\n- [ ] 还没做\n");
        let boxes: Vec<&str> = html.split("<input").skip(1).map(|s| s.split('>').next().unwrap()).collect();
        assert_eq!(boxes.len(), 2, "{html}");
        assert!(boxes.iter().all(|b| b.contains("type=\"checkbox\"") && b.contains("disabled")), "{html}");
        assert!(boxes[0].contains("checked") && !boxes[1].contains("checked"), "{html}");
        // 正文里写的输入框也只能是只读的勾选框
        let raw = md("<input type=\"text\" value=\"x\">");
        assert!(raw.contains("type=\"checkbox\"") && raw.contains("disabled") && !raw.contains("value"), "{raw}");
    }

    #[test]
    fn links_are_kept() {
        let html = md("[文档](https://example.com/a?b=1) <https://x.cn> [邮件](mailto:a@b.com)");
        assert!(html.contains("href=\"https://example.com/a?b=1\""), "{html}");
        assert!(html.contains("href=\"https://x.cn\""), "{html}");
        assert!(html.contains("href=\"mailto:a@b.com\""), "{html}");
    }

    #[test]
    fn bare_urls_and_emails_become_links() {
        let html = md("看 https://example.com/x 和 www.rust-lang.org，邮件 someone@example.com");
        assert!(html.contains("<a href=\"https://example.com/x\""), "{html}");
        assert!(html.contains("<a href=\"http://www.rust-lang.org\"") && html.contains(">www.rust-lang.org</a>，"), "{html}");
        assert!(html.contains("<a href=\"mailto:someone@example.com\""), "{html}");
        // 代码、链接里的不再变成链接
        let code = md("`https://a.com` 和 [https://b.com](https://c.com)\n\n```\nhttps://d.com\n```");
        assert_eq!(code.matches("<a ").count(), 1, "{code}");
    }

    #[test]
    fn autolinks_follow_the_editor_rules() {
        let found = |t: &str| autolinks(t).into_iter().map(|(r, href)| (t[r].to_string(), href)).collect::<Vec<_>>();
        // 末尾的标点、多出来的右括号不算
        assert_eq!(found("见 https://a.com/x.")[0].0, "https://a.com/x");
        assert_eq!(found("(https://a.com/x)")[0].0, "https://a.com/x");
        assert_eq!(found("https://a.com/w(x)")[0].0, "https://a.com/w(x)");
        // 只有域名时到不是字母数字的地方为止（中文标点前面）
        assert_eq!(found("打开https://a.com，然后")[0].0, "https://a.com");
        // 路径后面紧跟着的中文标点也不算
        assert_eq!(found("见 https://a.com/文档。")[0].0, "https://a.com/文档");
        assert_eq!(found("（https://a.com/x）")[0].0, "https://a.com/x");
        // 带端口
        assert_eq!(found("http://localhost.dev:8080/a b")[0].0, "http://localhost.dev:8080/a");
        // 前面紧挨着字母的、只有一段域名的、最后两段里有下划线的不算
        assert!(found("xhttps://a.com").is_empty());
        assert!(found("http://localhost").is_empty());
        assert!(found("www.a_b.com").is_empty());
        // 邮箱：末尾的点不算，mailto: 开头的照样
        assert_eq!(found("写信给 a.b+c@x.co.")[0], ("a.b+c@x.co".to_string(), "mailto:a.b+c@x.co".to_string()));
        assert_eq!(found("mailto:a@b.cn")[0], ("mailto:a@b.cn".to_string(), "mailto:a@b.cn".to_string()));
        assert!(found("a@b").is_empty());
    }

    #[test]
    fn footnotes_go_to_the_end() {
        let html = md("先说[^b]，再说[^a]，又提到[^b]。\n\n[^a]: 甲的说明\n[^b]: 乙的说明\n[^c]: 没人引用\n");
        let body = html.split("<div class=\"footnotes\">").next().unwrap();
        let notes = html.split("<div class=\"footnotes\">").nth(1).expect(&html);
        // 按第一次引用的先后编号：b 是 1，a 是 2
        assert!(body.contains("href=\"#md-t-fn-1\" id=\"md-t-fnref-1\""), "{html}");
        assert!(body.contains("href=\"#md-t-fn-2\" id=\"md-t-fnref-2\""), "{html}");
        assert!(body.find("#md-t-fn-1").unwrap() < body.find("#md-t-fn-2").unwrap(), "{html}");
        assert_eq!(body.matches("#md-t-fn-1").count(), 2, "{html}");
        let first = notes.find("乙的说明").unwrap();
        let second = notes.find("甲的说明").unwrap();
        assert!(first < second, "{notes}");
        assert!(notes.contains("id=\"md-t-fn-1\"") && notes.contains("href=\"#md-t-fnref-1\""), "{notes}");
        assert!(!html.contains("没人引用"), "{html}");
        // 没有定义的引用原样留着
        assert!(md("没有[^x]").contains("[^x]"));
    }

    #[test]
    fn github_alerts_keep_their_kind() {
        let html = md("> [!NOTE]\n> 记得备份\n");
        assert!(html.contains("<blockquote class=\"markdown-alert-note\">") && html.contains("记得备份"), "{html}");
    }

    #[test]
    fn raw_html_is_sanitized() {
        let html = md(concat!(
            "<script>alert(1)</script><style>p{color:red}</style>\n\n",
            "<img src=\"https://a.com/x.png\" onerror=\"alert(2)\">\n\n",
            "<a href=\"javascript:alert(3)\">点我</a> <a href=\"data:text/html,<b>x</b>\">数据</a>\n\n",
            "<iframe src=\"https://a.com\"></iframe><form><button>提交</button><textarea>x</textarea></form>\n\n",
            "<span style=\"color:red\" onclick=\"alert(4)\">红</span> <details><summary>更多</summary>内容</details> <kbd>Ctrl</kbd>\n",
        ));
        for bad in ["<script", "alert(1)", "<style", "onerror", "javascript:", "data:text", "<iframe", "<form", "<button", "<textarea", "style=\"color", "onclick"] {
            assert!(!html.contains(bad), "还有 {bad}：{html}");
        }
        for good in ["<img src=\"https://a.com/x.png\"", ">点我</a>", "<span>红</span>", "<details><summary>更多</summary>", "<kbd>Ctrl</kbd>"] {
            assert!(html.contains(good), "缺 {good}：{html}");
        }
    }

    // ----- 图片 -----

    #[test]
    fn local_images_are_embedded() {
        let tmp = TempDir::new("img");
        let dir = tmp.0.join("项目");
        fs::create_dir_all(dir.join(".assets/T1")).unwrap();
        fs::write(dir.join(".assets/T1/截图 1.png"), PNG).unwrap();
        fs::write(dir.join(".assets/T1/图.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>").unwrap();
        fs::write(dir.join(".assets/T1/照片.dat"), [0xFF, 0xD8, 0xFF, 0xE0, 1, 2]).unwrap();
        fs::write(tmp.0.join("外面.png"), PNG).unwrap();
        let data = format!("data:image/png;base64,{}", b64(PNG));
        let abs = tmp.0.join("外面.png");
        let file_url = ammonia::Url::from_file_path(&abs).unwrap();
        let text = format!(
            "![截图](<.assets/T1/截图 1.png> \"标题\")\n\n![转义](.assets/T1/%E6%88%AA%E5%9B%BE%201.png)\n\n![绝对](<{}>)\n\n![网址]({file_url})\n\n\
             ![矢量](.assets/T1/图.svg) ![照片](.assets/T1/照片.dat)\n\n<img src=\".assets/T1/截图 1.png\" width=\"20\">\n",
            abs.display()
        );
        let html = markdown(&text, &dir, "t-");
        assert_eq!(html.matches(&format!("src=\"{data}\"")).count(), 5, "{html}");
        assert!(html.contains("alt=\"截图\"") && html.contains("title=\"标题\""), "{html}");
        assert!(html.contains("src=\"data:image/svg+xml;base64,"), "{html}");
        assert!(html.contains("src=\"data:image/jpeg;base64,"), "{html}");
        assert!(html.contains("width=\"20\""), "{html}");
    }

    #[test]
    fn html_img_only_embeds_relative_paths() {
        // 正文里用 HTML 写的 <img>：相对路径的嵌进去，绝对路径的（含网络路径）不读
        let tmp = TempDir::new("html-img");
        let dir = tmp.0.join("项目");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("图.png"), PNG).unwrap();
        let abs = dir.join("图.png");
        let text = format!("<img src=\"图.png\">\n\n<img src=\"{}\">\n\n<img src=\"\\\\host\\share\\图.png\">\n", abs.display());
        let html = markdown(&text, &dir, "t-");
        assert_eq!(html.matches("src=\"data:image/png;base64,").count(), 1, "{html}");
    }

    #[test]
    fn missing_and_non_images_show_placeholders() {
        let tmp = TempDir::new("missing");
        fs::write(tmp.0.join("说明.txt"), "不是图片").unwrap();
        let html = markdown("![](.assets/没有.png) ![](说明.txt) ![](ftp://a.com/x.png)", &tmp.0, "t-");
        assert!(html.contains("<span class=\"img-missing\">图片不存在：.assets/没有.png</span>"), "{html}");
        assert!(html.contains("<span class=\"img-missing\">不是图片：说明.txt</span>"), "{html}");
        assert!(html.contains("图片不存在：ftp://a.com/x.png"), "{html}");
        assert!(!html.contains("<img"), "{html}");
    }

    #[test]
    fn remote_images_stay_as_they_are() {
        let html = md("![远程](https://example.com/a.png) ![远程2](http://example.com/b.gif)");
        assert!(html.contains("src=\"https://example.com/a.png\"") && html.contains("src=\"http://example.com/b.gif\""), "{html}");
    }

    // ----- 文件名 -----

    #[test]
    fn file_names_are_safe() {
        assert_eq!(file_name("周报: 第 3 周 / 草稿?", Format::Html), "周报_ 第 3 周 _ 草稿_.html");
        // 全角的标点可以用在文件名里
        assert_eq!(file_name("周报：第 3 周", Format::Html), "周报：第 3 周.html");
        assert_eq!(file_name("a<b>c\"d|e*f\\g\tz", Format::Html), "a_b_c_d_e_f_g_z.html");
        assert_eq!(file_name("  ..要点.. ", Format::Html), "要点.html");
        assert_eq!(file_name("", Format::Html), "待办.html");
        assert_eq!(file_name("???", Format::Html), "___.html");
        assert_eq!(file_name(" . ", Format::Html), "待办.html");
        assert_eq!(file_name("CON", Format::Html), "CON_.html");
        assert_eq!(file_name("nul.备份", Format::Html), "nul_.备份.html");
        assert_eq!(file_name("COM1", Format::Html), "COM1_.html");
        assert_eq!(file_name("CONSOLE", Format::Html), "CONSOLE.html");
        assert_eq!(file_name("周报 / 第 3 周", Format::Pdf), "周报 _ 第 3 周.pdf");
        let long = "长".repeat(100);
        assert_eq!(file_name(&long, Format::Html), format!("{}.html", "长".repeat(80)));
        // 截短后末尾的空格、点也去掉
        let cut = format!("{}  .后面", "字".repeat(79));
        assert_eq!(file_name(&cut, Format::Html), format!("{}.html", "字".repeat(79)));
    }

    #[test]
    fn extension_is_added_when_missing() {
        assert_eq!(with_extension(Path::new("C:/导出/周报"), Format::Html), PathBuf::from("C:/导出/周报.html"));
        assert_eq!(with_extension(Path::new("C:/导出/周报.HTML"), Format::Html), PathBuf::from("C:/导出/周报.HTML"));
        assert_eq!(with_extension(Path::new("C:/导出/周报.v2"), Format::Html), PathBuf::from("C:/导出/周报.v2.html"));
        assert_eq!(with_extension(Path::new("C:/导出/周报"), Format::Pdf), PathBuf::from("C:/导出/周报.pdf"));
        assert_eq!(with_extension(Path::new("C:/导出/周报.html"), Format::Pdf), PathBuf::from("C:/导出/周报.html.pdf"));
    }

    #[test]
    fn default_names_come_from_title_preview_or_project() {
        let tmp = TempDir::new("names");
        let s = Store::new(tmp.0.clone()).unwrap();
        s.create_workspace("工作").unwrap();
        s.create_project("工作", "需求").unwrap();
        s.create_sub_project("工作", "需求", "前端").unwrap();
        s.create_sub_project("工作", "需求/前端", "组件").unwrap();
        let titled = s.create_todo("工作", "需求", "写周报", "正文").unwrap();
        let untitled = s.create_todo("工作", "需求", "", "# 没有标题的待办\n第二行").unwrap();
        let deep = s.create_todo("工作", "需求/前端/组件", "按钮", "").unwrap();
        assert_eq!(default_name(&s, "工作", Some("需求"), Some(&titled.id)), "写周报");
        assert_eq!(default_name(&s, "工作", Some("需求"), Some(&untitled.id)), "没有标题的待办 第二行");
        assert_eq!(default_name(&s, "工作", Some("需求/前端/组件"), Some(&deep.id)), "按钮");
        // 项目：各级用「 - 」连起来，层数不限
        assert_eq!(default_name(&s, "工作", Some("需求"), None), "需求");
        assert_eq!(default_name(&s, "工作", Some("需求/前端"), None), "需求 - 前端");
        assert_eq!(default_name(&s, "工作", Some("需求/前端/组件"), None), "需求 - 前端 - 组件");
        assert_eq!(default_name(&s, "工作", None, None), "工作");
        assert_eq!(file_name(&default_name(&s, "工作", Some("需求"), Some("不在")), Format::Html), "待办.html");
    }

    #[test]
    fn long_project_paths_keep_the_top_and_the_project_itself() {
        // 连起来超过 80 个字：留下顶层项目和后面放得下的那几级，中间换成「…」
        let level = |c: &str| c.repeat(15);
        let path = ["甲", "乙", "丙", "丁", "戊", "己"].map(level).join("/");
        let name = project_base(&path);
        assert!(name.chars().count() <= 80, "{name}");
        assert_eq!(name, format!("{} - … - {} - {} - {}", level("甲"), level("丁"), level("戊"), level("己")));
        // 只折叠掉一级就放得下时也折叠
        let path = ["甲", "乙", "丙", "丁", "戊"].map(level).join("/");
        assert_eq!(project_base(&path), format!("{} - … - {} - {} - {}", level("甲"), level("丙"), level("丁"), level("戊")));
        // 顶层和它自己也放不下：留下这两级，由 file_name 截到 80 个字
        let path = format!("{}/中间/{}", "长".repeat(60), "尾".repeat(60));
        assert_eq!(project_base(&path), format!("{} - … - {}", "长".repeat(60), "尾".repeat(60)));
        assert_eq!(file_name(&project_base(&path), Format::Html).chars().count(), 80 + ".html".len());
        // 只有两级的不折叠，太长的照样由 file_name 截短
        let two = format!("{}/{}", "长".repeat(60), "尾".repeat(60));
        assert_eq!(project_base(&two), format!("{} - {}", "长".repeat(60), "尾".repeat(60)));
    }

    // ----- 整个文档 -----

    fn ms(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis()
    }

    fn item(project: &str, title: &str, content: &str, done: bool) -> Item {
        Item {
            workspace: "工作".into(),
            project: project.into(),
            title: title.into(),
            preview: store::make_preview(content),
            done,
            pinned: false,
            created_at: ms(2026, 10, 1, 9, 5),
            updated_at: ms(2026, 10, 2, 18, 30),
            done_at: done.then(|| ms(2026, 10, 3, 8, 0)),
            content: content.into(),
            dir: PathBuf::from("."),
        }
    }

    fn section(project: &str, items: Vec<Item>, children: Vec<Section>) -> Section {
        Section { project: project.into(), items, dropped: 0, children }
    }

    fn doc(scope: Scope, root: Section) -> Document {
        Document { scope, workspace: "工作".into(), include_done: true, root }
    }

    fn now() -> chrono::DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, 10, 15, 30, 0).unwrap()
    }

    /// 目录那一段
    fn toc_of(html: &str) -> &str {
        html.split("<nav class=\"toc\">").nth(1).unwrap().split("</nav>").next().unwrap()
    }

    /// 文档里各个标题（章的、待办的）按出现的先后：「h几:文字」（章前面灰色的上级路径不算）
    fn headings(html: &str) -> Vec<String> {
        let body = html.split("</nav>").nth(1).unwrap_or(html);
        body.split("<h")
            .skip(1)
            .filter_map(|s| {
                let level = s.chars().next().filter(char::is_ascii_digit)?;
                let inner = s.split_once('>')?.1;
                let inner = match inner.split_once("</span>") {
                    Some((path, rest)) if path.starts_with("<span class=\"chapter-path\">") => rest,
                    _ => inner,
                };
                Some(format!("h{level}:{}", inner.split('<').next()?))
            })
            .collect()
    }

    #[test]
    fn single_todo_has_its_details() {
        let mut t = item("需求/前端", "改登录页", "| a |\n| - |\n| 1 |\n", true);
        t.pinned = true;
        let html = render(&doc(Scope::Todo, section("需求/前端", vec![t], vec![])), now());
        assert!(html.contains("<title>改登录页</title>"), "{html}");
        assert!(html.contains("<h1 class=\"todo-title\">改登录页</h1>"), "{html}");
        assert!(!html.contains("class=\"cover") && !html.contains("class=\"toc"), "导出一条待办没有封面和目录");
        for want in [
            "<span class=\"tag done\">已完成</span>",
            "<span class=\"tag pinned\">已置顶</span>",
            "<span class=\"todo-where\">工作 / 需求 / 前端</span>",
            "创建于 2026-10-01 09:05",
            "最后修改 2026-10-02 18:30",
            "完成于 2026-10-03 08:00",
            "<table>",
            "由待办清单导出于 2026-10-10 15:30",
            "color-scheme: light",
        ] {
            assert!(html.contains(want), "缺 {want}：{html}");
        }
    }

    #[test]
    fn untitled_and_empty_todos() {
        let one = |t: Item| render(&doc(Scope::Todo, section("需求", vec![t], vec![])), now());
        let html = one(item("需求", "", "## 只有正文\n很多字", false));
        assert!(html.contains("<h1 class=\"todo-title untitled\">只有正文 很多字</h1>"), "{html}");
        assert!(html.contains("<span class=\"tag doing\">进行中</span>") && !html.contains("完成于"), "{html}");
        let html = one(item("需求", "", "", false));
        assert!(html.contains(">空白待办</h1>") && html.contains("（没有正文）"), "{html}");
        let long = "字".repeat(80);
        let html = one(item("需求", "", &long, false));
        assert!(html.contains(&format!(">{}…</h1>", "字".repeat(60))), "{html}");
    }

    #[test]
    fn project_chapters_nest_at_any_depth() {
        // 需求（自己两条）> 前端（一条）> 组件（一条）> 按钮（一条）；需求 > 后端（空的）
        let root = section(
            "需求",
            vec![item("需求", "父二", "", false), item("需求", "父一", "", true)],
            vec![
                section(
                    "需求/前端",
                    vec![item("需求/前端", "前端的", "", false)],
                    vec![section(
                        "需求/前端/组件",
                        vec![item("需求/前端/组件", "组件的", "", false)],
                        vec![section("需求/前端/组件/按钮", vec![item("需求/前端/组件/按钮", "按钮的", "", true)], vec![])],
                    )],
                ),
                section("需求/后端", vec![], vec![]),
            ],
        );
        let html = render(&doc(Scope::Project, root), now());
        // 封面：数目连同各级子项目
        for want in [
            "<div class=\"cover-kind\">项目</div><h1 class=\"cover-title\">需求</h1>",
            "<dt>项目路径</dt><dd>工作 / 需求</dd>",
            "<dt>子项目</dt><dd>4 个（含各级）</dd>",
            "<dt>待办</dt><dd>5 条（已完成 2 条，未完成 3 条）</dd>",
            "width: 40%",
            "<dt>导出时间</dt><dd>2026-10-10 15:30</dd>",
        ] {
            assert!(html.contains(want), "缺 {want}：{html}");
        }
        assert!(!html.contains("<dt>说明</dt>"), "{html}");
        // 顺序照给的：项目自己的待办在前，各级子项目依次作为下一级的章，标题一级级加深，章里待办的标题比章低一级
        assert_eq!(
            headings(&html),
            [
                "h2:父二",
                "h2:父一",
                "h1:前端",
                "h2:前端的",
                "h2:组件",
                "h3:组件的",
                "h3:按钮",
                "h4:按钮的",
                "h1:后端",
            ]
        );
        // 下一级的章在上一级的章里面
        let front = html.split("<h1 class=\"chapter-title\">前端</h1>").nth(1).unwrap();
        let front = front.split("<h1 class=\"chapter-title\">后端</h1>").next().unwrap();
        assert!(front.contains("<section class=\"chapter depth-2\"") && front.contains("<section class=\"chapter depth-3\""), "{front}");
        // 目录：章一层层缩进（下一级的章在上一级那一行下面），每个链接都有对应的锚点
        let toc = toc_of(&html);
        assert!(
            toc.contains(">前端</a><ul><li class=\"toc-todo\"><a href=\"#todo-2\">前端的</a></li><li class=\"toc-chapter\"><a href=\"#chapter-1\">组件</a><ul>"),
            "{toc}"
        );
        assert!(toc.contains(">按钮</a><ul><li class=\"toc-todo\"><a href=\"#todo-4\">按钮的</a><span class=\"toc-done\">已完成</span></li></ul></li></ul></li></ul></li><li class=\"toc-chapter\"><a href=\"#chapter-3\">后端</a>"), "{toc}");
        let t = |s: &str| toc.find(s).unwrap_or_else(|| panic!("目录里没有 {s}：{toc}"));
        assert!(t(">父二</a>") < t(">父一</a>") && t(">父一</a>") < t(">前端</a>") && t(">组件</a>") < t(">后端</a>"));
        for href in toc.split("href=\"#").skip(1).map(|s| s.split('"').next().unwrap()) {
            assert!(html.contains(&format!("id=\"{href}\"")), "没有锚点 {href}");
        }
        assert_eq!(toc.matches("<ul>").count(), toc.matches("</ul>").count(), "{toc}");
        // 没有待办的子项目也列出来
        let back = html.split("<h1 class=\"chapter-title\">后端</h1>").nth(1).unwrap();
        assert!(back.starts_with("<p class=\"empty\">没有待办</p>"), "{back}");
    }

    #[test]
    fn chapter_without_own_todos_goes_straight_to_its_sub_projects() {
        // 「需求」自己没有待办、下面有子项目：不写「没有待办」，标题后面直接是第一个子项目的章（打印时接在标题后面）
        let root = section(
            "",
            vec![],
            vec![section("需求", vec![], vec![section("需求/前端", vec![item("需求/前端", "页面", "", false)], vec![])])],
        );
        let html = render(&doc(Scope::Workspace, root), now());
        assert!(html.contains("<h1 class=\"chapter-title\">需求</h1><section class=\"chapter depth-2\""), "{html}");
        assert!(!html.contains("没有待办</p>"), "{html}");
        // 导出的项目自己没有待办：封面后面直接是第一章，不写「没有待办」
        let root = section("需求", vec![], vec![section("需求/前端", vec![item("需求/前端", "页面", "", false)], vec![])]);
        let html = render(&doc(Scope::Project, root), now());
        assert!(html.contains("</div><section class=\"chapter depth-1\""), "{html}");
        assert!(!html.contains("class=\"own\"") && !html.contains("没有待办</p>"), "{html}");
        // 什么都没有的项目写「没有待办」
        let html = render(&doc(Scope::Project, section("需求", vec![], vec![])), now());
        assert!(html.contains("<section class=\"own\"><p class=\"empty\">没有待办</p></section>"), "{html}");
        assert!(toc_of(&html).contains("<p class=\"empty\">没有待办</p>"), "{html}");
    }

    #[test]
    fn workspace_chapters_follow_the_project_tree() {
        let root = section(
            "",
            vec![],
            vec![
                section("日常", vec![item("日常", "打卡", "", true)], vec![]),
                section(
                    "需求",
                    vec![],
                    vec![section(
                        "需求/前端",
                        vec![item("需求/前端", "页面", "", false)],
                        vec![section("需求/前端/组件", vec![item("需求/前端/组件", "按钮", "", false)], vec![])],
                    )],
                ),
            ],
        );
        let html = render(&doc(Scope::Workspace, root), now());
        assert!(html.contains("<div class=\"cover-kind\">工作区</div><h1 class=\"cover-title\">工作</h1>"), "{html}");
        // 项目数是顶层项目，另写各级子项目；待办连同各级子项目
        assert!(html.contains("<dt>项目</dt><dd>2 个（另有各级子项目 2 个）</dd>"), "{html}");
        assert!(html.contains("3 条（已完成 1 条，未完成 2 条）"), "{html}");
        assert!(html.contains("<section class=\"chapter depth-1\" id=\"chapter-0\"><h1 class=\"chapter-title\">日常</h1>"), "{html}");
        // 二级和更深的章前面写上它外面那几章
        assert!(
            html.contains("<section class=\"chapter depth-2\" id=\"chapter-2\"><h2 class=\"chapter-title\"><span class=\"chapter-path\">需求 / </span>前端</h2>"),
            "{html}"
        );
        assert!(
            html.contains("<section class=\"chapter depth-3\" id=\"chapter-3\"><h3 class=\"chapter-title\"><span class=\"chapter-path\">需求 / 前端 / </span>组件</h3>"),
            "{html}"
        );
        assert_eq!(headings(&html), ["h1:日常", "h2:打卡", "h1:需求", "h2:前端", "h3:页面", "h3:组件", "h4:按钮"]);
        // 目录：子项目在它的父项目下面，一级级缩进
        let toc = toc_of(&html);
        assert!(
            toc.contains(">需求</a><ul><li class=\"toc-chapter\"><a href=\"#chapter-2\">前端</a><ul><li class=\"toc-todo\"><a href=\"#todo-1\">页面</a></li><li class=\"toc-chapter\"><a href=\"#chapter-3\">组件</a>"),
            "{toc}"
        );
        // 没有子项目的工作区：项目数只有一个数
        let html = render(&doc(Scope::Workspace, section("", vec![], vec![section("日常", vec![], vec![])])), now());
        assert!(html.contains("<dt>项目</dt><dd>1 个</dd>"), "{html}");
        // 没有项目的工作区
        let html = render(&doc(Scope::Workspace, section("", vec![], vec![])), now());
        assert!(html.contains("<p class=\"empty\">没有待办</p>"), "{html}");
    }

    #[test]
    fn headings_stop_deepening_at_h6() {
        // 七级子项目：章的标题最深到 h6，里面待办的标题也是 h6；样式上三级和更深的一样
        let names = ["一", "二", "三", "四", "五", "六", "七"];
        let mut deepest: Option<Section> = None;
        for i in (0..names.len()).rev() {
            let path = names[..=i].join("/");
            let children = deepest.take().into_iter().collect();
            deepest = Some(section(&path, vec![item(&path, &format!("待办{}", names[i]), "", false)], children));
        }
        let html = render(&doc(Scope::Workspace, section("", vec![], vec![deepest.unwrap()])), now());
        let h = headings(&html);
        assert_eq!(h[0], "h1:一");
        assert_eq!(h[1], "h2:待办一");
        assert_eq!(h[10], "h6:六");
        assert_eq!(h[11], "h6:待办六");
        assert_eq!(h[12], "h6:七");
        assert_eq!(h[13], "h6:待办七");
        assert!(
            html.contains("<section class=\"chapter depth-3\" id=\"chapter-6\"><h6 class=\"chapter-title\"><span class=\"chapter-path\">一 / 二 / 三 / 四 / 五 / 六 / </span>七</h6>"),
            "{html}"
        );
        assert!(!html.contains("<h7"), "{html}");
    }

    #[test]
    fn sub_project_cover_shows_the_whole_path() {
        let root = section("需求/前端/组件", vec![item("需求/前端/组件", "按钮", "", false)], vec![]);
        let html = render(&doc(Scope::Project, root), now());
        assert!(html.contains("<title>需求 / 前端 / 组件</title>"), "{html}");
        assert!(html.contains("<div class=\"cover-kind\">子项目</div><h1 class=\"cover-title\">需求 / 前端 / 组件</h1>"), "{html}");
        assert!(html.contains("<dd>工作 / 需求 / 前端 / 组件</dd>") && !html.contains("<dt>子项目</dt>"), "{html}");
        assert!(html.contains("<span class=\"todo-where\">工作 / 需求 / 前端 / 组件</span>"), "{html}");
    }

    #[test]
    fn collect_reads_latest_and_keeps_the_tree() {
        let tmp = TempDir::new("collect");
        let s = Store::new(tmp.0.clone()).unwrap();
        s.create_workspace("工作").unwrap();
        s.create_project("工作", "需求").unwrap();
        s.create_sub_project("工作", "需求", "前端").unwrap();
        s.create_sub_project("工作", "需求/前端", "组件").unwrap();
        let a = s.create_todo("工作", "需求", "甲", "旧的").unwrap();
        let b = s.create_todo("工作", "需求", "乙", "").unwrap();
        let c = s.create_todo("工作", "需求/前端", "丙", "").unwrap();
        let d = s.create_todo("工作", "需求/前端/组件", "丁", "").unwrap();
        s.set_todo_done("工作", "需求", &b.id, true).unwrap();
        s.set_todo_done("工作", "需求/前端/组件", &d.id, true).unwrap();
        s.save_todo_content("工作", "需求", &a.id, "新的正文", None, true).unwrap();
        let group = |project: &str, ids: Vec<String>, children: Vec<Group>| Group { project: project.into(), ids, children };
        let tree = |own: Vec<String>| {
            group(
                "需求",
                own,
                vec![group("需求/前端", vec![c.id.clone()], vec![group("需求/前端/组件", vec![d.id.clone()], vec![])])],
            )
        };
        let req = |scope: Scope, include_done: bool, groups: Vec<Group>| Request {
            format: Format::Html,
            path: String::new(),
            scope,
            workspace: "工作".into(),
            include_done,
            groups,
        };
        // 顺序照给的（不再排），排好序之后被删掉的跳过；读的是磁盘上最新的；各级子项目原样留着
        let doc = collect(&s, &req(Scope::Project, true, vec![tree(vec![b.id.clone(), "已删除".into(), a.id.clone()])])).unwrap();
        let titles: Vec<&str> = doc.root.items.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(titles, ["乙", "甲"]);
        assert_eq!(doc.root.items[1].content, "新的正文");
        assert_eq!(doc.root.items[0].dir, s.project_path("工作", "需求").unwrap());
        let front = &doc.root.children[0];
        assert_eq!((front.project.as_str(), front.items[0].title.as_str()), ("需求/前端", "丙"));
        let comp = &front.children[0];
        assert_eq!((comp.project.as_str(), comp.items[0].title.as_str()), ("需求/前端/组件", "丁"));
        // 正文里的相对路径相对于它自己那一级的项目文件夹
        assert_eq!(comp.items[0].dir, s.project_path("工作", "需求/前端/组件").unwrap());
        assert_eq!(doc.count(), 4);
        assert_eq!(doc.title(), "需求");
        // 不含已完成的：每一级都去掉，封面上写明一共去掉了几条
        let doc = collect(&s, &req(Scope::Project, false, vec![tree(vec![b.id.clone(), a.id.clone()])])).unwrap();
        assert_eq!(doc.count(), 2);
        let html = render(&doc, now());
        assert!(html.contains("<dd>4 条（已完成 2 条，未完成 2 条）</dd>") && html.contains("<dd>不含已完成的 2 条待办</dd>"), "{html}");
        assert!(!html.contains(">乙</") && !html.contains(">丁</"), "{html}");
        // 导出的项目里的都完成了、不含已完成时：正文和目录都写「没有未完成的待办」
        let all_done = collect(&s, &req(Scope::Project, false, vec![group("需求", vec![b.id.clone()], vec![])])).unwrap();
        let done_html = render(&all_done, now());
        assert_eq!(done_html.matches("<p class=\"empty\">没有未完成的待办</p>").count(), 2, "{done_html}");
        // 子项目里的都完成了、不含已完成时写「没有未完成的待办」
        assert!(html.contains("<span class=\"chapter-path\">前端 / </span>组件</h2><p class=\"empty\">没有未完成的待办</p>"), "{html}");
        // 导出工作区：给的是各个顶层项目
        let ws = collect(&s, &req(Scope::Workspace, true, vec![tree(vec![a.id.clone()])])).unwrap();
        assert_eq!((ws.root.project.as_str(), ws.root.children.len(), ws.count()), ("", 1, 3));
        // 导出一条待办时它不在了要说；导出项目时只能给一个项目
        assert!(collect(&s, &req(Scope::Todo, true, vec![group("需求", vec!["不在".into()], vec![])])).is_err());
        assert!(collect(&s, &req(Scope::Project, true, vec![])).is_err());
    }

    #[test]
    fn images_in_deep_projects_are_embedded() {
        // 正文里粘贴的图片存在它那一级项目的 .assets\{id}\ 里，正文写相对路径：导出时嵌进去
        let tmp = TempDir::new("deep-img");
        let s = Store::new(tmp.0.clone()).unwrap();
        s.create_workspace("工作").unwrap();
        s.create_project("工作", "需求").unwrap();
        s.create_sub_project("工作", "需求", "前端").unwrap();
        s.create_sub_project("工作", "需求/前端", "组件").unwrap();
        let t = s.create_todo("工作", "需求/前端/组件", "截图", "").unwrap();
        let saved = s.save_image("工作", "需求/前端/组件", &t.id, "png", PNG).unwrap();
        s.save_todo_content("工作", "需求/前端/组件", &t.id, &format!("![截图](<{}>)\n", saved.link), None, true).unwrap();
        let req = Request {
            format: Format::Html,
            path: String::new(),
            scope: Scope::Workspace,
            workspace: "工作".into(),
            include_done: true,
            groups: vec![Group {
                project: "需求".into(),
                ids: vec![],
                children: vec![Group {
                    project: "需求/前端".into(),
                    ids: vec![],
                    children: vec![Group { project: "需求/前端/组件".into(), ids: vec![t.id.clone()], children: vec![] }],
                }],
            }],
        };
        let html = render(&collect(&s, &req).unwrap(), now());
        assert!(html.contains(&format!("src=\"data:image/png;base64,{}\"", b64(PNG))), "{html}");
        assert!(!html.contains("图片不存在"), "{html}");
    }

    #[test]
    fn footnotes_of_different_todos_do_not_clash() {
        let root = section("需求", vec![item("需求", "一", "甲[^1]\n\n[^1]: 一的", false)], vec![section(
            "需求/前端",
            vec![item("需求/前端", "二", "乙[^1]\n\n[^1]: 二的", false)],
            vec![],
        )]);
        let html = render(&doc(Scope::Project, root), now());
        assert!(html.contains("id=\"md-todo-0-fn-1\"") && html.contains("id=\"md-todo-1-fn-1\""), "{html}");
    }
}
