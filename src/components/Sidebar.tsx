import type { InputRef } from "antd";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ancestorsOf, parentOf } from "../projects";
import { type ContentHits, NO_HITS } from "../search";
import type { MenuProps } from "antd";
import type { WorkspaceTree } from "../types";
import { useNow } from "../utils";
import type { ListOptions } from "../workspaceState";
import type { DragMove } from "./DragMove";
import { type Actions, moveTargets } from "./menus";
import RecycleBinButton from "./RecycleBin";
import { useRowPopups } from "./sidebar/RowPopups";
import SidebarToolbar from "./sidebar/SidebarToolbar";
import { useLingeringProjects } from "./sidebar/lingering";
import {
  type Collapsed,
  countAll,
  countDone,
  hiddenDoneProjects,
  indentLevelsFor,
  isProjectDone,
  parseSelKey,
  type Selection,
  selKey,
  WS_KEY,
} from "./sidebar/tree";
import { WorkspaceBranch } from "./sidebar/TreeRows";

// 侧栏：顶部工具栏（sidebar/SidebarToolbar）、工作区 / 项目 / 待办的树（sidebar/TreeRows）、
// 树的行共用的悬停提示和右键菜单（sidebar/RowPopups）、底部的统计。这里管树的焦点和键盘操作

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
  /** 分屏时另一边正显示着的待办：它所在的项目同样算右侧正在显示的，隐藏全部完成的项目时照常显示 */
  alsoShown: Selection | null;
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
  /** 全文搜索的结果（正文里有关键字的待办）；还没查完时是 null */
  hits: ContentHits | null;
  /** 各工作区的排序和隐藏已完成（待办、全部完成的项目）；侧栏顶部的按钮改的是右侧正在显示的工作区的 */
  listOptionsOf: (workspace: string) => ListOptions;
  /** 不变的函数 */
  setListOptions: (workspace: string, patch: Partial<ListOptions>) => void;
  /** 拖动待办到别的项目、项目到别的工作区 */
  drag: DragMove;
  /** 这个工作区里多选了的待办（行上的 data-sel），没有时是 undefined */
  pickedOf: (workspace: string) => ReadonlySet<string> | undefined;
  /** 单击待办（Ctrl / Shift+单击是多选）；不变的函数 */
  onTodoClick: (e: React.MouseEvent, s: Selection) => void;
  /** 双击待办（单击已经打开了它）：标签固定下来 */
  onTodoDoubleClick: (s: Selection) => void;
  /** 在多选了的待办上右键时的菜单；不变的函数 */
  pickedMenu: () => MenuProps | null;
}

/** 没有多选的、没有刚切走的项目的工作区都用这一个，行不必重新渲染 */
const NONE: ReadonlySet<string> = new Set();

export default function Sidebar(props: Props) {
  const { trees, sel, actionsFor, collapsedOf, setCollapsed, keyword, listOptionsOf, handleRef, searchRef } = props;
  const now = useNow();
  // 跨了一天时所有行的时间显示（今天 / 昨天 / 日期）都要重新算
  const today = new Date(now).toDateString();
  const kw = keyword.trim();
  const multi = trees.length > 1;
  const popups = useRowPopups(trees);

  // 右键「移动到」列出的项目：右键时才按侧栏里现在显示的工作区算。传给行的是不变的函数，
  // 别的待办、项目变了时行不必跟着重新渲染
  const treesRef = useRef(trees);
  useEffect(() => {
    treesRef.current = trees;
  });
  const moveTargetsOf = useCallback((ws: string) => moveTargets(treesRef.current, ws), []);
  // 「已隐藏 N 个全部完成的项目」后面的「显示」：这个工作区不再隐藏它们
  const { setListOptions } = props;
  const showDoneProjects = useCallback(
    (ws: string) => setListOptions(ws, { hideDoneProjects: false }),
    [setListOptions],
  );

  // 「隐藏全部完成的项目」开着时，右侧显示的内容离开一个全部完成的项目后，它再显示一会儿才藏起来（sidebar/lingering.ts）；
  // 搜索时本来就不藏，不必留。离开的是子项目时，它全部完成了，它或者它的哪一级父项目（也全部完成了时）会被藏起来
  const lingered = useLingeringProjects(sel, (ws, project) => {
    if (kw || !listOptionsOf(ws).hideDoneProjects) return false;
    const projects = trees.find((t) => t.name === ws)?.projects ?? [];
    return isProjectDone(projects, project);
  });
  // 分屏时另一边正显示着的项目也照常显示：和刚切走的一起算（没有时沿用原来的，侧栏的行不必重新渲染）
  const alsoWs = props.alsoShown?.workspace;
  const alsoProject = props.alsoShown?.project;
  const lingering = useMemo(() => {
    if (!alsoWs || !alsoProject || lingered.get(alsoWs)?.has(alsoProject)) return lingered;
    return new Map(lingered).set(alsoWs, new Set([...(lingered.get(alsoWs) ?? []), alsoProject]));
  }, [lingered, alsoWs, alsoProject]);

  // 各工作区藏起来的项目，参数和下面传给 WorkspaceBranch 的一样：顶部的「全部折叠 / 全部展开」不看它们。
  // 那里只对有展开着的项目的工作区才调用，没开这一项、在搜索时直接返回
  const hiddenOf = (t: WorkspaceTree) =>
    hiddenDoneProjects(t.projects, {
      hide: listOptionsOf(t.name).hideDoneProjects,
      keyword: kw,
      selProject: sel.workspace === t.name ? sel.project : undefined,
      lingering: lingering.get(t.name),
    });

  // 子项目最多缩进到第几级：侧栏窄时少缩进几级，名字不会被挤没；侧栏宽度变了、跨过某一级时行才重新渲染
  const indentLevels = indentLevelsFor(props.width);

  const total = trees.reduce((n, t) => n + countAll(t), 0);
  const done = trees.reduce((n, t) => n + countDone(t), 0);

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
    // 选中项被折叠或筛选掉了：从它所在的项目、往上最近的看得见的父项目、工作区开始
    if (sel.project)
      for (const project of [sel.project, ...ancestorsOf(sel.project).reverse()]) {
        if (at >= 0) break;
        at = keys.indexOf(selKey({ workspace: sel.workspace, project }));
      }
    if (at < 0) at = keys.indexOf(selKey({ workspace: sel.workspace }));
    const next = at < 0 ? 0 : at + step;
    if (next >= 0 && next < keys.length && next !== at) props.onSelect(parseSelKey(keys[next]));
  };

  useImperativeHandle(handleRef, () => ({ focus: focusTree, move }));

  // 列表获得焦点时：↑↓ 移动，← → 折叠 / 展开（或回到上一级：待办 → 所在的项目，子项目 → 上一级的父项目，项目 → 工作区），
  // Enter 打开待办或折叠 / 展开
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
      else if (sel.project) props.onSelect({ workspace: ws, project: parentOf(sel.project) });
    } else if (e.key === "Enter" && !kw) setOpen(!open);
  };

  // 在搜索框里按了 Esc（关键字已清空）：焦点回到左侧列表；列表恢复原样后把选中项滚到可见区域
  const onSearchEscape = () => {
    focusTree();
    requestAnimationFrame(() =>
      rows()
        .find((r) => r.dataset.sel === current)
        ?.scrollIntoView({ block: "nearest" }),
    );
  };

  return (
    <aside className="sidebar" style={{ width: props.width }}>
      <SidebarToolbar
        trees={trees}
        sel={sel}
        workspaces={props.workspaces}
        onWorkspacesChange={props.onWorkspacesChange}
        onHome={props.onHome}
        actions={actionsFor(sel.workspace)}
        searchRef={searchRef}
        keyword={keyword}
        setKeyword={props.setKeyword}
        onSearchEscape={onSearchEscape}
        listOptions={listOptionsOf(sel.workspace)}
        setListOptions={props.setListOptions}
        collapsedOf={collapsedOf}
        setCollapsed={setCollapsed}
        hiddenOf={hiddenOf}
      />

      <div
        ref={treeRef}
        className={`tree${kbFocus ? " kb-focus" : ""}`}
        role="tree"
        tabIndex={0}
        onKeyDown={onTreeKey}
        onMouseDown={() => setKbFocus(false)}
        // 待办行上的双击（勾选框上的、Ctrl / Shift 多选的不算）；工作区、项目行上的双击是折叠 / 展开，由行自己处理
        onDoubleClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) return;
          const target = e.target as Element;
          const row = target.closest<HTMLElement>(".todo-row[data-sel]");
          if (row && !target.closest(".check")) props.onTodoDoubleClick(parseSelKey(row.dataset.sel!));
        }}
        onBlur={() => setKbFocus(false)}
        onMouseOver={popups.onMouseOver}
        onMouseLeave={popups.hideTip}
        onScroll={popups.hideTip}
      >
        {trees.map((tree) => (
          <WorkspaceBranch
            key={tree.name}
            tree={tree}
            sel={sel.workspace === tree.name ? sel : undefined}
            actions={actionsFor(tree.name)}
            collapsed={collapsedOf(tree.name)}
            setCollapsed={setCollapsed}
            keyword={kw}
            hits={props.hits && (props.hits.get(tree.name) ?? NO_HITS)}
            {...listOptionsOf(tree.name)}
            lingering={lingering.get(tree.name) ?? NONE}
            now={now}
            today={today}
            dragState={props.drag.state}
            dragStart={props.drag.start}
            picked={props.pickedOf(tree.name) ?? NONE}
            onTodoClick={props.onTodoClick}
            pickedMenu={props.pickedMenu}
            onContextMenu={popups.openMenu}
            moveTargets={moveTargetsOf}
            onShowDoneProjects={showDoneProjects}
            indentLevels={indentLevels}
          />
        ))}
      </div>
      {popups.node}

      <div className="sidebar-foot">
        <span className="sidebar-stats">
          {multi && `${trees.length} 个工作区，`}共 {total} 条待办，已完成 {done} 条
        </span>
        <RecycleBinButton variant="link" />
      </div>
    </aside>
  );
}
