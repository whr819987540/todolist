/**
 * 数据目录在外部变了时 Rust 端发给主窗口的 data-changed（src-tauri/src/watch.rs：一阵变化合起来、去掉了不算的和
 * 软件自己写的）。首页、工作区视图、打开着的待办、回收站据此决定要不要刷新，只刷新有变化的部分。
 * 快速记录存好后、从回收站恢复后、离开待办时另存了一条后发的 data-changed 不带这些（null / undefined）：
 * 是软件自己新建、恢复的，数据有变化、具体哪里不知道
 */
export interface DataChanged {
  /** 什么都可能变了（一次变了很多处等）：全部刷新，这时 paths 是空的 */
  all: boolean;
  /**
   * 变了的路径，相对数据目录、用 / 分隔：工作区、项目、子项目的文件夹，待办的正文（「工作区/项目/id.md」，
   * 子项目里的是「工作区/父项目/子项目/id.md」），元数据（「工作区/项目/.todos.json」）
   */
  paths: string[];
  /** 软件的回收站有变化 */
  recycle: boolean;
}

/** data-changed 带的内容：Rust 端监听到的，或者不带（软件自己新建、恢复了东西） */
export type DataChange = DataChanged | null | undefined;

/** 工作区、项目、待办有没有可能变了（首页据此重新统计）；只是回收站变了的不算 */
export function dataTouched(c: DataChange): boolean {
  return !c || c.all || c.paths.length > 0;
}

/** 这几个工作区里有没有可能变了（工作区视图只重新加载侧栏里选中的工作区） */
export function workspacesTouched(c: DataChange, workspaces: readonly string[]): boolean {
  if (!c || c.all) return true;
  return c.paths.some((p) => workspaces.includes(p.split("/")[0]));
}

/**
 * 打开着的这条待办的正文文件有没有可能在外部变了：它自己变了，或者它所在的项目、工作区的文件夹改名、删掉了。
 * 只是元数据变了的（标题、完成状态等）不算，那些随工作区视图的刷新过来；不带内容的也不算（软件自己新建、恢复的，不动这条）
 */
export function todoTouched(c: DataChange, workspace: string, project: string, id: string): boolean {
  if (!c) return false;
  if (c.all) return true;
  const file = `${workspace}/${project}/${id}.md`;
  return c.paths.some((p) => file === p || file.startsWith(`${p}/`));
}

/** 软件的回收站有没有可能变了（开着的回收站据此刷新列表）；不带内容的也算（从回收站恢复了东西） */
export function recycleTouched(c: DataChange): boolean {
  return !c || c.all || c.recycle;
}
