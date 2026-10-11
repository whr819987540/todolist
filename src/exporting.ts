// 导出成 HTML：导出哪些待办、什么顺序（和侧栏同一份排序规则，排好交给 Rust 端），上次导出到的目录（只记在本机），提示的文字。
// 导出的流程（先存盘、确认、选位置、在后台导出、提示）在 components/exportFlow.tsx
import { deepCounts, descendantsOf, inProject, isSubProject, parentOf, shortProjectLabel, sortProjects } from "./projects";
import type { Exported, ExportFormat, ExportGroup, ProjectNode, SortKey } from "./types";
import { sortTodos } from "./utils";
import { readJson, writeJson } from "./workspaceState";

/** 上次导出到的目录（localStorage），「另存为」对话框从这里打开 */
const EXPORT_DIR_KEY = "exportDir";

export const FORMAT_LABELS: Record<ExportFormat, string> = { html: "HTML" };

/**
 * 导出项目（连同各级子项目；project 不给时是整个工作区）时导出哪些待办、什么顺序，排成项目树：每一层的项目按侧栏的顺序
 * （sortProjects：按名称，或这个工作区手动排序（manual）时按调整过的顺序），项目里的待办按侧栏的排序（sortTodos：
 * 置顶的在前、已完成的沉底）。导出项目时是这一个项目（它的子项目一层层挂在下面），导出工作区时是各个顶层项目。
 * 已完成的也列上，导不导由「包含已完成的待办」决定（Rust 端去掉），侧栏里隐藏了的也一样
 */
export function exportGroups(
  projects: readonly ProjectNode[],
  project: string | undefined,
  sortKey: SortKey,
  manual = false,
): ExportGroup[] {
  const chosen = project === undefined ? projects : projects.filter((p) => inProject(p.name, project));
  const roots: ExportGroup[] = [];
  const byName = new Map<string, ExportGroup>();
  // sortProjects 排出来的每个项目后面跟着它的各级子项目（先列完一个项目的再列下一个），父项目总在子项目前面
  for (const p of sortProjects(chosen, manual)) {
    const group: ExportGroup = { project: p.name, ids: sortTodos(p.todos, sortKey).map((t) => t.id), children: [] };
    byName.set(p.name, group);
    const parent = parentOf(p.name);
    const under = parent === undefined || p.name === project ? undefined : byName.get(parent);
    (under ? under.children : roots).push(group);
  }
  return roots;
}

/** 导出的范围里一共几条、已完成几条（确认框里写的），连同各级子项目 */
export function exportCounts(projects: readonly ProjectNode[], project?: string): { total: number; done: number } {
  if (project === undefined) {
    const todos = projects.flatMap((p) => p.todos);
    return { total: todos.length, done: todos.filter((t) => t.done).length };
  }
  const c = deepCounts(projects).get(project) ?? { total: 0, undone: 0 };
  return { total: c.total, done: c.total - c.undone };
}

/** 确认框里写的数目：一共几条、已完成几条；导出有子项目的项目时写明含各级子项目里的 */
export function countsText(projects: readonly ProjectNode[], project?: string): string {
  const { total, done } = exportCounts(projects, project);
  const deep = project !== undefined && descendantsOf(projects, project).length > 0;
  return `一共 ${total} 条待办${deep ? "（含各级子项目里的）" : ""}，其中已完成 ${done} 条。`;
}

/** 确认框的标题：导出项目「需求」为 HTML；层级多的子项目中间折叠 */
export function exportTitle(format: ExportFormat, workspace: string, project?: string): string {
  const what =
    project === undefined ? `工作区「${workspace}」` : `${isSubProject(project) ? "子项目" : "项目"}「${shortProjectLabel(project)}」`;
  return `导出${what}为 ${FORMAT_LABELS[format]}`;
}

/** 路径所在的文件夹（Windows 的 \ 和 / 都认）；没有文件夹时是 null */
export function dirOf(path: string): string | null {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i > 0 ? path.slice(0, i) : null;
}

/** 上次导出到的目录；还没导出过时是 null（Rust 端从「文档」打开） */
export const readExportDir = (): string | null => {
  const dir = readJson<unknown>(EXPORT_DIR_KEY, null);
  return typeof dir === "string" && dir ? dir : null;
};

/** 导出成功后记下导出到的目录，下次从这里打开 */
export function rememberExportDir(path: string) {
  const dir = dirOf(path);
  if (dir) writeJson(EXPORT_DIR_KEY, dir);
}

/** 导出成功的提示 */
export const exportedText = (r: Exported) => `已导出 ${r.count} 条待办到 ${r.path}`;
