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
import { memo, useCallback, useMemo, useState } from "react";
import { filterByTag, isFiltering, matchFilter, type TodoFilter } from "../../filter";
import { deepTodos, inProject, isSubProject, leafName, projectLabel, subProjectsOf } from "../../projects";
import { hitKey, matchTodo, searchSnippet, textKeyword } from "../../search";
import type { ProjectNode, SortKey, TodoSummary, WorkspaceTree } from "../../types";
import { avatarColor, compactTime, displayTitle, firstChar, relativeTime, sortTodos } from "../../utils";
import {
  type DragItem,
  type DragState,
  dragConcerns,
  dropClass,
  isDraggingProject,
  projectMark,
  reorderMark,
} from "../DragMove";
import Highlight from "../Highlight";
import { type MoveTarget, projectMenu, todoMenu, workspaceMenu, type Actions } from "../menus";
import { PriorityFlag, TagChips } from "../TodoMarks";
import {
  type Collapsed,
  countAll,
  countDone,
  hiddenByFilter,
  hiddenDoneProjects,
  isHidden,
  type Selection,
  selKey,
  unionHidden,
  WS_KEY,
} from "./tree";

/** 子项目比父项目多缩进这么多（px） */
const SUB_INDENT = 16;

/** 待办行的标题后面最多显示几个标签，多的显示成「+N」 */
const ROW_TAGS = 2;

/** 侧栏里列出的一个项目：排好序、筛过的待办；顶层项目带着列出的子项目 */
interface Listed {
  project: ProjectNode;
  todos: TodoSummary[];
  /** 搜索时项目自己的名字里有关键字 */
  nameMatch: boolean;
  subs: readonly Listed[];
  /** 行上的未完成数和总数：父项目包括子项目里的，不管筛没筛 */
  undone: number;
  total: number;
}

const NO_SUBS: readonly Listed[] = [];

/** 右侧显示的内容在 project（或它的子项目）里时是 sel，否则 undefined：传给项目的行，别的项目不必重新渲染 */
const selIn = (sel: Selection | undefined, project: string) =>
  sel?.project !== undefined && inProject(sel.project, project) ? sel : undefined;

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
  /** 这个工作区里刚切走、还要再显示一会儿的项目（会被藏起来、筛掉的，见 lingering.ts） */
  lingering: ReadonlySet<string>;
  /** 按标签、优先级筛选（侧栏显示的各工作区共用一个，见 filter.ts） */
  filter: TodoFilter;
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
  const { tree, sel, actions: a, collapsed, keyword: kw, hits, hideDone, hideDoneProjects, lingering, filter, sortKey, setCollapsed } =
    p;
  const filtering = isFiltering(filter);

  // 隐藏全部完成的项目时藏起来的项目（藏起来的父项目连同子项目，和单独藏起来的子项目），筛选时筛掉的项目（同样），
  // 合起来是看不见的
  const selProject = sel?.project;
  const hiddenDone = useMemo(
    () => hiddenDoneProjects(tree.projects, { hide: hideDoneProjects, keyword: kw, selProject, lingering }),
    [tree.projects, hideDoneProjects, kw, selProject, lingering],
  );
  const hiddenFiltered = useMemo(
    () => hiddenByFilter(tree.projects, { filter, hideDone, selProject, lingering }),
    [tree.projects, filter, hideDone, selProject, lingering],
  );
  const hidden = useMemo(() => unionHidden(hiddenDone, hiddenFiltered), [hiddenDone, hiddenFiltered]);
  // 「已隐藏 N 个全部完成的项目」不算被筛掉的：点「显示」也显示不出来
  const doneHiddenCount = [...hiddenDone].filter((name) => !isHidden(hiddenFiltered, name)).length;

  // 各项目里列出的待办，排好序；搜索时：标题、正文开头（前端匹配）或正文全文（hits）里有关键字的待办，和名字里有关键字的项目，
  // 子项目列出来时它的父项目也列出来；筛选时只有符合的待办（筛掉哪些项目在 hiddenFiltered 里算）。
  // 这里不管哪些项目藏起来：藏起哪些跟着右侧显示的、刚切走的项目变，变了时不必把全部待办重新排序，各项目拿到的
  // 还是原来的对象，项目不必重新渲染
  const listed = useMemo(() => {
    // 只按标签找（#标签名）时项目名不算命中
    const k = textKeyword(kw).toLowerCase();
    const kept = (x: Listed) => !kw || x.todos.length > 0 || x.nameMatch || x.subs.length > 0;
    const one = (project: ProjectNode, subs: readonly Listed[], all: readonly TodoSummary[]): Listed => {
      let todos = sortTodos(project.todos, sortKey);
      if (hideDone) todos = todos.filter((t) => !t.done);
      if (kw) todos = todos.filter((t) => matchTodo(t, kw) || !!hits?.has(hitKey(project.name, t.id)));
      if (filtering) todos = todos.filter((t) => matchFilter(t, filter));
      const nameMatch = !!k && leafName(project.name).toLowerCase().includes(k);
      return { project, todos, nameMatch, subs, undone: all.filter((t) => !t.done).length, total: all.length };
    };
    return tree.projects
      .filter((p) => !isSubProject(p.name))
      .map((top) => {
        const subs = subProjectsOf(tree.projects, top.name)
          .map((sub) => one(sub, NO_SUBS, sub.todos))
          .filter(kept);
        return one(top, subs.length ? subs : NO_SUBS, deepTodos(tree.projects, top.name));
      })
      .filter(kept);
  }, [tree, kw, hits, hideDone, sortKey, filtering, filter]);
  const visible = useMemo(() => {
    if (!hidden.size) return listed;
    return listed
      .filter((x) => !hidden.has(x.project.name))
      .map((x) => {
        if (!x.subs.some((s) => hidden.has(s.project.name))) return x;
        const subs = x.subs.filter((s) => !hidden.has(s.project.name));
        return { ...x, subs: subs.length ? subs : NO_SUBS };
      });
  }, [listed, hidden]);

  const total = countAll(tree);
  const done = countDone(tree);

  // 搜索时忽略折叠状态，把命中项全部展开
  const isOpen = (key: string) => !!kw || !collapsed[key];
  const toggle = useCallback(
    (key: string) => setCollapsed(tree.name, (c) => ({ ...c, [key]: !c[key] })),
    [setCollapsed, tree.name],
  );

  // 拖动中：只把和某个项目（或它的子项目）有关的传给它，其他项目不必重新渲染
  const drag = p.dragState;

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
            <RowMore menu={() => workspaceMenu(a)} />
          </span>
        </div>
      </Dropdown>

      {isOpen(WS_KEY) && (
        <div role="group">
          {visible.map((item) => (
            <ProjectBranch
              key={item.project.name}
              workspace={tree.name}
              item={item}
              depth={0}
              collapsed={collapsed}
              searching={!!kw}
              onToggle={toggle}
              sel={selIn(sel, item.project.name)}
              actions={a}
              moveTargets={p.moveTargets}
              keyword={kw}
              hits={hits}
              now={p.now}
              today={p.today}
              hideDone={hideDone}
              filtering={filtering}
              drag={dragConcerns(drag, tree.name, item.project.name) ? drag : null}
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
          {doneHiddenCount > 0 && (
            <div className="tree-empty hidden-projects" style={{ paddingLeft: 30 }}>
              已隐藏 {doneHiddenCount} 个全部完成的项目，
              <a onClick={() => p.onShowDoneProjects(tree.name)}>显示</a>
            </div>
          )}
          {filtering && !kw && visible.length === 0 && tree.projects.length > 0 && (
            <div className="tree-empty filtered-out" style={{ paddingLeft: 30 }}>
              没有符合筛选的待办
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

/**
 * 一个项目：项目行，展开时下面是子项目（顶层项目才有，排在前面，同资源管理器里文件夹排在文件前面）和项目自己的待办。
 * 子项目也用它显示（depth 1）
 */
const ProjectBranch = memo(function ProjectBranch(p: {
  workspace: string;
  item: Listed;
  /** 缩进几级：顶层项目 0，子项目 1 */
  depth: number;
  /** 这个工作区的折叠状态（项目和子项目都按路径记）；搜索时忽略，全部展开 */
  collapsed: Collapsed;
  searching: boolean;
  /** 折叠 / 展开，参数是项目路径 */
  onToggle: (key: string) => void;
  /** 右侧显示的内容在这个项目（或它的子项目）里时才传 */
  sel?: Selection;
  actions: Actions;
  moveTargets: (workspace: string) => MoveTarget[];
  keyword: string;
  /** 全文搜索在这个工作区里的结果 */
  hits: ReadonlyMap<string, string> | null;
  now: number;
  today: string;
  hideDone: boolean;
  /** 开着筛选：列出的待办是筛过的 */
  filtering: boolean;
  /** 拖动和这个项目（或它的子项目）有关时才传：拖的是它（或其中的待办），或者指针在它上面 */
  drag: DragState | null;
  dragStart: DragStart;
  onContextMenu: OpenMenu;
  picked: ReadonlySet<string>;
  onTodoClick: TodoClick;
  pickedMenu: () => MenuProps | null;
}) {
  const { item, actions: a, drag } = p;
  const { project, todos } = item;
  const name = project.name;
  const open = p.searching || !p.collapsed[name];
  const selected = p.sel?.project === name && !p.sel.todoId;
  const selTodoId = p.sel?.project === name ? p.sel.todoId : undefined;
  const hiddenDone = p.hideDone ? project.todos.filter((t) => t.done).length : 0;
  const draggingTodoId =
    drag?.item.kind === "todo" && drag.item.workspace === p.workspace && drag.item.project === name
      ? drag.item.todo.id
      : undefined;
  const mark = reorderMark(drag, p.workspace, name);
  // 拖项目放在它旁边：插入线画在整块（连同子项目、待办）的上面 / 下面
  const line = projectMark(drag, p.workspace, name);
  const toggle = () => p.onToggle(name);
  const indent = p.depth * SUB_INDENT;
  const hasSubs = item.subs.length > 0;
  // 右键、「…」的菜单打开时才算：「移动到」要列出侧栏里各工作区的项目
  const projectMenuOf = () => projectMenu(a, name, p.moveTargets(p.workspace));

  return (
    <div
      role="treeitem"
      aria-expanded={open}
      data-drop-project={name}
      className={[
        "project-branch",
        dropClass(drag, p.workspace, name),
        isDraggingProject(drag, p.workspace, name) && "drag-source",
        line && `drop-${line.place}`,
        line?.refused && "drop-line-refused",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <LazyDropdown menu={projectMenuOf} trigger={["contextMenu"]}>
        <div
          className={`tree-row project-row${selected ? " selected" : ""}`}
          data-sel={selKey({ workspace: p.workspace, project: name })}
          style={{ paddingLeft: 22 + indent }}
          onMouseDown={(e) => p.dragStart(e, { kind: "project", workspace: p.workspace, project: name })}
          onClick={() => {
            a.selectProject(name);
            if (!open) toggle();
          }}
          onDoubleClick={toggle}
        >
          <Chevron open={open} onClick={toggle} />
          <span className="project-icon">{open ? <FolderOpenFilled /> : <FolderFilled />}</span>
          <span className="row-label" title={projectLabel(name)}>
            <Highlight text={leafName(name)} kw={textKeyword(p.keyword)} />
          </span>
          <span
            className="row-count"
            title={`未完成 ${item.undone} / 共 ${item.total}${isSubProject(name) ? "" : "（含子项目）"}`}
          >
            {item.undone || ""}
          </span>
          <span className="row-actions">
            <RowButton title="新建待办" icon={<PlusOutlined />} onClick={() => a.newTodo(name, "", true)} />
            <RowMore menu={projectMenuOf} />
          </span>
        </div>
      </LazyDropdown>

      {open && hasSubs && (
        <div role="group">
          {item.subs.map((sub) => (
            <ProjectBranch
              key={sub.project.name}
              {...p}
              item={sub}
              depth={p.depth + 1}
              sel={selIn(p.sel, sub.project.name)}
              drag={dragConcerns(drag, p.workspace, sub.project.name) ? drag : null}
            />
          ))}
        </div>
      )}

      {open && (
        <div
          role="group"
          className="todo-group"
          // 不在可见区域时的占位高度：每行两行文字加上下内边距和间距（14px 字号时约 51px）
          style={{ containIntrinsicBlockSize: `auto calc(${todos.length} * (2 * var(--fs-sidebar) + 23px))` }}
        >
          {todos.map((t) => (
            <TodoRow
              key={t.id}
              picked={p.picked.has(selKey({ workspace: p.workspace, project: name, todoId: t.id }))}
              onTodoClick={p.onTodoClick}
              pickedMenu={p.pickedMenu}
              workspace={p.workspace}
              project={name}
              indent={indent}
              todo={t}
              selected={selTodoId === t.id}
              actions={a}
              moveTargets={p.moveTargets}
              keyword={p.keyword}
              snippet={p.keyword ? searchSnippet(t, p.keyword, p.hits?.get(hitKey(name, t.id))) : null}
              now={p.now}
              today={p.today}
              dragged={draggingTodoId === t.id}
              dropMark={mark?.id === t.id ? mark.place : undefined}
              dragStart={p.dragStart}
              onContextMenu={p.onContextMenu}
            />
          ))}
          {todos.length === 0 && !p.keyword && !hasSubs && (
            <div className="tree-empty" style={{ paddingLeft: 48 + indent }}>
              {p.filtering ? (
                "没有符合筛选的待办"
              ) : hiddenDone > 0 ? (
                `已隐藏 ${hiddenDone} 条已完成的待办`
              ) : (
                <>
                  暂无待办，<a onClick={() => a.newTodo(name, "", true)}>新建一条</a>
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
  /** 在子项目里时多缩进的（px） */
  indent: number;
  todo: TodoSummary;
  selected: boolean;
  actions: Actions;
  moveTargets: (workspace: string) => MoveTarget[];
  /** 搜索的关键字：标题、正文片段里的高亮，命中的标签描边 */
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
  const kw = textKeyword(p.keyword);

  return (
    <div
      role="treeitem"
      aria-selected={p.selected}
      data-sel={selKey({ workspace: p.workspace, project: p.project, todoId: t.id })}
      className={`tree-row todo-row${p.selected ? " selected" : ""}${p.picked ? " picked" : ""}${t.done ? " done" : ""}${p.dragged ? " drag-source" : ""}${p.dropMark ? ` drop-${p.dropMark}` : ""}`}
      style={{ paddingLeft: 44 + p.indent }}
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
          <PriorityFlag priority={t.priority} />
          <span className="todo-title-text">
            <Highlight text={text} kw={kw} />
          </span>
          <TagChips tags={t.tags} max={ROW_TAGS} keyword={p.keyword} onTagClick={filterByTag} />
        </div>
        {p.snippet ? (
          <div className="todo-meta todo-snippet">
            <Highlight text={p.snippet} kw={kw} />
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

const NO_MENU: MenuProps = { items: [] };

/** 下拉菜单打开时才算菜单（menu 每次打开时调用），行很多时不必每次渲染都算 */
function LazyDropdown({
  menu,
  trigger,
  placement,
  children,
}: {
  menu: () => MenuProps;
  trigger: ("click" | "contextMenu")[];
  placement?: "bottomRight";
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dropdown open={open} onOpenChange={setOpen} menu={open ? menu() : NO_MENU} trigger={trigger} placement={placement}>
      {children}
    </Dropdown>
  );
}

function RowMore({ menu }: { menu: () => MenuProps }) {
  return (
    <LazyDropdown menu={menu} trigger={["click"]} placement="bottomRight">
      <span
        className="row-btn"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <MoreOutlined />
      </span>
    </LazyDropdown>
  );
}
