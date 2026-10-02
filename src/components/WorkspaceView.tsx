import { App as AntApp, Spin, type InputRef } from "antd";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { useWindowFocus } from "../hooks";
import { type How, visit } from "../navHistory";
import { useSettings } from "../settings";
import { eventShortcut, sameShortcut } from "../shortcuts";
import type { TodoSummary, WorkspaceTree } from "../types";
import { compareName, useLocalState } from "../utils";
import {
  collapsedKey,
  type ListOptions,
  listOptionsKey,
  readJson,
  readListOptions,
  readOpenWorkspaces,
  writeJson,
  writeLastTodo,
  writeLastView,
  writeOpenWorkspaces,
} from "../workspaceState";
import { useDragMove } from "./DragMove";
import { useNameDialog } from "./NameDialog";
import { ProjectOverview, WorkspaceOverview } from "./Overview";
import Sidebar, { type SidebarHandle } from "./Sidebar";
import { type Selection, WS_KEY } from "./sidebar/tree";
import TodoEditor, { type EditorHandle } from "./TodoEditor";
import { todoMenu } from "./menus";
import { sortNames, useWorkspaceActions } from "./workspaceActions";

/** 供 App 的后退、前进（鼠标侧键）调用 */
export interface WorkspaceViewHandle {
  /** 右侧改显示工作区里的一处；它所在的工作区没选中时选中，展开它所在的分支 */
  show(sel: Selection): void;
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
  const setSel = useCallback((s: Selection, how: How = "push") => {
    selHow.current = how;
    setSelState(s);
  }, []);
  const [focusTitleId, setFocusTitleId] = useState<string | null>(null);
  // 用键盘在左侧列表里移到的选中项：这时焦点留在列表，右侧不自动聚焦输入框
  const [kbSel, setKbSel] = useState<Selection | null>(null);
  const [keyword, setKeyword] = useState("");
  const collapsed = usePerWorkspace(collapsedKey, readCollapsed);
  const setCollapsed = collapsed.set;
  const listOptions = usePerWorkspace(listOptionsKey, readListOptions);
  const setListOptions = (ws: string, patch: Partial<ListOptions>) => listOptions.set(ws, (o) => ({ ...o, ...patch }));
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

  // 刚取消选中的工作区不等重新加载完就从侧栏去掉
  const trees = loaded?.filter((t) => workspaces.includes(t.name)) ?? null;
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

  // 记下各工作区上次打开的待办：从首页进入工作区时直接打开它
  const selTodoId = selTodo?.id;
  useEffect(() => {
    if (sel.project && selTodoId) writeLastTodo(sel.workspace, sel.project, selTodoId);
  }, [sel.workspace, sel.project, selTodoId]);

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

  useImperativeHandle(handleRef, () => ({
    show(s) {
      if (!workspacesRef.current.includes(s.workspace)) setWorkspaces((list) => sortNames([...list, s.workspace]));
      reveal(s.workspace, s.project);
      setFocusTitleId(null);
      setSel(s);
    },
  }));

  /** 结构性操作（重命名、移动、删除）之前先把编辑器里的内容落盘 */
  const flushEditor = () => editorRef.current?.flush() ?? Promise.resolve();

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

  const { actionsFor, stableActions } = useWorkspaceActions({
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
  });

  // 把待办拖到左侧的另一个项目上、项目拖到另一个工作区上
  const drag = useDragMove({
    trees: trees ?? [],
    expand: (ws) => expand(ws, WS_KEY),
    onDrop: (item, target) => {
      const a = actionsFor(item.workspace);
      if (item.kind === "project") a.moveProject(item.project, target.workspace);
      else if (target.project) a.moveTodo(item.project, item.todo, target.project, target.workspace);
    },
  });

  /** 焦点移到右侧：待办的正文、项目概览的快速添加框，概览页没有输入框时落在右侧区域本身 */
  const focusMain = () => {
    const main = mainRef.current;
    (main?.querySelector<HTMLElement>(".cm-content, .quick-add input") ?? main)?.focus();
  };

  // 键盘快捷键
  const kbRef = useRef({ actionsFor, sel, selTree, selTodo, keys: settingsInfo?.settings });
  const focusMainRef = useRef(focusMain);
  useEffect(() => {
    kbRef.current = { actionsFor, sel, selTree, selTodo, keys: settingsInfo?.settings };
    focusMainRef.current = focusMain;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const { actionsFor, sel, selTree, selTodo, keys } = kbRef.current;
      const a = actionsFor(sel.workspace);
      // 设置里可修改的快捷键，作用于当前选中的待办（优先于下面的内置快捷键）
      const combo = eventShortcut(e);
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
      // Alt+←/→ 在左侧列表和右侧之间切换焦点，Alt+↑/↓ 在左侧列表里上下移动；对话框里不响应
      if (e.altKey && !ctrl && !e.shiftKey && e.key.startsWith("Arrow")) {
        if ((e.target as Element | null)?.closest?.(".ant-modal")) return;
        e.preventDefault();
        if (e.key === "ArrowLeft") sidebarRef.current?.focus();
        else if (e.key === "ArrowRight") focusMainRef.current();
        else sidebarRef.current?.move(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "F5" || (ctrl && key === "r")) {
        e.preventDefault();
        reload().then(() => message.success("已刷新"));
      } else if (ctrl && key === "s") {
        e.preventDefault();
        flushEditor().then(() => message.success("已保存"));
      } else if (ctrl && key === "f") {
        e.preventDefault();
        searchRef.current?.focus({ cursor: "all" });
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
  }, [reload, message]);

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
  if (!selTree) {
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
        handleRef={editorRef}
        menu={todoMenu(a, selProject.name, selTodo, selTree.projects.map((p) => p.name))}
        onSummary={(s) => patchTodo(selTree.name, selProject.name, s)}
        onToggleDone={() => a.toggleDone(selProject.name, selTodo)}
        onOpenExternal={() => a.openExternal(selProject.name, selTodo)}
        onSelectWorkspace={a.selectWorkspace}
        onSelectProject={() => a.selectProject(selProject.name)}
      />
    );
  } else if (selProject) {
    main = (
      <ProjectOverview
        workspace={selTree.name}
        project={selProject}
        projectNames={selTree.projects.map((p) => p.name)}
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
        listOptionsOf={listOptions.get}
        setListOptions={setListOptions}
        drag={drag}
      />
      <div className="resizer" onMouseDown={startResize} onDoubleClick={() => setWidth(300)} title="拖动调整宽度，双击恢复默认" />
      <main className="main" ref={mainRef} tabIndex={-1}>
        {main}
      </main>
      {dialog}
      {drag.ghost}
    </div>
  );
}
