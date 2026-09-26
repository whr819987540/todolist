import {
  DeleteOutlined,
  EditOutlined,
  FolderOpenOutlined,
  LoginOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { App as AntApp, Button, Dropdown, Empty, Progress, Spin, Tooltip, type MenuProps } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { useWindowFocus } from "../hooks";
import { ThemeButton } from "../theme";
import type { WorkspaceInfo } from "../types";
import { avatarColor, compareName, firstChar, relativeTime, useNow } from "../utils";
import Logo from "./Logo";
import { useNameDialog } from "./NameDialog";
import SettingsButton from "./SettingsButton";

/** 首页：全部工作区 */
export default function Home({ onEnter }: { onEnter: (workspace: string) => void }) {
  const { message, modal } = AntApp.useApp();
  const [list, setList] = useState<WorkspaceInfo[] | null>(null);
  const [root, setRoot] = useState("");
  const [dialog, openDialog] = useNameDialog();
  const now = useNow();

  const reload = useCallback(async () => {
    try {
      const l = await api.listWorkspaces();
      setList(l.sort((a, b) => compareName(a.name, b.name)));
    } catch (e) {
      message.error(errMsg(e));
      setList([]);
    }
  }, [message]);

  useEffect(() => {
    reload();
    api.dataRoot().then(setRoot);
  }, [reload]);

  useWindowFocus((focused) => {
    if (focused) reload();
  });

  const create = () =>
    openDialog({
      title: "新建工作区",
      label: "工作区用来区分不同领域，例如“工作”“生活”“学习”。",
      placeholder: "请输入工作区名称",
      okText: "创建",
      onSubmit: async (v) => {
        const name = await api.createWorkspace(v);
        message.success(`已创建工作区「${name}」`);
        onEnter(name);
      },
    });

  const createRef = useRef(create);
  useEffect(() => {
    createRef.current = create;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (e.key === "F5" || (ctrl && key === "r")) {
        e.preventDefault();
        reload();
      } else if (ctrl && key === "n") {
        e.preventDefault();
        createRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reload]);

  const rename = (ws: WorkspaceInfo) =>
    openDialog({
      title: "重命名工作区",
      initial: ws.name,
      onSubmit: async (v) => {
        await api.renameWorkspace(ws.name, v);
        message.success("已重命名");
        await reload();
      },
    });

  const remove = (ws: WorkspaceInfo) =>
    modal.confirm({
      title: `删除工作区「${ws.name}」？`,
      content: `其中的 ${ws.projectCount} 个项目、${ws.todoCount} 条待办将一并移到回收站。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await api.deleteWorkspace(ws.name);
          message.success("已移到回收站");
        } catch (e) {
          message.error(errMsg(e));
        }
        await reload();
      },
    });

  const menu = (ws: WorkspaceInfo): MenuProps => ({
    items: [
      { key: "enter", icon: <LoginOutlined />, label: "进入工作区" },
      { key: "rename", icon: <EditOutlined />, label: "重命名" },
      { key: "folder", icon: <FolderOpenOutlined />, label: "在资源管理器中打开" },
      { type: "divider" },
      { key: "delete", icon: <DeleteOutlined />, label: "删除", danger: true },
    ],
    onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation();
      if (key === "enter") onEnter(ws.name);
      else if (key === "rename") rename(ws);
      else if (key === "folder") api.openFolder(ws.name).catch((e) => message.error(errMsg(e)));
      else if (key === "delete") remove(ws);
    },
  });

  return (
    <div className="home">
      <header className="home-header">
        <div className="brand">
          <Logo size={40} />
          <div>
            <h1>待办清单</h1>
            <p>工作区 · 项目 · 待办，三级管理，井井有条</p>
          </div>
        </div>
        <div className="home-actions">
          <ThemeButton />
          <SettingsButton />
          <Tooltip title="刷新（F5）">
            <Button icon={<ReloadOutlined />} onClick={reload} />
          </Tooltip>
          <Button icon={<FolderOpenOutlined />} onClick={() => api.openFolder()}>
            打开数据目录
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={create}>
            新建工作区
          </Button>
        </div>
      </header>

      <main className="home-main">
        <div className="section-title">
          我的工作区{list && list.length > 0 && <span className="muted">（{list.length}）</span>}
        </div>

        {list === null ? (
          <div className="fullscreen-center">
            <Spin />
          </div>
        ) : list.length === 0 ? (
          <Empty className="home-empty" description="还没有工作区，先创建一个吧">
            <Button type="primary" size="large" icon={<PlusOutlined />} onClick={create}>
              创建第一个工作区
            </Button>
          </Empty>
        ) : (
          <div className="card-grid">
            {list.map((ws) => {
              const pct = ws.todoCount ? Math.round((ws.doneCount / ws.todoCount) * 100) : 0;
              return (
                <Dropdown key={ws.name} menu={menu(ws)} trigger={["contextMenu"]}>
                  <div className="card ws-card" onClick={() => onEnter(ws.name)}>
                    <div className="card-head">
                      <span className="ws-avatar big" style={{ background: avatarColor(ws.name) }}>
                        {firstChar(ws.name)}
                      </span>
                      <div className="card-title">
                        <div className="card-name" title={ws.name}>
                          {ws.name}
                        </div>
                        <div className="muted small">
                          {ws.projectCount} 个项目 · {ws.todoCount} 条待办
                        </div>
                      </div>
                      <Dropdown menu={menu(ws)} trigger={["click"]} placement="bottomRight">
                        <Button
                          type="text"
                          size="small"
                          icon={<MoreOutlined />}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </Dropdown>
                    </div>
                    <Progress percent={pct} size="small" />
                    <div className="card-foot">
                      <span>
                        已完成 {ws.doneCount} / {ws.todoCount}
                      </span>
                      <span>更新于 {relativeTime(ws.updatedAt, now)}</span>
                    </div>
                  </div>
                </Dropdown>
              );
            })}
            <div className="card card-add" onClick={create}>
              <PlusOutlined /> 新建工作区
            </div>
          </div>
        )}
      </main>

      <footer className="home-footer">
        数据保存在：
        <a onClick={() => api.openFolder()} title="在资源管理器中打开">
          {root}
        </a>
        <span className="sep">|</span>
        每条待办是一个 Markdown 文件，可直接用其他软件编辑
      </footer>
      {dialog}
    </div>
  );
}
