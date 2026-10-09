// 侧栏树共用的定义：右侧显示的内容（选中项）和它在行上的键、折叠状态、待办计数、隐藏全部完成的项目时藏起哪些，
// 「全部折叠 / 全部展开」看哪些项目
import { deepTodos, inProject, parentOf } from "../../projects";
import type { ProjectNode, WorkspaceTree } from "../../types";

/** 折叠状态里工作区本身用的键（项目用项目路径，子项目是「父项目/子项目」） */
export const WS_KEY = "\u0000workspace";

/** 右侧显示的内容：只有 workspace 时是工作区概览，有 project（项目路径）时是项目概览，再有 todoId 时是这条待办 */
export interface Selection {
  workspace: string;
  project?: string;
  todoId?: string;
}

export type Collapsed = Record<string, boolean>;

/** 列表里每一行对应的选中项，存在行的 data-sel 上，键盘上下移动时按显示顺序取 */
export const selKey = (s: Selection) => JSON.stringify([s.workspace, s.project ?? "", s.todoId ?? ""]);

export function parseSelKey(key: string): Selection {
  const [workspace, project, todoId] = JSON.parse(key) as string[];
  return { workspace, project: project || undefined, todoId: todoId || undefined };
}

/**
 * 全部完成的项目：里面有待办，而且全都完成了；有子项目的父项目连同子项目里的待办一起看。没有待办的（刚建的）不算。
 * projects 是这个工作区的全部项目
 */
export function isProjectDone(projects: readonly ProjectNode[], project: string): boolean {
  const todos = deepTodos(projects, project);
  return todos.length > 0 && todos.every((t) => t.done);
}

/** 没有藏起来的项目时都用这一个，侧栏的行不必重新渲染 */
const NONE_HIDDEN: ReadonlySet<string> = new Set();

/**
 * 「隐藏全部完成的项目」开着时，侧栏里藏起来的项目（路径）：全部完成的，除了右侧正在显示的那个（项目概览，或打开着其中的
 * 待办），免得正看着的东西从左边消失，和刚切走、还要再显示一会儿的（lingering，见 lingeringAfter）；显示的、刚切走的是
 * 子项目时，它的父项目也不藏。藏起来的父项目连同子项目一起不显示，这时子项目不再单独列进来；父项目没藏时，全部完成的
 * 子项目单独藏。侧栏搜索时什么都不藏，名字或待办命中的照常列出
 */
export function hiddenDoneProjects(
  projects: readonly ProjectNode[],
  o: {
    hide: boolean;
    /** 侧栏搜索的关键字，调用方传 trim 过的（Sidebar 的 kw），空的是没在搜索 */
    keyword: string;
    selProject?: string;
    lingering?: ReadonlySet<string>;
  },
): ReadonlySet<string> {
  if (!o.hide || o.keyword) return NONE_HIDDEN;
  const showing = [o.selProject, ...(o.lingering ?? [])].filter((x) => x !== undefined);
  const hidden = new Set<string>();
  const hide = (name: string) => {
    if (!showing.some((x) => inProject(x, name)) && isProjectDone(projects, name)) hidden.add(name);
  };
  // 先看顶层项目，再看没藏起来的父项目里的子项目
  for (const p of projects) if (parentOf(p.name) === undefined) hide(p.name);
  for (const p of projects) {
    const parent = parentOf(p.name);
    if (parent !== undefined && !hidden.has(parent)) hide(p.name);
  }
  return hidden.size ? hidden : NONE_HIDDEN;
}

/** 藏起来的项目（hiddenDoneProjects）里有它或它的父项目：侧栏里看不见 */
export const isHidden = (hidden: ReadonlySet<string>, project: string) => {
  const parent = parentOf(project);
  return hidden.has(project) || (parent !== undefined && hidden.has(parent));
};

/**
 * 侧栏顶部「全部折叠 / 全部展开」显示哪个：看得见的项目有展开着的时是「全部折叠」，都折叠着时是「全部展开」。
 * 看不见的不算：折叠着的工作区里的项目、折叠着的父项目里的子项目；hiddenOf(tree) 是这个工作区里藏起来的项目
 * （hiddenDoneProjects，和侧栏的树用同样的参数算），它们默认展开着，看不见也折叠不了。算进去的话折叠完看得见的项目后
 * 按钮还是「全部折叠」，点了界面没有变化。只对展开着、有展开着的项目的工作区才调用 hiddenOf
 */
export function anyVisibleProjectOpen(
  trees: readonly WorkspaceTree[],
  collapsedOf: (workspace: string) => Collapsed,
  hiddenOf: (tree: WorkspaceTree) => ReadonlySet<string>,
): boolean {
  return trees.some((t) => {
    const c = collapsedOf(t.name);
    if (c[WS_KEY]) return false;
    const isOpen = (name: string) => {
      const parent = parentOf(name);
      return !c[name] && (parent === undefined || !c[parent]);
    };
    const open = t.projects.filter((p) => isOpen(p.name));
    if (!open.length) return false;
    const hidden = hiddenOf(t);
    return open.some((p) => !isHidden(hidden, p.name));
  });
}

/**
 * 右侧显示的内容离开一个要藏起来的项目后，它在侧栏里再显示多久（毫秒）。比 Windows 的双击间隔（默认 500，最长约 900）长：
 * 在它下面的项目里双击时，第一下点击切走后它不会马上消失、让下面的行移到鼠标底下，第二下还落在同一行上
 */
export const LINGER_MS = 1000;

/** 刚切走、还要在侧栏里再显示一会儿的项目：工作区 → 项目路径 */
export type Lingering = ReadonlyMap<string, ReadonlySet<string>>;
export const NO_LINGERING: Lingering = new Map();

/**
 * 右侧显示的内容从 from 换到 to 之后，还要再显示一会儿的项目：离开的项目（在同一项目里换待办、换到它的概览不算离开）
 * 在 keep 说要留时（会被藏起来的：开着隐藏全部完成的项目、全部完成了、不在搜索）加进来；回到的项目去掉，它正显示着，
 * 照常显示。没有变化时返回 prev 本身，没变的工作区沿用原来的集合（侧栏里这些工作区不必重新渲染）
 */
export function lingeringAfter(
  prev: Lingering,
  from: Selection,
  to: Selection,
  keep: (workspace: string, project: string) => boolean,
): Lingering {
  let next = prev;
  const edit = (ws: string, project: string, add: boolean) => {
    const names = new Set(next.get(ws));
    if (add) names.add(project);
    else names.delete(project);
    const m = new Map(next);
    if (names.size) m.set(ws, names);
    else m.delete(ws);
    next = m;
  };
  const left = from.project;
  if (
    left &&
    (from.workspace !== to.workspace || left !== to.project) &&
    !next.get(from.workspace)?.has(left) &&
    keep(from.workspace, left)
  )
    edit(from.workspace, left, true);
  if (to.project && next.get(to.workspace)?.has(to.project)) edit(to.workspace, to.project, false);
  return next;
}

export const countDone = (t: WorkspaceTree) => t.projects.reduce((n, p) => n + p.todos.filter((x) => x.done).length, 0);
export const countAll = (t: WorkspaceTree) => t.projects.reduce((n, p) => n + p.todos.length, 0);
