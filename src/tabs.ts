// 右侧编辑区的标签页：打开着的待办按标签的顺序排成一列。这里只有对这一列的纯函数，记在哪里、怎么跟着改名走见 workspaceState。
//
// 同 VS Code：单击（或用键盘移到）打开的待办放在「预览」标签里，再打开别的待办时被替换；修改了标题或正文、双击
// 左侧的待办或标签、新建的待办，标签变成固定的，一直留着直到关掉。

/** 一条待办 */
export interface TodoRef {
  workspace: string;
  project: string;
  todoId: string;
}

/** 标签页里打开着的一条待办；preview 是预览标签 */
export interface OpenTodo extends TodoRef {
  preview: boolean;
}

export const sameTodo = (a: TodoRef, b: TodoRef) =>
  a.workspace === b.workspace && a.project === b.project && a.todoId === b.todoId;

/** todo 在 list 里的位置；todo 是 null 或不在 list 里时是 -1 */
export const tabIndex = (list: readonly TodoRef[], todo: TodoRef | null) =>
  todo ? list.findIndex((t) => sameTodo(t, todo)) : -1;

/**
 * 打开一条待办。已经有标签的不挪位置，keep 时预览标签变成固定的。
 * 没有标签的：preview 时顶替原来的预览标签（在原处），没有预览标签时放在 after（正显示着的那个）后面，找不到 after 时放在最后；
 * keep 时同样放在 after 后面，原来的预览标签不动。没有变化时返回原来的列表
 */
export function openTab(list: readonly OpenTodo[], todo: TodoRef, keep: boolean, after: TodoRef | null): readonly OpenTodo[] {
  const at = list.findIndex((t) => sameTodo(t, todo));
  if (at >= 0) {
    if (!keep || !list[at].preview) return list;
    return list.map((t, i) => (i === at ? { ...t, preview: false } : t));
  }
  const tab: OpenTodo = { workspace: todo.workspace, project: todo.project, todoId: todo.todoId, preview: !keep };
  if (!keep) {
    const p = list.findIndex((t) => t.preview);
    if (p >= 0) return list.map((t, i) => (i === p ? tab : t));
  }
  const a = tabIndex(list, after);
  return a < 0 ? [...list, tab] : [...list.slice(0, a + 1), tab, ...list.slice(a + 1)];
}

/** 关掉 closing 里的这些标签；没有变化时返回原来的列表 */
export function closeTabs(list: readonly OpenTodo[], closing: readonly TodoRef[]): readonly OpenTodo[] {
  const next = list.filter((t) => !closing.some((c) => sameTodo(t, c)));
  return next.length === list.length ? list : next;
}

/**
 * 拖动标签：把 moving 挪到 target 的前面 / 后面。list 里还有藏起来的标签（没选中的工作区里的），按 target 定位，
 * 它们的相对顺序不变。没有变化时返回原来的列表
 */
export function moveTab(
  list: readonly OpenTodo[],
  moving: TodoRef,
  target: TodoRef,
  place: "before" | "after",
): readonly OpenTodo[] {
  const from = list.findIndex((t) => sameTodo(t, moving));
  if (from < 0 || sameTodo(moving, target)) return list;
  const rest = list.filter((_, i) => i !== from);
  const at = rest.findIndex((t) => sameTodo(t, target));
  if (at < 0) return list;
  const to = place === "before" ? at : at + 1;
  if (to === from) return list;
  return [...rest.slice(0, to), list[from], ...rest.slice(to)];
}

/**
 * 在 shown（现在显示出来的标签，按顺序）里关掉 closing 之后，右侧改显示哪一个：
 * 正显示着的 active 没被关掉时返回 undefined（不用换）；被关掉了取它右边第一个还在的，右边没有时取左边最近的，
 * 都关掉了返回 null
 */
export function activeAfterClose(
  shown: readonly OpenTodo[],
  closing: readonly TodoRef[],
  active: TodoRef | null,
): OpenTodo | null | undefined {
  if (!active || !closing.some((c) => sameTodo(c, active))) return undefined;
  const at = shown.findIndex((t) => sameTodo(t, active));
  const left = (t: OpenTodo) => !closing.some((c) => sameTodo(t, c));
  if (at < 0) return shown.find(left) ?? null;
  return shown.slice(at + 1).find(left) ?? shown.slice(0, at).reverse().find(left) ?? null;
}

/**
 * Ctrl+Tab / Ctrl+Shift+Tab：shown 里 active 的下一个（step=1）/ 上一个（step=-1），到头了从另一头接着；
 * 没有正显示着的标签时，下一个是第一个、上一个是最后一个。没有标签时返回 null
 */
export function stepTab(shown: readonly OpenTodo[], active: TodoRef | null, step: 1 | -1): OpenTodo | null {
  if (!shown.length) return null;
  const at = tabIndex(shown, active);
  if (at < 0) return step > 0 ? shown[0] : shown[shown.length - 1];
  return shown[(at + step + shown.length) % shown.length];
}

/**
 * 焦点在右侧时的 Alt+← / Alt+→：shown 里 active 左边（step=-1）/ 右边（step=1）的标签。到头了不从另一头接着（不同于 Ctrl+Tab），
 * 返回 null，这时 Alt+← 回到左侧列表、Alt+→ 把焦点放进正文；没有正显示着的标签时也返回 null
 */
export function neighborTab(shown: readonly OpenTodo[], active: TodoRef | null, step: 1 | -1): OpenTodo | null {
  const at = tabIndex(shown, active);
  return at < 0 ? null : (shown[at + step] ?? null);
}

/**
 * 改名、移动、删除之后，标签跟过去：fn 返回 null 的关掉，跟过去后和前面的重复了的也去掉。
 * 跟到别的工作区的标签仍在原来的位置，那个工作区在侧栏显示时才显示出来。没有变化时返回原来的列表
 */
export function mapTabs(
  list: readonly OpenTodo[],
  fn: (key: [workspace: string, project: string, id: string]) => [string, string, string] | null,
): readonly OpenTodo[] {
  const out: OpenTodo[] = [];
  let changed = false;
  for (const t of list) {
    const to = fn([t.workspace, t.project, t.todoId]);
    const m = to && { workspace: to[0], project: to[1], todoId: to[2], preview: t.preview };
    if (!m || out.some((x) => sameTodo(x, m))) {
      changed = true;
      continue;
    }
    if (!sameTodo(m, t)) changed = true;
    out.push(m);
  }
  return changed ? out : list;
}

// ----- 分屏：右侧最多两个标签组（同 VS Code 的编辑器组），每组一排标签 -----
//
// 只有一组时就是不分屏。左侧列表、项目概览、搜索结果、后退 / 前进、新建打开的待办都放进有焦点（最后用过）的那一组；
// 一组的标签都关掉后这一组消失，回到不分屏。

/** 分屏的方向：row 左右，column 上下 */
export type SplitDirection = "row" | "column";

/** 一个标签组：一排标签和这组正显示着的那个 */
export interface TabGroup {
  /** 组的编号（"a" / "b"），这一组还在时不变；按组记的编辑位置用它 */
  readonly id: string;
  readonly tabs: readonly OpenTodo[];
  /** 这一组正显示着（或最后显示过）的标签：新开的标签放在它右边，没有焦点时这一组显示它；没有时为 null */
  readonly current: TodoRef | null;
}

/** 右侧的标签组：一组（不分屏）或两组（分屏） */
export interface TabGroups {
  readonly groups: readonly TabGroup[];
  /** 两组时怎么分：左右 / 上下 */
  readonly direction: SplitDirection;
  /** 第一组（左边 / 上面）占的比例 */
  readonly ratio: number;
  /** 有焦点（最后用过）的一组 */
  readonly focused: number;
}

export const SINGLE_GROUP: TabGroups = { groups: [{ id: "a", tabs: [], current: null }], direction: "row", ratio: 0.5, focused: 0 };

const sameRef = (a: TodoRef | null, b: TodoRef | null) => a === b || (!!a && !!b && sameTodo(a, b));
const ref = (t: TodoRef): TodoRef => ({ workspace: t.workspace, project: t.project, todoId: t.todoId });

/** 改第 at 组；fn 原样返回时整个不变 */
function withGroup(g: TabGroups, at: number, fn: (x: TabGroup) => TabGroup): TabGroups {
  const old = g.groups[at];
  if (!old) return g;
  const next = fn(old);
  return next === old ? g : { ...g, groups: g.groups.map((x, i) => (i === at ? next : x)) };
}

/**
 * 分屏时一组的标签都没了（关掉、删除、拖到另一组）：这一组消失，回到不分屏，焦点在留下的那一组。
 * 不分屏时那一组没有标签也留着（右侧显示概览）。没有变化时原样返回
 */
export function dropEmpty(g: TabGroups): TabGroups {
  if (g.groups.length < 2) return g;
  const kept = g.groups.filter((x) => x.tabs.length > 0);
  if (kept.length === g.groups.length) return g;
  const focusedGroup = g.groups[g.focused];
  if (!kept.length) return { ...g, groups: [focusedGroup], focused: 0 };
  return { ...g, groups: kept, focused: Math.max(0, kept.indexOf(focusedGroup)) };
}

/**
 * 关掉、删除、改名之后这一组正显示着的标签：left 返回留下的标签现在的样子（没留下的为 null）。正显示着的留下了就是它，
 * 没留下时改成它右边第一个留下的（右边没有时左边最近的），都没了为 null
 */
function currentAfter(tabs: readonly OpenTodo[], current: TodoRef | null, left: (t: TodoRef) => TodoRef | null) {
  if (!current) return null;
  const self = left(current);
  if (self) return self;
  const at = tabIndex(tabs, current);
  if (at < 0) return null;
  for (const t of [...tabs.slice(at + 1), ...tabs.slice(0, at).reverse()]) {
    const k = left(t);
    if (k) return k;
  }
  return null;
}

/** 右侧在有焦点的一组里显示了这条待办：还没有标签的放进这一组的预览标签，记下它是这一组正显示着的 */
export function showGroupTab(g: TabGroups, todo: TodoRef): TabGroups {
  return withGroup(g, g.focused, (x) => {
    const tabs = openTab(x.tabs, todo, false, x.current);
    return tabs === x.tabs && sameRef(x.current, todo) ? x : { ...x, tabs, current: ref(todo) };
  });
}

/** 第 at 组（默认有焦点的一组）里这条待办的标签固定下来（新建的、双击打开的）；还没有标签的新开一个 */
export function keepGroupTab(g: TabGroups, todo: TodoRef, at = g.focused): TabGroups {
  return withGroup(g, at, (x) => {
    const tabs = openTab(x.tabs, todo, true, x.current);
    return tabs === x.tabs ? x : { ...x, tabs };
  });
}

/** 修改了这条待办：它在各组里的预览标签都固定下来（不新开标签） */
export function pinGroupTabs(g: TabGroups, todo: TodoRef): TabGroups {
  let out = g;
  g.groups.forEach((x, i) => {
    if (x.tabs.some((t) => t.preview && sameTodo(t, todo))) out = keepGroupTab(out, todo, i);
  });
  return out;
}

/** 关掉第 at 组里的这些标签；这一组的标签都关掉了、另一组还在时，这一组消失 */
export function closeGroupTabs(g: TabGroups, at: number, closing: readonly TodoRef[]): TabGroups {
  const gone = (t: TodoRef) => closing.some((c) => sameTodo(c, t));
  return dropEmpty(
    withGroup(g, at, (x) => {
      const tabs = closeTabs(x.tabs, closing);
      return tabs === x.tabs ? x : { ...x, tabs, current: currentAfter(x.tabs, x.current, (t) => (gone(t) ? null : ref(t))) };
    }),
  );
}

/** 在第 at 组里拖动标签：moving 挪到 target 的前面 / 后面 */
export function moveGroupTab(g: TabGroups, at: number, moving: TodoRef, target: TodoRef, place: "before" | "after"): TabGroups {
  return withGroup(g, at, (x) => {
    const tabs = moveTab(x.tabs, moving, target, place);
    return tabs === x.tabs ? x : { ...x, tabs };
  });
}

/**
 * 把标签从第 from 组拖到第 to 组：放在 target 的前面 / 后面，target 为 null（放在那一组的编辑区上）时放在最后；
 * 那一组已经有这条待办的标签时挪过去（target 为 null 时不挪）。拖过去的标签固定下来，成为那一组正显示着的，焦点到那一组；
 * 拖走的是原来那一组正显示着的标签时，那一组改显示它右边的（没有时左边的）；原来那一组没有标签了就消失。
 * from 和 to 相同时同 moveGroupTab
 */
export function moveTabToGroup(
  g: TabGroups,
  from: number,
  moving: TodoRef,
  to: number,
  target: TodoRef | null,
  place: "before" | "after",
): TabGroups {
  if (from === to) return target ? moveGroupTab(g, from, moving, target, place) : g;
  const src = g.groups[from];
  const dst = g.groups[to];
  if (!src || !dst || tabIndex(src.tabs, moving) < 0) return g;
  const m: OpenTodo = { ...ref(moving), preview: false };
  const current = currentAfter(src.tabs, src.current, (t) => (sameTodo(t, moving) ? null : ref(t)));
  const there = tabIndex(dst.tabs, moving);
  let tabs: readonly OpenTodo[];
  if (there >= 0 && (!target || sameTodo(target, moving))) tabs = dst.tabs.map((t, i) => (i === there ? m : t));
  else {
    const rest = dst.tabs.filter((t) => !sameTodo(t, moving));
    const at = target ? tabIndex(rest, target) : -1;
    const pos = at < 0 ? rest.length : place === "before" ? at : at + 1;
    tabs = [...rest.slice(0, pos), m, ...rest.slice(pos)];
  }
  const groups = g.groups.map((x, i) =>
    i === from ? { ...x, tabs: closeTabs(x.tabs, [moving]), current } : i === to ? { ...x, tabs, current: ref(moving) } : x,
  );
  return dropEmpty({ ...g, groups, focused: to });
}

/**
 * 分屏的快捷键（左右 / 上下）：
 * - 不分屏时：在另一边（右边 / 下面）新开一组，先显示 todo（右侧正显示着的待办），焦点到新的一组；todo 为 null（显示概览等）时不分屏
 * - 已经分屏、换了方向：改成这个方向
 * - 已经是这个方向：合并回一边（见 mergeGroups）
 * - otherShown 为 false：分着屏、另一组却没显示出来（它的标签都在侧栏没选中的工作区里），当作不分屏：把 todo 开到那一组，
 *   让它显示出来
 * 新分出来的一边各占一半
 */
export function splitGroups(g: TabGroups, direction: SplitDirection, todo: TodoRef | null, otherShown = true): TabGroups {
  if (g.groups.length > 1 && otherShown) return direction === g.direction ? mergeGroups(g) : { ...g, direction };
  if (!todo) return g;
  if (g.groups.length > 1) {
    const other = 1 - g.focused;
    const opened = keepGroupTab(g, todo, other);
    return { ...withGroup(opened, other, (x) => ({ ...x, current: ref(todo) })), direction, ratio: 0.5, focused: other };
  }
  const first = g.groups[0];
  const added: TabGroup = { id: first.id === "a" ? "b" : "a", tabs: [{ ...ref(todo), preview: false }], current: ref(todo) };
  return { groups: [first, added], direction, ratio: 0.5, focused: 1 };
}

/**
 * 合并回一边：左边 / 上面那一组的标签在前，另一组的接在后面（两组都有的只留前面那个）；有焦点那一组的预览标签仍是预览，
 * 别的都是固定的（最多一个预览标签）；显示有焦点那一组正显示着的
 */
export function mergeGroups(g: TabGroups): TabGroups {
  if (g.groups.length < 2) return g;
  const f = g.groups[g.focused];
  const preview = f.tabs.find((t) => t.preview);
  const tabs: OpenTodo[] = [];
  for (const x of g.groups)
    for (const t of x.tabs) {
      if (tabs.some((y) => sameTodo(y, t))) continue;
      tabs.push({ ...ref(t), preview: !!preview && sameTodo(preview, t) });
    }
  return { ...g, groups: [{ id: f.id, tabs, current: f.current }], focused: 0 };
}

/** 焦点到第 at 组 */
export function focusGroup(g: TabGroups, at: number): TabGroups {
  return at === g.focused || !g.groups[at] ? g : { ...g, focused: at };
}

/** 改名、移动、删除之后，各组的标签和正显示着的跟过去（见 mapTabs）；一组的标签都删了时这一组消失 */
export function mapGroupTabs(
  g: TabGroups,
  fn: (key: [workspace: string, project: string, id: string]) => [string, string, string] | null,
): TabGroups {
  const move = (t: TodoRef): TodoRef | null => {
    const to = fn([t.workspace, t.project, t.todoId]);
    return to && { workspace: to[0], project: to[1], todoId: to[2] };
  };
  let changed = false;
  const groups = g.groups.map((x) => {
    const tabs = mapTabs(x.tabs, fn);
    const current = currentAfter(x.tabs, x.current, move);
    if (tabs === x.tabs && sameRef(current, x.current)) return x;
    changed = true;
    return { ...x, tabs, current };
  });
  return changed ? dropEmpty({ ...g, groups }) : g;
}

/** 一组显示的标签：shown（这一组显示出来的标签）里它正显示着的那个，不在了时第一个；没有标签时为 null */
export function shownTab(shown: readonly OpenTodo[], current: TodoRef | null): OpenTodo | null {
  const at = tabIndex(shown, current);
  return shown[at] ?? shown[0] ?? null;
}

/**
 * 焦点在右侧时的 Alt+← / Alt+→，分屏时两组连成一排（上下分屏时上面一组算左边）：先在有焦点的一组里切到左边 / 右边的标签；
 * 到了这一组的头上，切到另一组正显示着的标签（左边一组最右边的标签上 Alt+→ 进入右边一组，右边一组最左边的标签上 Alt+← 回到
 * 左边一组）。shown 是各组显示出来的标签，currents 是各组正显示着的。到了两头、没有正显示着的标签（显示概览）时返回 null
 */
export function stepAcrossGroups(
  shown: readonly (readonly OpenTodo[])[],
  currents: readonly (TodoRef | null)[],
  focused: number,
  active: TodoRef | null,
  step: 1 | -1,
): { group: number; tab: OpenTodo } | null {
  const mine = shown[focused] ?? [];
  if (tabIndex(mine, active) < 0) return null;
  const near = neighborTab(mine, active, step);
  if (near) return { group: focused, tab: near };
  const other = focused + step;
  const tab = other >= 0 && other < shown.length ? shownTab(shown[other], currents[other] ?? null) : null;
  return tab ? { group: other, tab } : null;
}
