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
import {
  Alert,
  App as AntApp,
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
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { api, errMsg } from "../api";
import { webUrl } from "../editor/links";
import { activeIndex, type OutlineItem } from "../editor/outline";
import type { EditPosition } from "../editor/position";
import type { EditorMode } from "../editor/setup";
import { useWindowFocus } from "../hooks";
import { FONT_LIMITS, useEditShortcuts, useSaveOptions, useSettings } from "../settings";
import { eventShortcut, shortcutLabel } from "../shortcuts";
import type { TextEncoding, TodoSummary } from "../types";
import type { TodoRef } from "../tabs";
import { formatDuration, fullTime, MY_VERSION, relativeTime, textStats, useNow } from "../utils";
import {
  keepUndo,
  readEditorMode,
  readGroupEditPosition,
  takeUndo,
  writeEditorMode,
  writeGroupEditPosition,
} from "../workspaceState";
import MarkdownEditor, { type MarkdownEditorHandle } from "./MarkdownEditor";
import Outline from "./Outline";
import PathCrumb from "./PathCrumb";
import { type SessionMember, todoSession } from "./todoSession";

export interface EditorHandle {
  /**
   * 立即保存所有未保存的修改（Ctrl+S、重命名 / 移动等操作前），不受 auto save 开关影响。
   * 返回是否都存好了（没有要存的也算）；正文有冲突（弹出了冲突对话框）、保存失败（已提示）时为 false
   */
  flush(): Promise<boolean>;
  /** 待办已被删除/移走：之后不再尝试保存（分屏的另一边开着同一条待办时也是）。撤销记录先按原来的位置留下，由 workspaceState 跟到新位置 */
  detach(): void;
  /** 在正文里查找（Ctrl+F）；replace 为 true 时同时展开替换（Ctrl+H）。正文还没加载出来时返回 false */
  find(replace: boolean): boolean;
  /** 焦点放进正文，光标还在原处、不滚动 */
  focusBody(): void;
  /** 立即量出、记下现在的编辑位置（平时光标、滚动停下片刻才记）：分屏时新的一边从这里开始 */
  savePosition(): void;
  /** 现在的编辑位置（正文还没加载出来时为 null）：把标签拖到另一边时，那一边从这里开始 */
  position(): EditPosition | null;
  /** 显示的是哪条待办 */
  readonly todo: TodoRef;
}

interface Props {
  workspace: string;
  project: string;
  summary: TodoSummary;
  /** 所在的标签组的编号：分屏时同一条待办两边各记各的编辑位置 */
  group: string;
  /** 在有焦点的那一边（不分屏时总是）：Ctrl+/、Ctrl+Shift+1 只作用于这一边 */
  focused: boolean;
  /** 显示大纲：本机的显示偏好，所有待办、分屏的两边共用 */
  outlineOn: boolean;
  onOutlineChange: (on: boolean) => void;
  autoFocusTitle: boolean;
  /** 正文加载出来后焦点放进正文（光标在上次编辑的地方），点标签切过来时用 */
  autoFocusBody: boolean;
  handleRef: React.RefObject<EditorHandle | null>;
  menu: MenuProps;
  onSummary: (s: TodoSummary) => void;
  onToggleDone: () => void;
  onOpenExternal: () => void;
  onSelectWorkspace: () => void;
  /** 点编辑区上方的项目（子项目时还有它的父项目），参数是项目路径 */
  onSelectProject: (project: string) => void;
  /** 外部修改冲突时选了「另存为新待办」：新建的那条（同一项目里），由外层加进列表并打开 */
  onSavedAsNew: (s: TodoSummary) => void;
  /** 打开后第一次修改了标题或正文（预览标签据此固定下来） */
  onEdit: () => void;
  /** 有没有没存好的修改（标签上的圆点）；卸载时（切走、关掉，那时会存盘）报一次 false */
  onDirty: (dirty: boolean) => void;
}

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
 * 正文、标题、保存和外部修改冲突在这条待办的会话里（todoSession.ts），分屏时两边开着同一条待办共用一个：
 * Ctrl+S、切换待办、从托盘退出时总是保存；有未保存的修改后还定时保存：auto save 开着时按设置的间隔，
 * 关着时满 1 小时兜底。auto save 开着时编辑器或窗口失去焦点也立即保存。
 * 这里管的是这一边自己的：编辑器（光标、滚动、查找框）、编辑模式、编辑位置、字数和大纲
 */
export default function TodoEditor(props: Props) {
  const { workspace, project, summary, handleRef, group, outlineOn } = props;
  const id = summary.id;
  const memberId = useId();
  const { message } = AntApp.useApp();
  const { info: settingsInfo, setFontSize } = useSettings();
  const keys = settingsInfo?.settings;
  const editShortcuts = useEditShortcuts();
  const saveOptions = useSaveOptions();
  const { autoSave, saveDelaySecs } = saveOptions;
  const now = useNow();

  // 这条待办的会话：分屏的另一边开着同一条待办时用它的（正文不再从磁盘读，用那边现在的）
  const [session] = useState(() => todoSession(workspace, project, id, summary.title));
  const { loading, loadError, status, conflict, encoding, path, title, lead } = useSyncExternalStore(
    session.subscribe,
    session.getState,
  );
  // 状态栏的字数、行数：打字停下来一会儿再算，不是每次按键都对全文统计
  const [stats, setStats] = useState(() => (loading ? { chars: 0, lines: 0 } : textStats(session.currentDoc())));
  // 大纲（正文里的标题）同样打字停下来再更新；正在看的标题只在变了时重新渲染
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [activeHeading, setActiveHeading] = useState(-1);
  // 实时渲染 / 源码模式，每条待办分别记住
  const [mode, setMode] = useState(() => readEditorMode(workspace, project, id));
  // 上次在这条待办里的编辑位置（分屏时这一边自己的）：打开时光标（选区）和滚动回到那里
  const [initialPosition] = useState(() => readGroupEditPosition(group, workspace, project, id));
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

  // 这一边自己的可变状态放在 ref 里，异步回调和卸载时都能拿到最新值。
  // 渲染时只取一次这个对象本身（每次都是同一个），里面的值只在回调和 effect 里读写，渲染结果不依赖它们
  const v = useRef({
    /** 还没记下的编辑位置 */
    position: null as EditPosition | null,
    /** 这个位置是在这一边有焦点时动到的：记成这条待办的（分屏时没有焦点的一边只是跟着另一边的改动挪了、滚了，只记这一边自己的） */
    persist: true,
    positionTimer: 0,
    statsTimer: 0,
    /** 大纲和正在看的位置：正在看的标题据此算，变了才重新渲染 */
    outline: [] as OutlineItem[],
    readingPos: 0,
    activeHeading: -1,
  }).current;

  /** 记下编辑位置（存在数据目录的 .state.json），下次打开这条待办时回到这里；改名、移动、删除之后（detached）不再记 */
  const savePosition = () => {
    window.clearTimeout(v.positionTimer);
    if (v.position && !session.detached) writeGroupEditPosition(group, workspace, project, id, v.position, v.persist);
    v.position = null;
  };

  const onPosition = (p: EditPosition) => {
    v.position = p;
    v.persist = propsRef.current.focused;
    window.clearTimeout(v.positionTimer);
    v.positionTimer = window.setTimeout(savePosition, POSITION_DELAY);
  };

  /** 正在看的标题：光标在可见区域里时是光标所在的那一节，否则是可见区域顶部的那一节 */
  const updateActiveHeading = () => {
    const i = activeIndex(v.outline, v.readingPos);
    if (i === v.activeHeading) return;
    v.activeHeading = i;
    setActiveHeading(i);
  };

  /** 按现在的正文重新列出大纲（没变时不重新渲染） */
  const refreshOutline = () => {
    const items = mdRef.current?.outline() ?? [];
    if (!sameOutline(items, v.outline)) {
      v.outline = items;
      setOutline(items);
    }
    updateActiveHeading();
  };

  const onReadingPos = (pos: number) => {
    v.readingPos = pos;
    updateActiveHeading();
  };

  // 打开这条待办（加入它的会话，第一个打开的从磁盘读正文）；卸载（切换到别的待办、返回首页等）时记下编辑位置、
  // 把没保存的写盘（不受 auto save 开关影响）
  useEffect(() => {
    const member: SessionMember = {
      id: memberId,
      onSummary: (s) => propsRef.current.onSummary(s),
      onEdit: () => propsRef.current.onEdit(),
      saveOptions: () => saveOptionsRef.current,
      error: (text) => messageRef.current.error(text),
      savePosition,
      loaded: (doc) => setStats(textStats(doc)),
      titleFocused: () => !!titleRef.current?.input && document.activeElement === titleRef.current.input,
      contentChanged: () => {
        window.clearTimeout(v.statsTimer);
        v.statsTimer = window.setTimeout(() => {
          setStats(textStats(session.currentDoc()));
          refreshOutline();
        }, STATS_DELAY);
      },
      reset: (doc) => {
        window.clearTimeout(v.statsTimer);
        setStats(textStats(doc));
        mdRef.current?.reset(doc);
        refreshOutline();
      },
    };
    session.attach(member);
    const handle: EditorHandle = {
      flush: session.flush,
      detach: () => session.detachTodo(),
      find: (replace) => mdRef.current?.openFind(replace) ?? false,
      focusBody: () => mdRef.current?.focus(),
      savePosition: () => {
        const now = mdRef.current?.position();
        if (now) {
          v.position = now;
          v.persist = true;
        }
        savePosition();
      },
      position: () => mdRef.current?.position() ?? null,
      todo: { workspace, project, todoId: id },
    };
    handleRef.current = handle;
    return () => {
      window.clearTimeout(v.statsTimer);
      savePosition();
      session.detach(member);
      if (handleRef.current === handle) handleRef.current = null;
      propsRef.current.onDirty(false);
    };
    // 只在挂载时执行一次、卸载时离开一次：组件以 工作区/项目/id 为 key 挂载，workspace、project、id、handleRef、
    // session 不会变；savePosition 等每次渲染都是新函数，但只经由 v、session 和各个 ref 读写，挂载时那一份一直可用。
    // 补上这些依赖会让每次渲染都离开再加入会话，并在离开时多存一次盘
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 正文加载出来、编辑器建好之后列出大纲（子组件的 effect 先执行，这时编辑器已经建好），新建的待办聚焦标题
  useEffect(() => {
    if (loading) return;
    refreshOutline();
    if (propsRef.current.autoFocusTitle) titleRef.current?.focus();
    // 只在加载完成时执行一次；之后打字、外部修改重新加载时另外更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // 保存状态变了时告诉外层：没存好（未保存、正在保存、保存失败）时标签上显示圆点
  useEffect(() => {
    propsRef.current.onDirty(status !== "saved");
  }, [status]);

  // 标题在别处被改（例如刷新）且这里没有编辑中时，同步过来
  useEffect(() => {
    session.syncTitle(summary.title);
  }, [summary.title, session]);

  // 开关 auto save、改了定时保存的间隔：按新的间隔重新安排，仍从第一处未保存的修改算起（已经超时的立即保存）
  useEffect(() => {
    session.reschedule();
  }, [autoSave, saveDelaySecs, session]);

  // 窗口失焦时立即记下编辑位置（auto save 开着时还存盘）；重新获得焦点时检查文件是否被外部程序改过。
  // 两边开着同一条待办时只由最早打开的那一边去查、去存
  useWindowFocus((focused) => {
    if (!focused) savePosition();
    if (session.getState().lead === memberId) session.windowFocus(focused);
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

  /**
   * 冲突时「另存为新待办」（见 todoSession.ts 的 saveAsNew），编辑位置用这一边的；然后打开新的那条，
   * 接着原来的地方编辑
   */
  const saveAsNew = async () => {
    savePosition();
    const r = await session.saveAsNew(readGroupEditPosition(group, workspace, project, id), mode);
    if (!r) return;
    message.success(`已另存为新待办「${r.title}」，这一条换成了外部修改后的内容`);
    propsRef.current.onSavedAsNew(r.created);
  };

  /** 切换这条待办的编辑模式并记下；改名、移动、删除之后（detached）不再记 */
  const toggleMode = () => {
    const next = otherMode(mode);
    setMode(next);
    if (!session.detached) writeEditorMode(workspace, project, id, next);
  };
  /** 显示 / 隐藏大纲（本机记住，所有待办共用）；标题不够多、打开了也不显示时提示一下 */
  const toggleOutline = () => {
    const next = !outlineOn;
    props.onOutlineChange(next);
    if (next && v.outline.length < MIN_OUTLINE)
      message.info(`已开启大纲，正文里有 ${MIN_OUTLINE} 个以上标题时显示在右侧`);
  };

  const toggleModeRef = useRef(toggleMode);
  const toggleOutlineRef = useRef(toggleOutline);
  useEffect(() => {
    toggleModeRef.current = toggleMode;
    toggleOutlineRef.current = toggleOutline;
  });

  // Ctrl+/ 切换实时渲染 / 源码模式（同 Typora），Ctrl+Shift+1 显示 / 隐藏大纲（同 Typora），焦点在标题上时也能用；
  // 分屏时只作用于有焦点的那一边
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const combo = eventShortcut(e);
      if ((combo !== "Ctrl+Slash" && combo !== "Ctrl+Shift+1") || !propsRef.current.focused) return;
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
        <PathCrumb
          className="editor-crumb"
          workspace={workspace}
          project={project}
          onSelectWorkspace={props.onSelectWorkspace}
          onSelectProject={props.onSelectProject}
          linkLast
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
            onChange={(e) => session.setTitle(e.target.value, (e.nativeEvent as InputEvent).isComposing)}
            onCompositionEnd={(e) => {
              session.setTitle(e.currentTarget.value);
              // 组合中失去焦点的，上屏后补上失去焦点时的保存
              if (autoSave && document.activeElement !== e.currentTarget) session.saveTitle();
            }}
            onBlur={() => autoSave && session.saveTitle()}
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
                peers={session.peers}
                initialDoc={session.currentDoc}
                initialPosition={initialPosition}
                takeHistory={(doc) => takeUndo(workspace, project, id, doc)}
                autoFocus={props.autoFocusBody && !props.autoFocusTitle}
                mode={mode}
                readOnly={readOnly}
                placeholder={"在这里记录详细内容…\n\n支持 Markdown 语法，Ctrl + / 切换实时渲染和源码模式"}
                appShortcuts={[
                  keys?.toggleDoneShortcut,
                  keys?.openExternalShortcut,
                  keys?.splitRightShortcut,
                  keys?.splitDownShortcut,
                ]}
                editShortcuts={editShortcuts}
                onChange={(text) => session.setContent(text)}
                onBlur={() => autoSave && session.saveContent()}
                onOpenLink={openLink}
                onPosition={onPosition}
                onReadingPos={onReadingPos}
                onDestroy={(snap) => snap && !session.detached && keepUndo(workspace, project, id, snap)}
              />
            </>
          )}
        </div>
        {outlineOn && !loading && !loadError && outline.length >= MIN_OUTLINE && (
          <Outline
            items={outline}
            active={activeHeading}
            onJump={(item) => mdRef.current?.jumpTo(item.pos)}
            onClose={() => props.onOutlineChange(false)}
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
        <span className="statusbar-chars">{stats.chars} 字</span>
        <span className="statusbar-lines">{stats.lines} 行</span>
        <span className={`statusbar-encoding${readOnly ? " warning-text" : ""}`}>
          Markdown · {ENCODING_LABELS[encoding]}
        </span>
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

      {/* 两边开着同一条待办时只弹一个，由最早打开的那一边弹 */}
      <Modal
        open={conflict && lead === memberId}
        title="文件已在外部被修改"
        width={560}
        closable={false}
        mask={{ closable: false }}
        keyboard={false}
        footer={[
          <Button key="theirs" onClick={() => session.resolveConflict(false)}>
            放弃我的修改，重新加载
          </Button>,
          <Button key="mine" danger onClick={() => session.resolveConflict(true)}>
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
