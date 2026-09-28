import { App as AntApp, Spin, type InputRef } from "antd";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { useWindowFocus } from "../hooks";
import { type How, visit } from "../navHistory";
import { useSettings } from "../settings";
import { eventShortcut, sameShortcut } from "../shortcuts";
import type { SortKey, TodoSummary, WorkspaceTree } from "../types";
import { compareName, displayTitle, useLocalState } from "../utils";
import {
  collapsedKey,
  forgetProjectState,
  forgetTodoState,
  forgetWorkspaceState,
  moveTodoState,
  readJson,
  readOpenWorkspaces,
  renameProjectState,
  renameWorkspaceState,
  writeJson,
  writeLastTodo,
  writeLastView,
  writeOpenWorkspaces,
} from "../workspaceState";
import { useNameDialog } from "./NameDialog";
import { ProjectOverview, WorkspaceOverview } from "./Overview";
import Sidebar, { WS_KEY, type Selection, type SidebarHandle } from "./Sidebar";
import TodoEditor, { type EditorHandle } from "./TodoEditor";
import { todoMenu, type Actions } from "./menus";

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

const sortNames = (names: string[]) => [...new Set(names)].sort(compareName);

type Collapsed = Record<string, boolean>;

const readCollapsed = (ws: string) => readJson<Collapsed>(collapsedKey(ws), {});

/** 各工作区的折叠状态，分别存在 localStorage 的 collapsed:{工作区} 里 */
function useCollapsed() {
  const [map, setMap] = useState<Record<string, Collapsed>>({});
  useEffect(() => {
    for (const [ws, c] of Object.entries(map)) writeJson(collapsedKey(ws), c);
  }, [map]);

  const get = (ws: string) => map[ws] ?? readCollapsed(ws);
  const set = useCallback(
    (ws: string, fn: (prev: Collapsed) => Collapsed) => setMap((m) => ({ ...m, [ws]: fn(m[ws] ?? readCollapsed(ws)) })),
    [],
  );
  /** 工作区改名后折叠状态跟过去 */
  const rename = useCallback((from: string, to: string) => {
    renameWorkspaceState(from, to);
    setMap(({ [from]: state, ...rest }) => (state ? { ...rest, [to]: state } : rest));
  }, []);
  const forget = useCallback((ws: string) => {
    forgetWorkspaceState(ws);
    setMap(({ [ws]: _, ...rest }) => rest);
  }, []);
  return [get, set, rename, forget] as const;
}

export default function WorkspaceView({ initialWorkspace, initialSel, onHome, handleRef }: Props) {
  const { message, modal } = AntApp.useApp();
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
  const [collapsedOf, setCollapsed, renameCollapsed, forgetCollapsed] = useCollapsed();
  const [hideDone, setHideDone] = useLocalState("hideDone", false);
  const [sortKey, setSortKey] = useLocalState<SortKey>("sortKey", "created");
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
    setLoaded(trees);
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

  // 选中的工作区/项目/待办在刷新后不存在了（被外部删除、取消选中等），退回上一级
  useEffect(() => {
    if (!loaded) return;
    const t = loaded.find((x) => x.name === sel.workspace);
    if (!t) {
      // 还在列表里说明正在加载（例如刚改名），等加载完
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

  const updateTodos = useCallback(
    (ws: string, project: string, fn: (todos: TodoSummary[]) => TodoSummary[]) => {
      setLoaded((ts) =>
        ts?.map((t) =>
          t.name !== ws
            ? t
            : { ...t, projects: t.projects.map((p) => (p.name === project ? { ...p, todos: fn(p.todos) } : p)) },
        ) ?? ts,
      );
    },
    [],
  );

  /** 只替换已有条目：保存回调晚到时不会把已删除/移走的待办加回来 */
  const patchTodo = useCallback(
    (ws: string, project: string, s: TodoSummary) =>
      updateTodos(ws, project, (todos) => todos.map((x) => (x.id === s.id ? s : x))),
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

  /** 执行操作，出错时弹出提示；返回是否成功 */
  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
      return true;
    } catch (e) {
      message.error(errMsg(e));
      return false;
    }
  };

  const confirmDelete = (title: string, content: string, onOk: () => Promise<void>) =>
    modal.confirm({
      title,
      content,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => run(onOk),
    });

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

  /** 绑定到某个工作区的操作：侧栏里每个工作区各用各的，右侧用选中的那个 */
  const actionsFor = (ws: string): Actions => {
    const tree = treeOf(ws);
    const inSel = sel.workspace === ws;
    const isSelProject = (project: string) => inSel && sel.project === project;
    const isSelTodo = (project: string, id: string) => isSelProject(project) && sel.todoId === id;

    return {
      goHome,
      selectWorkspace: () => setSel({ workspace: ws }),
      selectProject: (project) => setSel({ workspace: ws, project }),
      selectTodo: (project, id) => setSel({ workspace: ws, project, todoId: id }),

      renameWorkspace: () =>
        openDialog({
          title: "重命名工作区",
          initial: ws,
          onSubmit: async (v) => {
            if (inSel) await flushEditor();
            const name = await api.renameWorkspace(ws, v);
            if (inSel) editorRef.current?.detach();
            renameCollapsed(ws, name);
            setWorkspaces((list) => sortNames(list.map((w) => (w === ws ? name : w))));
            if (inSel) setSel({ ...sel, workspace: name }, "replace");
            message.success("已重命名");
          },
        }),
      deleteWorkspace: () => {
        const count = tree?.projects.reduce((n, p) => n + p.todos.length, 0) ?? 0;
        confirmDelete(
          `删除工作区「${ws}」？`,
          `其中的 ${tree?.projects.length ?? 0} 个项目、${count} 条待办将一并移到回收站。`,
          async () => {
            if (inSel) await flushEditor();
            await api.deleteWorkspace(ws);
            if (inSel) editorRef.current?.detach();
            forgetCollapsed(ws);
            message.success("已移到回收站");
            const rest = workspaces.filter((w) => w !== ws);
            if (rest.length) changeWorkspaces(rest);
            else onHome();
          },
        );
      },
      openWorkspaceFolder: () => run(() => api.openFolder(ws)),

      newProject: () =>
        openDialog({
          title: "新建项目",
          label: workspaces.length > 1 ? `在工作区「${ws}」中新建项目` : undefined,
          placeholder: "例如：需求开发、日常事务",
          okText: "创建",
          onSubmit: async (v) => {
            const name = await api.createProject(ws, v);
            await reload();
            expand(ws, WS_KEY);
            setSel({ workspace: ws, project: name });
          },
        }),
      renameProject: (project) =>
        openDialog({
          title: "重命名项目",
          initial: project,
          onSubmit: async (v) => {
            if (isSelProject(project)) await flushEditor();
            const name = await api.renameProject(ws, project, v);
            if (isSelProject(project)) editorRef.current?.detach();
            renameProjectState(ws, project, name);
            setCollapsed(ws, (c) => {
              const { [project]: state, ...rest } = c;
              return state === undefined ? rest : { ...rest, [name]: state };
            });
            await reload();
            if (isSelProject(project)) setSel({ ...sel, project: name }, "replace");
            message.success("已重命名");
          },
        }),
      deleteProject: (project) => {
        const count = tree?.projects.find((p) => p.name === project)?.todos.length ?? 0;
        confirmDelete(`删除项目「${project}」？`, `其中的 ${count} 条待办将一并移到回收站。`, async () => {
          if (isSelProject(project)) await flushEditor();
          await api.deleteProject(ws, project);
          if (isSelProject(project)) {
            editorRef.current?.detach();
            setSel({ workspace: ws });
          }
          forgetProjectState(ws, project);
          await reload();
          message.success("已移到回收站");
        });
      },
      openProjectFolder: (project) => run(() => api.openFolder(ws, project)),

      newTodo: (project, title = "", open = true) =>
        run(async () => {
          const s = await api.createTodo(ws, project, title);
          updateTodos(ws, project, (todos) => [...todos, s]);
          expand(ws, WS_KEY);
          expand(ws, project);
          if (open) {
            setSel({ workspace: ws, project, todoId: s.id });
            setFocusTitleId(title ? null : s.id);
          }
        }),
      toggleDone: (project, t, notify) =>
        run(async () => {
          const s = await api.setTodoDone(ws, project, t.id, !t.done);
          patchTodo(ws, project, s);
          if (notify) message.success(s.done ? "已标记为完成" : "已标记为未完成");
        }),
      deleteTodo: (project, t) =>
        confirmDelete(`删除待办「${displayTitle(t).text}」？`, "对应的 Markdown 文件将被移到回收站。", async () => {
          const isSel = isSelTodo(project, t.id);
          if (isSel) await flushEditor();
          await api.deleteTodo(ws, project, t.id);
          if (isSel) {
            editorRef.current?.detach();
            setSel({ workspace: ws, project });
          }
          forgetTodoState(ws, project, t.id);
          updateTodos(ws, project, (todos) => todos.filter((x) => x.id !== t.id));
          message.success("已移到回收站");
        }),
      moveTodo: (project, t, target) =>
        run(async () => {
          const isSel = isSelTodo(project, t.id);
          if (isSel) await flushEditor();
          const moved = await api.moveTodo(ws, project, t.id, target);
          if (isSel) editorRef.current?.detach();
          moveTodoState(ws, project, t.id, target, moved.id);
          await reload();
          expand(ws, target);
          if (isSel) setSel({ workspace: ws, project: target, todoId: moved.id }, "replace");
          message.success(`已移动到「${target}」`);
        }),
      openExternal: (project, t) =>
        run(async () => {
          if (isSelTodo(project, t.id)) await flushEditor();
          await api.openTodoExternal(ws, project, t.id);
        }),
      revealTodo: (project, t) => run(() => api.revealTodo(ws, project, t.id)),
    };
  };

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
        sortKey={sortKey}
        actions={a}
        autoFocus={sel !== kbSel}
      />
    );
  } else {
    main = <WorkspaceOverview tree={selTree} actions={a} />;
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
        actionsFor={actionsFor}
        onHome={goHome}
        onFocusMain={focusMain}
        handleRef={sidebarRef}
        width={width}
        searchRef={searchRef}
        collapsedOf={collapsedOf}
        setCollapsed={setCollapsed}
        keyword={keyword}
        setKeyword={setKeyword}
        hideDone={hideDone}
        setHideDone={setHideDone}
        sortKey={sortKey}
        setSortKey={setSortKey}
      />
      <div className="resizer" onMouseDown={startResize} onDoubleClick={() => setWidth(300)} title="拖动调整宽度，双击恢复默认" />
      <main className="main" ref={mainRef} tabIndex={-1}>
        {main}
      </main>
      {dialog}
    </div>
  );
}
