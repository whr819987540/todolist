import {
  CheckCircleFilled,
  CheckOutlined,
  CodeOutlined,
  ExportOutlined,
  EyeOutlined,
  LoadingOutlined,
  MoreOutlined,
  UndoOutlined,
} from "@ant-design/icons";
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
import { webUrl } from "../editor/links";
import type { EditPosition } from "../editor/position";
import type { EditorMode } from "../editor/setup";
import { registerFlusher, useWindowFocus } from "../hooks";
import { FONT_LIMITS, useEditShortcuts, useSaveOptions, useSettings } from "../settings";
import { eventShortcut, shortcutLabel } from "../shortcuts";
import type { TextEncoding, TodoDetail, TodoSummary } from "../types";
import { formatDuration, fullTime, MY_VERSION, myVersionTitle, relativeTime, textStats, useNow } from "../utils";
import {
  keepUndo,
  readEditorMode,
  readEditPosition,
  takeUndo,
  writeEditorMode,
  writeEditPosition,
} from "../workspaceState";
import MarkdownEditor, { type MarkdownEditorHandle } from "./MarkdownEditor";

export interface EditorHandle {
  /**
   * 立即保存所有未保存的修改（Ctrl+S、重命名 / 移动等操作前），不受 auto save 开关影响。
   * 返回是否都存好了（没有要存的也算）；正文有冲突（弹出了冲突对话框）、保存失败（已提示）时为 false
   */
  flush(): Promise<boolean>;
  /** 待办已被删除/移走：之后不再尝试保存。撤销记录先按原来的位置留下，由 workspaceState 跟到新位置 */
  detach(): void;
}

interface Props {
  workspace: string;
  project: string;
  summary: TodoSummary;
  autoFocusTitle: boolean;
  handleRef: React.RefObject<EditorHandle | null>;
  menu: MenuProps;
  onSummary: (s: TodoSummary) => void;
  onToggleDone: () => void;
  onOpenExternal: () => void;
  onSelectWorkspace: () => void;
  onSelectProject: () => void;
  /** 外部修改冲突时选了「另存为新待办」：新建的那条（同一项目里），由外层加进列表并打开 */
  onSavedAsNew: (s: TodoSummary) => void;
}

type Status = "saved" | "dirty" | "saving" | "error";

/** Ctrl+滚轮调字号：滚轮转一格（约 100）调 1px，触控板双指缩放的小增量攒够一半再调 */
const WHEEL_STEP = 50;

/** 光标、滚动停下来多久后记下编辑位置（ms）；离开这条待办、窗口失去焦点时立即记 */
const POSITION_DELAY = 1000;

/** 打字停下来多久后更新状态栏的字数、行数（ms） */
const STATS_DELAY = 300;

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
 * 关着时满 1 小时兜底。auto save 开着时编辑器或窗口失去焦点也立即保存
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

  const titleRef = useRef<InputRef>(null);
  const mdRef = useRef<MarkdownEditorHandle | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  const messageRef = useRef(message);
  const saveOptionsRef = useRef(saveOptions);
  useEffect(() => {
    propsRef.current = props;
    messageRef.current = message;
    saveOptionsRef.current = saveOptions;
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
  }).current;

  const isDirty = () => s.content !== s.savedContent || s.title !== s.savedTitle;

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
        setStatus("error");
        messageRef.current.error(`保存失败：${errMsg(e)}`);
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
        setStatus("error");
        messageRef.current.error(`保存标题失败：${errMsg(e)}`);
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

  /** 立即存标题和正文，返回是否都存好了 */
  const flush = async () => {
    stopTimer();
    savePosition();
    const title = saveTitle();
    const content = saveContent();
    return (await title) && (await content);
  };

  // 加载正文；卸载（切换到别的待办、返回首页等）时把没保存的写盘，不受 auto save 开关影响，同时记下编辑位置
  useEffect(() => {
    let cancelled = false;
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
    const unregister = registerFlusher(flush, true);
    handleRef.current = {
      flush,
      detach: () => {
        const snap = mdRef.current?.snapshot();
        if (snap) keepUndo(workspace, project, id, snap);
        s.detached = true;
        stopTimer();
      },
    };
    return () => {
      cancelled = true;
      window.clearTimeout(s.statsTimer);
      unregister();
      flush();
    };
    // 只在挂载时执行一次、卸载时 flush 一次：组件以 工作区/项目/id 为 key 挂载，workspace、project、id、handleRef
    // 不会变；flush、stopTimer 每次渲染都是新函数，但只经由 s 和各个 ref 读写，挂载时那一份一直可用。
    // 补上这些依赖会让每次渲染都重新读正文、注销再注册 flusher，并在清理时多存一次盘
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  /** 换成磁盘上的正文（外部改过后重新加载） */
  const applyDiskContent = (d: TodoDetail) => {
    s.content = s.savedContent = d.content;
    s.mtime = d.mtime;
    window.clearTimeout(s.statsTimer);
    setStats(textStats(d.content));
    setEncoding(d.encoding);
    refreshStatus();
    mdRef.current?.reset(d.content);
  };

  // auto save：窗口失焦立即保存（编辑位置总是立即记下）；重新获得焦点时检查文件是否被外部程序改过
  useWindowFocus(async (focused) => {
    if (!focused) {
      savePosition();
      if (autoSave) flush();
      return;
    }
    if (!s.loaded || s.detached || s.conflict || s.content !== s.savedContent) return;
    try {
      const d = await api.readTodo(workspace, project, id);
      // 读取期间用户开始打字了：保留用户的输入，由保存时的冲突检测兜底
      if (d.mtime === s.mtime || s.content !== s.savedContent) return;
      applyDiskContent(d);
      propsRef.current.onSummary(d.summary);
    } catch {
      /* 文件被删等情况由外层刷新处理 */
    }
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
    refreshStatus();
    window.clearTimeout(s.statsTimer);
    s.statsTimer = window.setTimeout(() => setStats(textStats(s.content)), STATS_DELAY);
  };

  /** composing：输入法组合中（拼音还没上屏），这时只更新输入框，不算修改 */
  const onTitleChange = (text: string, composing = false) => {
    setTitle(text);
    if (composing) return;
    s.title = text;
    refreshStatus();
  };

  const resolveConflict = async (keepMine: boolean) => {
    setConflict(false);
    if (keepMine) {
      await saveContent(true);
      return;
    }
    try {
      const d = await api.readTodo(workspace, project, id);
      s.conflict = false;
      applyDiskContent(d);
      propsRef.current.onSummary(d.summary);
    } catch (e) {
      message.error(errMsg(e));
    }
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
    const position = readEditPosition(workspace, project, id);
    const snap = mdRef.current?.snapshot();
    let created: TodoSummary;
    try {
      created = await api.createTodo(workspace, project, newTitle, mine);
    } catch (e) {
      message.error(`另存为新待办失败：${errMsg(e)}`);
      setConflict(true);
      return;
    }
    if (position) writeEditPosition(workspace, project, created.id, position);
    if (snap) keepUndo(workspace, project, created.id, snap);
    writeEditorMode(workspace, project, created.id, mode);
    try {
      const d = await api.readTodo(workspace, project, id);
      s.conflict = false;
      applyDiskContent(d);
      propsRef.current.onSummary(d.summary);
    } catch {
      /* 这一条在外部被删了等：由外层刷新处理。这里的内容已经在新的那条里了，冲突标记留着，不会再往这一条存 */
    }
    message.success(`已另存为新待办「${newTitle}」，这一条换成了外部修改后的内容`);
    propsRef.current.onSavedAsNew(created);
  };

  /** 切换这条待办的编辑模式并记下；改名、移动、删除之后（detached）不再记 */
  const toggleMode = () => {
    const next = otherMode(mode);
    setMode(next);
    if (!s.detached) writeEditorMode(workspace, project, id, next);
  };
  const toggleModeRef = useRef(toggleMode);
  useEffect(() => {
    toggleModeRef.current = toggleMode;
  });

  // Ctrl+/ 切换实时渲染 / 源码模式（同 Typora），焦点在标题上时也能用
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (eventShortcut(e) !== "Ctrl+Slash") return;
      e.preventDefault();
      if (!e.repeat) toggleModeRef.current();
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
            { title: <a onClick={props.onSelectProject}>{project}</a> },
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
              mode={mode}
              readOnly={readOnly}
              placeholder={"在这里记录详细内容…\n\n支持 Markdown 语法，Ctrl + / 切换实时渲染和源码模式"}
              appShortcuts={[keys?.toggleDoneShortcut, keys?.openExternalShortcut]}
              editShortcuts={editShortcuts}
              onChange={onContentChange}
              onBlur={() => autoSave && saveContent()}
              onOpenLink={openLink}
              onPosition={onPosition}
              onDestroy={(snap) => snap && !s.detached && keepUndo(workspace, project, id, snap)}
            />
          </>
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
