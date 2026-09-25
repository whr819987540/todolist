import { App as AntApp, Spin, type InputRef } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { useWindowFocus } from "../hooks";
import type { SortKey, TodoSummary, WorkspaceTree } from "../types";
import { compareName, displayTitle, useLocalState } from "../utils";
import { useNameDialog } from "./NameDialog";
import { ProjectOverview, WorkspaceOverview } from "./Overview";
import Sidebar, { WS_KEY, type Selection } from "./Sidebar";
import TodoEditor, { type EditorHandle } from "./TodoEditor";
import { todoMenu, type Actions } from "./menus";

interface Props {
  workspace: string;
  initialSel: Selection;
  onHome: () => void;
  onSwitch: (workspace: string, sel?: Selection) => void;
}

const MIN_SIDEBAR = 240;
const MAX_SIDEBAR = 560;

function sortTree(t: WorkspaceTree): WorkspaceTree {
  return { ...t, projects: [...t.projects].sort((a, b) => compareName(a.name, b.name)) };
}

export default function WorkspaceView({ workspace, initialSel, onHome, onSwitch }: Props) {
  const { message, modal } = AntApp.useApp();
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [sel, setSel] = useState<Selection>(initialSel);
  const [focusTitleId, setFocusTitleId] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [collapsed, setCollapsed] = useLocalState<Record<string, boolean>>(`collapsed:${workspace}`, {});
  const [hideDone, setHideDone] = useLocalState("hideDone", false);
  const [sortKey, setSortKey] = useLocalState<SortKey>("sortKey", "created");
  const [storedWidth, setWidth] = useLocalState("sidebarWidth", 300);
  const width = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, storedWidth));
  const [dialog, openDialog] = useNameDialog();
  const editorRef = useRef<EditorHandle | null>(null);
  const searchRef = useRef<InputRef>(null);

  const onHomeRef = useRef(onHome);
  useEffect(() => {
    onHomeRef.current = onHome;
  });

  const reload = useCallback(async () => {
    try {
      setTree(sortTree(await api.loadWorkspace(workspace)));
    } catch (e) {
      // 工作区在外部被删除/改名
      message.error(errMsg(e));
      onHomeRef.current();
    }
  }, [workspace, message]);

  useEffect(() => {
    reload();
  }, [reload]);

  // 从外部编辑器切回来时刷新（文件可能被改过、增删过）
  useWindowFocus((focused) => {
    if (focused) reload();
  });

  // 选中的项目/待办在刷新后不存在了（被外部删除等），退回上一级
  useEffect(() => {
    if (!tree || !sel.project) return;
    const p = tree.projects.find((x) => x.name === sel.project);
    if (!p) setSel({});
    else if (sel.todoId && !p.todos.some((t) => t.id === sel.todoId)) setSel({ project: sel.project });
  }, [tree, sel]);

  const projectNames = useMemo(() => tree?.projects.map((p) => p.name) ?? [], [tree]);
  const selProject = tree?.projects.find((p) => p.name === sel.project);
  const selTodo = selProject?.todos.find((t) => t.id === sel.todoId);

  const updateTodos = useCallback((project: string, fn: (todos: TodoSummary[]) => TodoSummary[]) => {
    setTree(
      (t) =>
        t && {
          ...t,
          projects: t.projects.map((p) => (p.name === project ? { ...p, todos: fn(p.todos) } : p)),
        },
    );
  }, []);

  /** 只替换已有条目：保存回调晚到时不会把已删除/移走的待办加回来 */
  const patchTodo = useCallback(
    (project: string, s: TodoSummary) =>
      updateTodos(project, (todos) => todos.map((x) => (x.id === s.id ? s : x))),
    [updateTodos],
  );

  const expand = (key: string) => setCollapsed((c) => (c[key] ? { ...c, [key]: false } : c));

  /** 结构性操作（重命名、移动、删除）之前先把编辑器里的内容落盘 */
  const flushEditor = () => editorRef.current?.flush() ?? Promise.resolve();

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      message.error(errMsg(e));
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

  const a: Actions = {
    goHome: () => {
      flushEditor();
      onHome();
    },
    selectWorkspace: () => setSel({}),
    selectProject: (project) => setSel({ project }),
    selectTodo: (project, id) => setSel({ project, todoId: id }),

    renameWorkspace: () =>
      openDialog({
        title: "重命名工作区",
        initial: workspace,
        onSubmit: async (v) => {
          await flushEditor();
          const name = await api.renameWorkspace(workspace, v);
          editorRef.current?.detach();
          message.success("已重命名");
          onSwitch(name, sel);
        },
      }),
    deleteWorkspace: () => {
      const count = tree?.projects.reduce((n, p) => n + p.todos.length, 0) ?? 0;
      confirmDelete(
        `删除工作区「${workspace}」？`,
        `其中的 ${projectNames.length} 个项目、${count} 条待办将一并移到回收站。`,
        async () => {
          await flushEditor();
          await api.deleteWorkspace(workspace);
          editorRef.current?.detach();
          message.success("已移到回收站");
          onHome();
        },
      );
    },
    openWorkspaceFolder: () => run(() => api.openFolder(workspace)),

    newProject: () =>
      openDialog({
        title: "新建项目",
        placeholder: "例如：需求开发、日常事务",
        okText: "创建",
        onSubmit: async (v) => {
          const name = await api.createProject(workspace, v);
          await reload();
          expand(WS_KEY);
          setSel({ project: name });
        },
      }),
    renameProject: (project) =>
      openDialog({
        title: "重命名项目",
        initial: project,
        onSubmit: async (v) => {
          if (sel.project === project) await flushEditor();
          const name = await api.renameProject(workspace, project, v);
          if (sel.project === project) editorRef.current?.detach();
          setCollapsed((c) => {
            const { [project]: state, ...rest } = c;
            return state === undefined ? rest : { ...rest, [name]: state };
          });
          await reload();
          if (sel.project === project) setSel({ ...sel, project: name });
          message.success("已重命名");
        },
      }),
    deleteProject: (project) => {
      const count = tree?.projects.find((p) => p.name === project)?.todos.length ?? 0;
      confirmDelete(`删除项目「${project}」？`, `其中的 ${count} 条待办将一并移到回收站。`, async () => {
        if (sel.project === project) await flushEditor();
        await api.deleteProject(workspace, project);
        if (sel.project === project) {
          editorRef.current?.detach();
          setSel({});
        }
        await reload();
        message.success("已移到回收站");
      });
    },
    openProjectFolder: (project) => run(() => api.openFolder(workspace, project)),

    newTodo: (project, title = "", open = true) =>
      run(async () => {
        const s = await api.createTodo(workspace, project, title);
        updateTodos(project, (todos) => [...todos, s]);
        expand(WS_KEY);
        expand(project);
        if (open) {
          setSel({ project, todoId: s.id });
          setFocusTitleId(title ? null : s.id);
        }
      }),
    toggleDone: (project, t) =>
      run(async () => {
        patchTodo(project, await api.setTodoDone(workspace, project, t.id, !t.done));
      }),
    deleteTodo: (project, t) =>
      confirmDelete(`删除待办「${displayTitle(t).text}」？`, "对应的 Markdown 文件将被移到回收站。", async () => {
        const isSel = sel.project === project && sel.todoId === t.id;
        if (isSel) await flushEditor();
        await api.deleteTodo(workspace, project, t.id);
        if (isSel) {
          editorRef.current?.detach();
          setSel({ project });
        }
        updateTodos(project, (todos) => todos.filter((x) => x.id !== t.id));
        message.success("已移到回收站");
      }),
    moveTodo: (project, t, target) =>
      run(async () => {
        const isSel = sel.project === project && sel.todoId === t.id;
        if (isSel) await flushEditor();
        const moved = await api.moveTodo(workspace, project, t.id, target);
        if (isSel) editorRef.current?.detach();
        await reload();
        expand(target);
        if (isSel) setSel({ project: target, todoId: moved.id });
        message.success(`已移动到「${target}」`);
      }),
    openExternal: (project, t) =>
      run(async () => {
        if (sel.project === project && sel.todoId === t.id) await flushEditor();
        await api.openTodoExternal(workspace, project, t.id);
      }),
    revealTodo: (project, t) => run(() => api.revealTodo(workspace, project, t.id)),
  };

  // 键盘快捷键
  const aRef = useRef(a);
  useEffect(() => {
    aRef.current = a;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
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
        const project = sel.project ?? (projectNames.length === 1 ? projectNames[0] : undefined);
        if (project) aRef.current.newTodo(project, "", true);
        else aRef.current.newProject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reload, message, sel.project, projectNames]);

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

  if (!tree) {
    return (
      <div className="fullscreen-center">
        <Spin size="large" />
      </div>
    );
  }

  let main: React.ReactNode;
  if (selProject && selTodo) {
    main = (
      <TodoEditor
        key={`${selProject.name}/${selTodo.id}`}
        workspace={workspace}
        project={selProject.name}
        summary={selTodo}
        autoFocusTitle={focusTitleId === selTodo.id}
        handleRef={editorRef}
        menu={todoMenu(a, selProject.name, selTodo, projectNames)}
        onSummary={(s) => patchTodo(selProject.name, s)}
        onToggleDone={() => a.toggleDone(selProject.name, selTodo)}
        onOpenExternal={() => a.openExternal(selProject.name, selTodo)}
        onSelectWorkspace={a.selectWorkspace}
        onSelectProject={() => a.selectProject(selProject.name)}
      />
    );
  } else if (selProject) {
    main = (
      <ProjectOverview
        workspace={workspace}
        project={selProject}
        projectNames={projectNames}
        sortKey={sortKey}
        actions={a}
      />
    );
  } else {
    main = <WorkspaceOverview tree={tree} actions={a} />;
  }

  return (
    <div className="layout">
      <Sidebar
        tree={tree}
        sel={sel}
        actions={a}
        width={width}
        searchRef={searchRef}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        keyword={keyword}
        setKeyword={setKeyword}
        hideDone={hideDone}
        setHideDone={setHideDone}
        sortKey={sortKey}
        setSortKey={setSortKey}
        onSwitchWorkspace={(name) => {
          flushEditor();
          onSwitch(name);
        }}
      />
      <div className="resizer" onMouseDown={startResize} onDoubleClick={() => setWidth(300)} title="拖动调整宽度，双击恢复默认" />
      <main className="main">{main}</main>
      {dialog}
    </div>
  );
}
