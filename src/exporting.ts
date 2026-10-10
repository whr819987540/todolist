// 导出成 HTML / PDF：导出哪些待办、什么顺序（和侧栏同一份排序规则，排好交给 Rust 端），上次导出到的目录（只记在本机），提示的文字。
// 导出的流程（先存盘、确认、选位置、在后台导出、提示）在 components/exportFlow.tsx
import { inProject, isSubProject, projectLabel, sortProjects } from "./projects";
import type { Exported, ExportFormat, ExportGroup, ProjectNode, SortKey } from "./types";
import { sortTodos } from "./utils";
import { readJson, writeJson } from "./workspaceState";

/** 上次导出到的目录（localStorage），「另存为」对话框从这里打开 */
const EXPORT_DIR_KEY = "exportDir";

export const FORMAT_LABELS: Record<ExportFormat, string> = { html: "HTML", pdf: "PDF" };

/**
 * 导出项目（连同子项目；project 不给时是整个工作区）时导出哪些待办、什么顺序：项目按侧栏的顺序（顶层项目按名字，
 * 每个后面跟着它的子项目，所以父项目自己的待办在前、子项目在后），项目里的待办按侧栏的排序（sortTodos：置顶的在前、
 * 已完成的沉底）。已完成的也列上，导不导由「包含已完成的待办」决定（Rust 端去掉），侧栏里隐藏了的也一样
 */
export function exportGroups(projects: readonly ProjectNode[], project: string | undefined, sortKey: SortKey): ExportGroup[] {
  const chosen = project === undefined ? projects : projects.filter((p) => inProject(p.name, project));
  return sortProjects(chosen).map((p) => ({ project: p.name, ids: sortTodos(p.todos, sortKey).map((t) => t.id) }));
}

/** 导出的范围里一共几条、已完成几条（确认框里写的） */
export function exportCounts(projects: readonly ProjectNode[], groups: readonly ExportGroup[]): { total: number; done: number } {
  const wanted = new Set(groups.map((g) => g.project));
  const todos = projects.filter((p) => wanted.has(p.name)).flatMap((p) => p.todos);
  return { total: todos.length, done: todos.filter((t) => t.done).length };
}

/** 确认框的标题：导出项目「需求」为 HTML */
export function exportTitle(format: ExportFormat, workspace: string, project?: string): string {
  const what = project === undefined ? `工作区「${workspace}」` : `${isSubProject(project) ? "子项目" : "项目"}「${projectLabel(project)}」`;
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

/** 导出 PDF 退回了系统的打印对话框时的提示：为什么，以及在对话框里怎么存成 PDF */
export const printDialogText = (reason: string) =>
  `没能直接存成 PDF（${reason}），已打开打印对话框：在「打印机」里选「另存为 PDF」或「Microsoft Print to PDF」存成 PDF，存好后关掉那个窗口`;
