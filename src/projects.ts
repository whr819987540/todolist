// 项目路径：顶层项目是它的名字，子项目是「父项目/子项目」（只有一层子项目；名字里不能有 /，不会和名字混淆）。
// 和后端（store.rs）的约定相同。选中项、标签、.state.json、折叠状态、拖动、搜索结果等处的「项目」都是路径
import type { ProjectNode, TodoSummary } from "./types";
import { compareName } from "./utils";

export const PROJECT_SEP = "/";

/** 子项目的父项目；顶层项目是 undefined */
export function parentOf(project: string): string | undefined {
  const i = project.indexOf(PROJECT_SEP);
  return i < 0 ? undefined : project.slice(0, i);
}

/** 项目自己的名字（子项目不带父项目） */
export const leafName = (project: string) => project.slice(project.indexOf(PROJECT_SEP) + 1);

export const isSubProject = (project: string) => project.includes(PROJECT_SEP);

export const childPath = (parent: string, name: string) => `${parent}${PROJECT_SEP}${name}`;

/** p 是项目 project 本身或它的子项目 */
export const inProject = (p: string, project: string) => p === project || p.startsWith(project + PROJECT_SEP);

/** 项目 from 改名、移动成 to 之后，路径 p（它自己或它的子项目）变成什么；不相干的原样返回 */
export const reparent = (p: string, from: string, to: string) => (inProject(p, from) ? to + p.slice(from.length) : p);

/** 显示用的路径：父项目 / 子项目 */
export const projectLabel = (project: string) => project.split(PROJECT_SEP).join(" / ");

/** projects 里 parent 的子项目 */
export const subProjectsOf = <T extends { name: string }>(projects: readonly T[], parent: string): T[] =>
  projects.filter((p) => parentOf(p.name) === parent);

/** 项目连同子项目的全部待办（子项目只有自己的） */
export const deepTodos = (projects: readonly ProjectNode[], project: string): TodoSummary[] =>
  projects.filter((p) => inProject(p.name, project)).flatMap((p) => p.todos);

/** 顶层项目按名字排，每个后面跟着它的子项目（也按名字排） */
export function sortProjects<T extends { name: string }>(projects: readonly T[]): T[] {
  const top = (p: T) => parentOf(p.name) ?? p.name;
  return [...projects].sort(
    (a, b) =>
      compareName(top(a), top(b)) ||
      Number(isSubProject(a.name)) - Number(isSubProject(b.name)) ||
      compareName(leafName(a.name), leafName(b.name)),
  );
}
