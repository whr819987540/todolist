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
