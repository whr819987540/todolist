import {
  DeleteOutlined,
  EditOutlined,
  FolderOpenOutlined,
  LoginOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  App as AntApp,
  Button,
  Dropdown,
  Empty,
  Input,
  Progress,
  Spin,
  Tooltip,
  type InputRef,
  type MenuProps,
} from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { useWindowFocus } from "../hooks";
import { isRefreshShortcut } from "../shortcuts";
import { ThemeButton } from "../theme";
import type { WorkspaceInfo, WorkspaceTree } from "../types";
import { avatarColor, compareName, firstChar, relativeTime, useNow } from "../utils";
import { forgetWorkspaceState, renameWorkspaceState } from "../workspaceState";
import Highlight from "./Highlight";
import Logo from "./Logo";
import { useNameDialog } from "./NameDialog";
import SearchResults from "./SearchResults";
import SettingsButton from "./SettingsButton";
import type { Selection } from "./sidebar/tree";

/** 首页：全部工作区 */
export default function Home({ onEnter }: { onEnter: (workspace: string, sel?: Omit<Selection, "workspace">) => void }) {
  const { message, modal } = AntApp.useApp();
  const [list, setList] = useState<WorkspaceInfo[] | null>(null);
  const [root, setRoot] = useState("");
  const [keyword, setKeyword] = useState("");
  const [trees, setTrees] = useState<WorkspaceTree[] | null>(null);
  const [dialog, openDialog] = useNameDialog();
  const searchRef = useRef<InputRef>(null);
  const now = useNow();
  const kw = keyword.trim();
  const searching = kw !== "";

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
    // reload 是异步加载，setState 都在 await 之后，规则看不出来，当成了同步调用
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
    api.dataRoot().then(setRoot);
  }, [reload]);

  useWindowFocus((focused) => {
    if (focused) reload();
  });

  // 搜索时才加载各工作区的项目和待办；工作区列表刷新（切回窗口、F5）后跟着重新加载
  useEffect(() => {
    if (!searching || !list) return;
    let stale = false;
    Promise.all(list.map((ws) => api.loadWorkspace(ws.name).catch(() => null))).then((ts) => {
      if (!stale) setTrees(ts.filter((t) => t !== null));
    });
    return () => {
      stale = true;
    };
  }, [searching, list]);

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
      if (isRefreshShortcut(e)) {
        e.preventDefault();
        reload();
      } else if (ctrl && key === "n") {
        e.preventDefault();
        createRef.current();
      } else if (ctrl && key === "f") {
        e.preventDefault();
        searchRef.current?.focus({ cursor: "all" });
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
        const name = await api.renameWorkspace(ws.name, v);
        renameWorkspaceState(ws.name, name);
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
          forgetWorkspaceState(ws.name);
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

  const renderCard = (ws: WorkspaceInfo) => {
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
                <Highlight text={ws.name} kw={kw} />
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
  };

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
        <div className="home-toolbar">
          <div className="section-title">
            {searching ? (
              "搜索结果"
            ) : (
              <>我的工作区{list && list.length > 0 && <span className="muted">（{list.length}）</span>}</>
            )}
          </div>
          {(searching || (list && list.length > 0)) && (
            <Input
              ref={searchRef}
              className="home-search"
              allowClear
              prefix={<SearchOutlined className="muted" />}
              placeholder="搜索工作区、项目、待办（Ctrl+F）"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setKeyword("");
              }}
            />
          )}
        </div>

        {list === null ? (
          <div className="fullscreen-center">
            <Spin />
          </div>
        ) : searching ? (
          <SearchResults
            kw={kw}
            workspaces={list.filter((ws) => ws.name.toLowerCase().includes(kw.toLowerCase()))}
            trees={trees}
            renderCard={renderCard}
            onEnter={onEnter}
          />
        ) : list.length === 0 ? (
          <Empty className="home-empty" description="还没有工作区，先创建一个吧">
            <Button type="primary" size="large" icon={<PlusOutlined />} onClick={create}>
              创建第一个工作区
            </Button>
          </Empty>
        ) : (
          <div className="card-grid">
            {list.map(renderCard)}
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
