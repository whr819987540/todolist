import {
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  HomeOutlined,
  PlusOutlined,
  SwapOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import type { TodoSummary, WorkspaceTree } from "../types";

/** 工作区视图里所有可触发的操作，由 WorkspaceView 实现，侧栏、概览、编辑器共用 */
export interface Actions {
  goHome(): void;
  selectWorkspace(): void;
  selectProject(project: string): void;
  selectTodo(project: string, id: string): void;

  renameWorkspace(): void;
  deleteWorkspace(): void;
  openWorkspaceFolder(): void;

  newProject(): void;
  renameProject(project: string): void;
  deleteProject(project: string): void;
  /** 连同其中的待办移到另一个工作区 */
  moveProject(project: string, targetWorkspace: string): void;
  openProjectFolder(project: string): void;

  /** open=true 时创建后立即打开并聚焦标题；返回是否创建成功（失败时已弹出提示） */
  newTodo(project: string, title?: string, open?: boolean): Promise<boolean>;
  /** notify=true 时弹出提示（用快捷键操作时看不到鼠标点击的反馈） */
  toggleDone(project: string, t: TodoSummary, notify?: boolean): void;
  deleteTodo(project: string, t: TodoSummary): void;
  /** 移到另一个项目；targetWorkspace 不填时是同一工作区里的 */
  moveTodo(project: string, t: TodoSummary, target: string, targetWorkspace?: string): void;
  openExternal(project: string, t: TodoSummary): void;
  revealTodo(project: string, t: TodoSummary): void;
}

type Handler = NonNullable<MenuProps["onClick"]>;
type ClickInfo = Parameters<Handler>[0];

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
      { type: "divider" },
      { key: "home", icon: <HomeOutlined />, label: "返回首页" },
      { key: "delete", icon: <DeleteOutlined />, label: "删除工作区", danger: true },
    ],
    onClick: handler((key) => {
      if (key === "new-project") a.newProject();
      else if (key === "rename") a.renameWorkspace();
      else if (key === "folder") a.openWorkspaceFolder();
      else if (key === "home") a.goHome();
      else if (key === "delete") a.deleteWorkspace();
    }),
  };
}

export function projectMenu(a: Actions, project: string): MenuProps {
  return {
    items: [
      { key: "new-todo", icon: <PlusOutlined />, label: "新建待办" },
      { key: "rename", icon: <EditOutlined />, label: "重命名" },
      { key: "folder", icon: <FolderOpenOutlined />, label: "在资源管理器中打开" },
      { type: "divider" },
      { key: "delete", icon: <DeleteOutlined />, label: "删除项目", danger: true },
    ],
    onClick: handler((key) => {
      if (key === "new-todo") a.newTodo(project, "", true);
      else if (key === "rename") a.renameProject(project);
      else if (key === "folder") a.openProjectFolder(project);
      else if (key === "delete") a.deleteProject(project);
    }),
  };
}

/** 「移动到」里一个工作区的项目 */
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
  const item = (workspace: string, p: string) => ({ key: moveKey(workspace, p), icon: <FolderOutlined />, label: p });
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
      { type: "divider" },
      { key: "delete", icon: <DeleteOutlined />, label: "删除", danger: true },
    ],
    onClick: handler((key) => {
      if (key.startsWith(MOVE_PREFIX)) {
        const [workspace, target] = JSON.parse(key.slice(MOVE_PREFIX.length)) as [string, string];
        a.moveTodo(project, t, target, workspace === ownWorkspace ? undefined : workspace);
      } else if (key === "open") a.openExternal(project, t);
      else if (key === "done") a.toggleDone(project, t);
      else if (key === "reveal") a.revealTodo(project, t);
      else if (key === "delete") a.deleteTodo(project, t);
    }),
  };
}
