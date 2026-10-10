import {
  CheckCircleOutlined,
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  ExportOutlined,
  FlagOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  HomeOutlined,
  Html5Outlined,
  PlusOutlined,
  PushpinOutlined,
  SwapOutlined,
  TagOutlined,
  TagsOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { PRIORITIES } from "../priority";
import { isSubProject, parentOf, projectLabel, projectMoveProblem } from "../projects";
import type { ExportFormat, Priority, TodoSummary, WorkspaceTree } from "../types";
import type { TodoAt } from "./DragMove";
import { PriorityLabel } from "./TodoMarks";
import type { BatchActions } from "./workspaceActions";

/** 工作区视图里所有可触发的操作，由 WorkspaceView 实现，侧栏、概览、编辑器共用。项目都是路径（子项目是「父项目/子项目」） */
export interface Actions {
  goHome(): void;
  selectWorkspace(): void;
  selectProject(project: string): void;
  selectTodo(project: string, id: string): void;

  renameWorkspace(): void;
  deleteWorkspace(): void;
  openWorkspaceFolder(): void;
  /** 导出整个工作区（见 exportFlow.tsx） */
  exportWorkspace(format: ExportFormat): void;

  newProject(): void;
  /** 在顶层项目 parent 里新建子项目 */
  newSubProject(parent: string): void;
  renameProject(project: string): void;
  deleteProject(project: string): void;
  /** 连同其中的待办（和子项目）移到工作区 targetWorkspace 的顶层，或放进那里的顶层项目 targetParent 成为子项目 */
  moveProject(project: string, targetWorkspace: string, targetParent?: string): void;
  /**
   * 放在工作区 targetWorkspace 里的项目 sibling 的前面 / 后面：同一层是调整顺序，不在同一层是移过去放在那里；
   * 那个工作区改成手动排序
   */
  placeProject(project: string, targetWorkspace: string, sibling: string, place: "before" | "after"): void;
  /** 这个工作区的项目改成手动排序（manual 为 true）或按名称 */
  setManualProjectOrder(manual: boolean): void;
  openProjectFolder(project: string): void;
  /** 导出项目（连同子项目） */
  exportProject(project: string, format: ExportFormat): void;

  /** open=true 时创建后立即打开并聚焦标题；返回是否创建成功（失败时已弹出提示） */
  newTodo(project: string, title?: string, open?: boolean): Promise<boolean>;
  /** notify=true 时弹出提示（用快捷键操作时看不到鼠标点击的反馈） */
  toggleDone(project: string, t: TodoSummary, notify?: boolean): void;
  /** 置顶 / 取消置顶 */
  togglePinned(project: string, t: TodoSummary): void;
  /** 设置优先级 */
  setPriority(project: string, t: TodoSummary, priority: Priority): void;
  /** 改标签（tags 是全部标签）；返回是否存好了（没存好的已经提示过） */
  setTags(project: string, t: TodoSummary, tags: string[]): Promise<boolean>;
  /** 打开选标签的对话框（右键「标签…」） */
  editTags(project: string, t: TodoSummary): void;
  deleteTodo(project: string, t: TodoSummary): void;
  /** 移到另一个项目；targetWorkspace 不填时是同一工作区里的 */
  moveTodo(project: string, t: TodoSummary, target: string, targetWorkspace?: string): void;
  /** 调整顺序：挪到同一项目里 targetId 那条的前面 / 后面，没在手动排序时改成手动排序 */
  reorderTodo(project: string, id: string, targetId: string, place: "before" | "after"): void;
  openExternal(project: string, t: TodoSummary): void;
  revealTodo(project: string, t: TodoSummary): void;
  /** 导出这条待办 */
  exportTodo(project: string, t: TodoSummary, format: ExportFormat): void;
}

type Handler = NonNullable<MenuProps["onClick"]>;
type ClickInfo = Parameters<Handler>[0];

const EXPORT_PREFIX = "export:";

/** 「导出」和它的子菜单：导出为 HTML */
function exportItem(): NonNullable<MenuProps["items"]>[number] {
  return {
    key: "export",
    icon: <DownloadOutlined />,
    label: "导出",
    children: [{ key: `${EXPORT_PREFIX}html`, icon: <Html5Outlined />, label: "导出为 HTML" }],
  };
}

/** 点的是「导出」里的哪一种；不是导出时为 null */
const exportFormat = (key: string) => (key.startsWith(EXPORT_PREFIX) ? (key.slice(EXPORT_PREFIX.length) as ExportFormat) : null);

/** 菜单挂在树节点上：点击菜单项的事件会沿 React 树冒泡到节点的 onClick，这里统一拦下 */
function handler(fn: (key: string) => void): Handler {
  return ({ key, domEvent }: ClickInfo) => {
    domEvent.stopPropagation();
    fn(key);
  };
}

export function workspaceMenu(a: Actions): MenuProps {
  return {
    items: [
      { key: "new-project", icon: <PlusOutlined />, label: "新建项目" },
      { key: "rename", icon: <EditOutlined />, label: "重命名工作区" },
      { key: "folder", icon: <FolderOpenOutlined />, label: "在资源管理器中打开" },
      exportItem(),
      { type: "divider" },
      { key: "home", icon: <HomeOutlined />, label: "返回首页" },
      { key: "delete", icon: <DeleteOutlined />, label: "删除工作区", danger: true },
    ],
    onClick: handler((key) => {
      const format = exportFormat(key);
      if (format) a.exportWorkspace(format);
      else if (key === "new-project") a.newProject();
      else if (key === "rename") a.renameWorkspace();
      else if (key === "folder") a.openWorkspaceFolder();
      else if (key === "home") a.goHome();
      else if (key === "delete") a.deleteWorkspace();
    }),
  };
}

/** targets：「移动到」列出的地方（moveTargets，第一组是项目所在的工作区） */
export function projectMenu(a: Actions, project: string, targets: readonly MoveTarget[]): MenuProps {
  const move = projectMoveItems(project, targets);
  return {
    items: [
      { key: "new-todo", icon: <PlusOutlined />, label: "新建待办" },
      // 只有一层子项目：子项目里不能再建
      ...(isSubProject(project) ? [] : [{ key: "new-sub", icon: <FolderAddOutlined />, label: "新建子项目" }]),
      { key: "rename", icon: <EditOutlined />, label: "重命名" },
      {
        key: "move",
        icon: <SwapOutlined />,
        label: "移动到",
        disabled: move.length === 0,
        children: move.length ? move : undefined,
        popupClassName: "move-menu",
      },
      { key: "folder", icon: <FolderOpenOutlined />, label: "在资源管理器中打开" },
      exportItem(),
      { type: "divider" },
      { key: "delete", icon: <DeleteOutlined />, label: "删除项目", danger: true },
    ],
    onClick: handler((key) => {
      const format = exportFormat(key);
      if (key.startsWith(PROJECT_MOVE_PREFIX)) {
        const [workspace, parent] = JSON.parse(key.slice(PROJECT_MOVE_PREFIX.length)) as [string, string];
        a.moveProject(project, workspace, parent || undefined);
      } else if (format) a.exportProject(project, format);
      else if (key === "new-todo") a.newTodo(project, "", true);
      else if (key === "new-sub") a.newSubProject(project);
      else if (key === "rename") a.renameProject(project);
      else if (key === "folder") a.openProjectFolder(project);
      else if (key === "delete") a.deleteProject(project);
    }),
  };
}

/** 「移动到」里一个工作区的项目（路径，子项目跟在父项目后面） */
export interface MoveTarget {
  workspace: string;
  projects: string[];
}

/** 待办可以移到的项目：侧栏里同时显示的各工作区（trees）的项目，待办所在的工作区排第一，其余按侧栏里的顺序 */
export function moveTargets(trees: readonly WorkspaceTree[], workspace: string): MoveTarget[] {
  const own = trees.filter((t) => t.name === workspace);
  const others = trees.filter((t) => t.name !== workspace);
  return [...own, ...others].map((t) => ({ workspace: t.name, projects: t.projects.map((p) => p.name) }));
}

const MOVE_PREFIX = "move:";
const moveKey = (workspace: string, project: string) => MOVE_PREFIX + JSON.stringify([workspace, project]);

/**
 * 「移动到」的子菜单：只显示一个工作区时直接列出同一工作区的其他项目；同时显示了几个工作区时，
 * 按工作区分组列出（所在的工作区排第一，标上「当前」），没有可移去的项目的工作区不列
 */
function moveItems(project: string, targets: readonly MoveTarget[]): NonNullable<MenuProps["items"]> {
  const [own, ...others] = targets;
  const item = (workspace: string, p: string) => ({
    key: moveKey(workspace, p),
    icon: <FolderOutlined />,
    label: projectLabel(p),
  });
  const ownItems = own ? own.projects.filter((p) => p !== project).map((p) => item(own.workspace, p)) : [];
  if (!others.length) return ownItems;
  const groups = [
    { workspace: own?.workspace, label: own && `${own.workspace}（当前）`, children: ownItems },
    ...others.map((t) => ({ workspace: t.workspace, label: t.workspace, children: t.projects.map((p) => item(t.workspace, p)) })),
  ];
  return groups
    .filter((g) => g.children.length)
    .map((g) => ({ type: "group" as const, key: `group:${g.workspace}`, label: g.label, children: g.children }));
}

const PROJECT_MOVE_PREFIX = "move-project:";

/**
 * 项目的「移动到」的子菜单：放进别的顶层项目成为子项目，或移到工作区的顶层（子项目移出来、移到别的工作区）。
 * 只显示一个工作区时直接列出；同时显示了几个工作区时按工作区分组（所在的工作区排第一，标上「当前」）。
 * 已经在那里的、放不进去的（它自己、子项目里，有子项目的项目放进别的项目）不列；那里已有同名的列出来但不能点
 */
function projectMoveItems(project: string, targets: readonly MoveTarget[]): NonNullable<MenuProps["items"]> {
  const [own, ...others] = targets;
  if (!own) return [];
  const from = own.projects.map((name) => ({ name }));
  const parentNow = parentOf(project);
  const choices = (t: MoveTarget) => {
    const to = t.projects.map((name) => ({ name }));
    const places = [undefined, ...t.projects.filter((p) => !isSubProject(p))];
    return places.flatMap((parent) => {
      const problem = projectMoveProblem({ project, from, to, sameWorkspace: t === own, parent });
      if (problem && problem.code !== "taken") return [];
      const top = t === own && parentNow !== undefined ? `顶层（移出「${parentNow}」）` : "顶层";
      const label = parent === undefined ? top : parent;
      return [
        {
          key: PROJECT_MOVE_PREFIX + JSON.stringify([t.workspace, parent ?? ""]),
          icon: <FolderOutlined />,
          label: problem ? `${label}（已有同名的）` : label,
          disabled: !!problem,
        },
      ];
    });
  };
  const ownItems = choices(own);
  if (!others.length) return ownItems;
  const groups = [
    { workspace: own.workspace, label: `${own.workspace}（当前）`, children: ownItems },
    ...others.map((t) => ({ workspace: t.workspace, label: t.workspace, children: choices(t) })),
  ];
  return groups
    .filter((g) => g.children.length)
    .map((g) => ({ type: "group" as const, key: `group:${g.workspace}`, label: g.label, children: g.children }));
}

const PRIORITY_PREFIX = "priority:";

/** 「优先级」子菜单的几项（从高到低，小旗子和文字）；current 是现在的，后面打勾 */
function priorityItems(prefix: string, current?: Priority): NonNullable<MenuProps["items"]> {
  return PRIORITIES.map((p) => ({
    key: prefix + p,
    label: <PriorityLabel priority={p} />,
    extra: p === current ? <CheckOutlined /> : undefined,
  }));
}

const priorityOf = (key: string, prefix: string) => Number(key.slice(prefix.length)) as Priority;

/** targets：可以移到的项目（moveTargets），第一组是待办所在的工作区 */
export function todoMenu(a: Actions, project: string, t: TodoSummary, targets: readonly MoveTarget[]): MenuProps {
  const move = moveItems(project, targets);
  const ownWorkspace = targets[0]?.workspace;
  return {
    items: [
      { key: "open", icon: <ExportOutlined />, label: "用默认程序打开" },
      {
        key: "done",
        icon: t.done ? <UndoOutlined /> : <CheckCircleOutlined />,
        label: t.done ? "标记为未完成" : "标记为已完成",
      },
      { key: "pin", icon: <PushpinOutlined />, label: t.pinned ? "取消置顶" : "置顶" },
      { key: "priority", icon: <FlagOutlined />, label: "优先级", children: priorityItems(PRIORITY_PREFIX, t.priority) },
      { key: "tags", icon: <TagsOutlined />, label: "标签…" },
      {
        key: "move",
        icon: <SwapOutlined />,
        label: "移动到",
        disabled: move.length === 0,
        children: move.length ? move : undefined,
        // 项目多（几个工作区一起列出）时子菜单可以滚动，不超出窗口
        popupClassName: "move-menu",
      },
      { key: "reveal", icon: <FolderOpenOutlined />, label: "在资源管理器中显示" },
      exportItem(),
      { type: "divider" },
      { key: "delete", icon: <DeleteOutlined />, label: "删除", danger: true },
    ],
    onClick: handler((key) => {
      const format = exportFormat(key);
      if (key.startsWith(MOVE_PREFIX)) {
        const [workspace, target] = JSON.parse(key.slice(MOVE_PREFIX.length)) as [string, string];
        a.moveTodo(project, t, target, workspace === ownWorkspace ? undefined : workspace);
      } else if (format) a.exportTodo(project, t, format);
      else if (key.startsWith(PRIORITY_PREFIX)) a.setPriority(project, t, priorityOf(key, PRIORITY_PREFIX));
      else if (key === "open") a.openExternal(project, t);
      else if (key === "done") a.toggleDone(project, t);
      else if (key === "pin") a.togglePinned(project, t);
      else if (key === "tags") a.editTags(project, t);
      else if (key === "reveal") a.revealTodo(project, t);
      else if (key === "delete") a.deleteTodo(project, t);
    }),
  };
}

const BATCH_MOVE_PREFIX = "batch-move:";
const BATCH_PRIORITY_PREFIX = "batch-priority:";

/** 批量「设置优先级」的菜单 */
export function batchPriorityMenu(onSet: (p: Priority) => void): MenuProps {
  return {
    items: priorityItems(BATCH_PRIORITY_PREFIX),
    onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation();
      onSet(priorityOf(key, BATCH_PRIORITY_PREFIX));
    },
  };
}


/** 「移动到」的菜单：侧栏里显示的各工作区的项目，按工作区分组（只显示一个工作区时不分组） */
export function batchMoveMenu(targets: readonly MoveTarget[], onMove: (workspace: string, project: string) => void): MenuProps {
  const item = (workspace: string, p: string) => ({
    key: BATCH_MOVE_PREFIX + JSON.stringify([workspace, p]),
    icon: <FolderOutlined />,
    label: projectLabel(p),
  });
  const items: NonNullable<MenuProps["items"]> =
    targets.length === 1
      ? targets[0].projects.map((p) => item(targets[0].workspace, p))
      : targets
          .filter((t) => t.projects.length)
          .map((t) => ({ type: "group" as const, key: `group:${t.workspace}`, label: t.workspace, children: t.projects.map((p) => item(t.workspace, p)) }));
  return {
    items,
    className: "move-menu",
    onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation();
      const [workspace, project] = JSON.parse(key.slice(BATCH_MOVE_PREFIX.length)) as [string, string];
      onMove(workspace, project);
    },
  };
}

/** 多选的待办在右键菜单里能做的事 */
export function batchMenu(items: TodoAt[], targets: readonly MoveTarget[], a: BatchActions, clear: () => void): MenuProps {
  const move = batchMoveMenu(targets, (ws, p) => a.move(items, p, ws));
  return {
    items: [
      { key: "done", icon: <CheckCircleOutlined />, label: `${items.length} 条标记为已完成` },
      { key: "undone", icon: <UndoOutlined />, label: "标记为未完成" },
      { key: "pin", icon: <PushpinOutlined />, label: "置顶" },
      { key: "unpin", icon: <PushpinOutlined />, label: "取消置顶" },
      { key: "priority", icon: <FlagOutlined />, label: "设置优先级", children: priorityItems(BATCH_PRIORITY_PREFIX) },
      { key: "add-tags", icon: <TagsOutlined />, label: "添加标签…" },
      { key: "remove-tags", icon: <TagOutlined />, label: "移除标签…" },
      { key: "move", icon: <SwapOutlined />, label: "移动到", children: move.items, popupClassName: "move-menu" },
      { type: "divider" },
      { key: "clear", icon: <CloseOutlined />, label: "取消选择" },
      { key: "delete", icon: <DeleteOutlined />, label: `删除 ${items.length} 条`, danger: true },
    ],
    onClick: (info) => {
      info.domEvent.stopPropagation();
      const { key } = info;
      if (key.startsWith(BATCH_MOVE_PREFIX)) move.onClick?.(info);
      else if (key.startsWith(BATCH_PRIORITY_PREFIX)) a.setPriority(items, priorityOf(key, BATCH_PRIORITY_PREFIX));
      else if (key === "done" || key === "undone") a.setDone(items, key === "done");
      else if (key === "pin" || key === "unpin") a.setPinned(items, key === "pin");
      else if (key === "add-tags") a.addTags(items);
      else if (key === "remove-tags") a.removeTags(items);
      else if (key === "delete") a.remove(items);
      else if (key === "clear") clear();
    },
  };
}
