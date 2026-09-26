import {
  CheckOutlined,
  ColumnHeightOutlined,
  DownOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FolderFilled,
  FolderOpenFilled,
  HomeOutlined,
  MoreOutlined,
  PlusOutlined,
  RightOutlined,
  SearchOutlined,
  SortAscendingOutlined,
  VerticalAlignMiddleOutlined,
} from "@ant-design/icons";
import { Button, Dropdown, Input, Tooltip, type InputRef, type MenuProps } from "antd";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { ThemeButton } from "../theme";
import type { ProjectNode, SortKey, TodoSummary, WorkspaceTree } from "../types";
import {
  avatarColor,
  compactTime,
  compareName,
  displayTitle,
  firstChar,
  fullTime,
  matchTodo,
  relativeTime,
  sortTodos,
  useNow,
} from "../utils";
import Highlight from "./Highlight";
import { projectMenu, todoMenu, workspaceMenu, type Actions } from "./menus";
import SettingsButton from "./SettingsButton";

export const WS_KEY = "\u0000workspace";

export interface Selection {
  project?: string;
  todoId?: string;
}

interface Props {
  tree: WorkspaceTree;
  sel: Selection;
  actions: Actions;
  width: number;
  searchRef: React.RefObject<InputRef | null>;
  collapsed: Record<string, boolean>;
  setCollapsed: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  keyword: string;
  setKeyword: (v: string) => void;
  hideDone: boolean;
  setHideDone: (v: boolean) => void;
  sortKey: SortKey;
  setSortKey: (v: SortKey) => void;
  onSwitchWorkspace: (name: string) => void;
}

const SORT_LABELS: Record<SortKey, string> = {
  created: "按创建时间",
  updated: "按修改时间",
  title: "按标题",
};

export default function Sidebar(props: Props) {
  const { tree, sel, actions: a, collapsed, setCollapsed, keyword, hideDone, sortKey } = props;
  const now = useNow();
  const kw = keyword.trim();
  const projectNames = useMemo(() => tree.projects.map((p) => p.name), [tree]);

  const visible = useMemo(() => {
    const k = kw.toLowerCase();
    return tree.projects
      .map((project) => {
        let todos = sortTodos(project.todos, sortKey);
        if (hideDone) todos = todos.filter((t) => !t.done);
        if (kw) todos = todos.filter((t) => matchTodo(t, kw));
        return { project, todos, nameMatch: !!k && project.name.toLowerCase().includes(k) };
      })
      .filter((x) => !kw || x.todos.length > 0 || x.nameMatch);
  }, [tree, kw, hideDone, sortKey]);

  const total = tree.projects.reduce((n, p) => n + p.todos.length, 0);
  const done = tree.projects.reduce((n, p) => n + p.todos.filter((t) => t.done).length, 0);

  // 搜索时忽略折叠状态，把命中项全部展开
  const isOpen = (key: string) => !!kw || !collapsed[key];
  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));
  const anyProjectOpen = tree.projects.some((p) => !collapsed[p.name]);
  const toggleAll = () =>
    setCollapsed((c) => {
      const next = { ...c };
      for (const p of tree.projects) next[p.name] = anyProjectOpen;
      return next;
    });

  // 选中项滚动到可见区域
  useEffect(() => {
    if (!sel.todoId) return;
    const el = document.querySelector(`[data-todo="${CSS.escape(`${sel.project}/${sel.todoId}`)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel.project, sel.todoId]);

  const currentProject = sel.project ?? (tree.projects.length === 1 ? tree.projects[0].name : undefined);
  const newMenu: MenuProps = {
    items: [
      {
        key: "todo",
        icon: <PlusOutlined />,
        label: currentProject ? `新建待办（${currentProject}）` : "新建待办（请先选择项目）",
        disabled: !currentProject,
        extra: "Ctrl+N",
      },
      { key: "project", icon: <FolderFilled />, label: "新建项目" },
    ],
    onClick: ({ key }) => {
      if (key === "todo" && currentProject) a.newTodo(currentProject, "", true);
      if (key === "project") a.newProject();
    },
  };

  const sortMenu: MenuProps = {
    selectable: true,
    selectedKeys: [sortKey],
    items: (Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({ key: k, label: SORT_LABELS[k] })),
    onClick: ({ key }) => props.setSortKey(key as SortKey),
  };

  return (
    <aside className="sidebar" style={{ width: props.width }}>
      <div className="sidebar-head">
        <Tooltip title="返回首页">
          <Button type="text" icon={<HomeOutlined />} onClick={a.goHome} />
        </Tooltip>
        <WorkspaceSwitcher current={tree.name} onSwitch={props.onSwitchWorkspace} onHome={a.goHome} />
        <ThemeButton type="text" />
        <SettingsButton type="text" />
      </div>

      <div className="sidebar-search">
        <Input
          ref={props.searchRef}
          allowClear
          prefix={<SearchOutlined className="muted" />}
          placeholder="搜索待办（Ctrl+F）"
          value={keyword}
          onChange={(e) => props.setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.setKeyword("");
          }}
        />
        <Dropdown menu={newMenu} trigger={["click"]} placement="bottomRight">
          <Button type="primary" icon={<PlusOutlined />} />
        </Dropdown>
      </div>

      <div className="sidebar-bar">
        <span className="sidebar-bar-title">项目与待办</span>
        <Dropdown menu={sortMenu} trigger={["click"]}>
          <Tooltip title={`排序：${SORT_LABELS[sortKey]}`}>
            <Button type="text" size="small" icon={<SortAscendingOutlined />} />
          </Tooltip>
        </Dropdown>
        <Tooltip title={hideDone ? "显示已完成" : "隐藏已完成"}>
          <Button
            type="text"
            size="small"
            className={hideDone ? "is-active" : undefined}
            icon={hideDone ? <EyeInvisibleOutlined /> : <EyeOutlined />}
            onClick={() => props.setHideDone(!hideDone)}
          />
        </Tooltip>
        <Tooltip title={anyProjectOpen ? "全部折叠" : "全部展开"}>
          <Button
            type="text"
            size="small"
            icon={anyProjectOpen ? <VerticalAlignMiddleOutlined /> : <ColumnHeightOutlined />}
            onClick={toggleAll}
          />
        </Tooltip>
      </div>

      <div className="tree" role="tree">
        <Dropdown menu={workspaceMenu(a)} trigger={["contextMenu"]}>
          <div
            className={`tree-row ws-row${!sel.project ? " selected" : ""}`}
            onClick={() => {
              a.selectWorkspace();
              if (!isOpen(WS_KEY)) toggle(WS_KEY);
            }}
            onDoubleClick={() => toggle(WS_KEY)}
          >
            <Chevron open={isOpen(WS_KEY)} onClick={() => toggle(WS_KEY)} />
            <span className="ws-avatar" style={{ background: avatarColor(tree.name) }}>
              {firstChar(tree.name)}
            </span>
            <span className="row-label">{tree.name}</span>
            <span className="row-count" title={`未完成 ${total - done} / 共 ${total}`}>
              {total - done || ""}
            </span>
            <span className="row-actions">
              <RowButton title="新建项目" icon={<PlusOutlined />} onClick={a.newProject} />
              <RowMore menu={workspaceMenu(a)} />
            </span>
          </div>
        </Dropdown>

        {isOpen(WS_KEY) && (
          <div role="group">
            {visible.map(({ project, todos }) => (
              <ProjectBranch
                key={project.name}
                project={project}
                todos={todos}
                open={isOpen(project.name)}
                onToggle={() => toggle(project.name)}
                sel={sel}
                actions={a}
                projectNames={projectNames}
                keyword={kw}
                now={now}
                hideDone={hideDone}
              />
            ))}
            {tree.projects.length === 0 && (
              <div className="tree-empty" style={{ paddingLeft: 30 }}>
                还没有项目，
                <a onClick={a.newProject}>新建一个</a>
              </div>
            )}
            {kw && visible.length === 0 && (
              <div className="tree-empty" style={{ paddingLeft: 30 }}>
                没有找到包含“{kw}”的待办
              </div>
            )}
          </div>
        )}
      </div>

      <div className="sidebar-foot">
        共 {total} 条待办，已完成 {done} 条
      </div>
    </aside>
  );
}

function ProjectBranch(p: {
  project: ProjectNode;
  todos: TodoSummary[];
  open: boolean;
  onToggle: () => void;
  sel: Selection;
  actions: Actions;
  projectNames: string[];
  keyword: string;
  now: number;
  hideDone: boolean;
}) {
  const { project, todos, sel, actions: a } = p;
  const undone = project.todos.filter((t) => !t.done).length;
  const selected = sel.project === project.name && !sel.todoId;
  const hiddenDone = p.hideDone ? project.todos.length - undone : 0;

  return (
    <div role="treeitem" aria-expanded={p.open}>
      <Dropdown menu={projectMenu(a, project.name)} trigger={["contextMenu"]}>
        <div
          className={`tree-row project-row${selected ? " selected" : ""}`}
          style={{ paddingLeft: 22 }}
          onClick={() => {
            a.selectProject(project.name);
            if (!p.open) p.onToggle();
          }}
          onDoubleClick={p.onToggle}
        >
          <Chevron open={p.open} onClick={p.onToggle} />
          <span className="project-icon">{p.open ? <FolderOpenFilled /> : <FolderFilled />}</span>
          <span className="row-label" title={project.name}>
            <Highlight text={project.name} kw={p.keyword} />
          </span>
          <span className="row-count" title={`未完成 ${undone} / 共 ${project.todos.length}`}>
            {undone || ""}
          </span>
          <span className="row-actions">
            <RowButton title="新建待办" icon={<PlusOutlined />} onClick={() => a.newTodo(project.name, "", true)} />
            <RowMore menu={projectMenu(a, project.name)} />
          </span>
        </div>
      </Dropdown>

      {p.open && (
        <div role="group">
          {todos.map((t) => (
            <TodoRow
              key={t.id}
              project={project.name}
              todo={t}
              selected={sel.project === project.name && sel.todoId === t.id}
              actions={a}
              projectNames={p.projectNames}
              keyword={p.keyword}
              now={p.now}
            />
          ))}
          {todos.length === 0 && !p.keyword && (
            <div className="tree-empty" style={{ paddingLeft: 48 }}>
              {hiddenDone > 0 ? (
                `已隐藏 ${hiddenDone} 条已完成的待办`
              ) : (
                <>
                  暂无待办，<a onClick={() => a.newTodo(project.name, "", true)}>新建一条</a>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TodoRow(p: {
  project: string;
  todo: TodoSummary;
  selected: boolean;
  actions: Actions;
  projectNames: string[];
  keyword: string;
  now: number;
}) {
  const { todo: t, actions: a } = p;
  const { text, fromContent } = displayTitle(t);

  const tip = (
    <div className="todo-tip">
      <div className="todo-tip-title">{text}</div>
      <div>状态：{t.done ? "已完成" : "未完成"}</div>
      <div>创建时间：{fullTime(t.createdAt)}</div>
      <div>修改时间：{fullTime(t.updatedAt)}</div>
      {t.done && t.doneAt && <div>完成时间：{fullTime(t.doneAt)}</div>}
      <div className="todo-tip-hint">右键可用默认程序打开</div>
    </div>
  );

  return (
    <Tooltip title={tip} placement="right" mouseEnterDelay={0.8}>
      <Dropdown menu={todoMenu(a, p.project, t, p.projectNames)} trigger={["contextMenu"]}>
        <div
          role="treeitem"
          aria-selected={p.selected}
          data-todo={`${p.project}/${t.id}`}
          className={`tree-row todo-row${p.selected ? " selected" : ""}${t.done ? " done" : ""}`}
          style={{ paddingLeft: 44 }}
          onClick={() => a.selectTodo(p.project, t.id)}
        >
          <span
            className={`check${t.done ? " checked" : ""}`}
            role="checkbox"
            aria-checked={t.done}
            title={t.done ? "标记为未完成" : "标记为已完成"}
            onClick={(e) => {
              e.stopPropagation();
              a.toggleDone(p.project, t);
            }}
          >
            {t.done && <CheckOutlined />}
          </span>
          <div className="todo-main">
            <div className={`todo-title${fromContent ? " from-content" : ""}`}>
              <Highlight text={text} kw={p.keyword} />
            </div>
            <div className="todo-meta">
              创建 {compactTime(t.createdAt, p.now)}
              <span className="sep">·</span>
              修改 {relativeTime(t.updatedAt, p.now, true)}
            </div>
          </div>
        </div>
      </Dropdown>
    </Tooltip>
  );
}

function Chevron({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <span
      className={`chevron${open ? " open" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <RightOutlined />
    </span>
  );
}

function RowButton({ title, icon, onClick }: { title: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <Tooltip title={title} mouseEnterDelay={0.4}>
      <span
        className="row-btn"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {icon}
      </span>
    </Tooltip>
  );
}

function RowMore({ menu }: { menu: MenuProps }) {
  return (
    <Dropdown menu={menu} trigger={["click"]} placement="bottomRight">
      <span
        className="row-btn"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <MoreOutlined />
      </span>
    </Dropdown>
  );
}

function WorkspaceSwitcher(p: { current: string; onSwitch: (name: string) => void; onHome: () => void }) {
  const [names, setNames] = useState<string[]>([]);
  const menu: MenuProps = {
    selectable: true,
    selectedKeys: [p.current],
    items: [
      { type: "group", label: "切换工作区", children: names.map((n) => ({ key: n, label: n })) },
      { type: "divider" },
      { key: "\u0000home", icon: <HomeOutlined />, label: "全部工作区" },
    ],
    onClick: ({ key }) => {
      if (key === "\u0000home") p.onHome();
      else if (key !== p.current) p.onSwitch(key);
    },
  };
  return (
    <Dropdown
      menu={menu}
      trigger={["click"]}
      onOpenChange={(open) => {
        if (open)
          api
            .listWorkspaces()
            .then((l) => setNames(l.map((w) => w.name).sort(compareName)))
            .catch(() => {});
      }}
    >
      <button className="ws-switcher" title="切换工作区">
        <span className="ws-avatar" style={{ background: avatarColor(p.current) }}>
          {firstChar(p.current)}
        </span>
        <span className="ws-switcher-name">{p.current}</span>
        <DownOutlined className="muted" style={{ fontSize: 10 }} />
      </button>
    </Dropdown>
  );
}
