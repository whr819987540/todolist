// 项目路径：顶层项目是它的名字，下一级用 / 连起来：「父项目/子项目/孙项目」…，层数不限（名字里不能有 /，不会和名字混淆）。
// 和后端（store.rs）的约定相同。选中项、标签、.state.json、折叠状态、拖动、搜索结果等处的「项目」都是路径
import type { ProjectNode, TodoSummary } from "./types";
import { compareName } from "./utils";

export const PROJECT_SEP = "/";

/** 父项目（也是路径，可以有好几级）；顶层项目是 undefined */
export function parentOf(project: string): string | undefined {
  const i = project.lastIndexOf(PROJECT_SEP);
  return i < 0 ? undefined : project.slice(0, i);
}

/** 项目自己的名字（不带父项目） */
export const leafName = (project: string) => project.slice(project.lastIndexOf(PROJECT_SEP) + 1);

export const isSubProject = (project: string) => project.includes(PROJECT_SEP);

/** 第几级：顶层项目 0，子项目 1，子项目的子项目 2… */
export const depthOf = (project: string) => project.split(PROJECT_SEP).length - 1;

/** 各级父项目，从顶层往下：「A/B/C」→ ["A", "A/B"]；顶层项目没有 */
export function ancestorsOf(project: string): string[] {
  const out: string[] = [];
  for (let i = project.indexOf(PROJECT_SEP); i >= 0; i = project.indexOf(PROJECT_SEP, i + 1)) out.push(project.slice(0, i));
  return out;
}

export const childPath = (parent: string, name: string) => `${parent}${PROJECT_SEP}${name}`;

/** p 是项目 project 本身或它的各级子项目 */
export const inProject = (p: string, project: string) => p === project || p.startsWith(project + PROJECT_SEP);

/** 项目 from 改名、移动成 to 之后，路径 p（它自己或它的各级子项目）变成什么；不相干的原样返回 */
export const reparent = (p: string, from: string, to: string) => (inProject(p, from) ? to + p.slice(from.length) : p);

/** 显示用的路径：父项目 / 子项目 / … */
export const projectLabel = (project: string) => project.split(PROJECT_SEP).join(" / ");

/**
 * 地方小、又不能悬停看完整路径的地方（操作后的提示、拖动时的说明、对话框和菜单里的说明）用的路径：级数多时留下开头 head 级
 * 和最后 tail 级，中间折叠成「…」（只折叠掉一级时不折叠，省不了地方）
 */
export function compactPath(parts: readonly string[], head = 1, tail = 2): string {
  const shown = parts.length > head + tail + 1 ? [...parts.slice(0, head), "…", ...parts.slice(-tail)] : parts;
  return shown.join(" / ");
}

/** 项目路径超过 4 级时中间折叠：「需求 / … / 组件 / 按钮」 */
export const shortProjectLabel = (project: string) => compactPath(project.split(PROJECT_SEP));

/** 工作区 / 项目，项目层级多时中间折叠：「工作 / 需求 / … / 组件 / 按钮」 */
export const shortPlaceLabel = (workspace: string, project: string) =>
  compactPath([workspace, ...project.split(PROJECT_SEP)], 2, 2);

/** projects 里 parent 的子项目（只是下一级的） */
export const subProjectsOf = <T extends { name: string }>(projects: readonly T[], parent: string): T[] =>
  projects.filter((p) => parentOf(p.name) === parent);

/** projects 里 project 的各级子项目（不含它自己） */
export const descendantsOf = <T extends { name: string }>(projects: readonly T[], project: string): T[] =>
  projects.filter((p) => p.name.startsWith(project + PROJECT_SEP));

/** 项目连同各级子项目的全部待办 */
export const deepTodos = (projects: readonly ProjectNode[], project: string): TodoSummary[] =>
  projects.filter((p) => inProject(p.name, project)).flatMap((p) => p.todos);

/** 项目连同各级子项目里的待办数和其中未完成的 */
export interface DeepCount {
  total: number;
  undone: number;
}

/**
 * 全部项目连同各级子项目里的待办数（项目路径 → 数目）：每个项目的待办算进它自己和它的各级父项目，一次算完，
 * 不必每个项目各自把全部项目筛一遍（项目多、层级多时侧栏也要快）
 */
export function deepCounts(projects: readonly ProjectNode[]): Map<string, DeepCount> {
  const out = new Map<string, DeepCount>();
  for (const p of projects) {
    const undone = p.todos.reduce((n, t) => n + (t.done ? 0 : 1), 0);
    for (const name of [...ancestorsOf(p.name), p.name]) {
      const c = out.get(name);
      if (c) {
        c.total += p.todos.length;
        c.undone += undone;
      } else out.set(name, { total: p.todos.length, undone });
    }
  }
  return out;
}

/** 各项目下一级子项目的名字（转成小写，比较同名时不分大小写）：父项目路径（顶层项目的是 undefined）→ 名字 */
type ChildNames = ReadonlyMap<string | undefined, ReadonlySet<string>>;

/** 按项目列表（数组本身）记住算过的 ChildNames：「移动到」列出每个地方、拖动时指针每动一下都要查，不必每次把全部项目扫一遍 */
const childNamesCache = new WeakMap<object, ChildNames>();

function childNames(projects: readonly { name: string }[] | readonly string[]): ChildNames {
  const cached = childNamesCache.get(projects);
  if (cached) return cached;
  const out = new Map<string | undefined, Set<string>>();
  for (const p of projects) {
    const name = typeof p === "string" ? p : p.name;
    const parent = parentOf(name);
    const set = out.get(parent);
    if (set) set.add(leafName(name).toLowerCase());
    else out.set(parent, new Set([leafName(name).toLowerCase()]));
  }
  childNamesCache.set(projects, out);
  return out;
}

/** 项目为什么不能移到那里：self 放进它自己或它自己的子项目里，here 已经在那里，taken 那里已有同名的（不分大小写，项目是文件夹） */
export interface MoveProblem {
  code: "self" | "here" | "taken";
  reason: string;
}

/**
 * 项目 project 能不能移到目标工作区的顶层（parent 为 undefined），或放进那里的项目 parent（可以是哪一级的子项目）里成为
 * 它的子项目；可以时返回 null。to 是目标工作区的全部项目（项目或路径的数组；同一个数组查第二次起不再扫一遍），
 * sameWorkspace 是目标工作区就是它所在的工作区
 */
export function projectMoveProblem(o: {
  project: string;
  to: readonly { name: string }[] | readonly string[];
  sameWorkspace: boolean;
  parent?: string;
}): MoveProblem | null {
  const { project, parent, sameWorkspace } = o;
  if (sameWorkspace && parent !== undefined && inProject(parent, project))
    return { code: "self", reason: parent === project ? "不能放进它自己里面" : "不能放进它自己的子项目里" };
  if (sameWorkspace && parentOf(project) === parent)
    return { code: "here", reason: parent === undefined ? "已在这个工作区的顶层" : "已在这个项目里" };
  const taken = !!childNames(o.to).get(parent)?.has(leafName(project).toLowerCase());
  if (taken)
    return { code: "taken", reason: parent === undefined ? "那里已有同名项目" : `「${shortProjectLabel(parent)}」里已有同名子项目` };
  return null;
}

/** 同一级的名字按名字排（数字按大小）；只差大小写等、按名字排算一样的再按原文排，排出来的顺序总是固定的 */
const compareSegment = (a: string, b: string) => compareName(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** 同资源管理器的树：每个项目后面跟着它的各级子项目（列完一个项目的再列下一个），同一级的按名字排 */
export function sortProjects<T extends { name: string }>(projects: readonly T[]): T[] {
  const keyed = projects.map((p) => ({ p, parts: p.name.split(PROJECT_SEP) }));
  keyed.sort((a, b) => {
    const n = Math.min(a.parts.length, b.parts.length);
    for (let i = 0; i < n; i++) {
      const c = compareSegment(a.parts[i], b.parts[i]);
      if (c) return c;
    }
    return a.parts.length - b.parts.length;
  });
  return keyed.map((x) => x.p);
}
