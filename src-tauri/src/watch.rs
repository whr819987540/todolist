//! 监听数据目录：运行期间数据目录里的文件在外部变化时（网盘同步下来的、别的程序保存的、在资源管理器里增删改名的），
//! 告诉主窗口哪些变了（lib.rs 发 data-changed），前端只刷新有变化的部分。
//!
//! - 一阵变化合起来算一次：最后一处变化之后静下来 QUIET 才报；一直在变（网盘在同步一大批文件）时最多攒 MAX_WAIT 报一次。
//!   一批里变了很多处（BURST 以上）时当成什么都可能变了：系统的变化通知缓冲区满了会把那一段整个丢掉，notify 不报错
//! - 哪些路径的变化算、算成什么见 classify：只看工作区、项目、子项目的文件夹，待办的正文和元数据，项目的顺序；
//!   `.recycle` 里的只用来刷新开着的回收站
//! - 软件自己写的不算：store.rs 每次写完记下写过的文件、文件夹现在的样子（OwnWrites），监听到的变化和记下的一样就去掉
//!
//! 监听建不起来（数据目录不在等）时 start 返回错误；建起来之后出了错（数据目录被删、网络盘不支持变化通知），
//! notify 在 Windows 上悄悄停掉、不再报。都只是不再自动刷新，窗口获得焦点、F5 时照常刷新

use crate::store::{own_writes, PathState, META_FILE, ORDER_FILE, RECYCLE_DIR};
use notify::event::{EventKind, ModifyKind};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// 最后一处变化之后静下来这么久才报
const QUIET: Duration = Duration::from_millis(300);
/// 一直在变时最多攒这么久报一次
const MAX_WAIT: Duration = Duration::from_secs(2);
/// 一批里有这么多处以上（去掉不算的和自己写的之后）时，当成什么都可能变了
const BURST: usize = 200;
/// 一批里最多记这么多个不同的路径，再多的当成什么都可能变了（不让内存跟着涨）
const MAX_PENDING: usize = 50_000;

/// 一批变化合起来要告诉前端的（data-changed 事件带的内容）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataChanged {
    /// 什么都可能变了（一次变了很多处、监听出错）：全部刷新，这时 paths 是空的
    pub all: bool,
    /// 变了的路径，相对数据目录、用 / 分隔：工作区、项目、子项目的文件夹，待办的正文（写成「待办 id.md」），
    /// 元数据 .todos.json，项目的顺序 .projects.json（工作区、父项目文件夹里的）
    pub paths: BTreeSet<String>,
    /// 软件的回收站有变化（开着的回收站刷新列表）
    pub recycle: bool,
}

impl DataChanged {
    pub fn is_empty(&self) -> bool {
        !self.all && !self.recycle && self.paths.is_empty()
    }

    fn add(&mut self, change: Changed) {
        match change {
            Changed::All => self.all = true,
            Changed::Recycle => self.recycle = true,
            Changed::Path(p) => {
                self.paths.insert(p);
            }
        }
    }

    /// 合上后来的一批（主窗口藏在托盘里时攒着）
    pub fn merge(&mut self, later: DataChanged) {
        self.all |= later.all;
        self.recycle |= later.recycle;
        self.paths.extend(later.paths);
        self.settle();
    }

    /// 变了很多处时当成什么都可能变了，不再一条条列
    fn settle(&mut self) {
        if self.paths.len() > BURST {
            self.all = true;
        }
        if self.all {
            self.paths.clear();
        }
    }
}

/// 一个路径的变化算成什么
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Changed {
    /// 数据目录本身：全部刷新
    All,
    /// 软件的回收站里的
    Recycle,
    /// 工作区、项目、子项目的文件夹，待办的正文、元数据，项目的顺序（相对数据目录，/ 分隔）
    Path(String),
}

fn is_markdown(name: &str) -> bool {
    Path::new(name).extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// 数据目录里 rel（相对数据目录的各级名字）处的变化算不算、算成什么。structural：新建、删除、改名了
/// （不只是改了内容、属性）；now：变化之后它现在的样子（不在了的不知道原来是文件还是文件夹）
pub fn classify(rel: &[&str], structural: bool, now: PathState) -> Option<Changed> {
    let Some((first, rest)) = rel.split_first() else {
        return Some(Changed::All);
    };
    if first.eq_ignore_ascii_case(RECYCLE_DIR) {
        return Some(Changed::Recycle);
    }
    let depth = rel.len();
    let name = rel[depth - 1];
    let meta = (depth == 3 || depth == 4) && name.eq_ignore_ascii_case(META_FILE);
    // 项目的顺序：工作区文件夹里的（顶层项目的）、父项目文件夹里的（子项目的）
    let order = (depth == 2 || depth == 3) && name.eq_ignore_ascii_case(ORDER_FILE);
    // 数据目录里 . 开头的（界面状态、设置文件、.trash 等），项目文件夹里 . 开头的（保存时的临时文件、损坏的元数据留档、
    // 图片的附件目录 .assets）和 . 开头的文件夹里的都不算；元数据、项目的顺序算
    if first.starts_with('.') || (!meta && !order && rest.iter().any(|c| c.starts_with('.'))) {
        return None;
    }
    let dir = now == PathState::Dir;
    // 文件夹自己的修改时间、属性变了：里面增删改名了东西，那些东西自己有变化
    if dir && !structural {
        return None;
    }
    let file = matches!(now, PathState::File { .. });
    let md = !dir && is_markdown(name);
    let counted = match depth {
        // 工作区、项目的文件夹；直接放在数据目录、工作区文件夹里的文件（如设置备份的 zip）不算，工作区里的项目顺序算。
        // 不在了的可能是文件夹（删掉、改名了的工作区、项目），算
        1 => !file,
        2 => order || !file,
        // 项目里的待办正文、元数据、子项目的顺序、子项目的文件夹；别的文件不算
        3 => meta || md || order || !file,
        // 子项目里的待办正文、元数据；子项目里的文件夹、别的文件不算
        4 => meta || md,
        _ => false,
    };
    if !counted {
        return None;
    }
    let mut key = rel.join("/");
    if md {
        // 扩展名的大小写统一成 .md（前端按「待办 id.md」找打开着的待办）
        key.truncate(key.len() - 3);
        key.push_str(".md");
    }
    Some(Changed::Path(key))
}

/// 攒着的一批变化：路径 → 新建、删除、改名过（不只是改了内容）
#[derive(Default)]
struct Pending {
    paths: HashMap<PathBuf, bool>,
    /// 出错了、系统说要重新扫描、路径太多：当成什么都可能变了
    overflow: bool,
}

impl Pending {
    fn add(&mut self, res: notify::Result<Event>) {
        let event = match res {
            Ok(e) => e,
            Err(e) => {
                eprintln!("监听数据目录出错：{e}");
                self.overflow = true;
                return;
            }
        };
        if event.need_rescan() {
            self.overflow = true;
        }
        let structural = match event.kind {
            // 只是读了一下
            EventKind::Access(_) => return,
            EventKind::Modify(ModifyKind::Name(_)) => true,
            EventKind::Modify(_) => false,
            _ => true,
        };
        for path in event.paths {
            if self.paths.len() >= MAX_PENDING && !self.paths.contains_key(&path) {
                self.overflow = true;
                continue;
            }
            *self.paths.entry(path).or_default() |= structural;
        }
    }

    /// 静下来之后看看各个路径现在的样子，算出要告诉前端的；软件自己写的去掉
    fn finish(self, root: &Path) -> DataChanged {
        let mut out = DataChanged::default();
        if self.overflow {
            out.all = true;
            return out;
        }
        // 先读各个路径现在的文件信息，再拿着锁查是不是自己写的：读一大批文件信息时不拿锁，正在写数据的命令不用等
        let mut found = Vec::new();
        for (path, structural) in self.paths {
            let Ok(rel) = path.strip_prefix(root) else { continue };
            let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
            let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
            let now = PathState::of(&path);
            if let Some(change) = classify(&parts, structural, now) {
                found.push((path, now, change));
            }
        }
        let at = Instant::now();
        let mut own = own_writes();
        for (path, now, change) in found {
            if !own.is_own(&path, now, at) {
                out.add(change);
            }
        }
        drop(own);
        out.settle();
        out
    }
}

/// 在监听着的数据目录；丢掉它就不再监听，监听线程也跟着结束
pub struct DataWatcher {
    _watcher: RecommendedWatcher,
}

/// 开始监听数据目录 root（含各级子文件夹）。一阵变化合起来、去掉不算的和软件自己写的之后，还有要告诉前端的
/// 就在监听线程里调 on_change
pub fn start(root: &Path, on_change: impl FnMut(DataChanged) + Send + 'static) -> notify::Result<DataWatcher> {
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    let root = root.to_path_buf();
    std::thread::Builder::new()
        .name("watch-data".into())
        .spawn(move || run(&root, &rx, on_change))
        .map_err(notify::Error::io)?;
    Ok(DataWatcher { _watcher: watcher })
}

/// 监听线程：没有变化时一直等着（不占 CPU）；来了一处变化就开始攒，静下来 QUIET（最多攒 MAX_WAIT）后报一次。
/// 监听停了（DataWatcher 丢掉了）时结束
fn run(root: &Path, rx: &Receiver<notify::Result<Event>>, mut on_change: impl FnMut(DataChanged)) {
    while let Ok(first) = rx.recv() {
        let mut batch = Pending::default();
        batch.add(first);
        let started = Instant::now();
        loop {
            let wait = QUIET.min(MAX_WAIT.saturating_sub(started.elapsed()));
            if wait.is_zero() {
                break;
            }
            match rx.recv_timeout(wait) {
                Ok(e) => batch.add(e),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let changed = batch.finish(root);
        if !changed.is_empty() {
            on_change(changed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{OwnWrites, Store};
    use notify::event::{AccessKind, CreateKind, DataChange, RemoveKind, RenameMode};
    use std::fs;
    use std::time::SystemTime;

    const FILE: PathState = PathState::File { modified: None, len: 1 };
    const DIR: PathState = PathState::Dir;
    const GONE: PathState = PathState::Absent;

    fn path(p: &str) -> Option<Changed> {
        Some(Changed::Path(p.into()))
    }

    /// 新建、删除、改名的（structural），和只改了内容的
    fn moved(rel: &str, now: PathState) -> Option<Changed> {
        classify(&rel.split('/').collect::<Vec<_>>(), true, now)
    }
    fn edited(rel: &str, now: PathState) -> Option<Changed> {
        classify(&rel.split('/').collect::<Vec<_>>(), false, now)
    }

    #[test]
    fn workspaces_projects_and_todos_count() {
        // 工作区、项目、子项目的文件夹：新建、删除、改名
        assert_eq!(moved("工作", DIR), path("工作"));
        assert_eq!(moved("工作", GONE), path("工作"));
        assert_eq!(moved("工作/需求", DIR), path("工作/需求"));
        assert_eq!(moved("工作/需求", GONE), path("工作/需求"));
        assert_eq!(moved("工作/需求/前端", DIR), path("工作/需求/前端"));
        assert_eq!(moved("工作/需求/前端", GONE), path("工作/需求/前端"));
        // 项目、子项目里的待办正文：新建、改了内容、删除、改名；扩展名统一成 .md
        assert_eq!(moved("工作/需求/A.md", FILE), path("工作/需求/A.md"));
        assert_eq!(edited("工作/需求/A.md", FILE), path("工作/需求/A.md"));
        assert_eq!(moved("工作/需求/A.md", GONE), path("工作/需求/A.md"));
        assert_eq!(edited("工作/需求/会议纪要.MD", FILE), path("工作/需求/会议纪要.md"));
        assert_eq!(edited("工作/需求/前端/B.md", FILE), path("工作/需求/前端/B.md"));
        assert_eq!(moved("工作/需求/前端/B.md", GONE), path("工作/需求/前端/B.md"));
        // 元数据（标题、完成状态、置顶、顺序）
        assert_eq!(edited("工作/需求/.todos.json", FILE), path("工作/需求/.todos.json"));
        assert_eq!(moved("工作/需求/.todos.json", GONE), path("工作/需求/.todos.json"));
        assert_eq!(edited("工作/需求/前端/.todos.json", FILE), path("工作/需求/前端/.todos.json"));
        // 项目的顺序：工作区里的（顶层项目）、父项目里的（子项目）
        assert_eq!(edited("工作/.projects.json", FILE), path("工作/.projects.json"));
        assert_eq!(moved("工作/.projects.json", GONE), path("工作/.projects.json"));
        assert_eq!(edited("工作/需求/.projects.json", FILE), path("工作/需求/.projects.json"));
        assert_eq!(moved("工作/需求/.projects.json", FILE), path("工作/需求/.projects.json"));
        // 数据目录本身
        assert_eq!(classify(&[], true, GONE), Some(Changed::All));
    }

    #[test]
    fn hidden_and_unrelated_files_do_not_count() {
        // 数据目录里 . 开头的：界面状态、设置文件、WebDAV 配置、.trash、恢复数据时的临时文件夹
        for rel in [".state.json", ".settings.json", ".webdav.json", ".state.json.tmp", ".trash/x.md", ".restoring-1/新/工作"] {
            assert_eq!(edited(rel, FILE), None, "{rel}");
            assert_eq!(moved(rel, GONE), None, "{rel}");
        }
        // 项目文件夹里 . 开头的：保存时的临时文件、损坏的元数据留档、隐藏的文件夹和里面的
        for rel in [
            "工作/需求/.A.md.tmp",
            "工作/需求/..todos.json.tmp",
            "工作/需求/.todos.json.broken-20261009",
            "工作/需求/前端/.B.md.tmp",
            "工作/.git/config",
            "工作/需求/.git",
            "工作/需求/.obsidian/A.md",
            "工作/.todos.json",
            // 项目的顺序写盘时的临时文件；子项目里没有子项目，那里的不算
            "工作/..projects.json.tmp",
            "工作/需求/..projects.json.tmp",
            "工作/需求/前端/.projects.json",
            ".projects.json",
            // 图片的附件目录和里面的图片（含子项目的、放错了地方的 .md）
            "工作/需求/.assets",
            "工作/需求/.assets/20261010-101010",
            "工作/需求/.assets/20261010-101010/图片-20261010-101010.png",
            "工作/需求/.assets/20261010-101010/笔记.md",
            "工作/需求/前端/.assets/A/截图.png",
        ] {
            assert_eq!(moved(rel, FILE), None, "{rel}");
            assert_eq!(moved(rel, GONE), None, "{rel}");
        }
        // 直接放在数据目录、工作区文件夹里的文件（如设置备份的 zip），项目里不是 .md 的文件
        assert_eq!(moved("TodoList-settings-20261009-120000.zip", FILE), None);
        assert_eq!(moved("工作/说明.md", FILE), None);
        assert_eq!(moved("工作/需求/截图.png", FILE), None);
        assert_eq!(edited("工作/需求/截图.png", FILE), None);
        // 子项目里的文件夹、它里面的，和更深的
        assert_eq!(moved("工作/需求/前端/图片", DIR), None);
        assert_eq!(moved("工作/需求/前端/图片", GONE), None);
        assert_eq!(moved("工作/需求/前端/图片/C.md", FILE), None);
        assert_eq!(moved("工作/需求/前端/截图.png", GONE), None);
        // 文件夹自己的修改时间、属性变了（里面增删改名了东西）
        for rel in ["工作", "工作/需求", "工作/需求/前端"] {
            assert_eq!(edited(rel, DIR), None, "{rel}");
        }
    }

    #[test]
    fn recycle_bin_changes_are_reported_separately() {
        assert_eq!(moved(".recycle", DIR), Some(Changed::Recycle));
        assert_eq!(moved(".recycle/20261009-120000-123/entry.json", FILE), Some(Changed::Recycle));
        assert_eq!(edited(".recycle/20261009-120000-123", DIR), Some(Changed::Recycle));
        let mut c = DataChanged::default();
        c.add(Changed::Recycle);
        assert!(c.recycle && c.paths.is_empty() && !c.all && !c.is_empty());
    }

    #[test]
    fn many_changes_become_one_full_refresh() {
        let mut c = DataChanged::default();
        for i in 0..BURST {
            c.add(Changed::Path(format!("工作/需求/{i}.md")));
        }
        c.settle();
        assert!(!c.all && c.paths.len() == BURST);
        let mut later = DataChanged::default();
        later.add(Changed::Path("工作/需求/又一个.md".into()));
        c.merge(later);
        assert!(c.all && c.paths.is_empty(), "超过 {BURST} 处时当成全部变了");
        // 合并：攒着的和后来的合起来
        let mut a = DataChanged::default();
        a.add(Changed::Path("工作".into()));
        let mut b = DataChanged::default();
        b.add(Changed::Path("生活".into()));
        b.add(Changed::Recycle);
        a.merge(b);
        assert_eq!(a.paths.iter().map(String::as_str).collect::<Vec<_>>(), ["工作", "生活"]);
        assert!(a.recycle && !a.all);
    }

    #[test]
    fn own_writes_are_recognised_until_changed_again() {
        let t0 = Instant::now();
        let mut own = OwnWrites::new();
        let saved = PathState::File { modified: Some(SystemTime::UNIX_EPOCH + Duration::from_secs(100)), len: 5 };
        let later = PathState::File { modified: Some(SystemTime::UNIX_EPOCH + Duration::from_secs(101)), len: 5 };
        let p = Path::new(r"C:\数据\工作\需求\A.md");
        own.note(p, saved, t0);
        // 现在的样子和写完时一样：自己写的（Windows 的路径不分大小写、/ 和 \ 都行）
        assert!(own.is_own(p, saved, t0 + Duration::from_secs(1)));
        assert!(own.is_own(Path::new("c:/数据/工作/需求/a.MD"), saved, t0 + Duration::from_secs(2)));
        // 写完之后外部又改了：不算自己写的，之后又变回同样的样子也不算了
        assert!(!own.is_own(p, later, t0 + Duration::from_secs(3)));
        assert!(!own.is_own(p, saved, t0 + Duration::from_secs(3)));
        // 删掉、移走的记成不在；过了 10 秒的不认
        let q = Path::new(r"C:\数据\工作\旧项目");
        own.note(q, PathState::Absent, t0);
        assert!(own.is_own(q, PathState::Absent, t0 + Duration::from_secs(9)));
        assert!(!own.is_own(q, PathState::Absent, t0 + Duration::from_secs(11)));
        // 没写过的
        assert!(!own.is_own(Path::new(r"C:\数据\工作\需求\B.md"), saved, t0));
        // 刚写过里面的文件，随即把文件夹改名、移走、删掉了：里面的也跟着不在了；名字只是开头一样的文件夹不受影响
        let inside = Path::new(r"C:\数据\工作\日常\B.md");
        let other = Path::new(r"C:\数据\工作\日常事务\C.md");
        own.note(inside, saved, t0);
        own.note(other, saved, t0);
        own.note(Path::new(r"C:\数据\工作\日常"), PathState::Absent, t0);
        assert!(own.is_own(inside, PathState::Absent, t0 + Duration::from_secs(1)));
        assert!(own.is_own(other, saved, t0 + Duration::from_secs(1)));
    }

    fn event(kind: EventKind, p: &Path) -> notify::Result<Event> {
        Ok(Event::new(kind).add_path(p.to_path_buf()))
    }

    #[test]
    fn batch_merges_events_of_the_same_path() {
        let root = Path::new(r"C:\不存在的数据目录");
        let file = root.join("工作").join("需求").join("A.md");
        let mut b = Pending::default();
        b.add(event(EventKind::Modify(ModifyKind::Data(DataChange::Content)), &file));
        b.add(event(EventKind::Access(AccessKind::Read), &root.join("工作").join("需求").join("B.md")));
        assert_eq!(b.paths.len(), 1, "只是读了一下的不算");
        assert!(!b.paths[&file]);
        b.add(event(EventKind::Remove(RemoveKind::Any), &file));
        assert!(b.paths[&file], "删除过：不只是改了内容");
        let dir = root.join("工作").join("需求");
        b.add(event(EventKind::Modify(ModifyKind::Name(RenameMode::From)), &dir));
        b.add(event(EventKind::Create(CreateKind::Any), &root.join("工作").join("需求池")));
        let c = b.finish(root);
        assert_eq!(c.paths.iter().map(String::as_str).collect::<Vec<_>>(), ["工作/需求", "工作/需求/A.md", "工作/需求池"]);
        // 系统说要重新扫描、监听出错：当成全部变了
        let mut b = Pending::default();
        b.add(Ok(Event::new(EventKind::Any).set_flag(notify::event::Flag::Rescan)));
        assert!(b.finish(root).all);
        let mut b = Pending::default();
        b.add(Err(notify::Error::generic("测试")));
        assert!(b.finish(root).all);
    }

    // ----- 真的起监听：临时数据目录里外部改文件、软件自己写 -----

    struct TempRoot(PathBuf);

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_store(tag: &str) -> (TempRoot, Store) {
        let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
        let tmp = TempRoot(std::env::temp_dir().join(format!("todolist-watch-{tag}-{}-{nanos}", std::process::id())));
        let store = Store::new(tmp.0.join("数据")).unwrap();
        (tmp, store)
    }

    /// 收集 rx 里的批次，直到 enough(合起来的) 为真或者 wait 之内没有新的一批；返回合起来的和批数
    fn collect(rx: &Receiver<DataChanged>, wait: Duration, enough: impl Fn(&DataChanged) -> bool) -> (DataChanged, usize) {
        let mut all = DataChanged::default();
        let mut n = 0;
        while let Ok(c) = rx.recv_timeout(wait) {
            n += 1;
            all.merge(c);
            if enough(&all) {
                break;
            }
        }
        (all, n)
    }

    #[test]
    fn external_changes_are_merged_and_own_writes_skipped() {
        let (_tmp, s) = temp_store("merge");
        s.create_workspace("工作").unwrap();
        s.create_project("工作", "需求").unwrap();
        let mine = s.create_todo("工作", "需求", "自己的", "正文").unwrap();
        let dir = s.project_path("工作", "需求").unwrap();
        let (tx, rx) = mpsc::channel();
        let _w = start(s.root(), move |c| {
            let _ = tx.send(c);
        })
        .unwrap();

        // 外部一下子放进 50 个 .md、一个子项目，还有不算的（临时文件、图片、设置文件）：合成一两批
        for i in 0..50 {
            fs::write(dir.join(format!("外部{i:02}.md")), format!("第 {i} 条")).unwrap();
        }
        fs::create_dir(dir.join("前端")).unwrap();
        fs::write(dir.join(".外部00.md.tmp"), "x").unwrap();
        fs::write(dir.join("截图.png"), "x").unwrap();
        fs::write(s.root().join(".settings.json"), "{}").unwrap();
        let (got, batches) = collect(&rx, Duration::from_secs(5), |c| c.paths.len() >= 51);
        let expected: BTreeSet<String> = (0..50)
            .map(|i| format!("工作/需求/外部{i:02}.md"))
            .chain(["工作/需求/前端".to_string()])
            .collect();
        assert_eq!(got.paths, expected, "{got:?}");
        assert!(!got.all && !got.recycle);
        assert!(batches <= 3, "合成了 {batches} 批");
        // 下面要把有图片的待办移进「图片」项目，那里已经有外部放的同名 .md：移过去要换 id、改正文里的链接
        let pic = s.create_todo("工作", "需求", "有图的", "").unwrap();
        fs::create_dir(s.root().join("工作").join("图片")).unwrap();
        fs::write(s.root().join("工作").join("图片").join(format!("{}.md", pic.id)), "占着 id").unwrap();
        // 剩下的（同一批文件后来的变化）收完
        collect(&rx, Duration::from_secs(1), |_| false);

        // 软件自己写的：扫描时补登记元数据，新建、保存、改标题和完成状态、置顶、排序、移动、改名、删除、恢复，
        // 粘贴图片、移动有图片的待办（换了 id 时改正文里的链接），都不报（删除、恢复动了软件的回收站，只报回收站有变化）
        s.load_workspace("工作").unwrap();
        let img = s.save_image("工作", "需求", &pic.id, "png", b"png").unwrap();
        s.save_todo_content("工作", "需求", &pic.id, &format!("![]({})", img.link), None, false).unwrap();
        let relinked = s.move_todo("工作", "需求", &pic.id, "工作", "图片").unwrap();
        assert_ne!(relinked.id, pic.id);
        let rid = s.delete_todo("工作", "图片", &relinked.id).unwrap();
        assert!(s.restore(&[rid]).errors.is_empty());
        let t = s.create_todo("工作", "需求", "新建的", "").unwrap();
        s.save_todo_content("工作", "需求", &t.id, "保存的正文", None, false).unwrap();
        s.set_todo_title("工作", "需求", &mine.id, "改过的标题").unwrap();
        s.set_todo_done("工作", "需求", &mine.id, true).unwrap();
        s.set_todo_pinned("工作", "需求", &mine.id, true).unwrap();
        s.reorder_todos("工作", "需求", &[mine.id.clone(), t.id.clone()]).unwrap();
        s.create_project("工作", "日常").unwrap();
        // 项目的顺序：调整、换成按名称再换回来，跟着改名、移动、删除
        s.reorder_projects("工作", None, &["日常".into(), "需求".into(), "图片".into()]).unwrap();
        s.set_projects_manual("工作", false).unwrap();
        s.set_projects_manual("工作", true).unwrap();
        s.create_sub_project("工作", "需求", "前台").unwrap();
        s.reorder_projects("工作", Some("需求"), &["前台".into(), "前端".into()]).unwrap();
        s.create_project("工作", "零散").unwrap();
        s.move_project("工作", "零散", "工作", Some("需求"), Some(&["零散".into(), "前台".into()])).unwrap();
        s.move_project("工作", "需求/零散", "工作", None, None).unwrap();
        let rid = s.delete_project("工作", "零散").unwrap();
        assert!(s.restore(&[rid]).errors.is_empty());
        s.rename_project("工作", "需求/前台", "前台页面").unwrap();
        let moved = s.move_todo("工作", "需求", &t.id, "工作", "日常").unwrap();
        s.rename_project("工作", "日常", "日常事务").unwrap();
        s.create_sub_project("工作", "需求", "后端").unwrap();
        let rid = s.delete_todo("工作", "日常事务", &moved.id).unwrap();
        assert!(s.restore(&[rid]).errors.is_empty());
        // 刚恢复进来的待办随即连同项目删掉、又恢复回来
        let rid = s.delete_project("工作", "日常事务").unwrap();
        assert!(s.restore(&[rid]).errors.is_empty());
        let rid = s.delete_todo("工作", "日常事务", &moved.id).unwrap();
        assert!(s.restore(&[rid]).errors.is_empty());
        s.quick_capture("收件箱", "快速记录", "快速记的").unwrap();
        s.write_ui_state("{}").unwrap();
        let (own, _) = collect(&rx, Duration::from_millis(1500), |_| false);
        assert!(!own.all && own.paths.is_empty(), "软件自己写的不报：{own:?}");

        // 之后外部又改了自己刚写过的：照常报
        fs::write(dir.join(format!("{}.md", mine.id)), "外部改的").unwrap();
        let (got, _) = collect(&rx, Duration::from_secs(5), |c| !c.paths.is_empty());
        assert_eq!(got.paths.iter().map(String::as_str).collect::<Vec<_>>(), [format!("工作/需求/{}.md", mine.id)]);

        // 外部删掉项目（在资源管理器里删除是移到 Windows 回收站，相当于移出数据目录）、改名工作区：只报文件夹本身
        fs::rename(s.root().join("工作").join("日常事务"), _tmp.0.join("删掉的")).unwrap();
        fs::rename(s.root().join("收件箱"), s.root().join("收件")).unwrap();
        let (got, _) = collect(&rx, Duration::from_secs(5), |c| c.paths.len() >= 3);
        assert_eq!(got.paths.iter().map(String::as_str).collect::<Vec<_>>(), ["工作/日常事务", "收件", "收件箱"]);
    }

    #[test]
    fn watching_stops_when_dropped() {
        let (_tmp, s) = temp_store("stop");
        let (tx, rx) = mpsc::channel();
        let w = start(s.root(), move |c| {
            let _ = tx.send(c);
        })
        .unwrap();
        drop(w);
        fs::create_dir(s.root().join("工作")).unwrap();
        // 监听线程结束，on_change（连同 tx）跟着丢掉
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)), Err(RecvTimeoutError::Disconnected));
    }
}
