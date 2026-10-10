import { App as AntApp } from "antd";
import { useEffect, useMemo, useRef } from "react";
import { api, errMsg } from "../api";
import type { How } from "../navHistory";
import {
  deepTodos,
  inProject,
  isSubProject,
  leafName,
  levelNames,
  parentOf,
  projectLabel,
  reorderedNames,
  reparent,
  subProjectsOf,
  topProjects,
  withProjectOrder,
} from "../projects";
import { dropTagFromFilter, renameTagInFilter, setFilter } from "../filter";
import { addTags, allTodos, cleanTag, countTags, MAX_TAG_CHARS, removeTags, sameTag } from "../tags";
import { priorityText } from "../priority";
import type { Priority, TodoSummary, WorkspaceTree } from "../types";
import type { TodoAt } from "./DragMove";
import { useExport } from "./exportFlow";
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
import type { TagOption, useTagDialog } from "./TagDialog";
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
  /**
   * 结构性操作（重命名、移动、删除）、导出之前先把编辑器里的内容落盘；返回是否存好了（没打开着待办也算），
   * 正文有冲突（弹出了冲突对话框）、保存失败（已提示）时为 false
   */
  flushEditor: () => Promise<boolean>;
  editorRef: React.RefObject<EditorHandle | null>;
  openDialog: ReturnType<typeof useNameDialog>[1];
  /** 选标签的对话框（右键「标签…」、批量添加 / 移除标签） */
  openTagDialog: ReturnType<typeof useTagDialog>[1];
  collapsed: PerWorkspace<Collapsed>;
  listOptions: PerWorkspace<ListOptions>;
  /** 展开工作区（WS_KEY）或项目 */
  expand: (ws: string, key: string) => void;
  /** 展开项目所在的分支（工作区、父项目和它自己） */
  reveal: (ws: string, project?: string) => void;
  updateTodos: (ws: string, project: string, fn: (todos: TodoSummary[]) => TodoSummary[]) => void;
  /** 改一个已加载的工作区（项目的顺序），改完按项目的顺序重新排 */
  updateTree: (ws: string, fn: (t: WorkspaceTree) => WorkspaceTree) => void;
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
  /** 设成同一个优先级（已经是的不动） */
  setPriority(items: TodoAt[], priority: Priority): void;
  /** 选几个标签加到每一条上（已经有的不重复加） */
  addTags(items: TodoAt[]): void;
  /** 从选中的待办上有的标签里选几个去掉 */
  removeTags(items: TodoAt[]): void;
  /** 移到 targetWs 的项目 target；已经在那里的不动 */
  move(items: TodoAt[], target: string, targetWs: string): void;
  /** 确认后删除 */
  remove(items: TodoAt[]): void;
}

/** 标签本身的操作（侧栏「筛选」的弹出框里），作用于侧栏里显示的各工作区的全部待办 */
export interface TagActions {
  /** 改名（改成已有的就是合并） */
  rename(tag: string): void;
  /** 先确认，再从带它的待办上去掉 */
  remove(tag: string): void;
}

/**
 * 工作区视图里所有可触发的操作（Actions，见 menus.tsx），侧栏、概览、编辑器共用。
 * actionsFor(ws) 每次渲染都是新的，用的是这次渲染的状态；stableActions(ws) 是不变的对象（每个工作区一个），
 * 调用时转给最新的 actionsFor，传给侧栏里用 memo 的行
 */
export function useWorkspaceActions(ctx: ActionContext) {
  const { message, modal } = AntApp.useApp();
  const undoDelete = useUndoDelete();
  const runExport = useExport();
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
    openTagDialog,
    collapsed,
    listOptions,
    expand,
    reveal,
    updateTodos,
    updateTree,
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
   * 项目改名、移动后，它和子项目的折叠状态跟过去：fromWs 里的 from（路径）→ toWs 里的 to。
   * 先按现在的状态算好要搬的，再分别改两个工作区（可以是同一个）
   */
  const moveCollapsed = (fromWs: string, from: string, toWs: string, to: string) => {
    const moved: Collapsed = {};
    for (const [k, v] of Object.entries(collapsed.get(fromWs)))
      if (k !== WS_KEY && inProject(k, from)) moved[reparent(k, from, to)] = v;
    setCollapsed(fromWs, (c) => Object.fromEntries(Object.entries(c).filter(([k]) => k === WS_KEY || !inProject(k, from))));
    setCollapsed(toWs, (c) => ({ ...c, ...moved }));
  };

  /**
   * 右侧打开着的待办先存盘：存不上（弹出了冲突对话框、保存失败已提示）时抛出，what 这个操作不做（不 detach，
   * 冲突对话框留着让用户先处理）；抛出的原因在重命名的对话框里显示，别的操作经 run 提示
   */
  const saveFirst = async (what: string) => {
    if (!(await flushEditor())) throw new Error(`打开着的待办还没保存好，先处理好再${what}`);
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

  /** 侧栏里显示的工作区用过的标签和几条有，用得多的在前 */
  const shownTags = () => countTags(allTodos(workspaces.map(treeOf).filter((t) => t !== undefined)));

  /** 选标签时下拉里列出的：侧栏里显示的工作区用过的标签，后面写着几条 */
  const tagOptions = (): TagOption[] => shownTags().map((c) => ({ name: c.name, note: `${c.count} 条` }));

  /** 对话框里写明作用于哪些工作区 */
  const shownWorkspaces = () =>
    workspaces.length > 1 ? `侧栏里显示的 ${workspaces.length} 个工作区（${workspaces.join("、")}）` : `工作区「${workspaces[0]}」`;

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
    /** 右侧显示的是这个项目或它的子项目（概览或其中的待办）：改名、移动、删除它时要先存盘、跟过去 */
    const showsProject = (project: string) => inSel && sel.project !== undefined && inProject(sel.project, project);
    const isSelTodo = (project: string, id: string) => isSelProject(project) && sel.todoId === id;

    /**
     * 项目移到工作区 targetWs 的顶层，或那里的顶层项目 parent 里成为子项目；order 是放下的位置（那一层从前到后的名字），
     * 不给时在那里排在后面。先存盘，状态（标签、编辑位置、折叠等）跟过去
     */
    const moveProjectTo = async (project: string, targetWs: string, parent: string | undefined, order?: string[]) => {
      const isSel = showsProject(project);
      if (isSel) await saveFirst("移动");
      // 移过去后的路径：放进项目后是「父项目/名字」，子项目移出来后是名字
      const to = await api.moveProject(ws, project, targetWs, parent, order);
      if (isSel) editorRef.current?.detach();
      moveProjectState(ws, project, targetWs, to);
      // 折叠状态跟过去；展开目标工作区、放进的项目，看得到移过去的项目
      moveCollapsed(ws, project, targetWs, to);
      reveal(targetWs, to);
      await reload();
      if (isSel && sel.project)
        setSel({ ...sel, workspace: targetWs, project: reparent(sel.project, project, to) }, "replace");
      const there = targetWs === ws ? "" : `${targetWs} / `;
      if (parent !== undefined) message.success(`已放进「${there}${parent}」`);
      else if (targetWs === ws) message.success(order ? "已移出来" : "已移出来，放在顶层");
      else message.success(`已移动到工作区「${targetWs}」`);
    };

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
            if (inSel) await saveFirst("重命名");
            const name = await api.renameWorkspace(ws, v);
            if (inSel) editorRef.current?.detach();
            renameWorkspaceMemory(ws, name);
            setWorkspaces((list) => sortNames(list.map((w) => (w === ws ? name : w))));
            if (inSel) setSel({ ...sel, workspace: name }, "replace");
            message.success("已重命名");
          },
        }),
      deleteWorkspace: () => {
        // 同首页的卡片：项目数只算顶层项目（子项目不另算），待办数包括子项目里的
        const projects = tree?.projects ?? [];
        const count = projects.reduce((n, p) => n + p.todos.length, 0);
        confirmDelete(
          `删除工作区「${ws}」？`,
          `其中的 ${topProjects(projects).length} 个项目、${count} 条待办将一并移到回收站，可以在回收站里恢复。`,
          async () => {
            if (inSel) await saveFirst("删除");
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
      exportWorkspace: (format) =>
        runExport({
          format,
          scope: "workspace",
          workspace: ws,
          sortKey: listOptions.get(ws).sortKey,
          flush: () => (inSel ? flushEditor() : Promise.resolve(true)),
        }),

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
          label: `在项目「${workspaces.length > 1 ? `${ws} / ` : ""}${parent}」中新建子项目`,
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
            if (isSel) await saveFirst("重命名");
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
        const subs = subProjectsOf(projects, project).length;
        confirmDelete(
          `删除${isSubProject(project) ? "子项目" : "项目"}「${projectLabel(project)}」？`,
          `其中的 ${subs ? `${subs} 个子项目、` : ""}${count} 条待办将一并移到回收站，可以在回收站里恢复。`,
          async () => {
            const isSel = showsProject(project);
            if (isSel) await saveFirst("删除");
            const rid = await api.deleteProject(ws, project);
            if (isSel) {
              editorRef.current?.detach();
              setSel({ workspace: ws });
            }
            forgetProjectState(ws, project);
            await reload();
            undoDelete(`已删除${isSubProject(project) ? "子项目" : "项目"}「${projectLabel(project)}」`, [rid]);
          },
        );
      },
      moveProject: (project, targetWs, parent) => run(() => moveProjectTo(project, targetWs, parent)),
      placeProject: (project, targetWs, sibling, place) =>
        run(async () => {
          const target = treeOf(targetWs);
          if (!target) return;
          // 那一层现在的顺序（含藏起来的），把它放到 sibling 旁边
          const parent = parentOf(sibling);
          const names = reorderedNames(levelNames(target.projects, parent), leafName(project), leafName(sibling), place);
          const wasManual = target.manualOrder;
          if (targetWs === ws && parentOf(project) === parent) {
            await api.reorderProjects(ws, parent, names);
            updateTree(ws, (t) => withProjectOrder(t, parent, names));
          } else await moveProjectTo(project, targetWs, parent, names);
          if (!wasManual)
            message.info(workspaces.length > 1 ? `「${targetWs}」的项目已改为手动排序` : "项目已改为手动排序", 4);
        }),
      setManualProjectOrder: (manual) =>
        run(async () => {
          if (!tree || tree.manualOrder === manual) return;
          await api.setProjectsManual(ws, manual);
          updateTree(ws, (t) => ({ ...t, manualOrder: manual }));
        }),
      openProjectFolder: (project) => run(() => api.openFolder(ws, project)),
      exportProject: (project, format) =>
        runExport({
          format,
          scope: "project",
          workspace: ws,
          project,
          sortKey: listOptions.get(ws).sortKey,
          flush: () => (showsProject(project) ? flushEditor() : Promise.resolve(true)),
        }),

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
      setPriority: (project, t, priority) =>
        run(async () => {
          patchTodo(ws, project, await api.setTodoPriority(ws, project, t.id, priority));
        }),
      setTags: (project, t, tags) =>
        run(async () => {
          patchTodo(ws, project, await api.setTodoTags(ws, project, t.id, tags));
        }),
      editTags: (project, t) =>
        openTagDialog({
          title: "标签",
          label: `「${displayTitle(t).text}」的标签`,
          initial: t.tags,
          options: tagOptions(),
          creatable: true,
          onSubmit: async (tags) => {
            patchTodo(ws, project, await api.setTodoTags(ws, project, t.id, tags));
          },
        }),
      deleteTodo: (project, t) =>
        confirmDelete(`删除待办「${displayTitle(t).text}」？`, "将被移到回收站，可以在回收站里恢复。", async () => {
          const isSel = isSelTodo(project, t.id);
          if (isSel) await saveFirst("删除");
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
          if (isSel) await saveFirst("移动");
          const moved = await api.moveTodo(ws, project, t.id, targetWs, target);
          if (isSel) editorRef.current?.detach();
          moveTodoState(ws, project, t.id, [targetWs, target, moved.id]);
          await reload();
          reveal(targetWs, target);
          if (isSel) setSel({ workspace: targetWs, project: target, todoId: moved.id }, "replace");
          const where = projectLabel(target);
          message.success(`已移动到「${targetWs === ws ? where : `${targetWs} / ${where}`}」`);
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
          // 用默认程序打开的是磁盘上的文件：没存好时那边看到的是旧的内容
          if (isSelTodo(project, t.id)) await saveFirst("用默认程序打开");
          await api.openTodoExternal(ws, project, t.id);
        }),
      revealTodo: (project, t) => run(() => api.revealTodo(ws, project, t.id)),
      exportTodo: (project, t, format) =>
        runExport({
          format,
          scope: "todo",
          workspace: ws,
          project,
          todo: t.id,
          sortKey: listOptions.get(ws).sortKey,
          flush: () => (isSelTodo(project, t.id) ? flushEditor() : Promise.resolve(true)),
        }),
    };
  };

  /**
   * 逐条执行 fn，返回成功的条数；有失败的弹出提示（失败的条数和第一条的原因），成功的照常算。
   * 多选的待办不会有打开着的（多选时右侧是批量操作，编辑器已经关掉了，关掉时存好了，存不上的另存成了新待办），
   * 不用先存盘
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
    setPriority: async (items, priority) => {
      const todo = items.filter((x) => x.todo.priority !== priority);
      const ok = await each(todo, async ({ workspace, project, todo: t }) =>
        patchTodo(workspace, project, await api.setTodoPriority(workspace, project, t.id, priority)),
      );
      if (ok) message.success(`已把 ${ok} 条设为${priorityText(priority)}`);
      else if (!todo.length) message.info(`选中的都已经是${priorityText(priority)}`);
    },
    addTags: (items) =>
      openTagDialog({
        title: `给选中的 ${items.length} 条待办添加标签`,
        label: "加到每一条上，已经有的不重复加",
        initial: [],
        options: tagOptions(),
        creatable: true,
        required: true,
        okText: "添加",
        onSubmit: async (tags) => {
          const todo = items.filter((x) => addTags(x.todo.tags, tags) !== x.todo.tags);
          const ok = await each(todo, async ({ workspace, project, todo: t }) =>
            patchTodo(workspace, project, await api.setTodoTags(workspace, project, t.id, [...addTags(t.tags, tags)])),
          );
          if (ok) message.success(`已给 ${ok} 条添加标签「${tags.join("、")}」`);
          else if (!todo.length) message.info("选中的都已经有这些标签");
        },
      }),
    removeTags: (items) => {
      const used = countTags(items.map((x) => x.todo));
      if (!used.length) {
        message.info("选中的待办都没有标签");
        return;
      }
      openTagDialog({
        title: `从选中的 ${items.length} 条待办上移除标签`,
        label: "待办本身不删除",
        initial: [],
        options: used.map((c) => ({ name: c.name, note: `${c.count} 条有` })),
        creatable: false,
        required: true,
        okText: "移除",
        onSubmit: async (tags) => {
          const todo = items.filter((x) => removeTags(x.todo.tags, tags) !== x.todo.tags);
          const ok = await each(todo, async ({ workspace, project, todo: t }) =>
            patchTodo(workspace, project, await api.setTodoTags(workspace, project, t.id, [...removeTags(t.tags, tags)])),
          );
          if (ok) message.success(`已从 ${ok} 条上移除标签「${tags.join("、")}」`);
        },
      });
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
      if (ok) message.success(`已把 ${ok} 条移动到「${targetWs} / ${projectLabel(target)}」`);
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

  const tags: TagActions = {
    rename: (tag) =>
      openDialog({
        title: `重命名标签「${tag}」`,
        label: `${shownWorkspaces()}里带这个标签的待办一起改；改成已有的标签就是合并到它`,
        initial: tag,
        maxLength: MAX_TAG_CHARS,
        okText: "改名",
        onSubmit: async (v) => {
          const r = cleanTag(v);
          if ("error" in r) throw new Error(r.error);
          if (r.tag === tag) return;
          const merging = shownTags().some((c) => sameTag(c.name, r.tag) && !sameTag(c.name, tag));
          const n = await api.renameTag(workspaces, tag, r.tag);
          setFilter((f) => renameTagInFilter(f, tag, r.tag));
          await reload();
          message.success(merging ? `已把「${tag}」合并到「${r.tag}」（${n} 条）` : `已把标签「${tag}」改名为「${r.tag}」（${n} 条）`);
        },
      }),
    remove: (tag) => {
      const count = shownTags().find((c) => sameTag(c.name, tag))?.count ?? 0;
      modal.confirm({
        title: `删除标签「${tag}」？`,
        content: `将从${shownWorkspaces()}的 ${count} 条待办上去掉这个标签，待办本身不删除。`,
        okText: "删除",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: () =>
          run(async () => {
            const n = await api.removeTag(workspaces, tag);
            setFilter((f) => dropTagFromFilter(f, tag));
            await reload();
            message.success(`已从 ${n} 条待办上删除标签「${tag}」`);
          }),
      });
    },
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

  return { actionsFor, stableActions, batch, tags };
}
