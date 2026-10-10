import { DeleteOutlined, FileTextOutlined, FolderFilled, RestOutlined, SearchOutlined, UndoOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Empty, Input, Modal, Popconfirm, Spin, Tooltip } from "antd";
import { useCallback, useEffect, useState } from "react";
import { api, errMsg } from "../api";
import type { RecycleEntry, RecycleKind } from "../types";
import { compactPath, parentOf, PROJECT_SEP } from "../projects";
import { avatarColor, firstChar, fullTime, relativeTime, useNow } from "../utils";
import { restoredPlace } from "./undo";

const KIND_LABELS: Record<RecycleKind, string> = { todo: "待办", project: "项目", workspace: "工作区" };

/** 回收站列表里显示的名字：待办没有标题时用正文开头 */
const nameOf = (e: RecycleEntry) => e.title.trim() || e.preview || "空白待办";

/** 原来在哪里的各级：工作区（子项目还有它的各级父项目）、待办所在的项目 */
function placeParts(e: RecycleEntry): string[] {
  if (e.kind === "workspace") return [];
  const project = e.kind === "project" ? (e.project ? parentOf(e.project) : undefined) : (e.project ?? "");
  return [e.workspace, ...(project ? project.split(PROJECT_SEP) : [])];
}

/** 原来在哪里（完整的，查找时也按它找） */
const placeOf = (e: RecycleEntry) => placeParts(e).join(" / ");

function KindIcon({ e }: { e: RecycleEntry }) {
  if (e.kind === "workspace")
    return (
      <span className="ws-avatar" style={{ background: avatarColor(e.title) }}>
        {firstChar(e.title)}
      </span>
    );
  if (e.kind === "project") return <FolderFilled className="project-icon" />;
  return <FileTextOutlined className="recycle-todo-icon" />;
}

/**
 * 软件的回收站：删除的工作区、项目、待办先放在这里（数据目录的 .recycle），可以恢复到原来的位置，
 * 或彻底删除（移到 Windows 回收站）；放满 30 天的启动时移到 Windows 回收站
 */
function RecycleBinDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const now = useNow();
  const [list, setList] = useState<RecycleEntry[] | null>(null);
  const [keyword, setKeyword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.listRecycle());
    } catch (e) {
      message.error(errMsg(e));
      setList([]);
    }
  }, [message]);

  useEffect(() => {
    // load 里的 setState 都在 await 之后
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) load();
  }, [open, load]);

  const restore = async (e: RecycleEntry) => {
    setBusy(e.id);
    try {
      const r = await api.restoreRecycled([e.id]);
      if (r.restored[0]) message.success(`已恢复到${restoredPlace(r.restored[0])}`);
      else message.error(`恢复失败：${r.errors[0] ?? "回收站里已经没有了"}`);
    } catch (err) {
      message.error(errMsg(err));
    } finally {
      setBusy(null);
      load();
    }
  };

  const purge = async (ids: string[], all = false) => {
    setBusy(all ? "*" : ids[0]);
    try {
      const r = all ? await api.emptyRecycle() : await api.purgeRecycled(ids);
      if (r.moved) message.success(all ? `已清空回收站，${r.moved} 项移到了 Windows 回收站` : "已移到 Windows 回收站");
      // 里面的路径太长、Windows 回收站放不下的留在这里（交给它可能失败，也可能被直接删掉），还能恢复
      if (r.tooLong)
        message.warning(
          `${all ? `有 ${r.tooLong} 项` : "这一项"}里面的路径太长，Windows 回收站放不下，留在了回收站里。可以恢复后把里面的文件夹改短或拆开，再删除`,
          8,
        );
    } catch (err) {
      message.error(errMsg(err));
    } finally {
      setBusy(null);
      load();
    }
  };

  const k = keyword.trim().toLowerCase();
  const shown = list?.filter((e) => !k || `${nameOf(e)} ${placeOf(e)}`.toLowerCase().includes(k)) ?? [];

  return (
    <Modal
      open={open}
      title="回收站"
      width={720}
      centered
      destroyOnHidden
      onCancel={onClose}
      footer={
        <div className="recycle-foot">
          <span className="muted">删除的工作区、项目和待办在这里保留 30 天，之后移到 Windows 回收站。</span>
          <Popconfirm
            title="清空回收站？"
            description="全部移到 Windows 回收站，之后只能从那里找回。"
            okText="清空"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => purge([], true)}
          >
            <Button danger disabled={!list?.length} loading={busy === "*"}>
              清空回收站
            </Button>
          </Popconfirm>
        </div>
      }
    >
      {list === null ? (
        <div className="recycle-loading">
          <Spin />
        </div>
      ) : list.length === 0 ? (
        <Empty className="recycle-empty" description="回收站是空的" />
      ) : (
        <>
          <Input
            className="recycle-search"
            allowClear
            prefix={<SearchOutlined className="muted" />}
            placeholder="按名称、原来的位置查找"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <div className="list recycle-list">
            {shown.map((e) => (
              <div key={e.id} className={`list-row recycle-row${e.kind === "todo" && e.done ? " done" : ""}`}>
                <KindIcon e={e} />
                <div className="list-main">
                  <div className={`list-title${e.kind === "todo" && !e.title.trim() ? " from-content" : ""}`} title={nameOf(e)}>
                    {nameOf(e)}
                  </div>
                  <div className="list-snippet" title={placeOf(e) ? `原来在「${placeOf(e)}」` : undefined}>
                    {KIND_LABELS[e.kind]}
                    {/* 层级多时中间折叠，悬停看完整的 */}
                    {placeOf(e) && ` · 原来在「${compactPath(placeParts(e), 2, 2)}」`}
                    {e.kind !== "todo" && ` · ${e.todoCount} 条待办`}
                  </div>
                </div>
                <Tooltip title={`删除时间：${fullTime(e.deletedAt)}`}>
                  <span className="list-time">{relativeTime(e.deletedAt, now)}删除</span>
                </Tooltip>
                <Button size="small" icon={<UndoOutlined />} loading={busy === e.id} onClick={() => restore(e)}>
                  恢复
                </Button>
                <Popconfirm
                  title="彻底删除？"
                  description="移到 Windows 回收站，之后只能从那里找回。"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => purge([e.id])}
                >
                  <Tooltip title="彻底删除（移到 Windows 回收站）">
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Tooltip>
                </Popconfirm>
              </div>
            ))}
            {shown.length === 0 && <div className="list-empty">没有找到包含“{keyword.trim()}”的</div>}
          </div>
        </>
      )}
    </Modal>
  );
}

/** 打开回收站的按钮：首页的头部是普通按钮，侧栏底部是文字链接 */
export default function RecycleBinButton({ variant = "button" }: { variant?: "button" | "link" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {variant === "button" ? (
        <Tooltip title="回收站：恢复删除的工作区、项目、待办">
          <Button icon={<RestOutlined />} onClick={() => setOpen(true)}>
            回收站
          </Button>
        </Tooltip>
      ) : (
        <a className="sidebar-recycle" onClick={() => setOpen(true)} title="恢复删除的工作区、项目、待办">
          <RestOutlined /> 回收站
        </a>
      )}
      <RecycleBinDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
