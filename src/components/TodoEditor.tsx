import {
  CheckCircleFilled,
  CheckOutlined,
  CodeOutlined,
  ExportOutlined,
  EyeOutlined,
  LoadingOutlined,
  MoreOutlined,
  PushpinFilled,
  UndoOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Alert,
  App as AntApp,
  Breadcrumb,
  Button,
  Dropdown,
  Input,
  Modal,
  Spin,
  Tag,
  Tooltip,
  type InputRef,
  type MenuProps,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import {
  fileName,
  formatSize,
  IMAGE_EXTS,
  ImageResolver,
  imageMarkdown,
  isImageName,
  LARGE_IMAGE,
  pastedImageExt,
} from "../editor/images";
import { webUrl } from "../editor/links";
import { activeIndex, type OutlineItem } from "../editor/outline";
import type { EditPosition } from "../editor/position";
import type { EditorMode } from "../editor/setup";
import { emitAppEvent, registerFlusher, useAppEvent, useFileDrag, useWindowFocus } from "../hooks";
import { leafName, parentOf } from "../projects";
import { type Leftover, leaveProblem, type LeaveProblem, type ProjectAt, rescueAsNew, rescueNotice } from "../rescue";
import { FONT_LIMITS, useEditShortcuts, useSaveOptions, useSettings } from "../settings";
import { eventShortcut, shortcutLabel } from "../shortcuts";
import type { TagCount } from "../tags";
import type { SavedImage, TextEncoding, TodoDetail, TodoSummary } from "../types";
import {
  displayTitle,
  formatDuration,
  fullTime,
  MY_VERSION,
  myVersionTitle,
  relativeTime,
  textStats,
  useLocalState,
  useNow,
} from "../utils";
import { type DataChange, todoTouched } from "../watch";
import {
  keepUndo,
  readEditorMode,
  readEditPosition,
  takeUndo,
  type UndoSnapshot,
  writeEditorMode,
  writeEditPosition,
} from "../workspaceState";
import MarkdownEditor, { type MarkdownEditorHandle } from "./MarkdownEditor";
import Outline from "./Outline";
import { TagEditor } from "./TodoMarks";

export interface EditorHandle {
  /**
   * 立即保存所有未保存的修改（Ctrl+S、重命名 / 移动等操作前），不受 auto save 开关影响。
   * 返回是否都存好了（没有要存的也算）；正文有冲突（弹出了冲突对话框）、保存失败（已提示）时为 false。
   * 离开这条待办（卸载）时另外会存一次，那时存不上的另存为新待办
   */
  flush(): Promise<boolean>;
  /** 待办已被删除/移走：之后不再尝试保存。撤销记录先按原来的位置留下，由 workspaceState 跟到新位置 */
  detach(): void;
  /** 在正文里查找（Ctrl+F）；replace 为 true 时同时展开替换（Ctrl+H）。正文还没加载出来时返回 false */
  find(replace: boolean): boolean;
  /** 焦点放进正文，光标还在原处、不滚动 */
  focusBody(): void;
}

interface Props {
  workspace: string;
  project: string;
  summary: TodoSummary;
  autoFocusTitle: boolean;
  /** 正文加载出来后焦点放进正文（光标在上次编辑的地方），点标签切过来时用 */
  autoFocusBody: boolean;
  handleRef: React.RefObject<EditorHandle | null>;
  menu: MenuProps;
  onSummary: (s: TodoSummary) => void;
  onToggleDone: () => void;
  /** 侧栏里显示的工作区用过的标签：输入标签时联想 */
  allTags: readonly TagCount[];
  /** 改标签（全部标签）；存好了返回 true */
  onTags: (tags: string[]) => Promise<boolean>;
  onOpenExternal: () => void;
  onSelectWorkspace: () => void;
  /** 点编辑区上方的项目（子项目时还有它的父项目），参数是项目路径 */
  onSelectProject: (project: string) => void;
  /** 外部修改冲突时选了「另存为新待办」：新建的那条（同一项目里），由外层加进列表并打开 */
  onSavedAsNew: (s: TodoSummary) => void;
  /** 打开后第一次修改了标题或正文（预览标签据此固定下来） */
  onEdit: () => void;
  /** 有没有没存好的修改（标签上的圆点）；卸载时（切走、关掉，那时会存盘，存不上的另存为新待办）报一次 false */
  onDirty: (dirty: boolean) => void;
}

type Status = "saved" | "dirty" | "saving" | "error";

/** Ctrl+滚轮调字号：滚轮转一格（约 100）调 1px，触控板双指缩放的小增量攒够一半再调 */
const WHEEL_STEP = 50;

/** 光标、滚动停下来多久后记下编辑位置（ms）；离开这条待办、窗口失去焦点时立即记 */
const POSITION_DELAY = 1000;

/** 打字停下来多久后更新状态栏的字数、行数和大纲（ms） */
const STATS_DELAY = 300;

/** 正文里至少有这么多个标题时才显示大纲 */
export const MIN_OUTLINE = 2;

const sameOutline = (a: readonly OutlineItem[], b: readonly OutlineItem[]) =>
  a.length === b.length && a.every((x, i) => x.pos === b[i].pos && x.level === b[i].level && x.text === b[i].text);

/**
 * auto save 关闭时的兜底（秒）：有未保存的修改，从第一处开始满 1 小时也自动保存一次，
 * 免得程序在托盘里挂好几天、改了的内容一直只在内存里。auto save 开着时按设置的间隔（不超过 1 小时）
 */
export const FALLBACK_SAVE_SECS = 3600;

const ENCODING_LABELS: Record<TextEncoding, string> = {
  "UTF-8": "UTF-8",
  "UTF-16": "UTF-16（修改后转存为 UTF-8）",
  GBK: "GBK（修改后转存为 UTF-8）",
  unknown: "编码无法识别（只读）",
};

const MODE_LABELS: Record<EditorMode, string> = { live: "实时渲染", source: "源码模式" };
const otherMode = (m: EditorMode): EditorMode => (m === "live" ? "source" : "live");

/**
 * 右侧的待办详情：标题 + Markdown 正文（实时渲染或源码模式）。
 * Ctrl+S、切换待办、从托盘退出时总是保存；有未保存的修改后还定时保存：auto save 开着时按设置的间隔，
 * 关着时满 1 小时兜底。auto save 开着时编辑器或窗口失去焦点也立即保存。
 * 切换待办、从托盘退出时存不上的（正文在外部被改过、待办在外部被删了等），自动另存为新待办（leave）
 */
export default function TodoEditor(props: Props) {
  const { workspace, project, summary, handleRef } = props;
  const id = summary.id;
  const { message } = AntApp.useApp();
  const { info: settingsInfo, setFontSize } = useSettings();
  const keys = settingsInfo?.settings;
  const editShortcuts = useEditShortcuts();
  const saveOptions = useSaveOptions();
  const { autoSave, saveDelaySecs } = saveOptions;
  const now = useNow();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  // 正文只在创建编辑器时读一次；之后的正文在 s.content 里，打字时不重新渲染这个组件
  const [initialDoc, setInitialDoc] = useState("");
  // 状态栏的字数、行数：打字停下来一会儿再算，不是每次按键都对全文统计
  const [stats, setStats] = useState({ chars: 0, lines: 0 });
  // 大纲（正文里的标题）同样打字停下来再更新；正在看的标题只在变了时重新渲染
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [activeHeading, setActiveHeading] = useState(-1);
  // 显示大纲是本机的显示偏好，所有待办共用
  const [outlineOn, setOutlineOn] = useLocalState("outlineVisible", true);
  const [title, setTitle] = useState(summary.title);
  const [path, setPath] = useState("");
  const [encoding, setEncoding] = useState<TextEncoding>("UTF-8");
  const [status, setStatus] = useState<Status>("saved");
  const [conflict, setConflict] = useState(false);
  // 实时渲染 / 源码模式，每条待办分别记住
  const [mode, setMode] = useState(() => readEditorMode(workspace, project, id));
  // 上次在这条待办里的编辑位置：打开时光标（选区）和滚动回到那里
  const [initialPosition] = useState(() => readEditPosition(workspace, project, id));
  // 这次运行期间上次打开时留下的撤销记录，正文在外部被改过时不用
  const [initialHistory, setInitialHistory] = useState<unknown>(null);
  // 认不出编码的文件只读，免得保存时把原文件覆盖成乱码
  const readOnly = encoding === "unknown";
  // 正文里的本地图片：经 Rust 端找到文件（相对于这条待办所在的项目文件夹，或绝对路径），用 asset 协议的地址显示，
  // 带上修改时间（图片在外部被替换后不用 WebView 缓存里旧的）
  const [images] = useState(
    () =>
      new ImageResolver(async (src) => {
        const f = await api.imageFile(workspace, project, src);
        return `${convertFileSrc(f.path)}?v=${f.modified}`;
      }),
  );

  const titleRef = useRef<InputRef>(null);
  const mdRef = useRef<MarkdownEditorHandle | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  // App 级的提示：卸载后（离开时另存为新待办）也能用
  const messageRef = useRef(message);
  const saveOptionsRef = useRef(saveOptions);
  // 快速记录存到的项目：离开时存不上、原来的项目也不在了时另存到这里
  const quickTargetRef = useRef(keys?.quickCaptureTarget);
  useEffect(() => {
    propsRef.current = props;
    messageRef.current = message;
    saveOptionsRef.current = saveOptions;
    quickTargetRef.current = keys?.quickCaptureTarget;
  });

  // 保存相关的可变状态放在 ref 里，异步回调和卸载时都能拿到最新值。
  // 渲染时只取一次这个对象本身（每次都是同一个），里面的值只在回调和 effect 里读写，渲染结果不依赖它们
  // eslint-disable-next-line react-hooks/refs
  const s = useRef({
    content: "",
    savedContent: "",
    title: summary.title,
    savedTitle: summary.title,
    mtime: null as number | null,
    loaded: false,
    detached: false,
    conflict: false,
    /** 定时保存：从第一处未保存的修改开始倒计时 */
    timer: 0,
    /** 这次倒计时从什么时候算起（第一处未保存的修改的时间），没在倒计时时是 0 */
    dirtyAt: 0,
    chain: Promise.resolve(),
    /** 还没记下的编辑位置 */
    position: null as EditPosition | null,
    positionTimer: 0,
    statsTimer: 0,
    /** 大纲和正在看的位置：正在看的标题据此算，变了才重新渲染 */
    outline: [] as OutlineItem[],
    readingPos: 0,
    activeHeading: -1,
    /** 打开后修改过标题或正文 */
    edited: false,
    /** 最近一次存盘失败的原因（离开时另存的提示里说明） */
    saveError: "",
    /** 正在离开（卸载、从托盘退出）：存盘失败不单独提示，和另存的结果一起说 */
    leaving: false,
    /** 已经卸载了 */
    left: false,
  }).current;

  const isDirty = () => s.content !== s.savedContent || s.title !== s.savedTitle;

  const noteEdit = () => {
    if (s.edited) return;
    s.edited = true;
    propsRef.current.onEdit();
  };

  const stopTimer = () => {
    window.clearTimeout(s.timer);
    s.timer = 0;
    s.dirtyAt = 0;
  };

  /** 现在的定时保存间隔（ms）：auto save 开着时按设置，关着时 1 小时兜底 */
  const saveDelayMs = () => {
    const { autoSave, saveDelaySecs } = saveOptionsRef.current;
    return (autoSave ? saveDelaySecs : FALLBACK_SAVE_SECS) * 1000;
  };

  /**
   * 有未保存的修改时开始倒计时，从第一处未保存的修改算起；倒计时中继续修改不往后推，最多隔这么久就存一次。
   * 已经在倒计时（或已经超时、正等着保存）时不重复开始
   */
  const schedule = () => {
    if (s.timer || s.detached || !isDirty()) return;
    s.dirtyAt ||= Date.now();
    s.timer = window.setTimeout(
      () => {
        s.timer = 0;
        flush();
      },
      // schedule 只在回调、effect 里调用，不在渲染时调用；purity 规则在这个组件里推断错了
      // （删掉不相干的 useRef(zoomBy) 它就不报了），不是真的在渲染时取时间
      // eslint-disable-next-line react-hooks/purity
      Math.max(0, s.dirtyAt + saveDelayMs() - Date.now()),
    );
  };

  /** 更新保存状态；有未保存的修改时按需开始定时保存 */
  const refreshStatus = () => {
    const dirty = isDirty();
    setStatus(dirty ? "dirty" : "saved");
    if (dirty) schedule();
    else stopTimer();
  };

  const enqueue = (job: () => Promise<void>) => {
    s.chain = s.chain.then(job, job);
    return s.chain;
  };

  /** 存正文；返回是否存好了（没有要存的也算），有冲突、保存失败时为 false */
  const saveContent = (force = false): Promise<boolean> => {
    let ok = true;
    const job = enqueue(async () => {
      if (!s.loaded || s.detached) return;
      if (s.conflict && !force) {
        ok = false;
        return;
      }
      const text = s.content;
      if (text === s.savedContent && !force) return;
      setStatus("saving");
      try {
        const r = await api.saveTodoContent(workspace, project, id, text, s.mtime, force);
        if (!r.saved) {
          ok = false;
          s.conflict = true;
          setConflict(true);
          setStatus("dirty");
          return;
        }
        s.savedContent = text;
        s.mtime = r.mtime;
        s.conflict = false;
        setEncoding("UTF-8");
        propsRef.current.onSummary(r.summary);
        refreshStatus();
      } catch (e) {
        ok = false;
        s.saveError = errMsg(e);
        setStatus("error");
        if (!s.leaving) messageRef.current.error(`保存失败：${s.saveError}`);
      }
    });
    return job.then(() => ok);
  };

  /** 存标题；返回是否存好了（没有要存的也算） */
  const saveTitle = (): Promise<boolean> => {
    let ok = true;
    const job = enqueue(async () => {
      if (s.detached) return;
      const t = s.title;
      if (t === s.savedTitle) return;
      try {
        const r = await api.setTodoTitle(workspace, project, id, t);
        s.savedTitle = t;
        propsRef.current.onSummary(r);
        refreshStatus();
      } catch (e) {
        ok = false;
        s.saveError = errMsg(e);
        setStatus("error");
        if (!s.leaving) messageRef.current.error(`保存标题失败：${s.saveError}`);
      }
    });
    return job.then(() => ok);
  };

  /** 记下编辑位置（存在数据目录的 .state.json），下次打开这条待办时回到这里；改名、移动、删除之后（detached）不再记 */
  const savePosition = () => {
    window.clearTimeout(s.positionTimer);
    if (s.position && !s.detached) writeEditPosition(workspace, project, id, s.position);
    s.position = null;
  };

  const onPosition = (p: EditPosition) => {
    s.position = p;
    window.clearTimeout(s.positionTimer);
    s.positionTimer = window.setTimeout(savePosition, POSITION_DELAY);
  };

  /** 正在看的标题：光标在可见区域里时是光标所在的那一节，否则是可见区域顶部的那一节 */
  const updateActiveHeading = () => {
    const i = activeIndex(s.outline, s.readingPos);
    if (i === s.activeHeading) return;
    s.activeHeading = i;
    setActiveHeading(i);
  };

  /** 按现在的正文重新列出大纲（没变时不重新渲染） */
  const refreshOutline = () => {
    const items = mdRef.current?.outline() ?? [];
    if (!sameOutline(items, s.outline)) {
      s.outline = items;
      setOutline(items);
    }
    updateActiveHeading();
  };

  const onReadingPos = (pos: number) => {
    s.readingPos = pos;
    updateActiveHeading();
  };

  /** 立即存标题和正文，返回是否都存好了 */
  const flush = async () => {
    stopTimer();
    savePosition();
    const title = saveTitle();
    const content = saveContent();
    return (await title) && (await content);
  };

  /** 换成磁盘上的正文（外部改过后重新加载） */
  const applyDiskContent = (d: TodoDetail) => {
    s.content = s.savedContent = d.content;
    s.mtime = d.mtime;
    window.clearTimeout(s.statsTimer);
    setStats(textStats(d.content));
    setEncoding(d.encoding);
    refreshStatus();
    mdRef.current?.reset(d.content);
    refreshOutline();
  };

  /** 另存成的新待办（at 里的 newId）接着原来的地方编辑：编辑位置、撤销记录和编辑模式跟过去 */
  const carryTo = (at: ProjectAt, newId: string, snap: UndoSnapshot | null) => {
    const position = readEditPosition(workspace, project, id);
    if (position) writeEditPosition(at.workspace, at.project, newId, position);
    // 新的那条的正文里图片的链接改成了它自己的 id（复制了一份附件目录），撤销记录接到改过的正文上
    if (snap) keepUndo(at.workspace, at.project, newId, { ...snap, relinked: true });
    writeEditorMode(at.workspace, at.project, newId, readEditorMode(workspace, project, id));
  };

  /**
   * 离开时存不上的修改另存为新待办（见 leave）：这里的正文连同标题（加上「（我的版本）」）存成同一项目里的
   * 一条新待办，原来的项目也不在了时存到快速记录存到的项目；提示新待办的标题，左侧列表刷新出它。
   * 另存也失败时提示，卸载了的把正文复制到剪贴板。返回是否另存好了
   */
  const rescue = async (problem: LeaveProblem): Promise<boolean> => {
    const content = s.content;
    const here = { workspace, project };
    const original = displayTitle(propsRef.current.summary).text;
    // 新的那条复制一份这条的图片（附件目录）
    const create = (ws: string, p: string, title: string, text: string, createProject: boolean) =>
      api.createTodo(ws, p, title, text, createProject, { workspace, project, id });
    const r = await rescueAsNew(create, here, quickTargetRef.current, myVersionTitle(s.title, content), content);
    if (!r.ok) {
      // 从托盘退出时还开着，内容在编辑区里（不退出）；卸载了的只能放进剪贴板
      let leftover: Leftover = "editor";
      if (s.left)
        leftover = (await navigator.clipboard.writeText(content).then(() => true, () => false)) ? "clipboard" : "lost";
      messageRef.current.error(rescueNotice(problem, original, here, r, leftover), 15);
      return false;
    }
    // 卸载了的，撤销记录已经按原来的位置留下了（MarkdownEditor 销毁时），取出来给新的那条
    let snap = mdRef.current?.snapshot() ?? null;
    if (!snap) {
      const history = takeUndo(workspace, project, id, content);
      snap = history ? { doc: content, history } : null;
    }
    carryTo(r.at, r.todo.id, snap);
    if (s.left || !problem.conflict) {
      // 之后不再往这一条存：内容已经在新的那条里了，这一条（还开着时）由外层刷新后关掉
      s.detached = true;
    } else {
      // 从托盘退出时还开着：这一条换成外部的版本，没退出（问用户时选了不退出）也不会再另存一份
      try {
        const d = await api.readTodo(workspace, project, id);
        s.conflict = false;
        setConflict(false);
        applyDiskContent(d);
        propsRef.current.onSummary(d.summary);
      } catch {
        s.detached = true;
      }
    }
    messageRef.current.warning(rescueNotice(problem, original, here, r), 10);
    // 编辑器可能已经卸载了，经事件让外层（工作区视图或首页）刷新，列出新的那条
    emitAppEvent("data-changed");
    return true;
  };

  /**
   * 离开这条待办（卸载：切换待办、关标签、返回首页等；quitting：从托盘退出）时存盘。这时存不上的（正文在外部被
   * 改过、正显示着冲突对话框，待办或项目在外部被删了等）没法再让用户选，自动另存为新待办，两份都保留。
   * 排在保存后面做，连着离开两次也只另存一份。返回是否都存好了（另存好了也算）
   */
  const leave = async (quitting: boolean): Promise<boolean> => {
    s.leaving = true;
    s.saveError = "";
    await flush();
    let ok = true;
    await enqueue(async () => {
      const problem = leaveProblem({ unsaved: isDirty(), detached: s.detached, conflict: s.conflict, error: s.saveError });
      if (problem) ok = await rescue(problem);
    });
    if (quitting) s.leaving = false;
    return ok;
  };

  // 加载正文；卸载（切换到别的待办、返回首页等）时把没保存的写盘，不受 auto save 开关影响，存不上的另存为新待办，
  // 同时记下编辑位置
  useEffect(() => {
    let cancelled = false;
    // 开发时 StrictMode 先卸载再挂载一次，s 还是原来那个
    s.left = s.leaving = false;
    api
      .readTodo(workspace, project, id)
      .then((d) => {
        if (cancelled) return;
        s.content = s.savedContent = d.content;
        s.mtime = d.mtime;
        s.loaded = true;
        setInitialHistory(takeUndo(workspace, project, id, d.content));
        setInitialDoc(d.content);
        setStats(textStats(d.content));
        setPath(d.path);
        setEncoding(d.encoding);
        setLoading(false);
        propsRef.current.onSummary(d.summary);
        if (propsRef.current.autoFocusTitle) titleRef.current?.focus();
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(errMsg(e));
        setLoading(false);
      });
    // 从托盘退出前存盘时存不上的另存为新待办；隐藏到托盘时只是存盘
    const unregister = registerFlusher((quitting) => (quitting ? leave(true) : flush()), true);
    const handle: EditorHandle = {
      flush,
      detach: () => {
        const snap = mdRef.current?.snapshot();
        if (snap) keepUndo(workspace, project, id, snap);
        s.detached = true;
        stopTimer();
      },
      find: (replace) => mdRef.current?.openFind(replace) ?? false,
      focusBody: () => mdRef.current?.focus(),
    };
    handleRef.current = handle;
    return () => {
      cancelled = true;
      s.left = true;
      window.clearTimeout(s.statsTimer);
      unregister();
      // 卸载了的不再算右侧打开着的编辑器：之后的操作不必、也不该再经它存盘
      if (handleRef.current === handle) handleRef.current = null;
      leave(false);
      propsRef.current.onDirty(false);
    };
    // 只在挂载时执行一次、卸载时 leave 一次：组件以 工作区/项目/id 为 key 挂载，workspace、project、id、handleRef
    // 不会变；flush、leave、stopTimer 每次渲染都是新函数，但只经由 s 和各个 ref 读写，挂载时那一份一直可用。
    // 补上这些依赖会让每次渲染都重新读正文、注销再注册 flusher，并在清理时多存一次盘
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 正文加载出来、编辑器建好之后列出大纲（子组件的 effect 先执行，这时编辑器已经建好）
  useEffect(() => {
    if (!loading) refreshOutline();
    // 只在加载完成时执行一次；之后打字、外部修改重新加载时另外更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // 保存状态变了时告诉外层：没存好（未保存、正在保存、保存失败）时标签上显示圆点
  useEffect(() => {
    propsRef.current.onDirty(status !== "saved");
  }, [status]);

  // 标题在别处被改（例如刷新）且这里没有编辑中时，同步过来
  useEffect(() => {
    if (s.title === s.savedTitle && document.activeElement !== titleRef.current?.input) {
      s.title = s.savedTitle = summary.title;
      setTitle(summary.title);
    }
  }, [summary.title, s]);

  // 开关 auto save、改了定时保存的间隔：按新的间隔重新安排，仍从第一处未保存的修改算起（已经超时的立即保存）
  useEffect(() => {
    window.clearTimeout(s.timer);
    s.timer = 0;
    schedule();
    // 只在这两个设置变了时重新安排：schedule 每次渲染都是新函数（间隔从 saveOptionsRef 读，前面的 effect 已经更新过），
    // 加进依赖会让每次渲染（打字时状态栏刷新等）都清掉重来；s 是不变的对象
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, saveDelaySecs]);

  /**
   * 核对磁盘上的正文（窗口重新获得焦点、监听到正文文件在外部变了时）。外部改过时：这里没有未保存的修改就重新加载；
   * 有的话立即弹出冲突对话框让用户选，不动正在编辑的内容（不等到存盘、离开这条待办时才发现，那时没法再问）。
   * 外部的正文和这里打开时的一样（只是修改时间变了，如网盘同步时重写了一遍）、或者和这里改成的一样时不算冲突，
   * 也不重新加载（光标、撤销记录都不动）。排在保存后面做：刚存完、新的修改时间还没记下时不会当成外部改的
   */
  const checkDisk = () =>
    enqueue(async () => {
      if (!s.loaded || s.detached || s.conflict) return;
      let d: TodoDetail;
      try {
        d = await api.readTodo(workspace, project, id);
      } catch {
        return; // 文件被删等情况由外层刷新处理（之后卸载时存不上，另存为新待办）
      }
      if (d.mtime === s.mtime || s.detached || s.conflict) return;
      if (d.content === s.savedContent || d.content === s.content) {
        s.mtime = d.mtime;
        s.savedContent = d.content;
        setEncoding(d.encoding);
        refreshStatus();
      } else if (s.content === s.savedContent) {
        applyDiskContent(d);
      } else {
        s.conflict = true;
        setConflict(true);
        return;
      }
      propsRef.current.onSummary(d.summary);
    });

  // auto save：窗口失焦立即保存（编辑位置总是立即记下）；重新获得焦点时检查文件是否被外部程序改过
  useWindowFocus((focused) => {
    if (!focused) {
      savePosition();
      if (autoSave) flush();
      return;
    }
    checkDisk();
  });
  // 监听到这条的正文文件（或所在的项目、工作区文件夹）在外部变了：窗口一直在前台、没切换焦点时也立即核对
  useAppEvent<DataChange>("data-changed", (c) => {
    if (todoTouched(c, workspace, project, id)) checkDisk();
  });

  const zoomBy = (step: number) => {
    const { min, max } = FONT_LIMITS.editor;
    const size = setFontSize("editor", (cur) => cur + step);
    const edge = size === max && step > 0 ? "（最大）" : size === min && step < 0 ? "（最小）" : "";
    messageRef.current.open({
      key: "editor-font-size",
      type: "info",
      content: `编辑区字号 ${size}px${edge}`,
      duration: 1,
    });
  };
  const zoomRef = useRef(zoomBy);
  useEffect(() => {
    zoomRef.current = zoomBy;
  });

  // 按住 Ctrl 滚动滚轮调编辑区字号；要阻止默认行为，只能用非 passive 的原生监听
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !e.deltaY) return;
      e.preventDefault();
      const delta = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? e.deltaY : Math.sign(e.deltaY) * WHEEL_STEP;
      acc = Math.sign(acc) === Math.sign(delta) ? acc + delta : delta;
      if (Math.abs(acc) < WHEEL_STEP) return;
      acc = 0;
      zoomRef.current(delta < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onContentChange = (text: string) => {
    s.content = text;
    noteEdit();
    refreshStatus();
    window.clearTimeout(s.statsTimer);
    s.statsTimer = window.setTimeout(() => {
      setStats(textStats(s.content));
      refreshOutline();
    }, STATS_DELAY);
  };

  /** composing：输入法组合中（拼音还没上屏），这时只更新输入框，不算修改 */
  const onTitleChange = (text: string, composing = false) => {
    setTitle(text);
    if (composing) return;
    s.title = text;
    noteEdit();
    refreshStatus();
  };

  // 冲突对话框里的选择也排在保存后面做：做的时候离开这条待办（卸载、退出），离开时看到的已经是选完的样子，
  // 不会再另存一份
  const resolveConflict = async (keepMine: boolean) => {
    setConflict(false);
    if (keepMine) {
      await saveContent(true);
      return;
    }
    await enqueue(async () => {
      try {
        const d = await api.readTodo(workspace, project, id);
        s.conflict = false;
        applyDiskContent(d);
        propsRef.current.onSummary(d.summary);
      } catch (e) {
        message.error(errMsg(e));
      }
    });
  };

  /**
   * 冲突时「另存为新待办」，两份都保留：这里的正文连同标题（加上「（我的版本）」）存成同一项目里的一条新待办，
   * 这一条重新加载外部的版本，然后打开新的那条。新的那条的正文和这里一模一样，编辑位置、撤销记录、编辑模式
   * 跟过去，打开后接着原来的地方编辑
   */
  const saveAsNew = async () => {
    setConflict(false);
    const mine = s.content;
    const newTitle = myVersionTitle(s.title, mine);
    savePosition();
    const snap = mdRef.current?.snapshot() ?? null;
    await enqueue(async () => {
      let created: TodoSummary;
      try {
        created = await api.createTodo(workspace, project, newTitle, mine, false, { workspace, project, id });
      } catch (e) {
        message.error(`另存为新待办失败：${errMsg(e)}`);
        setConflict(true);
        return;
      }
      carryTo({ workspace, project }, created.id, snap);
      try {
        const d = await api.readTodo(workspace, project, id);
        s.conflict = false;
        applyDiskContent(d);
        propsRef.current.onSummary(d.summary);
      } catch {
        // 这一条在外部被删了等：由外层刷新处理。这里的内容已经在新的那条里了，不再往这一条存（离开时也不再另存）
        s.detached = true;
      }
      message.success(`已另存为新待办「${newTitle}」，这一条换成了外部修改后的内容`);
      propsRef.current.onSavedAsNew(created);
    });
  };

  /** 切换这条待办的编辑模式并记下；改名、移动、删除之后（detached）不再记 */
  const toggleMode = () => {
    const next = otherMode(mode);
    setMode(next);
    if (!s.detached) writeEditorMode(workspace, project, id, next);
  };
  /** 显示 / 隐藏大纲（本机记住，所有待办共用）；标题不够多、打开了也不显示时提示一下 */
  const toggleOutline = () => {
    const next = !outlineOn;
    setOutlineOn(next);
    if (next && s.outline.length < MIN_OUTLINE)
      message.info(`已开启大纲，正文里有 ${MIN_OUTLINE} 个以上标题时显示在右侧`);
  };

  const toggleModeRef = useRef(toggleMode);
  const toggleOutlineRef = useRef(toggleOutline);
  useEffect(() => {
    toggleModeRef.current = toggleMode;
    toggleOutlineRef.current = toggleOutline;
  });

  // Ctrl+/ 切换实时渲染 / 源码模式（同 Typora），Ctrl+Shift+1 显示 / 隐藏大纲（同 Typora），焦点在标题上时也能用
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const combo = eventShortcut(e);
      if (combo !== "Ctrl+Slash" && combo !== "Ctrl+Shift+1") return;
      e.preventDefault();
      if (e.repeat) return;
      if (combo === "Ctrl+Slash") toggleModeRef.current();
      else toggleOutlineRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openLink = (raw: string) => {
    const url = webUrl(raw);
    if (!url) {
      message.warning("只能打开网页和邮件链接");
      return;
    }
    api.openUrl(url).catch((e) => message.error(errMsg(e)));
  };

  /** 能不能往正文里插入图片：只读的（编码认不出）不能，提示原因；正显示着冲突对话框时不插 */
  const canInsertImages = () => {
    if (!s.loaded || s.detached || s.conflict) return false;
    if (readOnly) {
      message.warning("这条待办的正文只读（认不出编码），不能插入图片");
      return false;
    }
    return true;
  };

  /** 逐张存进附件目录，返回存好了的；有没存成的提示原因，太大的提示一下（照常插入） */
  const saveImages = async (jobs: (() => Promise<SavedImage>)[]): Promise<SavedImage[]> => {
    const saved: SavedImage[] = [];
    const errors: string[] = [];
    for (const job of jobs) {
      try {
        saved.push(await job());
      } catch (e) {
        errors.push(errMsg(e));
      }
    }
    if (errors.length) message.error(jobs.length > 1 ? `${errors.length} 张图片没能插入：${errors[0]}` : `没能插入图片：${errors[0]}`);
    for (const big of saved.filter((x) => x.size > LARGE_IMAGE)) {
      message.warning(`图片「${big.name}」有 ${formatSize(big.size)}，比较大：会占用数据目录的空间，数据目录用网盘同步时也慢`, 6);
    }
    return saved;
  };

  /** 粘贴的图片（剪贴板里有图片、没有文字时）存进附件目录，插在光标处；files 是空的说明只有不是图片的文件 */
  const pasteImages = async (files: File[]) => {
    if (!files.length) {
      message.warning("只能粘贴图片");
      return;
    }
    if (!canInsertImages()) return;
    const saved = await saveImages(
      files.map((f) => async () =>
        api.saveImage(workspace, project, id, pastedImageExt(f) ?? "png", new Uint8Array(await f.arrayBuffer())),
      ),
    );
    mdRef.current?.insertImages(saved.map((x) => imageMarkdown(x.link, x.name)));
  };

  /** 拖进来的文件：图片复制一份到附件目录（原文件不动），插在放下的位置 at；不是图片的提示一下 */
  const dropFiles = async (paths: string[], at: number) => {
    const others = paths.filter((p) => !isImageName(p));
    if (others.length) {
      const names = others.map((p) => `「${fileName(p)}」`).join("、");
      message.warning(`${names}不是图片，没有插入（能插入 ${IMAGE_EXTS.join("、")}）`, 6);
    }
    const pictures = paths.filter(isImageName);
    if (!pictures.length || !canInsertImages()) return;
    const saved = await saveImages(pictures.map((p) => () => api.importImage(workspace, project, id, p)));
    mdRef.current?.insertImages(
      saved.map((x) => imageMarkdown(x.link, x.name)),
      at,
    );
  };

  // 从资源管理器拖进来的文件（Tauri 接管了系统的拖放，见 hooks.ts 的 useFileDrag）：拖着图片停在正文上时画出放下的位置，
  // 放在正文里时插入；放在正文以外的地方什么都不做
  const draggedPaths = useRef<string[]>([]);
  useFileDrag((e) => {
    const md = mdRef.current;
    if (!md) return;
    if (e.type === "leave") {
      md.dropCaret(null);
      return;
    }
    if (e.type === "enter") draggedPaths.current = e.paths;
    const at = md.posAt(e.x, e.y);
    if (e.type === "drop") {
      md.dropCaret(null);
      if (at !== null) dropFiles(e.paths, at);
      return;
    }
    md.dropCaret(draggedPaths.current.some(isImageName) && !readOnly ? at : null);
  });

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      message.success("已复制文件路径");
    } catch {
      message.error("复制失败");
    }
  };

  return (
    <section className="editor">
      <header className="editor-head">
        <Breadcrumb
          className="editor-crumb"
          items={[
            { title: <a onClick={props.onSelectWorkspace}>{workspace}</a> },
            ...[parentOf(project), project]
              .filter((p) => p !== undefined)
              .map((p) => ({ title: <a onClick={() => props.onSelectProject(p)}>{leafName(p)}</a> })),
          ]}
        />
        <div className="editor-actions">
          <Tooltip title={keys?.toggleDoneShortcut && `快捷键：${shortcutLabel(keys.toggleDoneShortcut)}`}>
            <Button
              type={summary.done ? "default" : "primary"}
              ghost={!summary.done}
              icon={summary.done ? <UndoOutlined /> : <CheckOutlined />}
              onClick={props.onToggleDone}
            >
              {summary.done ? "标记为未完成" : "标记完成"}
            </Button>
          </Tooltip>
          <Tooltip
            title={
              <>
                用系统默认的 Markdown 程序打开
                {keys?.openExternalShortcut && <div>快捷键：{shortcutLabel(keys.openExternalShortcut)}</div>}
              </>
            }
          >
            <Button icon={<ExportOutlined />} onClick={props.onOpenExternal}>
              默认程序打开
            </Button>
          </Tooltip>
          <Dropdown menu={props.menu} trigger={["click"]} placement="bottomRight">
            <Button icon={<MoreOutlined />} />
          </Dropdown>
        </div>
      </header>

      <div className="editor-main">
        <div className="editor-body" ref={bodyRef}>
          <Input
            ref={titleRef}
            className={`editor-title${summary.done ? " done" : ""}`}
            variant="borderless"
            placeholder="无标题（左侧将显示正文开头）"
            value={title}
            maxLength={200}
            onChange={(e) => onTitleChange(e.target.value, (e.nativeEvent as InputEvent).isComposing)}
            onCompositionEnd={(e) => {
              onTitleChange(e.currentTarget.value);
              // 组合中失去焦点的，上屏后补上失去焦点时的保存
              if (autoSave && document.activeElement !== e.currentTarget) saveTitle();
            }}
            onBlur={() => autoSave && saveTitle()}
            onPressEnter={() => mdRef.current?.focus()}
          />
          <div className="editor-meta">
            {summary.done ? (
              <Tag color="success" icon={<CheckCircleFilled />} variant="filled">
                已完成
              </Tag>
            ) : (
              <Tag color="processing" variant="filled">
                进行中
              </Tag>
            )}
            {summary.pinned && (
              <Tag color="warning" icon={<PushpinFilled />} variant="filled">
                已置顶
              </Tag>
            )}
            <TagEditor tags={summary.tags} allTags={props.allTags} onChange={props.onTags} />
            <span className="sep">|</span>
            <span title={fullTime(summary.createdAt)}>创建于 {fullTime(summary.createdAt).slice(0, 16)}</span>
            <span className="sep">|</span>
            <span title={fullTime(summary.updatedAt)}>
              最后修改 {fullTime(summary.updatedAt).slice(0, 16)}（{relativeTime(summary.updatedAt, now)}）
            </span>
            {summary.done && summary.doneAt && (
              <>
                <span className="sep">|</span>
                <span>完成于 {fullTime(summary.doneAt).slice(0, 16)}</span>
              </>
            )}
          </div>

          {loading ? (
            <div className="editor-loading">
              <Spin />
            </div>
          ) : loadError ? (
            <div className="editor-loading error-text">{loadError}</div>
          ) : (
            <>
              {readOnly && (
                <Alert
                  className="editor-alert"
                  type="warning"
                  showIcon
                  title="认不出这条待办正文的编码（不是 UTF-8 或 GBK），为免损坏原文件，这里只读显示；需要修改请用默认程序打开"
                />
              )}
              <MarkdownEditor
                handleRef={mdRef}
                initialDoc={initialDoc}
                initialPosition={initialPosition}
                initialHistory={initialHistory}
                autoFocus={props.autoFocusBody && !props.autoFocusTitle}
                mode={mode}
                readOnly={readOnly}
                placeholder={"在这里记录详细内容…\n\n支持 Markdown 语法，可以粘贴、拖进图片；Ctrl + / 切换实时渲染和源码模式"}
                appShortcuts={[keys?.toggleDoneShortcut, keys?.openExternalShortcut]}
                editShortcuts={editShortcuts}
                onChange={onContentChange}
                onBlur={() => autoSave && saveContent()}
                onOpenLink={openLink}
                onPosition={onPosition}
                onReadingPos={onReadingPos}
                images={images}
                onPasteImages={pasteImages}
                onDestroy={(snap) => snap && !s.detached && keepUndo(workspace, project, id, snap)}
              />
            </>
          )}
        </div>
        {outlineOn && !loading && !loadError && outline.length >= MIN_OUTLINE && (
          <Outline
            items={outline}
            active={activeHeading}
            onJump={(item) => mdRef.current?.jumpTo(item.pos)}
            onClose={() => setOutlineOn(false)}
          />
        )}
      </div>

      <footer className="statusbar">
        <Tooltip
          title={
            autoSave ? (
              <>
                auto save 已开启：修改后 {formatDuration(saveDelaySecs)}内自动保存，失去焦点、切换待办时也会保存
                <div>按 Ctrl+S 立即保存</div>
              </>
            ) : (
              <>
                auto save 已关闭：按 Ctrl+S 保存，切换待办、从托盘退出时也会保存
                <div>修改后一直没保存的，满 1 小时自动保存一次</div>
                <div>可在设置的「保存」里开启</div>
              </>
            )
          }
        >
          <span className={`save-state ${status}`}>
            {status === "saving" ? <LoadingOutlined /> : <span className="dot" />}
            {{ saved: "已保存", dirty: "未保存", saving: "正在保存…", error: "保存失败" }[status]}
          </span>
        </Tooltip>
        <span>{stats.chars} 字</span>
        <span>{stats.lines} 行</span>
        <span className={readOnly ? "warning-text" : undefined}>Markdown · {ENCODING_LABELS[encoding]}</span>
        <Tooltip
          title={
            <>
              点击切换到{MODE_LABELS[otherMode(mode)]}（Ctrl + /），每条待办分别记住
              <div>按住 Ctrl 单击链接可在浏览器中打开</div>
            </>
          }
        >
          <span className="statusbar-mode" onClick={toggleMode}>
            {mode === "live" ? <EyeOutlined /> : <CodeOutlined />} {MODE_LABELS[mode]}
          </span>
        </Tooltip>
        <Tooltip
          title={
            <>
              点击{outlineOn ? "隐藏" : "显示"}大纲（Ctrl + Shift + 1），所有待办共用
              <div>正文里有 {MIN_OUTLINE} 个以上标题时显示在右侧，编辑区太窄时不显示</div>
            </>
          }
        >
          <span className={`statusbar-outline${outlineOn ? "" : " off"}`} onClick={toggleOutline}>
            <UnorderedListOutlined /> 大纲{outlineOn && outline.length > 0 ? `（${outline.length}）` : ""}
          </span>
        </Tooltip>
        {keys && (
          <Tooltip
            title={
              <>
                编辑区字号，按住 Ctrl 滚动鼠标滚轮调整
                {keys.editorFontSize !== settingsInfo.defaults.editorFontSize && <div>点击恢复默认</div>}
              </>
            }
          >
            <span
              className="statusbar-font"
              onClick={() => setFontSize("editor", settingsInfo.defaults.editorFontSize)}
            >
              {keys.editorFontSize}px
            </span>
          </Tooltip>
        )}
        <span className="statusbar-path" title="点击复制文件路径" onClick={copyPath}>
          {path}
        </span>
      </footer>

      <Modal
        open={conflict}
        title="文件已在外部被修改"
        width={560}
        closable={false}
        mask={{ closable: false }}
        keyboard={false}
        footer={[
          <Button key="theirs" onClick={() => resolveConflict(false)}>
            放弃我的修改，重新加载
          </Button>,
          <Button key="mine" danger onClick={() => resolveConflict(true)}>
            用我的内容覆盖
          </Button>,
          <Button key="copy" type="primary" onClick={saveAsNew}>
            另存为新待办
          </Button>,
        ]}
      >
        这条待办的 Markdown 文件在其他程序中被修改过，而这里也有尚未保存的修改，请选择怎么处理。
        <div className="conflict-hint">
          「另存为新待办」两份都保留：你的修改存成同一项目里的一条新待办，标题后面加上「{MY_VERSION}」，并打开它；
          这一条换成外部修改后的内容。
        </div>
      </Modal>
    </section>
  );
}
