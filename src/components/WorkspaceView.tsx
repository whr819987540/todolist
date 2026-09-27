import { App as AntApp, Spin, type InputRef } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { useWindowFocus } from "../hooks";
import { useSettings } from "../settings";
import { eventShortcut, sameShortcut } from "../shortcuts";
import type { SortKey, TodoSummary, WorkspaceTree } from "../types";
import { compareName, displayTitle, useLocalState } from "../utils";
import { useNameDialog } from "./NameDialog";
import { ProjectOverview, WorkspaceOverview } from "./Overview";
import Sidebar, { WS_KEY, type Selection } from "./Sidebar";
import TodoEditor, { type EditorHandle } from "./TodoEditor";
import { todoMenu, type Actions } from "./menus";

interface Props {
  /** 从首页进入的工作区；进来后可以在侧栏顶部再选中其他工作区一起显示 */
  initialWorkspace: string;
  initialSel: Omit<Selection, "workspace">;
  onHome: () => void;
}

const MIN_SIDEBAR = 240;
const MAX_SIDEBAR = 560;

function sortTree(t: WorkspaceTree): WorkspaceTree {
  return { ...t, projects: [...t.projects].sort((a, b) => compareName(a.name, b.name)) };
}

const sortNames = (names: string[]) => [...new Set(names)].sort(compareName);

type Collapsed = Record<string, boolean>;

const collapsedKey = (ws: string) => `collapsed:${ws}`;

function readCollapsed(ws: string): Collapsed {
  try {
    return JSON.parse(localStorage.getItem(collapsedKey(ws)) ?? "{}") as Collapsed;
  } catch {
    return {};
  }
}

/** 各工作区的折叠状态，分别存在 localStorage 的 collapsed:{工作区} 里 */
function useCollapsed() {
  const [map, setMap] = useState<Record<string, Collapsed>>({});
  useEffect(() => {
    try {
      for (const [ws, c] of Object.entries(map)) localStorage.setItem(collapsedKey(ws), JSON.stringify(c));
    } catch {
      /* 忽略 */
    }
  }, [map]);

  const get = (ws: string) => map[ws] ?? readCollapsed(ws);
  const set = useCallback(
    (ws: string, fn: (prev: Collapsed) => Collapsed) => setMap((m) => ({ ...m, [ws]: fn(m[ws] ?? readCollapsed(ws)) })),
    [],
  );
  /** 工作区改名后折叠状态跟过去 */
  const rename = useCallback((from: string, to: string) => {
    setMap(({ [from]: state, ...rest }) => ({ ...rest, [to]: state ?? readCollapsed(from) }));
    try {
      localStorage.removeItem(collapsedKey(from));
    } catch {
      /* 忽略 */
    }
  }, []);
  return [get, set, rename] as const;
}

export default function WorkspaceView({ initialWorkspace, initialSel, onHome }: Props) {
  const { message, modal } = AntApp.useApp();
  // 侧栏里选中显示的工作区，按名称排序
  const [workspaces, setWorkspaces] = useState<string[]>([initialWorkspace]);
  const [loaded, setLoaded] = useState<WorkspaceTree[] | null>(null);
  const [sel, setSel] = useState<Selection>({ workspace: initialWorkspace, ...initialSel });
  const [focusTitleId, setFocusTitleId] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [collapsedOf, setCollapsed, renameCollapsed] = useCollapsed();
  const [hideDone, setHideDone] = useLocalState("hideDone", false);
  const [sortKey, setSortKey] = useLocalState<SortKey>("sortKey", "created");
  const [storedWidth, setWidth] = useLocalState("sidebarWidth", 300);
  const width = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, storedWidth));
  const [dialog, openDialog] = useNameDialog();
  const { info: settingsInfo } = useSettings();
  const editorRef = useRef<EditorHandle | null>(null);
  const searchRef = useRef<InputRef>(null);

  const onHomeRef = useRef(onHome);
  useEffect(() => {
    onHomeRef.current = onHome;
  });

  const workspacesRef = useRef(workspaces);
  useEffect(() => {
    workspacesRef.current = workspaces;
  });

  const reload = useCallback(async () => {
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
  }, [workspaces, message]);

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
      if (!workspaces.includes(sel.workspace)) setSel({ workspace: workspaces[0] });
      return;
    }
    if (!sel.project) return;
    const p = t.projects.find((x) => x.name === sel.project);
    if (!p) setSel({ workspace: sel.workspace });
    else if (sel.todoId && !p.todos.some((x) => x.id === sel.todoId))
      setSel({ workspace: sel.workspace, project: sel.project });
  }, [loaded, sel, workspaces]);

  const selTree = treeOf(sel.workspace);
  const selProject = selTree?.projects.find((p) => p.name === sel.project);
  const selTodo = selProject?.todos.find((t) => t.id === sel.todoId);

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

  // 从首页搜索结果直接打开某个项目 / 待办时，展开它所在的分支
  const initialProject = initialSel.project;
  useEffect(() => {
    if (initialProject)
      setCollapsed(initialWorkspace, (c) =>
        c[WS_KEY] || c[initialProject] ? { ...c, [WS_KEY]: false, [initialProject]: false } : c,
      );
  }, [initialWorkspace, initialProject, setCollapsed]);

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
            if (inSel) setSel({ ...sel, workspace: name });
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
            setCollapsed(ws, (c) => {
              const { [project]: state, ...rest } = c;
              return state === undefined ? rest : { ...rest, [name]: state };
            });
            await reload();
            if (isSelProject(project)) setSel({ ...sel, project: name });
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
          updateTodos(ws, project, (todos) => todos.filter((x) => x.id !== t.id));
          message.success("已移到回收站");
        }),
      moveTodo: (project, t, target) =>
        run(async () => {
          const isSel = isSelTodo(project, t.id);
          if (isSel) await flushEditor();
          const moved = await api.moveTodo(ws, project, t.id, target);
          if (isSel) editorRef.current?.detach();
          await reload();
          expand(ws, target);
          if (isSel) setSel({ workspace: ws, project: target, todoId: moved.id });
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

  // 键盘快捷键
  const kbRef = useRef({ actionsFor, sel, selTree, selTodo, keys: settingsInfo?.settings });
  useEffect(() => {
    kbRef.current = { actionsFor, sel, selTree, selTodo, keys: settingsInfo?.settings };
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
        actionsFor={actionsFor}
        onHome={goHome}
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
      <main className="main">{main}</main>
      {dialog}
    </div>
  );
}
