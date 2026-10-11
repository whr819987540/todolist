import { projectLabel, sortProjects } from "./projects";
import type { QuickTarget, WorkspaceProjects } from "./types";
import { compareName } from "./utils";

// 快速记录小窗用到的：选择存到哪个项目、按键、没存的草稿

/** 下拉框里一个项目的值 */
export const targetKey = (t: QuickTarget) => JSON.stringify([t.workspace, t.project]);

export function parseTargetKey(key: string): QuickTarget {
  const [workspace, project] = JSON.parse(key) as [string, string];
  return { workspace, project };
}

/** 工作区 / 项目（子项目是「工作区 / 父项目 / 子项目」） */
export const targetLabel = (t: QuickTarget) => `${t.workspace} / ${projectLabel(t.project)}`;

export interface TargetGroup {
  label: string;
  title: string;
  options: { value: string; label: string; title: string }[];
}

/**
 * 下拉框的选项：每个工作区一组，工作区按名称排序，项目按项目的顺序（按名称或手动排序，同侧栏），子项目跟在父项目后面
 * （写成「父项目 / 子项目」）；没有项目的工作区不列。
 * 现在存到的项目还不在时（默认的「收件箱 / 快速记录」第一次用，或被删了）放在最前面，注明保存时新建
 */
export function targetOptions(list: readonly WorkspaceProjects[], current: QuickTarget | null): TargetGroup[] {
  const groups: TargetGroup[] = [...list]
    .sort((a, b) => compareName(a.name, b.name))
    .filter((w) => w.projects.length)
    .map((w) => ({
      label: w.name,
      title: w.name,
      options: sortProjects(
        w.projects.map((name) => ({ name, order: w.order[name] ?? null })),
        w.manualOrder,
      ).map(({ name: p }) => ({
        value: targetKey({ workspace: w.name, project: p }),
        label: projectLabel(p),
        title: targetLabel({ workspace: w.name, project: p }),
      })),
    }));
  if (current && !targetExists(list, current))
    groups.unshift({
      label: "保存时新建",
      title: "保存时新建",
      options: [{ value: targetKey(current), label: targetLabel(current), title: targetLabel(current) }],
    });
  return groups;
}

export const targetExists = (list: readonly WorkspaceProjects[], t: QuickTarget) =>
  list.some((w) => w.name === t.workspace && w.projects.includes(t.project));

/** 下拉框里的搜索：工作区名、项目名都算 */
export const matchTarget = (input: string, option?: { title?: string }) =>
  !!option?.title?.toLowerCase().includes(input.trim().toLowerCase());

type Key = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "isComposing">;

/** 输入框里的按键：Enter 保存，Ctrl+Enter 保存并在主窗口里打开；Shift+Enter 换行、输入法组合中的 Enter 交给输入框 */
export function submitKey(e: Key): "save" | "open" | null {
  if (e.key !== "Enter" || e.isComposing || e.shiftKey || e.altKey || e.metaKey) return null;
  return e.ctrlKey ? "open" : "save";
}

/** 没存的草稿记在本机（小窗藏起来、程序退出后再打开还在），存好后清掉 */
const DRAFT_KEY = "quickCaptureDraft";

export function readDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(text: string) {
  try {
    if (text) localStorage.setItem(DRAFT_KEY, text);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 忽略 */
  }
}
