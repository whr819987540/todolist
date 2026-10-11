// 侧栏（和项目概览）的筛选：按标签、优先级。只记在这次运行期间（内存里，返回首页再进来还在，不跨重启），
// 侧栏显示的各工作区一起用这一个
import { useSyncExternalStore } from "react";
import { PRIORITIES, PRIORITY_LABELS } from "./priority";
import { hasTag, sameTag } from "./tags";
import type { Priority, TodoSummary } from "./types";

export interface TodoFilter {
  /** 选中的标签（不区分大小写地比） */
  tags: readonly string[];
  /** 标签之间：any 有其中一个就算（默认），all 选中的都有才算 */
  tagMode: "any" | "all";
  /** 选中的优先级，之间是「任一」 */
  priorities: readonly Priority[];
}

export const NO_FILTER: TodoFilter = { tags: [], tagMode: "any", priorities: [] };

/** 开着筛选：选了标签或优先级 */
export const isFiltering = (f: TodoFilter) => f.tags.length > 0 || f.priorities.length > 0;

/** 待办符不符合筛选：标签（任一 / 全部）并且优先级（任一）；没开筛选时都符合 */
export function matchFilter(t: Pick<TodoSummary, "tags" | "priority">, f: TodoFilter): boolean {
  if (f.tags.length) {
    const ok = f.tagMode === "all" ? f.tags.every((x) => hasTag(t.tags, x)) : f.tags.some((x) => hasTag(t.tags, x));
    if (!ok) return false;
  }
  return !f.priorities.length || f.priorities.includes(t.priority);
}

/** 侧栏顶部那一行写的：「标签 工作 或 等回复，优先级 高、低」（标签选了「全部」时是「工作 和 等回复」） */
export function describeFilter(f: TodoFilter): string {
  const parts: string[] = [];
  if (f.tags.length) parts.push(`标签 ${f.tags.join(f.tagMode === "all" ? " 和 " : " 或 ")}`);
  if (f.priorities.length)
    parts.push(`优先级 ${PRIORITIES.filter((p) => f.priorities.includes(p)).map((p) => PRIORITY_LABELS[p]).join("、")}`);
  return parts.join("，");
}

/** 选上 / 取消一个标签 */
export function toggleTag(f: TodoFilter, tag: string): TodoFilter {
  return { ...f, tags: hasTag(f.tags, tag) ? f.tags.filter((x) => !sameTag(x, tag)) : [...f.tags, tag] };
}

/** 选上 / 取消一档优先级 */
export function togglePriority(f: TodoFilter, p: Priority): TodoFilter {
  return { ...f, priorities: f.priorities.includes(p) ? f.priorities.filter((x) => x !== p) : [...f.priorities, p] };
}

/** 点了某个标签：标签只选它一个，优先级的选择不变；已经是这样时原样返回 */
export function onlyTag(f: TodoFilter, tag: string): TodoFilter {
  return f.tags.length === 1 && sameTag(f.tags[0], tag) ? f : { ...f, tags: [tag] };
}

/** 标签 from 改名成 to（已经选着 to 的就是合并）后，筛选里选着的跟着改；没选着它时原样返回 */
export function renameTagInFilter(f: TodoFilter, from: string, to: string): TodoFilter {
  if (!hasTag(f.tags, from)) return f;
  const tags: string[] = [];
  for (const x of f.tags) {
    const next = sameTag(x, from) ? to : x;
    if (!hasTag(tags, next)) tags.push(next);
  }
  return { ...f, tags };
}

/** 标签删掉后，筛选里不再选着它；没选着它时原样返回 */
export function dropTagFromFilter(f: TodoFilter, tag: string): TodoFilter {
  return hasTag(f.tags, tag) ? { ...f, tags: f.tags.filter((x) => !sameTag(x, tag)) } : f;
}

/** 这些待办里各档优先级有几条 */
export function countPriorities(todos: readonly Pick<TodoSummary, "priority">[]): Record<Priority, number> {
  const n: Record<Priority, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const t of todos) n[t.priority]++;
  return n;
}

// ----- 现在的筛选：内存里的一份，改了通知订阅的组件 -----

let current: TodoFilter = NO_FILTER;
const listeners = new Set<() => void>();

export const readFilter = () => current;

export function subscribeFilter(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 改筛选；没变（返回同一个对象）时什么都不做 */
export function setFilter(next: TodoFilter | ((f: TodoFilter) => TodoFilter)) {
  const f = typeof next === "function" ? next(current) : next;
  if (f === current) return;
  current = f;
  for (const fn of listeners) fn();
}

export const clearFilter = () => setFilter(NO_FILTER);

/** 点了某个标签：按这个标签筛选（不变的函数，侧栏的行也用） */
export const filterByTag = (tag: string) => setFilter((f) => onlyTag(f, tag));

/** 组件里用：现在的筛选，改了重新渲染 */
export const useTodoFilter = () => useSyncExternalStore(subscribeFilter, readFilter);
