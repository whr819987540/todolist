import type { InputRef } from "antd";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
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
import { type Collapsed, countAll, countDone, parseSelKey, type Selection, selKey, WS_KEY } from "./sidebar/tree";
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
  /** 各工作区的排序和隐藏已完成；侧栏顶部的按钮改的是右侧正在显示的工作区的 */
  listOptionsOf: (workspace: string) => ListOptions;
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

/** 没有多选的工作区都用这一个，行不必重新渲染 */
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
    // 选中项被折叠或筛选掉了：从它所在的项目 / 工作区开始
    if (at < 0 && sel.project) at = keys.indexOf(selKey({ workspace: sel.workspace, project: sel.project }));
    if (at < 0) at = keys.indexOf(selKey({ workspace: sel.workspace }));
    const next = at < 0 ? 0 : at + step;
    if (next >= 0 && next < keys.length && next !== at) props.onSelect(parseSelKey(keys[next]));
  };

  useImperativeHandle(handleRef, () => ({ focus: focusTree, move }));

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
            now={now}
            today={today}
            dragState={props.drag.state}
            dragStart={props.drag.start}
            picked={props.pickedOf(tree.name) ?? NONE}
            onTodoClick={props.onTodoClick}
            pickedMenu={props.pickedMenu}
            onContextMenu={popups.openMenu}
            moveTargets={moveTargetsOf}
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
