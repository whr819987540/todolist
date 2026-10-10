import { App as AntApp } from "antd";
import { useEffect, useMemo, useRef } from "react";
import { api, errMsg } from "../api";
import type { How } from "../navHistory";
import {
  deepTodos,
  descendantsOf,
  inProject,
  isSubProject,
  leafName,
  parentOf,
  projectLabel,
  reparent,
  shortPlaceLabel,
  shortProjectLabel,
} from "../projects";
import type { TodoSummary, WorkspaceTree } from "../types";
import type { TodoAt } from "./DragMove";
import { compareName, displayTitle, reorderedIds, sortTodos } from "../utils";
import {
  forgetProjectState,
  forgetTodoState,
  forgetWorkspaceState,
  keepTodoTab,
  type ListOptions,
  moveProjectState,
  moveTodoState,
  renameProjectState,
  renameWorkspaceState,
} from "../workspaceState";
import type { Actions } from "./menus";
import type { useNameDialog } from "./NameDialog";
import { type Collapsed, type Selection, WS_KEY } from "./sidebar/tree";
import type { EditorHandle } from "./TodoEditor";
import { useUndoDelete } from "./undo";

/** 去重后按名称排序：侧栏里选中的工作区按这个顺序显示 */
export const sortNames = (names: string[]) => [...new Set(names)].sort(compareName);

/** 按工作区分别记在本机的界面状态（WorkspaceView 的 usePerWorkspace：折叠状态、排序和隐藏已完成） */
interface PerWorkspace<T> {
  get(ws: string): T;
  set(ws: string, fn: (prev: T) => T): void;
  /** 工作区改名、删除后，内存里的跟着改 */
  rename(from: string, to: string): void;
  forget(ws: string): void;
}

/** 操作要用到的状态和函数，由 WorkspaceView 每次渲染时给出 */
export interface ActionContext {
  /** 右侧显示的内容 */
  sel: Selection;
  setSel: (s: Selection, how?: How) => void;
  /** 侧栏里显示的（已加载的）工作区 */
  treeOf: (ws: string) => WorkspaceTree | undefined;
  /** 选中显示的工作区 */
  workspaces: string[];
  setWorkspaces: (fn: (list: string[]) => string[]) => void;
  /** 改选中的工作区（至少保留一个）；右侧显示的工作区被取消选中时改显示第一个 */
  changeWorkspaces: (list: string[]) => void;
  /** 重新加载选中的工作区 */
  reload: () => Promise<void>;
  onHome: () => void;
  /** 先存盘再返回首页 */
  goHome: () => void;
  /** 结构性操作（重命名、移动、删除）之前先把编辑器里的内容落盘 */
  flushEditor: () => Promise<unknown>;
  editorRef: React.RefObject<EditorHandle | null>;
  openDialog: ReturnType<typeof useNameDialog>[1];
  collapsed: PerWorkspace<Collapsed>;
  listOptions: PerWorkspace<ListOptions>;
  /** 展开工作区（WS_KEY）或项目 */
  expand: (ws: string, key: string) => void;
  /** 展开项目所在的分支（工作区、各级父项目和它自己） */
  reveal: (ws: string, project?: string) => void;
  updateTodos: (ws: string, project: string, fn: (todos: TodoSummary[]) => TodoSummary[]) => void;
  patchTodo: (ws: string, project: string, s: TodoSummary) => void;
  /** 新建的待办打开后聚焦标题 */
  setFocusTitleId: (id: string | null) => void;
  /** 批量操作做完（移动、删除）后取消多选 */
  clearPicked: () => void;
}

/** 多选的几条待办一起做的操作（可以跨项目、跨工作区） */
export interface BatchActions {
  setDone(items: TodoAt[], done: boolean): void;
  setPinned(items: TodoAt[], pinned: boolean): void;
  /** 移到 targetWs 的项目 target；已经在那里的不动 */
  move(items: TodoAt[], target: string, targetWs: string): void;
  /** 确认后删除 */
  remove(items: TodoAt[]): void;
}

/**
 * 工作区视图里所有可触发的操作（Actions，见 menus.tsx），侧栏、概览、编辑器共用。
 * actionsFor(ws) 每次渲染都是新的，用的是这次渲染的状态；stableActions(ws) 是不变的对象（每个工作区一个），
 * 调用时转给最新的 actionsFor，传给侧栏里用 memo 的行
 */
export function useWorkspaceActions(ctx: ActionContext) {
  const { message, modal } = AntApp.useApp();
  const undoDelete = useUndoDelete();
  // 撤销删除时（提示停留的几秒里选中的工作区可能变了）用最新的 reload
  const reloadRef = useRef(ctx.reload);
  useEffect(() => {
    reloadRef.current = ctx.reload;
  });
  const {
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
  } = ctx;
  const setCollapsed = collapsed.set;

  /** 工作区改名后，按工作区记的状态（折叠状态、排序等，和记住的选中、编辑位置等）跟过去 */
  const renameWorkspaceMemory = (from: string, to: string) => {
    renameWorkspaceState(from, to);
    collapsed.rename(from, to);
    listOptions.rename(from, to);
  };

  /** 工作区删除后不再记住它，免得以后新建同名工作区时沿用 */
  const forgetWorkspaceMemory = (ws: string) => {
    forgetWorkspaceState(ws);
    collapsed.forget(ws);
    listOptions.forget(ws);
  };

  /**
   * 项目改名、移动后，它和各级子项目的折叠状态跟过去：fromWs 里的 from（路径）→ toWs 里的 to。
   * 先按现在的状态算好要搬的，再分别改两个工作区（可以是同一个）
   */
  const moveCollapsed = (fromWs: string, from: string, toWs: string, to: string) => {
    const moved: Collapsed = {};
    for (const [k, v] of Object.entries(collapsed.get(fromWs)))
      if (k !== WS_KEY && inProject(k, from)) moved[reparent(k, from, to)] = v;
    setCollapsed(fromWs, (c) => Object.fromEntries(Object.entries(c).filter(([k]) => k === WS_KEY || !inProject(k, from))));
    setCollapsed(toWs, (c) => ({ ...c, ...moved }));
  };

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

  /** 绑定到某个工作区的操作：侧栏里每个工作区各用各的，右侧用选中的那个 */
  const actionsFor = (ws: string): Actions => {
    const tree = treeOf(ws);
    const inSel = sel.workspace === ws;
    const isSelProject = (project: string) => inSel && sel.project === project;
    /** 右侧显示的是这个项目或它的各级子项目（概览或其中的待办）：改名、移动、删除它时要先存盘、跟过去 */
    const showsProject = (project: string) => inSel && sel.project !== undefined && inProject(sel.project, project);
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
            renameWorkspaceMemory(ws, name);
            setWorkspaces((list) => sortNames(list.map((w) => (w === ws ? name : w))));
            if (inSel) setSel({ ...sel, workspace: name }, "replace");
            message.success("已重命名");
          },
        }),
      deleteWorkspace: () => {
        const count = tree?.projects.reduce((n, p) => n + p.todos.length, 0) ?? 0;
        confirmDelete(
          `删除工作区「${ws}」？`,
          `其中的 ${tree?.projects.length ?? 0} 个项目、${count} 条待办将一并移到回收站，可以在回收站里恢复。`,
          async () => {
            if (inSel) await flushEditor();
            const rid = await api.deleteWorkspace(ws);
            if (inSel) editorRef.current?.detach();
            forgetWorkspaceMemory(ws);
            // 撤销后重新选中它（只剩它一个、已经回了首页时，首页会刷新出来）
            undoDelete(`已删除工作区「${ws}」`, [rid], ({ restored }) => {
              const back = restored[0]?.workspace;
              if (back) setWorkspaces((list) => sortNames([...list, back]));
            });
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
      newSubProject: (parent) =>
        openDialog({
          title: "新建子项目",
          label: `在项目「${workspaces.length > 1 ? shortPlaceLabel(ws, parent) : shortProjectLabel(parent)}」中新建子项目`,
          placeholder: "例如：前端、后端",
          okText: "创建",
          onSubmit: async (v) => {
            const name = await api.createProject(ws, v, parent);
            await reload();
            reveal(ws, name);
            setSel({ workspace: ws, project: name });
          },
        }),
      renameProject: (project) =>
        openDialog({
          title: isSubProject(project) ? "重命名子项目" : "重命名项目",
          initial: leafName(project),
          onSubmit: async (v) => {
            const isSel = showsProject(project);
            if (isSel) await flushEditor();
            const name = await api.renameProject(ws, project, v);
            if (isSel) editorRef.current?.detach();
            renameProjectState(ws, project, name);
            moveCollapsed(ws, project, ws, name);
            await reload();
            if (isSel && sel.project) setSel({ ...sel, project: reparent(sel.project, project, name) }, "replace");
            message.success("已重命名");
          },
        }),
      deleteProject: (project) => {
        const projects = tree?.projects ?? [];
        const count = deepTodos(projects, project).length;
        // 各级子项目都算
        const subs = descendantsOf(projects, project).length;
        confirmDelete(
          `删除${isSubProject(project) ? "子项目" : "项目"}「${projectLabel(project)}」？`,
          `其中的 ${subs ? `${subs} 个子项目、` : ""}${count} 条待办将一并移到回收站，可以在回收站里恢复。`,
          async () => {
            const isSel = showsProject(project);
            if (isSel) await flushEditor();
            const rid = await api.deleteProject(ws, project);
            // 正看着它（或它下面的）：退回往上最近的还在的父项目（它的父项目），顶层项目退回工作区概览
            if (isSel) {
              editorRef.current?.detach();
              setSel({ workspace: ws, project: parentOf(project) });
            }
            forgetProjectState(ws, project);
            await reload();
            undoDelete(`已删除${isSubProject(project) ? "子项目" : "项目"}「${shortProjectLabel(project)}」`, [rid]);
          },
        );
      },
      moveProject: (project, targetWs, parent) =>
        run(async () => {
          const isSel = showsProject(project);
          if (isSel) await flushEditor();
          // 移过去后的路径：放进项目后是「父项目/名字」，子项目移出来后是名字
          const to = await api.moveProject(ws, project, targetWs, parent);
          if (isSel) editorRef.current?.detach();
          moveProjectState(ws, project, targetWs, to);
          // 折叠状态跟过去；展开目标工作区、放进的项目，看得到移过去的项目
          moveCollapsed(ws, project, targetWs, to);
          reveal(targetWs, to);
          await reload();
          if (isSel && sel.project)
            setSel({ ...sel, workspace: targetWs, project: reparent(sel.project, project, to) }, "replace");
          if (parent !== undefined)
            message.success(`已放进「${targetWs === ws ? shortProjectLabel(parent) : shortPlaceLabel(targetWs, parent)}」`);
          else if (targetWs === ws) message.success("已移出来，放在顶层");
          else message.success(`已移动到工作区「${targetWs}」`);
        }),
      openProjectFolder: (project) => run(() => api.openFolder(ws, project)),

      newTodo: (project, title = "", open = true) =>
        run(async () => {
          const s = await api.createTodo(ws, project, title);
          updateTodos(ws, project, (todos) => [...todos, s]);
          reveal(ws, project);
          if (open) {
            // 新建的待办开在固定的标签里
            keepTodoTab({ workspace: ws, project, todoId: s.id });
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
      togglePinned: (project, t) =>
        run(async () => {
          patchTodo(ws, project, await api.setTodoPinned(ws, project, t.id, !t.pinned));
        }),
      deleteTodo: (project, t) =>
        confirmDelete(`删除待办「${displayTitle(t).text}」？`, "将被移到回收站，可以在回收站里恢复。", async () => {
          const isSel = isSelTodo(project, t.id);
          if (isSel) await flushEditor();
          const rid = await api.deleteTodo(ws, project, t.id);
          if (isSel) {
            editorRef.current?.detach();
            setSel({ workspace: ws, project });
          }
          forgetTodoState(ws, project, t.id);
          updateTodos(ws, project, (todos) => todos.filter((x) => x.id !== t.id));
          // 撤销时，删的是正打开着的那条就重新打开它
          undoDelete(`已删除待办「${displayTitle(t).text}」`, [rid], async ({ restored }) => {
            const r = restored[0];
            if (!isSel || !r?.project || !r.todoId) return;
            await reloadRef.current();
            setSel({ workspace: r.workspace, project: r.project, todoId: r.todoId });
          });
        }),
      moveTodo: (project, t, target, targetWs = ws) =>
        run(async () => {
          const isSel = isSelTodo(project, t.id);
          if (isSel) await flushEditor();
          const moved = await api.moveTodo(ws, project, t.id, targetWs, target);
          if (isSel) editorRef.current?.detach();
          moveTodoState(ws, project, t.id, [targetWs, target, moved.id]);
          await reload();
          reveal(targetWs, target);
          if (isSel) setSel({ workspace: targetWs, project: target, todoId: moved.id }, "replace");
          message.success(`已移动到「${targetWs === ws ? shortProjectLabel(target) : shortPlaceLabel(targetWs, target)}」`);
        }),
      reorderTodo: (project, id, targetId, place) =>
        run(async () => {
          const todos = tree?.projects.find((p) => p.name === project)?.todos;
          if (!todos) return;
          const { sortKey } = listOptions.get(ws);
          const ids = reorderedIds(sortTodos(todos, sortKey), id, targetId, place);
          await api.reorderTodos(ws, project, ids);
          const order = new Map(ids.map((x, i) => [x, i]));
          updateTodos(ws, project, (list) => list.map((t) => ({ ...t, order: order.get(t.id) ?? null })));
          if (sortKey !== "manual") {
            listOptions.set(ws, (o) => ({ ...o, sortKey: "manual" }));
            message.info(workspaces.length > 1 ? `「${ws}」已改为手动排序` : "已改为手动排序", 4);
          }
        }),
      openExternal: (project, t) =>
        run(async () => {
          if (isSelTodo(project, t.id)) await flushEditor();
          await api.openTodoExternal(ws, project, t.id);
        }),
      revealTodo: (project, t) => run(() => api.revealTodo(ws, project, t.id)),
    };
  };

  /**
   * 逐条执行 fn，返回成功的条数；有失败的弹出提示（失败的条数和第一条的原因），成功的照常算。
   * 多选的待办不会有打开着的（多选时右侧是批量操作，编辑器已经存好、关掉了），不用先存盘
   */
  const each = async (items: TodoAt[], fn: (x: TodoAt) => Promise<void>): Promise<number> => {
    let ok = 0;
    const errors: string[] = [];
    for (const x of items) {
      try {
        await fn(x);
        ok++;
      } catch (e) {
        errors.push(errMsg(e));
      }
    }
    if (errors.length) message.error(`${errors.length} 条没有成功：${errors[0]}`);
    return ok;
  };

  const batch: BatchActions = {
    setDone: async (items, done) => {
      const todo = items.filter((x) => x.todo.done !== done);
      const ok = await each(todo, async ({ workspace, project, todo: t }) =>
        patchTodo(workspace, project, await api.setTodoDone(workspace, project, t.id, done)),
      );
      if (ok) message.success(`已把 ${ok} 条标记为${done ? "已完成" : "未完成"}`);
      else if (!todo.length) message.info(`选中的都已经是${done ? "已完成" : "未完成"}的`);
    },
    setPinned: async (items, pinned) => {
      const todo = items.filter((x) => x.todo.pinned !== pinned);
      const ok = await each(todo, async ({ workspace, project, todo: t }) =>
        patchTodo(workspace, project, await api.setTodoPinned(workspace, project, t.id, pinned)),
      );
      if (ok) message.success(`已${pinned ? "置顶" : "取消置顶"} ${ok} 条`);
      else if (!todo.length) message.info(`选中的都已经${pinned ? "置顶" : "没有置顶"}`);
    },
    move: async (items, target, targetWs) => {
      const todo = items.filter((x) => x.workspace !== targetWs || x.project !== target);
      let selMoved: Selection | null = null;
      const ok = await each(todo, async ({ workspace, project, todo: t }) => {
        const moved = await api.moveTodo(workspace, project, t.id, targetWs, target);
        moveTodoState(workspace, project, t.id, [targetWs, target, moved.id]);
        if (sel.workspace === workspace && sel.project === project && sel.todoId === t.id)
          selMoved = { workspace: targetWs, project: target, todoId: moved.id };
      });
      // 重新加载完再取消多选：先取消的话右侧马上回到打开着的那条，它已经移走了，会闪一下「待办不存在」
      await reload();
      reveal(targetWs, target);
      if (selMoved) setSel(selMoved, "replace");
      clearPicked();
      if (ok) message.success(`已把 ${ok} 条移动到「${shortPlaceLabel(targetWs, target)}」`);
    },
    remove: (items) =>
      modal.confirm({
        title: `删除选中的 ${items.length} 条待办？`,
        content: "将被移到回收站，可以在回收站里恢复。",
        okText: "删除",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: async () => {
          const ids: string[] = [];
          const ok = await each(items, async ({ workspace, project, todo: t }) => {
            ids.push(await api.deleteTodo(workspace, project, t.id));
            forgetTodoState(workspace, project, t.id);
            updateTodos(workspace, project, (todos) => todos.filter((x) => x.id !== t.id));
          });
          clearPicked();
          if (ok) undoDelete(`已删除 ${ok} 条待办`, ids);
        },
      }),
  };

  // 侧栏的行只在自己的内容变了时才重新渲染，传给它们的操作要是不变的对象：每个工作区一个，调用时转给最新的 actionsFor
  const actionsRef = useRef(actionsFor);
  useEffect(() => {
    actionsRef.current = actionsFor;
  });
  // cache 是这个 useMemo 自己的，只在第一次要某个工作区的操作时放进去，放进去的对象不再变（转给最新的 actionsFor），
  // 正是要它在渲染之间保持不变
  // eslint-disable-next-line react-hooks/immutability
  const stableActions = useMemo(() => {
    const cache = new Map<string, Actions>();
    return (ws: string): Actions => {
      let a = cache.get(ws);
      if (!a) {
        const forward =
          (name: keyof Actions) =>
          (...args: unknown[]) =>
            (actionsRef.current(ws)[name] as (...a: unknown[]) => unknown)(...args);
        const names = Object.keys(actionsRef.current(ws)) as (keyof Actions)[];
        a = Object.fromEntries(names.map((k) => [k, forward(k)])) as unknown as Actions;
        cache.set(ws, a);
      }
      return a;
    };
  }, []);

  return { actionsFor, stableActions, batch };
}
