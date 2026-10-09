import {
  CheckOutlined,
  FolderFilled,
  FolderOpenFilled,
  MoreOutlined,
  PlusOutlined,
  PushpinFilled,
  RightOutlined,
} from "@ant-design/icons";
import { Dropdown, Tooltip, type MenuProps } from "antd";
import type { OpenMenu } from "./RowPopups";
import { memo, useCallback, useMemo } from "react";
import { hitKey, searchSnippet } from "../../search";
import type { ProjectNode, SortKey, TodoSummary, WorkspaceTree } from "../../types";
import { avatarColor, compactTime, displayTitle, firstChar, matchTodo, relativeTime, sortTodos } from "../../utils";
import { type DragItem, type DragState, dropClass, isDraggingProject, reorderMark } from "../DragMove";
import Highlight from "../Highlight";
import { type MoveTarget, projectMenu, todoMenu, workspaceMenu, type Actions } from "../menus";
import { type Collapsed, countAll, countDone, hiddenDoneProjects, type Selection, selKey, WS_KEY } from "./tree";

/** 拖动：没在拖时 state 是 null；start 是不变的函数 */
type DragStart = (e: React.MouseEvent, item: DragItem) => void;

/** 单击待办（Ctrl / Shift+单击是多选）；是不变的函数 */
type TodoClick = (e: React.MouseEvent, s: Selection) => void;

/**
 * 一个工作区：工作区行 + 下面的项目和待办。
 * 工作区、项目、待办的行都用 memo：待办可能有几千条，只有内容（对象）、选中、折叠、拖动状态变了的才重新渲染
 */
export const WorkspaceBranch = memo(function WorkspaceBranch(p: {
  tree: WorkspaceTree;
  /** 右侧显示的是这个工作区里的内容时才传 */
  sel?: Selection;
  actions: Actions;
  collapsed: Collapsed;
  setCollapsed: (workspace: string, fn: (prev: Collapsed) => Collapsed) => void;
  keyword: string;
  /** 全文搜索在这个工作区里的结果（正文里有关键字的待办，见 search.ts）；还没查完时是 null */
  hits: ReadonlyMap<string, string> | null;
  hideDone: boolean;
  /** 隐藏全部完成的项目（右侧正在显示的那个除外，搜索时不隐藏） */
  hideDoneProjects: boolean;
  /** 这个工作区里刚切走、还要再显示一会儿的全部完成的项目（见 lingering.ts） */
  lingering: ReadonlySet<string>;
  /** 点「显示」：这个工作区不再隐藏全部完成的项目；是不变的函数 */
  onShowDoneProjects: (workspace: string) => void;
  sortKey: SortKey;
  now: number;
  today: string;
  dragState: DragState | null;
  dragStart: DragStart;
  onContextMenu: OpenMenu;
  /** 右键「移动到」列出的项目，右键时才算；是不变的函数 */
  moveTargets: (workspace: string) => MoveTarget[];
  /** 这个工作区里多选了的待办（行上的 data-sel） */
  picked: ReadonlySet<string>;
  onTodoClick: TodoClick;
  pickedMenu: () => MenuProps | null;
}) {
  const { tree, sel, actions: a, collapsed, keyword: kw, hits, hideDone, hideDoneProjects, lingering, sortKey, setCollapsed } =
    p;

  // 隐藏全部完成的项目时藏起来的项目
  const selProject = sel?.project;
  const hidden = useMemo(
    () => hiddenDoneProjects(tree.projects, { hide: hideDoneProjects, keyword: kw, selProject, lingering }),
    [tree.projects, hideDoneProjects, kw, selProject, lingering],
  );

  // 各项目里列出的待办，排好序；搜索时：标题、正文开头（前端匹配）或正文全文（hits）里有关键字的待办，和名字里有关键字的项目。
  // 这里不管哪些项目藏起来：藏起哪些跟着右侧显示的、刚切走的项目变，变了时不必把全部待办重新排序，各项目拿到的 todos
  // 还是原来的数组，项目不必重新渲染
  const listed = useMemo(() => {
    const k = kw.toLowerCase();
    return tree.projects
      .map((project) => {
        let todos = sortTodos(project.todos, sortKey);
        if (hideDone) todos = todos.filter((t) => !t.done);
        if (kw) todos = todos.filter((t) => matchTodo(t, kw) || !!hits?.has(hitKey(project.name, t.id)));
        return { project, todos, nameMatch: !!k && project.name.toLowerCase().includes(k) };
      })
      .filter((x) => !kw || x.todos.length > 0 || x.nameMatch);
  }, [tree, kw, hits, hideDone, sortKey]);
  const visible = useMemo(
    () => (hidden.size ? listed.filter((x) => !hidden.has(x.project.name)) : listed),
    [listed, hidden],
  );

  const total = countAll(tree);
  const done = countDone(tree);

  // 搜索时忽略折叠状态，把命中项全部展开
  const isOpen = (key: string) => !!kw || !collapsed[key];
  const toggle = useCallback(
    (key: string) => setCollapsed(tree.name, (c) => ({ ...c, [key]: !c[key] })),
    [setCollapsed, tree.name],
  );

  // 拖动中：正在拖的待办、指针下的项目；只把和某个项目有关的传给它，其他项目不必重新渲染
  const drag = p.dragState;
  const dragTodo = drag?.item.kind === "todo" && drag.item.workspace === tree.name ? drag.item : null;

  return (
    <div
      className={["ws-branch", dropClass(drag, tree.name)].filter(Boolean).join(" ")}
      role="treeitem"
      aria-expanded={isOpen(WS_KEY)}
      data-drop-ws={tree.name}
    >
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
              onToggle={toggle}
              selected={sel?.project === project.name && !sel.todoId}
              selTodoId={sel?.project === project.name ? sel.todoId : undefined}
              actions={a}
              moveTargets={p.moveTargets}
              keyword={kw}
              hits={hits}
              now={p.now}
              today={p.today}
              hideDone={hideDone}
              dropCls={dropClass(drag, tree.name, project.name)}
              dragSource={isDraggingProject(drag, tree.name, project.name)}
              draggingTodoId={dragTodo?.project === project.name ? dragTodo.todo.id : undefined}
              reorderAt={reorderMark(drag, tree.name, project.name)?.id}
              reorderPlace={reorderMark(drag, tree.name, project.name)?.place}
              dragStart={p.dragStart}
              onContextMenu={p.onContextMenu}
              picked={p.picked}
              onTodoClick={p.onTodoClick}
              pickedMenu={p.pickedMenu}
            />
          ))}
          {tree.projects.length === 0 && (
            <div className="tree-empty" style={{ paddingLeft: 30 }}>
              还没有项目，
              <a onClick={a.newProject}>新建一个</a>
            </div>
          )}
          {hidden.size > 0 && (
            <div className="tree-empty hidden-projects" style={{ paddingLeft: 30 }}>
              已隐藏 {hidden.size} 个全部完成的项目，
              <a onClick={() => p.onShowDoneProjects(tree.name)}>显示</a>
            </div>
          )}
          {kw && visible.length === 0 && tree.projects.length > 0 && (
            <div className="tree-empty" style={{ paddingLeft: 30 }}>
              {hits ? `没有找到包含“${kw}”的待办` : "正在搜索正文…"}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const ProjectBranch = memo(function ProjectBranch(p: {
  workspace: string;
  project: ProjectNode;
  todos: TodoSummary[];
  open: boolean;
  /** 折叠 / 展开，参数是项目名 */
  onToggle: (key: string) => void;
  /** 右侧显示的是这个项目的概览 */
  selected: boolean;
  /** 右侧打开的是这个项目里的哪条待办 */
  selTodoId?: string;
  actions: Actions;
  moveTargets: (workspace: string) => MoveTarget[];
  keyword: string;
  /** 全文搜索在这个工作区里的结果 */
  hits: ReadonlyMap<string, string> | null;
  now: number;
  today: string;
  hideDone: boolean;
  /** 拖动时指针在这个项目上：能放下 / 放不下的样式 */
  dropCls?: string;
  /** 正在拖的是这个项目 */
  dragSource: boolean;
  /** 正在拖的是这个项目里的哪条待办 */
  draggingTodoId?: string;
  /** 调整顺序时，插入线画在这个项目里哪条待办的前面 / 后面 */
  reorderAt?: string;
  reorderPlace?: "before" | "after";
  dragStart: DragStart;
  onContextMenu: OpenMenu;
  picked: ReadonlySet<string>;
  onTodoClick: TodoClick;
  pickedMenu: () => MenuProps | null;
}) {
  const { project, todos, actions: a } = p;
  const undone = project.todos.filter((t) => !t.done).length;
  const hiddenDone = p.hideDone ? project.todos.length - undone : 0;
  const toggle = () => p.onToggle(project.name);

  return (
    <div
      role="treeitem"
      aria-expanded={p.open}
      data-drop-project={project.name}
      className={[p.dropCls, p.dragSource && "drag-source"].filter(Boolean).join(" ") || undefined}
    >
      <Dropdown menu={projectMenu(a, project.name)} trigger={["contextMenu"]}>
        <div
          className={`tree-row project-row${p.selected ? " selected" : ""}`}
          data-sel={selKey({ workspace: p.workspace, project: project.name })}
          style={{ paddingLeft: 22 }}
          onMouseDown={(e) => p.dragStart(e, { kind: "project", workspace: p.workspace, project: project.name })}
          onClick={() => {
            a.selectProject(project.name);
            if (!p.open) toggle();
          }}
          onDoubleClick={toggle}
        >
          <Chevron open={p.open} onClick={toggle} />
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
        <div
          role="group"
          className="todo-group"
          // 不在可见区域时的占位高度：每行两行文字加上下内边距和间距（14px 字号时约 51px）
          style={{ containIntrinsicBlockSize: `auto calc(${todos.length} * (2 * var(--fs-sidebar) + 23px))` }}
        >
          {todos.map((t) => (
            <TodoRow
              key={t.id}
              picked={p.picked.has(selKey({ workspace: p.workspace, project: project.name, todoId: t.id }))}
              onTodoClick={p.onTodoClick}
              pickedMenu={p.pickedMenu}
              workspace={p.workspace}
              project={project.name}
              todo={t}
              selected={p.selTodoId === t.id}
              actions={a}
              moveTargets={p.moveTargets}
              keyword={p.keyword}
              snippet={p.keyword ? searchSnippet(t, p.keyword, p.hits?.get(hitKey(project.name, t.id))) : null}
              now={p.now}
              today={p.today}
              dragged={p.draggingTodoId === t.id}
              dropMark={p.reorderAt === t.id ? p.reorderPlace : undefined}
              dragStart={p.dragStart}
              onContextMenu={p.onContextMenu}
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
});

interface TodoRowProps {
  /** 多选了这一条（批量操作） */
  picked: boolean;
  onTodoClick: TodoClick;
  pickedMenu: () => MenuProps | null;
  workspace: string;
  project: string;
  todo: TodoSummary;
  selected: boolean;
  actions: Actions;
  moveTargets: (workspace: string) => MoveTarget[];
  keyword: string;
  /** 搜索时显示在标题下面（代替创建、修改时间）的一段正文，标题里已经有关键字时为 null */
  snippet: string | null;
  now: number;
  today: string;
  dragged: boolean;
  /** 调整顺序时插入线画在这一行的前面 / 后面 */
  dropMark?: "before" | "after";
  dragStart: DragStart;
  onContextMenu: OpenMenu;
}

/**
 * 修改时间在侧栏显示成什么（relativeTime 的 compact 格式）只取决于它在哪一档：刚刚、第几分钟前、第几小时前，
 * 再往前是日期，日期只在跨了一天（today 变了）时才变。按这个判断，不必真的格式化
 */
function timeBucket(ms: number, now: number): number {
  const diff = now - ms;
  if (diff < 60_000) return -1;
  if (diff < 3_600_000) return Math.floor(diff / 60_000);
  if (diff < 86_400_000) return 100 + Math.floor(diff / 3_600_000);
  return 1000;
}

/**
 * now 每 30 秒变一次：只有修改时间的显示（「x 分钟前」「x 小时前」）跟着变了的行才重新渲染；
 * 创建时间和更早的修改时间显示成日期，只在跨了一天（today 变了）时变
 */
function sameTodoRow(a: TodoRowProps, b: TodoRowProps): boolean {
  for (const k of Object.keys(b) as (keyof TodoRowProps)[]) {
    if (k === "now" || a[k] === b[k]) continue;
    return false;
  }
  return a.now === b.now || timeBucket(b.todo.updatedAt, a.now) === timeBucket(b.todo.updatedAt, b.now);
}

/**
 * 待办行。行很多，不给每行各挂 antd 的 Tooltip、Dropdown（几千行时挂载、重新渲染都很慢）：
 * 悬停提示和右键菜单由侧栏共用一个（useRowPopups），按行的 data-sel 找到这条待办
 */
const TodoRow = memo(function TodoRow(p: TodoRowProps) {
  const { todo: t, actions: a } = p;
  const { text, fromContent } = displayTitle(t);

  return (
    <div
      role="treeitem"
      aria-selected={p.selected}
      data-sel={selKey({ workspace: p.workspace, project: p.project, todoId: t.id })}
      className={`tree-row todo-row${p.selected ? " selected" : ""}${p.picked ? " picked" : ""}${t.done ? " done" : ""}${p.dragged ? " drag-source" : ""}${p.dropMark ? ` drop-${p.dropMark}` : ""}`}
      style={{ paddingLeft: 44 }}
      onMouseDown={(e) => p.dragStart(e, { kind: "todo", workspace: p.workspace, project: p.project, todo: t })}
      onClick={(e) => p.onTodoClick(e, { workspace: p.workspace, project: p.project, todoId: t.id })}
      onContextMenu={(e) =>
        p.onContextMenu(e, (p.picked && p.pickedMenu()) || todoMenu(a, p.project, t, p.moveTargets(p.workspace)))
      }
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
          {t.pinned && <PushpinFilled className="pin-mark" />}
          <Highlight text={text} kw={p.keyword} />
        </div>
        {p.snippet ? (
          <div className="todo-meta todo-snippet">
            <Highlight text={p.snippet} kw={p.keyword} />
          </div>
        ) : (
          <div className="todo-meta">
            创建 {compactTime(t.createdAt, p.now)}
            <span className="sep">·</span>
            修改 {relativeTime(t.updatedAt, p.now, true)}
          </div>
        )}
      </div>
    </div>
  );
}, sameTodoRow);

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
