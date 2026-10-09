import { App as AntApp, Spin, type InputRef } from "antd";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, errMsg } from "../api";
import { useAppEvent, useWindowFocus } from "../hooks";
import { rangePick, togglePick } from "../picking";
import { useContentSearch } from "../search";
import { type How, visit } from "../navHistory";
import { useSettings } from "../settings";
import { eventShortcut, isRefreshShortcut, sameShortcut } from "../shortcuts";
import { activeAfterClose, neighborTab, sameTodo, stepTab, tabIndex, type TodoRef } from "../tabs";
import type { TodoSummary, WorkspaceTree } from "../types";
import { compareName, useLocalState } from "../utils";
import {
  closeTodoTabs,
  collapsedKey,
  keepTodoTab,
  type ListOptions,
  listOptionsKey,
  moveTodoTab,
  pruneTodoTabs,
  readJson,
  readListOptions,
  readOpenTodos,
  readOpenWorkspaces,
  showTodoTab,
  stateGeneration,
  subscribeOpenTodos,
  writeJson,
  writeLastTodo,
  writeLastView,
  writeOpenWorkspaces,
} from "../workspaceState";
import BatchPanel from "./BatchPanel";
import { type DragItem, type TodoAt, useDragMove } from "./DragMove";
import EditorTabs, { type ShownTab } from "./EditorTabs";
import { useNameDialog } from "./NameDialog";
import { ProjectOverview, WorkspaceOverview } from "./Overview";
import Sidebar, { type SidebarHandle } from "./Sidebar";
import { parseSelKey, type Selection, selKey, WS_KEY } from "./sidebar/tree";
import TodoEditor, { type EditorHandle } from "./TodoEditor";
import { batchMenu, moveTargets, todoMenu } from "./menus";
import { sortNames, useWorkspaceActions } from "./workspaceActions";

/** 供 App 的后退、前进（鼠标侧键）调用 */
export interface WorkspaceViewHandle {
  /** 右侧改显示工作区里的一处；它所在的工作区没选中时选中，展开它所在的分支 */
  show(sel: Selection): void;
  /** 同 show，但先从磁盘重新加载（要打开的是刚在别处（快速记录）新建的待办） */
  open(sel: Selection): Promise<void>;
}

interface Props {
  /** 从首页进入的工作区；进来后可以在侧栏顶部再选中其他工作区一起显示 */
  initialWorkspace: string;
  initialSel: Omit<Selection, "workspace">;
  onHome: () => void;
  handleRef: React.RefObject<WorkspaceViewHandle | null>;
}

const MIN_SIDEBAR = 240;
const MAX_SIDEBAR = 560;

/** 左侧列表（侧栏）/ 右侧 */
type Side = "sidebar" | "main";
/** 元素在哪一侧；都不在（body、页面最外层的弹出菜单和选择框）时是 null */
function sideOf(el: EventTarget | null): Side | null {
  if (!(el instanceof Element)) return null;
  return el.closest(".sidebar") ? "sidebar" : el.closest(".main") ? "main" : null;
}

function sortTree(t: WorkspaceTree): WorkspaceTree {
  return { ...t, projects: [...t.projects].sort((a, b) => compareName(a.name, b.name)) };
}

const sameFields = <T extends object>(a: T, b: T) => {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

/** 新的列表和原来的逐项相同（reuse 过的会是同一个对象）时沿用原来的列表 */
const sameItems = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 沿用原来的对象：before 里有同名（同 id）且内容一样的就用它 */
function reuse<T>(before: T[], after: T[], key: (x: T) => string, same: (old: T, fresh: T) => T): T[] {
  const old = new Map(before.map((x) => [key(x), x]));
  const out = after.map((x) => {
    const o = old.get(key(x));
    return o === undefined ? x : same(o, x);
  });
  return sameItems(out, before) ? before : out;
}

/**
 * 刷新（窗口获得焦点、F5 等）后，内容没变的工作区、项目、待办沿用原来的对象：
 * 什么都没变时整个视图不重新渲染，变了的只有那一部分重新渲染（侧栏的行按对象是否相同决定要不要重新渲染）
 */
function reuseTrees(before: WorkspaceTree[] | null, after: WorkspaceTree[]): WorkspaceTree[] {
  if (!before) return after;
  return reuse(before, after, (t) => t.name, (oldTree, tree) => {
    const projects = reuse(oldTree.projects, tree.projects, (p) => p.name, (oldProject, project) => {
      const todos = reuse(oldProject.todos, project.todos, (x) => x.id, (o, x) => (sameFields(o, x) ? o : x));
      return todos === oldProject.todos ? oldProject : { ...project, todos };
    });
    return projects === oldTree.projects ? oldTree : { ...tree, projects };
  });
}

type Collapsed = Record<string, boolean>;

const readCollapsed = (ws: string) => readJson<Collapsed>(collapsedKey(ws), {});

/**
 * 按工作区分别存在 localStorage 里的界面状态（折叠状态存在 collapsed:{工作区}，排序和隐藏已完成存在
 * listOptions:{工作区}），用到哪个工作区才读；key、read 要是固定的函数
 */
function usePerWorkspace<T>(key: (ws: string) => string, read: (ws: string) => T) {
  const [map, setMap] = useState<Record<string, T>>({});
  useEffect(() => {
    for (const [ws, v] of Object.entries(map)) writeJson(key(ws), v);
  }, [map, key]);

  // 还没改过的工作区读 localStorage，读一次就记下，每次渲染拿到的是同一个对象（侧栏的行据此判断要不要重新渲染）
  const reads = useRef(new Map<string, T>());
  const readOnce = useCallback(
    (ws: string) => {
      if (!reads.current.has(ws)) reads.current.set(ws, read(ws));
      return reads.current.get(ws) as T;
    },
    [read],
  );
  const get = (ws: string) => map[ws] ?? readOnce(ws);
  const set = useCallback(
    (ws: string, fn: (prev: T) => T) => setMap((m) => ({ ...m, [ws]: fn(m[ws] ?? readOnce(ws)) })),
    [readOnce],
  );
  /** 工作区改名、删除后，内存里的跟着改（localStorage 里的由 workspaceState 改） */
  const rename = useCallback((from: string, to: string) => {
    reads.current.delete(from);
    reads.current.delete(to);
    setMap(({ [from]: v, ...rest }) => (v === undefined ? rest : { ...rest, [to]: v }));
  }, []);
  const forget = useCallback((ws: string) => {
    reads.current.delete(ws);
    setMap(({ [ws]: _, ...rest }) => rest);
  }, []);
  return { get, set, rename, forget };
}

export default function WorkspaceView({ initialWorkspace, initialSel, onHome, handleRef }: Props) {
  const { message } = AntApp.useApp();
  // 侧栏里选中显示的工作区，按名称排序；进入时恢复上次选中的，再加上这次进入的
  const [workspaces, setWorkspaces] = useState(() => sortNames([initialWorkspace, ...readOpenWorkspaces()]));
  const restoredList = useRef(workspaces);
  // 第一次加载前核对恢复的工作区还在不在（可能已在首页或外部删除、改名）
  const existing = useRef<Promise<Set<string> | null> | null>(null);
  const [loaded, setLoaded] = useState<WorkspaceTree[] | null>(null);
  const [sel, setSelState] = useState<Selection>({ workspace: initialWorkspace, ...initialSel });
  // 右侧这次改显示的内容是怎么来的，记后退、前进时用
  const selHow = useRef<How>("push");
  // 批量操作：在左侧列表里多选的待办（行上的 data-sel），按选中的先后；Shift+单击从 pickAnchor 选到点的那条
  const [picked, setPicked] = useState<string[]>([]);
  const pickAnchor = useRef<string | null>(null);
  const clearPicked = useCallback(() => setPicked((p) => (p.length ? [] : p)), []);
  // 右侧改显示别的内容（单击、键盘、后退前进等）时取消多选
  const setSel = useCallback(
    (s: Selection, how: How = "push") => {
      selHow.current = how;
      setSelState(s);
      clearPicked();
    },
    [clearPicked],
  );
  const [focusTitleId, setFocusTitleId] = useState<string | null>(null);
  // 点标签切到的待办（selKey）：正文加载出来后焦点放进正文，接着上次的光标编辑
  const [focusBodyKey, setFocusBodyKey] = useState<string | null>(null);
  // 右侧标签页里打开着的待办（全部工作区的，按顺序）
  const openTodos = useSyncExternalStore(subscribeOpenTodos, readOpenTodos);
  // 正显示着的待办有没存好的修改（切走时总会存盘，别的标签不会有）
  const [activeDirty, setActiveDirty] = useState(false);
  // 用键盘在左侧列表里移到的选中项：这时焦点留在列表，右侧不自动聚焦输入框
  const [kbSel, setKbSel] = useState<Selection | null>(null);
  const [keyword, setKeyword] = useState("");
  const collapsed = usePerWorkspace(collapsedKey, readCollapsed);
  const setCollapsed = collapsed.set;
  const listOptions = usePerWorkspace(listOptionsKey, readListOptions);
  // 不变的函数：侧栏的行（「已隐藏 N 个全部完成的项目，显示」）也用
  const setListOptionsOf = listOptions.set;
  const setListOptions = useCallback(
    (ws: string, patch: Partial<ListOptions>) => setListOptionsOf(ws, (o) => ({ ...o, ...patch })),
    [setListOptionsOf],
  );
  const [storedWidth, setWidth] = useLocalState("sidebarWidth", 300);
  const width = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, storedWidth));
  const [dialog, openDialog] = useNameDialog();
  const { info: settingsInfo } = useSettings();
  const editorRef = useRef<EditorHandle | null>(null);
  const searchRef = useRef<InputRef>(null);
  const sidebarRef = useRef<SidebarHandle | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  const onHomeRef = useRef(onHome);
  useEffect(() => {
    onHomeRef.current = onHome;
  });

  const workspacesRef = useRef(workspaces);
  useEffect(() => {
    workspacesRef.current = workspaces;
  });

  useEffect(() => {
    writeOpenWorkspaces(workspaces);
  }, [workspaces]);

  // 记下右侧显示的内容：后退、前进时用；设置里选了开屏「回到上次的位置」时，下次打开软件回到这里
  useEffect(() => {
    visit(sel, selHow.current);
    selHow.current = "push";
    writeLastView(sel);
  }, [sel]);

  const reload = useCallback(async () => {
    if (workspaces === restoredList.current && workspaces.length > 1) {
      existing.current ??= api.listWorkspaces().then(
        (l) => new Set(l.map((w) => w.name)),
        () => null,
      );
      const names = await existing.current;
      // 已经不在的悄悄去掉，不必逐个报「工作区不存在」
      const kept = names ? workspaces.filter((ws) => ws === initialWorkspace || names.has(ws)) : workspaces;
      if (kept.length < workspaces.length) {
        setWorkspaces(kept);
        return;
      }
    }
    const generation = stateGeneration();
    const results = await Promise.all(
      workspaces.map((ws) =>
        api.loadWorkspace(ws).then(sortTree, (e) => {
          // 工作区在外部被删除/改名
          message.error(errMsg(e));
          return null;
        }),
      ),
    );
    // 加载期间选中的工作区又变了：以按新列表的加载为准
    if (workspacesRef.current !== workspaces) return;
    const trees = results.filter((t) => t !== null);
    // 已经不在了（在外部被删除等）的待办关掉标签；加载期间改过名、移动过、开过标签的，读到的可能是之前的样子，等下次
    if (stateGeneration() === generation)
      for (const t of trees)
        pruneTodoTabs(t.name, (project, id) => !!t.projects.find((p) => p.name === project)?.todos.some((x) => x.id === id));
    if (trees.length === 0) {
      onHomeRef.current();
      return;
    }
    if (trees.length < workspaces.length) setWorkspaces(trees.map((t) => t.name));
    setLoaded((before) => reuseTrees(before, trees));
  }, [workspaces, initialWorkspace, message]);

  useEffect(() => {
    reload();
  }, [reload]);

  // 从外部编辑器切回来时刷新（文件可能被改过、增删过）
  useWindowFocus((focused) => {
    if (focused) reload();
  });
  // 用快速记录记了一条
  useAppEvent("data-changed", () => reload());
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });

  // 刚取消选中的工作区不等重新加载完就从侧栏去掉
  const trees = loaded?.filter((t) => workspaces.includes(t.name)) ?? null;
  // 侧栏搜索时在选中工作区的正文全文里查；数据刷新、保存后（loaded 变了）重新查
  const hits = useContentSearch(workspaces, keyword, loaded);
  const treeOf = (ws: string) => trees?.find((t) => t.name === ws);

  // 选中的工作区/项目/待办在刷新后不存在了（被外部删除、取消选中等），退回上一级。
  // 刻意放在 effect 里：退回上一级要经 setSel 记成后退、前进里的「替换」（selHow），并且只在加载完的数据变了之后做
  useEffect(() => {
    if (!loaded) return;
    const t = loaded.find((x) => x.name === sel.workspace);
    if (!t) {
      // 还在列表里说明正在加载（例如刚改名），等加载完
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!workspaces.includes(sel.workspace)) setSel({ workspace: workspaces[0] }, "replace");
      return;
    }
    if (!sel.project) return;
    const p = t.projects.find((x) => x.name === sel.project);
    if (!p) setSel({ workspace: sel.workspace }, "replace");
    else if (sel.todoId && !p.todos.some((x) => x.id === sel.todoId))
      setSel({ workspace: sel.workspace, project: sel.project }, "replace");
  }, [loaded, sel, workspaces, setSel]);

  const selTree = treeOf(sel.workspace);
  const selProject = selTree?.projects.find((p) => p.name === sel.project);
  const selTodo = selProject?.todos.find((t) => t.id === sel.todoId);

  // 记下各工作区上次打开的待办（从首页进入工作区时直接打开它）；还没有标签的放进预览标签
  const selTodoId = selTodo?.id;
  useEffect(() => {
    if (!sel.project || !selTodoId) return;
    writeLastTodo(sel.workspace, sel.project, selTodoId);
    showTodoTab({ workspace: sel.workspace, project: sel.project, todoId: selTodoId });
  }, [sel.workspace, sel.project, selTodoId]);

  // 右侧正显示着的待办；显示概览等时是 null
  const activeTodo: TodoRef | null =
    sel.project && selTodoId ? { workspace: sel.workspace, project: sel.project, todoId: selTodoId } : null;
  // 显示出来的标签：侧栏里选中显示的工作区里、还在的待办
  const shownTabs = useMemo(
    () =>
      openTodos.flatMap((t): ShownTab[] => {
        if (!workspaces.includes(t.workspace)) return [];
        const todo = loaded
          ?.find((x) => x.name === t.workspace)
          ?.projects.find((p) => p.name === t.project)
          ?.todos.find((x) => x.id === t.todoId);
        return todo ? [{ ...t, todo }] : [];
      }),
    [openTodos, loaded, workspaces],
  );

  /** 改某个项目的待办列表；fn 原样返回时什么都不改，其他工作区、项目沿用原来的对象 */
  const updateTodos = useCallback(
    (ws: string, project: string, fn: (todos: TodoSummary[]) => TodoSummary[]) => {
      setLoaded((ts) => {
        if (!ts) return ts;
        const next = ts.map((t) => {
          if (t.name !== ws) return t;
          const projects = t.projects.map((p) => {
            if (p.name !== project) return p;
            const todos = fn(p.todos);
            return todos === p.todos ? p : { ...p, todos };
          });
          return sameItems(projects, t.projects) ? t : { ...t, projects };
        });
        return sameItems(next, ts) ? ts : next;
      });
    },
    [],
  );

  /** 只替换已有条目：保存回调晚到时不会把已删除/移走的待办加回来；内容没变时什么都不改（侧栏不必重新渲染） */
  const patchTodo = useCallback(
    (ws: string, project: string, s: TodoSummary) =>
      updateTodos(ws, project, (todos) => {
        const i = todos.findIndex((x) => x.id === s.id);
        if (i < 0 || sameFields(todos[i], s)) return todos;
        return todos.map((x, j) => (j === i ? s : x));
      }),
    [updateTodos],
  );

  const expand = (ws: string, key: string) => setCollapsed(ws, (c) => (c[key] ? { ...c, [key]: false } : c));

  /** 展开项目所在的分支，左侧能看到它和其中的待办 */
  const reveal = useCallback(
    (ws: string, project?: string) => {
      if (project)
        setCollapsed(ws, (c) => (c[WS_KEY] || c[project] ? { ...c, [WS_KEY]: false, [project]: false } : c));
    },
    [setCollapsed],
  );

  // 进来时直接打开某个项目 / 待办（首页的搜索结果、工作区上次打开的待办、开屏回到上次的位置、后退 / 前进），展开它所在的分支
  const initialProject = initialSel.project;
  useEffect(() => reveal(initialWorkspace, initialProject), [initialWorkspace, initialProject, reveal]);

  useImperativeHandle(handleRef, () => {
    const show = (s: Selection) => {
      if (!workspacesRef.current.includes(s.workspace)) setWorkspaces((list) => sortNames([...list, s.workspace]));
      reveal(s.workspace, s.project);
      setFocusTitleId(null);
      setFocusBodyKey(null);
      setSel(s);
    };
    return {
      show,
      async open(s) {
        // 还没选中的工作区选中后会整个加载；已经显示着的先重新加载，否则新的待办还不在列表里，会被当成已删除退回上一级
        if (workspacesRef.current.includes(s.workspace)) await reloadRef.current();
        show(s);
      },
    };
  });

  /** 结构性操作（重命名、移动、删除）之前先把编辑器里的内容落盘 */
  const flushEditor = () => editorRef.current?.flush() ?? Promise.resolve(true);

  /** 改选中的工作区（至少保留一个）；右侧显示的工作区被取消选中时改显示第一个 */
  const changeWorkspaces = (list: string[]) => {
    if (!list.length) return;
    const next = sortNames(list);
    setWorkspaces(next);
    if (!next.includes(sel.workspace)) setSel({ workspace: next[0] });
  };

  const goHome = () => {
    flushEditor();
    onHome();
  };

  const { actionsFor, stableActions, batch } = useWorkspaceActions({
    sel,
    setSel,
    treeOf,
    workspaces,
    setWorkspaces,
    changeWorkspaces,
    reload,
    onHome,
    goHome,
    flushEditor,
    editorRef,
    openDialog,
    collapsed,
    listOptions,
    expand,
    reveal,
    updateTodos,
    patchTodo,
    setFocusTitleId,
    clearPicked,
  });

  // 多选的待办（还在、所在的工作区还选中着的），按左侧列表里的位置找到对应的待办
  const pickedItems = useMemo(() => {
    const out: TodoAt[] = [];
    for (const key of picked) {
      const s = parseSelKey(key);
      if (!workspaces.includes(s.workspace)) continue;
      const todo = loaded
        ?.find((t) => t.name === s.workspace)
        ?.projects.find((p) => p.name === s.project)
        ?.todos.find((t) => t.id === s.todoId);
      if (todo && s.project) out.push({ workspace: s.workspace, project: s.project, todo });
    }
    return out;
  }, [picked, loaded, workspaces]);
  const batchMode = pickedItems.length > 1;
  // 实际在多选的键：选中的被删、移走（在外部也算）、所在工作区取消选中后只剩一条或没有了时，不算在多选，
  // 留下的那条也不高亮，下次 Ctrl+单击从打开着的那条重新开始
  const pickedKeys = useMemo(
    () =>
      pickedItems.length > 1
        ? pickedItems.map((x) => selKey({ workspace: x.workspace, project: x.project, todoId: x.todo.id }))
        : [],
    [pickedItems],
  );
  // 侧栏的行按工作区拿到选中的键：没有选中的工作区是同一个空集合，不必重新渲染
  const pickedByWs = useMemo(() => {
    const m = new Map<string, Set<string>>();
    if (pickedItems.length < 2) return m;
    for (const x of pickedItems) {
      const set = m.get(x.workspace) ?? new Set<string>();
      set.add(selKey({ workspace: x.workspace, project: x.project, todoId: x.todo.id }));
      m.set(x.workspace, set);
    }
    return m;
  }, [pickedItems]);

  /** 切到这个标签：展开它在左侧的分支，正文加载出来后焦点放进正文（光标、滚动在上次的地方） */
  const activateTab = (t: TodoRef) => {
    const s: Selection = { workspace: t.workspace, project: t.project, todoId: t.todoId };
    reveal(t.workspace, t.project);
    setFocusTitleId(null);
    if (activeTodo && sameTodo(activeTodo, t) && !batchMode) {
      editorRef.current?.focusBody();
      return;
    }
    setFocusBodyKey(selKey(s));
    setSel(s);
  };

  /**
   * 关掉这些标签（关掉时和切到别的待办一样先存盘）。正显示着的被关掉时切到右边的标签（右边没有时左边的），
   * 都关掉了显示它所在的项目
   */
  const closeTabs = (closing: readonly TodoRef[]) => {
    if (!closing.length) return;
    const next = activeAfterClose(shownTabs, closing, activeTodo);
    closeTodoTabs(closing);
    if (next === undefined || !activeTodo) return;
    if (next) activateTab(next);
    else setSel({ workspace: activeTodo.workspace, project: activeTodo.project });
  };

  // 把待办拖到左侧的另一个项目上、项目拖到另一个工作区上；多选了的待办一起拖
  const drag = useDragMove({
    trees: trees ?? [],
    expand: (ws) => expand(ws, WS_KEY),
    canReorder: !keyword.trim(),
    onDrop: (item, target) => {
      if (item.kind === "todos") {
        if (target.project) batch.move(item.items, target.project, target.workspace);
        return;
      }
      const a = actionsFor(item.workspace);
      if (item.kind === "project") a.moveProject(item.project, target.workspace);
      else if (target.todoId && target.place) a.reorderTodo(item.project, item.todo.id, target.todoId, target.place);
      else if (target.project) a.moveTodo(item.project, item.todo, target.project, target.workspace);
    },
  });

  // 侧栏的行用到的几个不变的函数（行只在自己的内容变了时才重新渲染），调用时用最新的状态
  const latest = useRef({ picked: pickedKeys, pickedItems, sel, batch, trees, dragStart: drag.start });
  useEffect(() => {
    latest.current = { picked: pickedKeys, pickedItems, sel, batch, trees, dragStart: drag.start };
  });
  /** 单击左侧列表里的待办：Ctrl+单击加选 / 取消，Shift+单击选中一段，否则打开它 */
  const onTodoClick = useCallback(
    (e: React.MouseEvent, s: Selection) => {
      const key = selKey(s);
      const { picked, sel } = latest.current;
      const current = sel.todoId ? selKey(sel) : null;
      let next: string[] | null = null;
      if (e.ctrlKey || e.metaKey) {
        next = togglePick(picked, key, current);
        pickAnchor.current = key;
      } else if (e.shiftKey) {
        const anchor = pickAnchor.current ?? current;
        const order = [...document.querySelectorAll<HTMLElement>(".sidebar .todo-row[data-sel]")].map((r) => r.dataset.sel!);
        next = anchor ? rangePick(order, anchor, key) : null;
      }
      if (next && next.length > 1) {
        setPicked(next);
        return;
      }
      // 普通单击，或多选只剩一条：打开它
      pickAnchor.current = key;
      const only = next?.length === 1 ? parseSelKey(next[0]) : s;
      setFocusTitleId(null);
      setFocusBodyKey(null);
      setSel(only);
    },
    [setSel],
  );
  /** 双击左侧列表里的待办：标签固定下来（单击时已经打开在预览标签里） */
  const onTodoDoubleClick = useCallback((s: Selection) => {
    if (s.project && s.todoId) keepTodoTab({ workspace: s.workspace, project: s.project, todoId: s.todoId });
  }, []);
  /** 在多选的待办上右键：批量操作的菜单 */
  const pickedMenu = useCallback(() => {
    const { pickedItems, batch, trees } = latest.current;
    if (pickedItems.length < 2) return null;
    return batchMenu(pickedItems, moveTargets(trees ?? [], pickedItems[0].workspace), batch, clearPicked);
  }, [clearPicked]);
  /** 按住多选了的待办拖动时，选中的一起拖 */
  const dragStart = useCallback((e: React.MouseEvent, item: DragItem) => {
    const { pickedItems, dragStart } = latest.current;
    if (item.kind === "todo" && pickedItems.length > 1) {
      const key = selKey({ workspace: item.workspace, project: item.project, todoId: item.todo.id });
      if (pickedItems.some((x) => selKey({ workspace: x.workspace, project: x.project, todoId: x.todo.id }) === key)) {
        dragStart(e, { kind: "todos", items: pickedItems });
        return;
      }
    }
    dragStart(e, item);
  }, []);

  /** 焦点移到右侧：待办的正文、项目概览的快速添加框，概览页没有输入框时落在右侧区域本身 */
  const focusMain = () => {
    const main = mainRef.current;
    (main?.querySelector<HTMLElement>(".cm-content, .quick-add input") ?? main)?.focus();
  };

  // 键盘快捷键
  const kbRef = useRef({ actionsFor, sel, selTree, selTodo, keys: settingsInfo?.settings });
  const focusMainRef = useRef(focusMain);
  const tabsRef = useRef({ shownTabs, activeTodo, activateTab, closeTabs });
  useEffect(() => {
    kbRef.current = { actionsFor, sel, selTree, selTodo, keys: settingsInfo?.settings };
    focusMainRef.current = focusMain;
    tabsRef.current = { shownTabs, activeTodo, activateTab, closeTabs };
  });
  // 最后获得焦点或用鼠标点过的一侧。焦点不在左右任何一侧时 Alt+方向键按它算：切标签时编辑器重建的一瞬间焦点不在
  // 任何地方，仍算右侧；点了侧栏里不能获得焦点的地方（标题、底部的统计）焦点落到 body 上，算左侧；
  // 弹出的菜单、选择框在页面最外层，按打开它时点的那一侧算
  const region = useRef<Side | null>(null);
  useEffect(() => {
    const track = (e: Event) => {
      region.current = sideOf(e.target) ?? region.current;
    };
    document.addEventListener("focusin", track);
    document.addEventListener("pointerdown", track, true);
    return () => {
      document.removeEventListener("focusin", track);
      document.removeEventListener("pointerdown", track, true);
    };
  }, []);
  // 这次按下的 Alt+↑ 关了标签：按住不放时后面的重复事件什么都不做（同 Ctrl+W 只关一个）。
  // 不能只看还有没有标签：关掉的是最后一个时，重复事件会落到「在左侧列表里选中上一项」，按住时选中项一行行往上走
  const altUpClosed = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const { actionsFor, sel, selTree, selTodo, keys } = kbRef.current;
      const a = actionsFor(sel.workspace);
      const combo = eventShortcut(e);
      // 多选了待办时：Esc 取消选择，Delete 删除，「标记完成 / 未完成」的快捷键作用于选中的这些（输入框、对话框里不管）
      const { pickedItems, batch } = latest.current;
      const target = e.target as Element | null;
      if (pickedItems.length > 1 && !target?.closest?.(".ant-modal, input, textarea, [contenteditable='true']")) {
        // 右键菜单、下拉菜单开着时 Esc 是关菜单
        if (e.key === "Escape" && !document.querySelector(".ant-dropdown:not(.ant-dropdown-hidden)")) {
          e.preventDefault();
          clearPicked();
          return;
        }
        if (e.key === "Delete" && !e.repeat) {
          e.preventDefault();
          batch.remove(pickedItems);
          return;
        }
        if (combo && keys && sameShortcut(combo, keys.toggleDoneShortcut)) {
          e.preventDefault();
          if (!e.repeat) batch.setDone(pickedItems, pickedItems.some((x) => !x.todo.done));
          return;
        }
      }
      // 设置里可修改的快捷键，作用于当前选中的待办（优先于下面的内置快捷键）
      if (sel.project && selTodo && combo && keys) {
        if (sameShortcut(combo, keys.toggleDoneShortcut)) {
          e.preventDefault();
          if (!e.repeat) a.toggleDone(sel.project, selTodo, true);
          return;
        }
        if (sameShortcut(combo, keys.openExternalShortcut)) {
          e.preventDefault();
          if (!e.repeat) a.openExternal(sel.project, selTodo);
          return;
        }
      }
      // Alt+←/→ 在左侧列表和右侧之间切换焦点，Alt+↑/↓ 在左侧列表里上下移动；对话框里不响应。
      // 焦点在右侧、正显示着一条待办时：Alt+←/→ 切到左边 / 右边的标签，Alt+↑ 关掉它；
      // 最左边 / 最右边的标签上仍同原来：Alt+← 回到左侧列表，Alt+→ 焦点放进正文（在标题上时用得着）
      if (e.altKey && !ctrl && !e.shiftKey && e.key.startsWith("Arrow")) {
        const heldAfterClose = e.repeat && altUpClosed.current;
        if (!e.repeat) altUpClosed.current = false;
        if ((e.target as Element | null)?.closest?.(".ant-modal")) return;
        e.preventDefault();
        if (heldAfterClose) return;
        const { shownTabs, activeTodo, activateTab, closeTabs } = tabsRef.current;
        const at = tabIndex(shownTabs, activeTodo);
        const side = sideOf(document.activeElement) ?? region.current;
        if (side === "main" && at >= 0 && pickedItems.length < 2 && e.key !== "ArrowDown") {
          if (e.key === "ArrowUp") {
            if (!e.repeat) {
              closeTabs([shownTabs[at]]);
              altUpClosed.current = true;
            }
            return;
          }
          const next = neighborTab(shownTabs, activeTodo, e.key === "ArrowRight" ? 1 : -1);
          if (next) {
            activateTab(next);
            return;
          }
        }
        if (e.key === "ArrowLeft") sidebarRef.current?.focus();
        else if (e.key === "ArrowRight") focusMainRef.current();
        else sidebarRef.current?.move(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (isRefreshShortcut(e)) {
        e.preventDefault();
        reload().then(() => message.success("已刷新"));
      } else if (ctrl && key === "s") {
        e.preventDefault();
        // 有冲突（弹出了冲突对话框）、保存失败（已提示）时不提示「已保存」
        flushEditor().then((saved) => saved && message.success("已保存"));
      } else if (combo === "Ctrl+Shift+F") {
        e.preventDefault();
        searchRef.current?.focus({ cursor: "all" });
      } else if (combo === "Ctrl+F" || combo === "Ctrl+H") {
        // 在正文里查找 / 替换；没有打开待办时 Ctrl+F 聚焦侧栏搜索框。对话框里不响应
        e.preventDefault();
        if ((e.target as Element | null)?.closest?.(".ant-modal")) return;
        if (editorRef.current?.find(combo === "Ctrl+H")) return;
        if (combo === "Ctrl+F") searchRef.current?.focus({ cursor: "all" });
      } else if (combo === "Ctrl+W" || combo === "Ctrl+Tab" || combo === "Ctrl+Shift+Tab") {
        // 关掉正显示着的标签 / 切到下一个、上一个标签。对话框里不响应
        e.preventDefault();
        if ((e.target as Element | null)?.closest?.(".ant-modal")) return;
        const { shownTabs, activeTodo, activateTab, closeTabs } = tabsRef.current;
        if (combo !== "Ctrl+W") {
          const next = stepTab(shownTabs, activeTodo, combo === "Ctrl+Tab" ? 1 : -1);
          if (next) activateTab(next);
        } else if (activeTodo && !e.repeat) closeTabs([activeTodo]);
      } else if (ctrl && key === "n") {
        e.preventDefault();
        const projects = selTree?.projects ?? [];
        const project = sel.project ?? (projects.length === 1 ? projects[0].name : undefined);
        if (project) a.newTodo(project, "", true);
        else a.newProject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reload, message, clearPicked]);

  // 拖动调整侧栏宽度
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    document.body.classList.add("resizing");
    const onMove = (ev: MouseEvent) =>
      setWidth(Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, startW + ev.clientX - startX)));
    const onUp = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (!trees) {
    return (
      <div className="fullscreen-center">
        <Spin size="large" />
      </div>
    );
  }

  const a = actionsFor(sel.workspace);
  let main: React.ReactNode;
  if (batchMode) {
    main = (
      <BatchPanel
        items={pickedItems}
        targets={moveTargets(trees, pickedItems[0].workspace)}
        actions={batch}
        onClear={clearPicked}
      />
    );
  } else if (!selTree) {
    // 选中的工作区刚改名，正在重新加载
    main = (
      <div className="fullscreen-center">
        <Spin />
      </div>
    );
  } else if (selProject && selTodo) {
    main = (
      <TodoEditor
        key={`${selTree.name}/${selProject.name}/${selTodo.id}`}
        workspace={selTree.name}
        project={selProject.name}
        summary={selTodo}
        autoFocusTitle={focusTitleId === selTodo.id}
        autoFocusBody={focusBodyKey === selKey(sel)}
        handleRef={editorRef}
        menu={todoMenu(a, selProject.name, selTodo, moveTargets(trees, selTree.name))}
        onSummary={(s) => patchTodo(selTree.name, selProject.name, s)}
        onToggleDone={() => a.toggleDone(selProject.name, selTodo)}
        onOpenExternal={() => a.openExternal(selProject.name, selTodo)}
        onSelectWorkspace={a.selectWorkspace}
        onSelectProject={() => a.selectProject(selProject.name)}
        onSavedAsNew={(created) => {
          updateTodos(selTree.name, selProject.name, (todos) => [...todos, created]);
          const s = { workspace: selTree.name, project: selProject.name, todoId: created.id };
          keepTodoTab(s);
          setFocusBodyKey(selKey(s));
          setSel(s);
        }}
        onEdit={() => keepTodoTab({ workspace: selTree.name, project: selProject.name, todoId: selTodo.id })}
        onDirty={setActiveDirty}
      />
    );
  } else if (selProject) {
    main = (
      <ProjectOverview
        workspace={selTree.name}
        project={selProject}
        moveTargets={moveTargets(trees, selTree.name)}
        sortKey={listOptions.get(selTree.name).sortKey}
        actions={a}
        autoFocus={sel !== kbSel}
        drag={drag}
      />
    );
  } else {
    main = <WorkspaceOverview tree={selTree} actions={a} drag={drag} />;
  }

  return (
    <div className="layout">
      <Sidebar
        trees={trees}
        workspaces={workspaces}
        onWorkspacesChange={changeWorkspaces}
        sel={sel}
        onSelect={(s) => {
          setFocusTitleId(null);
          setFocusBodyKey(null);
          setKbSel(s);
          setSel(s, "keyboard");
        }}
        actionsFor={stableActions}
        onHome={goHome}
        onFocusMain={focusMain}
        handleRef={sidebarRef}
        width={width}
        searchRef={searchRef}
        collapsedOf={collapsed.get}
        setCollapsed={setCollapsed}
        keyword={keyword}
        setKeyword={setKeyword}
        hits={hits}
        listOptionsOf={listOptions.get}
        setListOptions={setListOptions}
        drag={{ state: drag.state, start: dragStart }}
        pickedOf={(ws) => pickedByWs.get(ws)}
        onTodoClick={onTodoClick}
        onTodoDoubleClick={onTodoDoubleClick}
        pickedMenu={pickedMenu}
      />
      <div className="resizer" onMouseDown={startResize} onDoubleClick={() => setWidth(300)} title="拖动调整宽度，双击恢复默认" />
      <main className="main" ref={mainRef} tabIndex={-1}>
        {shownTabs.length > 0 && (
          <EditorTabs
            tabs={shownTabs}
            active={activeTodo}
            activeDirty={activeDirty}
            onActivate={activateTab}
            onClose={closeTabs}
            onKeep={keepTodoTab}
            onMove={moveTodoTab}
          />
        )}
        {main}
      </main>
      {dialog}
      {drag.ghost}
    </div>
  );
}
