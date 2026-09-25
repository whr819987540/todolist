import {
  CheckCircleFilled,
  CheckOutlined,
  ExportOutlined,
  LoadingOutlined,
  MoreOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import { App as AntApp, Breadcrumb, Button, Dropdown, Input, Modal, Spin, Tag, Tooltip, type InputRef, type MenuProps } from "antd";
import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { registerFlusher, useWindowFocus } from "../hooks";
import type { TodoSummary } from "../types";
import { countChars, fullTime, relativeTime, useNow } from "../utils";

export interface EditorHandle {
  /** 立即保存所有未保存的修改 */
  flush(): Promise<void>;
  /** 待办已被删除/移走：之后不再尝试保存 */
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
}

type Status = "saved" | "dirty" | "saving" | "error";

const CONTENT_DELAY = 800;
const TITLE_DELAY = 500;

/** 右侧的待办详情：标题 + Markdown 纯文本内容，自动保存 */
export default function TodoEditor(props: Props) {
  const { workspace, project, summary } = props;
  const id = summary.id;
  const { message } = AntApp.useApp();
  const now = useNow();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [content, setContent] = useState("");
  const [title, setTitle] = useState(summary.title);
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<Status>("saved");
  const [conflict, setConflict] = useState(false);

  const titleRef = useRef<InputRef>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const propsRef = useRef(props);
  const messageRef = useRef(message);
  useEffect(() => {
    propsRef.current = props;
    messageRef.current = message;
  });

  // 保存相关的可变状态放在 ref 里，异步回调和卸载时都能拿到最新值
  const s = useRef({
    content: "",
    savedContent: "",
    title: summary.title,
    savedTitle: summary.title,
    mtime: null as number | null,
    loaded: false,
    detached: false,
    conflict: false,
    contentTimer: 0,
    titleTimer: 0,
    chain: Promise.resolve(),
  }).current;

  const refreshStatus = () => {
    setStatus(s.content === s.savedContent && s.title === s.savedTitle ? "saved" : "dirty");
  };

  const enqueue = (job: () => Promise<void>) => {
    s.chain = s.chain.then(job, job);
    return s.chain;
  };

  const saveContent = (force = false) => {
    window.clearTimeout(s.contentTimer);
    return enqueue(async () => {
      if (!s.loaded || s.detached || (s.conflict && !force)) return;
      const text = s.content;
      if (text === s.savedContent && !force) return;
      setStatus("saving");
      try {
        const r = await api.saveTodoContent(workspace, project, id, text, s.mtime, force);
        if (!r.saved) {
          s.conflict = true;
          setConflict(true);
          setStatus("dirty");
          return;
        }
        s.savedContent = text;
        s.mtime = r.mtime;
        s.conflict = false;
        propsRef.current.onSummary(r.summary);
        refreshStatus();
      } catch (e) {
        setStatus("error");
        messageRef.current.error(`保存失败：${errMsg(e)}`);
      }
    });
  };

  const saveTitle = () => {
    window.clearTimeout(s.titleTimer);
    return enqueue(async () => {
      if (s.detached) return;
      const t = s.title;
      if (t === s.savedTitle) return;
      try {
        const r = await api.setTodoTitle(workspace, project, id, t);
        s.savedTitle = t;
        propsRef.current.onSummary(r);
        refreshStatus();
      } catch (e) {
        setStatus("error");
        messageRef.current.error(`保存标题失败：${errMsg(e)}`);
      }
    });
  };

  const flush = () => {
    saveTitle();
    return saveContent();
  };

  // 加载正文；卸载（切换到别的待办）时把没保存的写盘
  useEffect(() => {
    let cancelled = false;
    api
      .readTodo(workspace, project, id)
      .then((d) => {
        if (cancelled) return;
        s.content = s.savedContent = d.content;
        s.mtime = d.mtime;
        s.loaded = true;
        setContent(d.content);
        setPath(d.path);
        setLoading(false);
        propsRef.current.onSummary(d.summary);
        if (propsRef.current.autoFocusTitle) titleRef.current?.focus();
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(errMsg(e));
        setLoading(false);
      });
    const unregister = registerFlusher(flush);
    props.handleRef.current = {
      flush,
      detach: () => {
        s.detached = true;
        window.clearTimeout(s.contentTimer);
        window.clearTimeout(s.titleTimer);
      },
    };
    return () => {
      cancelled = true;
      unregister();
      flush();
    };
    // 组件以 project/id 为 key 挂载，这里只需要执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 标题在别处被改（例如刷新）且这里没有编辑中时，同步过来
  useEffect(() => {
    if (s.title === s.savedTitle && document.activeElement !== titleRef.current?.input) {
      s.title = s.savedTitle = summary.title;
      setTitle(summary.title);
    }
  }, [summary.title, s]);

  // 窗口失焦立即保存；重新获得焦点时检查文件是否被外部程序改过
  useWindowFocus(async (focused) => {
    if (!focused) {
      flush();
      return;
    }
    if (!s.loaded || s.detached || s.conflict || s.content !== s.savedContent) return;
    try {
      const d = await api.readTodo(workspace, project, id);
      // 读取期间用户开始打字了：保留用户的输入，由保存时的冲突检测兜底
      if (d.mtime === s.mtime || s.content !== s.savedContent) return;
      applyDiskContent(d.content, d.mtime);
      propsRef.current.onSummary(d.summary);
    } catch {
      /* 文件被删等情况由外层刷新处理 */
    }
  });

  const applyDiskContent = (text: string, mtime: number) => {
    const el = textRef.current;
    const caret = el?.selectionStart ?? 0;
    s.content = s.savedContent = text;
    s.mtime = mtime;
    setContent(text);
    refreshStatus();
    requestAnimationFrame(() => {
      if (el && document.activeElement === el) el.setSelectionRange(caret, caret);
    });
  };

  const onContentChange = (text: string) => {
    s.content = text;
    setContent(text);
    refreshStatus();
    window.clearTimeout(s.contentTimer);
    s.contentTimer = window.setTimeout(() => saveContent(), CONTENT_DELAY);
  };

  const onTitleChange = (text: string) => {
    s.title = text;
    setTitle(text);
    refreshStatus();
    window.clearTimeout(s.titleTimer);
    s.titleTimer = window.setTimeout(saveTitle, TITLE_DELAY);
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
      applyDiskContent(d.content, d.mtime);
      propsRef.current.onSummary(d.summary);
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab 插入两个空格，而不是跳到下一个控件（execCommand 能保留撤销记录）
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertText", false, "  ");
    }
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      message.success("已复制文件路径");
    } catch {
      message.error("复制失败");
    }
  };

  const lines = content ? content.split("\n").length : 0;

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
          <Button
            type={summary.done ? "default" : "primary"}
            ghost={!summary.done}
            icon={summary.done ? <UndoOutlined /> : <CheckOutlined />}
            onClick={props.onToggleDone}
          >
            {summary.done ? "标记为未完成" : "标记完成"}
          </Button>
          <Tooltip title="用系统默认的 Markdown 程序打开">
            <Button icon={<ExportOutlined />} onClick={props.onOpenExternal}>
              默认程序打开
            </Button>
          </Tooltip>
          <Dropdown menu={props.menu} trigger={["click"]} placement="bottomRight">
            <Button icon={<MoreOutlined />} />
          </Dropdown>
        </div>
      </header>

      <div className="editor-body">
        <Input
          ref={titleRef}
          className={`editor-title${summary.done ? " done" : ""}`}
          variant="borderless"
          placeholder="无标题（左侧将显示正文开头）"
          value={title}
          maxLength={200}
          onChange={(e) => onTitleChange(e.target.value)}
          onBlur={() => saveTitle()}
          onPressEnter={() => textRef.current?.focus()}
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
          <textarea
            ref={textRef}
            className="editor-text"
            spellCheck={false}
            value={content}
            placeholder={"在这里记录详细内容…\n\n支持 Markdown 语法（此处按纯文本编辑，右键左侧待办可用默认程序打开）"}
            onChange={(e) => onContentChange(e.target.value)}
            onBlur={() => saveContent()}
            onKeyDown={onKeyDown}
          />
        )}
      </div>

      <footer className="statusbar">
        <span className={`save-state ${status}`}>
          {status === "saving" ? <LoadingOutlined /> : <span className="dot" />}
          {{ saved: "已保存", dirty: "未保存", saving: "正在保存…", error: "保存失败" }[status]}
        </span>
        <span>{countChars(content)} 字</span>
        <span>{lines} 行</span>
        <span>Markdown · UTF-8</span>
        <span className="statusbar-path" title="点击复制文件路径" onClick={copyPath}>
          {path}
        </span>
      </footer>

      <Modal
        open={conflict}
        title="文件已在外部被修改"
        closable={false}
        mask={{ closable: false }}
        keyboard={false}
        footer={[
          <Button key="theirs" onClick={() => resolveConflict(false)}>
            放弃我的修改，重新加载
          </Button>,
          <Button key="mine" type="primary" danger onClick={() => resolveConflict(true)}>
            用我的内容覆盖
          </Button>,
        ]}
      >
        这条待办的 Markdown 文件在其他程序中被修改过，而这里也有尚未保存的修改，请选择保留哪一份。
      </Modal>
    </section>
  );
}
