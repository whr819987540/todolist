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
import { Button, Checkbox, Dropdown, Input, Popover, Tooltip, type InputRef, type MenuProps } from "antd";
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
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

/** 右侧显示的内容：只有 workspace 时是工作区概览，有 project 时是项目概览，再有 todoId 时是这条待办 */
export interface Selection {
  workspace: string;
  project?: string;
  todoId?: string;
}

type Collapsed = Record<string, boolean>;

/** 列表里每一行对应的选中项，存在行的 data-sel 上，键盘上下移动时按显示顺序取 */
const selKey = (s: Selection) => JSON.stringify([s.workspace, s.project ?? "", s.todoId ?? ""]);

function parseSelKey(key: string): Selection {
  const [workspace, project, todoId] = JSON.parse(key) as string[];
  return { workspace, project: project || undefined, todoId: todoId || undefined };
}

/** 供 WorkspaceView 的快捷键（Alt+方向键）调用 */
export interface SidebarHandle {
  /** 焦点移到左侧列表 */
  focus(): void;
  /** 选中上一行 / 下一行（折叠起来的不算），焦点移到左侧列表 */
  move(step: 1 | -1): void;
}

interface Props {
  /** 侧栏里显示的工作区（已加载的） */
  trees: WorkspaceTree[];
  /** 选中显示的工作区 */
  workspaces: string[];
  onWorkspacesChange: (list: string[]) => void;
  sel: Selection;
  onSelect: (s: Selection) => void;
  actionsFor: (workspace: string) => Actions;
  onHome: () => void;
  /** 焦点移到右侧（编辑区 / 概览） */
  onFocusMain: () => void;
  handleRef: React.RefObject<SidebarHandle | null>;
  width: number;
  searchRef: React.RefObject<InputRef | null>;
  collapsedOf: (workspace: string) => Collapsed;
  setCollapsed: (workspace: string, fn: (prev: Collapsed) => Collapsed) => void;
  keyword: string;
  setKeyword: (v: string) => void;
  hideDone: boolean;
  setHideDone: (v: boolean) => void;
  sortKey: SortKey;
  setSortKey: (v: SortKey) => void;
}

const SORT_LABELS: Record<SortKey, string> = {
  created: "按创建时间",
  updated: "按修改时间",
  title: "按标题",
};

const countDone = (t: WorkspaceTree) => t.projects.reduce((n, p) => n + p.todos.filter((x) => x.done).length, 0);
const countAll = (t: WorkspaceTree) => t.projects.reduce((n, p) => n + p.todos.length, 0);

export default function Sidebar(props: Props) {
  const { trees, sel, actionsFor, collapsedOf, setCollapsed, keyword, hideDone, sortKey } = props;
  const now = useNow();
  const kw = keyword.trim();
  const multi = trees.length > 1;

  const total = trees.reduce((n, t) => n + countAll(t), 0);
  const done = trees.reduce((n, t) => n + countDone(t), 0);

  const anyProjectOpen = trees.some((t) => t.projects.some((p) => !collapsedOf(t.name)[p.name]));
  const toggleAll = () => {
    for (const t of trees)
      setCollapsed(t.name, (c) => {
        const next = { ...c };
        for (const p of t.projects) next[p.name] = anyProjectOpen;
        return next;
      });
  };

  const treeRef = useRef<HTMLDivElement>(null);
  // 用键盘操作时给列表里的选中行加上焦点框，用鼠标点时不加
  const [kbFocus, setKbFocus] = useState(false);
  const rows = () => [...(treeRef.current?.querySelectorAll<HTMLElement>(".tree-row[data-sel]") ?? [])];

  // 选中项滚动到可见区域
  const current = selKey(sel);
  useEffect(() => {
    rows()
      .find((r) => r.dataset.sel === current)
      ?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const focusTree = () => {
    setKbFocus(true);
    treeRef.current?.focus({ preventScroll: true });
  };

  const move = (step: 1 | -1) => {
    focusTree();
    const keys = rows().map((r) => r.dataset.sel!);
    if (!keys.length) return;
    let at = keys.indexOf(current);
    // 选中项被折叠或筛选掉了：从它所在的项目 / 工作区开始
    if (at < 0 && sel.project) at = keys.indexOf(selKey({ workspace: sel.workspace, project: sel.project }));
    if (at < 0) at = keys.indexOf(selKey({ workspace: sel.workspace }));
    const next = at < 0 ? 0 : at + step;
    if (next >= 0 && next < keys.length && next !== at) props.onSelect(parseSelKey(keys[next]));
  };

  useImperativeHandle(props.handleRef, () => ({ focus: focusTree, move }));

  // 列表获得焦点时：↑↓ 移动，← → 折叠 / 展开（或回到上一级），Enter 打开待办或折叠 / 展开
  const onTreeKey = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const ws = sel.workspace;
    // 待办没有下一级；搜索时全部展开，不能折叠
    const branch = sel.todoId ? null : (sel.project ?? WS_KEY);
    const open = branch !== null && (!!kw || !collapsedOf(ws)[branch]);
    const setOpen = (v: boolean) => branch && setCollapsed(ws, (c) => ({ ...c, [branch]: !v }));
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Enter"].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "Enter" && sel.todoId) {
      // 焦点移到右侧正文；在这个处理函数里移走焦点，列表的 onBlur 清不掉焦点框，这里直接清
      setKbFocus(false);
      props.onFocusMain();
      return;
    }
    setKbFocus(true);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") move(e.key === "ArrowDown" ? 1 : -1);
    else if (e.key === "ArrowRight") {
      if (branch && !open) setOpen(true);
      else if (branch) move(1);
    } else if (e.key === "ArrowLeft") {
      if (branch && open && !kw) setOpen(false);
      else if (sel.todoId) props.onSelect({ workspace: ws, project: sel.project });
      else if (sel.project) props.onSelect({ workspace: ws });
    } else if (e.key === "Enter" && !kw) setOpen(!open);
  };

  // 「新建」按钮作用于右侧正在显示的工作区
  const selTree = trees.find((t) => t.name === sel.workspace);
  const a = actionsFor(sel.workspace);
  const currentProject = sel.project ?? (selTree?.projects.length === 1 ? selTree.projects[0].name : undefined);
  const where = (project?: string) => [multi ? sel.workspace : "", project ?? ""].filter(Boolean).join(" / ");
  const newMenu: MenuProps = {
    items: [
      {
        key: "todo",
        icon: <PlusOutlined />,
        label: currentProject ? `新建待办（${where(currentProject)}）` : "新建待办（请先选择项目）",
        disabled: !currentProject,
        extra: "Ctrl+N",
      },
      { key: "project", icon: <FolderFilled />, label: multi ? `新建项目（${where()}）` : "新建项目" },
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
          <Button type="text" icon={<HomeOutlined />} onClick={props.onHome} />
        </Tooltip>
        <WorkspacePicker selected={props.workspaces} onChange={props.onWorkspacesChange} onHome={props.onHome} />
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
        <span className="sidebar-bar-title">{multi ? "工作区、项目与待办" : "项目与待办"}</span>
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

      <div
        ref={treeRef}
        className={`tree${kbFocus ? " kb-focus" : ""}`}
        role="tree"
        tabIndex={0}
        onKeyDown={onTreeKey}
        onMouseDown={() => setKbFocus(false)}
        onBlur={() => setKbFocus(false)}
      >
        {trees.map((tree) => (
          <WorkspaceBranch
            key={tree.name}
            tree={tree}
            sel={sel}
            actions={actionsFor(tree.name)}
            collapsed={collapsedOf(tree.name)}
            setCollapsed={(fn) => setCollapsed(tree.name, fn)}
            keyword={kw}
            hideDone={hideDone}
            sortKey={sortKey}
            now={now}
          />
        ))}
      </div>

      <div className="sidebar-foot">
        {multi && `${trees.length} 个工作区，`}共 {total} 条待办，已完成 {done} 条
      </div>
    </aside>
  );
}

/** 一个工作区：工作区行 + 下面的项目和待办 */
function WorkspaceBranch(p: {
  tree: WorkspaceTree;
  sel: Selection;
  actions: Actions;
  collapsed: Collapsed;
  setCollapsed: (fn: (prev: Collapsed) => Collapsed) => void;
  keyword: string;
  hideDone: boolean;
  sortKey: SortKey;
  now: number;
}) {
  const { tree, actions: a, collapsed, keyword: kw, hideDone, sortKey } = p;
  const projectNames = useMemo(() => tree.projects.map((x) => x.name), [tree]);
  // 右侧显示的是这个工作区里的内容时才有选中项
  const sel = p.sel.workspace === tree.name ? p.sel : undefined;

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

  const total = countAll(tree);
  const done = countDone(tree);

  // 搜索时忽略折叠状态，把命中项全部展开
  const isOpen = (key: string) => !!kw || !collapsed[key];
  const toggle = (key: string) => p.setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  return (
    <div className="ws-branch" role="treeitem" aria-expanded={isOpen(WS_KEY)}>
      <Dropdown menu={workspaceMenu(a)} trigger={["contextMenu"]}>
        <div
          className={`tree-row ws-row${sel && !sel.project ? " selected" : ""}`}
          data-sel={selKey({ workspace: tree.name })}
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
          <span className="row-label" title={tree.name}>
            {tree.name}
          </span>
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
              workspace={tree.name}
              project={project}
              todos={todos}
              open={isOpen(project.name)}
              onToggle={() => toggle(project.name)}
              sel={sel}
              actions={a}
              projectNames={projectNames}
              keyword={kw}
              now={p.now}
              hideDone={hideDone}
            />
          ))}
          {tree.projects.length === 0 && (
            <div className="tree-empty" style={{ paddingLeft: 30 }}>
              还没有项目，
              <a onClick={a.newProject}>新建一个</a>
            </div>
          )}
          {kw && visible.length === 0 && tree.projects.length > 0 && (
            <div className="tree-empty" style={{ paddingLeft: 30 }}>
              没有找到包含“{kw}”的待办
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectBranch(p: {
  workspace: string;
  project: ProjectNode;
  todos: TodoSummary[];
  open: boolean;
  onToggle: () => void;
  /** 右侧显示的是这个工作区里的内容时才传 */
  sel?: Selection;
  actions: Actions;
  projectNames: string[];
  keyword: string;
  now: number;
  hideDone: boolean;
}) {
  const { project, todos, sel, actions: a } = p;
  const undone = project.todos.filter((t) => !t.done).length;
  const selected = sel?.project === project.name && !sel.todoId;
  const hiddenDone = p.hideDone ? project.todos.length - undone : 0;

  return (
    <div role="treeitem" aria-expanded={p.open}>
      <Dropdown menu={projectMenu(a, project.name)} trigger={["contextMenu"]}>
        <div
          className={`tree-row project-row${selected ? " selected" : ""}`}
          data-sel={selKey({ workspace: p.workspace, project: project.name })}
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
              workspace={p.workspace}
              project={project.name}
              todo={t}
              selected={sel?.project === project.name && sel.todoId === t.id}
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
  workspace: string;
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
          data-sel={selKey({ workspace: p.workspace, project: p.project, todoId: t.id })}
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

/** 侧栏顶部：选中要显示的工作区，可多选，勾选后立即显示 */
function WorkspacePicker(p: { selected: string[]; onChange: (list: string[]) => void; onHome: () => void }) {
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const chosen = new Set(p.selected);
  const only = p.selected.length === 1;

  const toggle = (name: string) => {
    if (!chosen.has(name)) p.onChange([...p.selected, name]);
    else if (!only) p.onChange(p.selected.filter((n) => n !== name));
  };

  const panel = (
    <div className="ws-picker">
      <div className="ws-picker-head">选中要显示的工作区（可多选）</div>
      <div className="ws-picker-list">
        {names.map((n) => {
          const checked = chosen.has(n);
          // 至少要显示一个工作区
          const locked = checked && only;
          return (
            <div
              key={n}
              className={`ws-picker-item${locked ? " locked" : ""}`}
              title={locked ? "至少要选中一个工作区" : undefined}
              onClick={() => toggle(n)}
            >
              <Checkbox className="ws-picker-check" checked={checked} disabled={locked} tabIndex={-1} />
              <span className="ws-avatar" style={{ background: avatarColor(n) }}>
                {firstChar(n)}
              </span>
              <span className="ws-picker-name">{n}</span>
              {!locked && (
                <a
                  className="ws-picker-only"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onChange([n]);
                    setOpen(false);
                  }}
                >
                  仅显示
                </a>
              )}
            </div>
          );
        })}
      </div>
      <div className="ws-picker-foot">
        <Button
          size="small"
          type="text"
          disabled={names.every((n) => chosen.has(n))}
          onClick={() => p.onChange(names)}
        >
          全选
        </Button>
        <Button
          size="small"
          type="text"
          icon={<HomeOutlined />}
          onClick={() => {
            setOpen(false);
            p.onHome();
          }}
        >
          返回首页
        </Button>
      </div>
    </div>
  );

  const [first] = p.selected;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o)
          api
            .listWorkspaces()
            .then((l) => setNames(l.map((w) => w.name).sort(compareName)))
            .catch(() => {});
      }}
      trigger="click"
      placement="bottomLeft"
      arrow={false}
      classNames={{ root: "ws-picker-pop" }}
      content={panel}
    >
      <button className="ws-switcher" title={`正在显示：${p.selected.join("、")}`}>
        {only ? (
          <>
            <span className="ws-avatar" style={{ background: avatarColor(first) }}>
              {firstChar(first)}
            </span>
            <span className="ws-switcher-name">{first}</span>
          </>
        ) : (
          <>
            <span className="ws-avatars">
              {p.selected.slice(0, 3).map((n) => (
                <span key={n} className="ws-avatar" style={{ background: avatarColor(n) }}>
                  {firstChar(n)}
                </span>
              ))}
            </span>
            <span className="ws-switcher-name">{p.selected.length} 个工作区</span>
          </>
        )}
        <DownOutlined className="muted" style={{ fontSize: 10 }} />
      </button>
    </Popover>
  );
}
