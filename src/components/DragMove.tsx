import { FileTextOutlined, FolderFilled } from "@ant-design/icons";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { inProject, leafName, parentOf, projectLabel, projectMoveProblem } from "../projects";
import type { TodoSummary, WorkspaceTree } from "../types";
import { displayTitle } from "../utils";
import { parseSelKey } from "./sidebar/tree";

// 拖动移动：在左侧列表或概览里按住待办，拖到左侧的另一个项目上（可以是别的工作区的）松开；
// 按住项目，拖到左侧的另一个项目上松开放进去成为子项目（指针在子项目上时是放进它的父项目），拖到工作区那一行
// （项目以外的地方）上松开移到那个工作区的顶层；拖到另一个项目那一行的上沿 / 下沿时放在它的前面 / 后面
// （同一层是调整项目的顺序，不在同一层是移过去放在那里）。
// 在同一个项目里把待办拖到另一条待办上（左侧列表或项目概览里），放在它的前面 / 后面，调整顺序（手动排序）。
// 用鼠标事件自己实现，不用 HTML5 拖放：WebView2 里拖放默认被 Tauri 接管（给拖文件进窗口用），
// 自己做也好控制放下的位置、跟着指针的说明和自动滚动。
// 能放下的地方是侧栏里标了 data-drop-ws（工作区）、data-drop-project（项目）的节点，调整顺序时是待办行（data-sel）。

/** 一条待办和它在哪里 */
export interface TodoAt {
  workspace: string;
  project: string;
  todo: TodoSummary;
}

/** 拖动中的东西：待办拖到别的项目（或同一项目里调整顺序），多选的几条待办一起拖到别的项目，项目拖到别的项目或工作区 */
export type DragItem =
  | ({ kind: "todo" } & TodoAt)
  | { kind: "todos"; items: TodoAt[] }
  | { kind: "project"; workspace: string; project: string };

/**
 * 放下的地方：待办放在项目上；项目放在顶层项目上（project，成为它的子项目）或工作区上（移到顶层），或者放在另一个
 * 项目 sibling 的前面 / 后面（project 是 sibling 所在的那一层：它的父项目，顶层时没有）；
 * 调整待办的顺序时是同一项目里另一条待办（todoId）的前面 / 后面
 */
export interface DropTarget {
  workspace: string;
  project?: string;
  todoId?: string;
  sibling?: string;
  place?: "before" | "after";
}

/** ok：可以放下；refused：指针下的地方放不下（那里已有同名项目、有子项目的放不进别的项目）；none：指针不在能放的地方，或者就在原处 */
export type DropStatus = "ok" | "refused" | "none";

export interface DragState {
  item: DragItem;
  /** 指针下的项目（拖待办时），或项目、工作区（拖项目时） */
  target: DropTarget | null;
  status: DropStatus;
  /** 跟着指针显示的说明：移到哪里，或者该往哪里拖 */
  hint: string;
}

export interface DragMove {
  /** 没在拖时是 null */
  state: DragState | null;
  /** 在可拖动的行上按下鼠标时调用；移动几个像素后才开始拖，没怎么动就还是单击 */
  start(e: React.MouseEvent, item: DragItem): void;
}

/** 按下后移动超过这么多像素才算拖动 */
const THRESHOLD = 5;
/** 拖着待办在折叠起来的工作区上停这么久（ms），展开它 */
const EXPAND_DELAY = 600;
/** 指针离侧栏列表上下边缘这么近（px）时自动滚动 */
const SCROLL_ZONE = 32;
/** 自动滚动每帧最多滚这么多像素 */
const SCROLL_STEP = 14;
/** 拖项目时，指针在另一个项目那一行的上下各这么一截（占行高）里是放在它前面 / 后面，中间是放进它 */
const EDGE = 0.25;

/** 指针在一行的上沿 / 下沿（offset 是离这一行顶上的距离）时放在它的前面 / 后面，在中间时是 null */
export function edgePlace(offset: number, height: number): "before" | "after" | null {
  if (offset < height * EDGE) return "before";
  if (offset > height * (1 - EDGE)) return "after";
  return null;
}

/** 正在拖的是不是这条待办 */
export const isDraggingTodo = (s: DragState | null, workspace: string, project: string, id: string) =>
  s?.item.kind === "todo" && s.item.workspace === workspace && s.item.project === project && s.item.todo.id === id;

/** 正在拖的是不是这个项目 */
export const isDraggingProject = (s: DragState | null, workspace: string, project: string) =>
  s?.item.kind === "project" && s.item.workspace === workspace && s.item.project === project;

/**
 * 拖动和这个项目（或它的子项目）有没有关系：拖的是它（或其中的待办），或者指针在它上面。
 * 侧栏只把拖动的状态传给有关系的项目，别的项目不必重新渲染
 */
export function dragConcerns(s: DragState | null, workspace: string, project: string): boolean {
  if (!s) return false;
  const t = s.target;
  if (t?.workspace === workspace && t.project !== undefined && inProject(t.project, project)) return true;
  if (t?.workspace === workspace && t.sibling !== undefined && inProject(t.sibling, project)) return true;
  const it = s.item;
  return it.kind !== "todos" && it.workspace === workspace && inProject(it.project, project);
}

/** 指针下放下的地方加的样式：能放下时高亮，放不下时标红；不是指针下的地方（含调整顺序、放在项目旁边时）返回 undefined */
export function dropClass(s: DragState | null, workspace: string, project?: string): string | undefined {
  if (!s || s.status === "none" || s.target?.todoId || s.target?.sibling) return undefined;
  if (s.target?.workspace !== workspace || s.target.project !== project) return undefined;
  return s.status === "ok" ? "drop-target" : "drop-refused";
}

/** 调整顺序时插入线画在哪个项目的哪条待办的前面 / 后面；不在调整这个项目的顺序时返回 undefined */
export function reorderMark(s: DragState | null, workspace: string, project: string): { id: string; place: "before" | "after" } | undefined {
  const t = s?.status === "ok" ? s.target : null;
  if (!t?.todoId || !t.place || t.workspace !== workspace || t.project !== project) return undefined;
  return { id: t.todoId, place: t.place };
}

/**
 * 拖项目时插入线画在哪个项目的前面 / 后面（放在它旁边；放不下时 refused，插入线标红）；
 * 指针不在这个项目那一行的上沿 / 下沿时返回 undefined
 */
export function projectMark(
  s: DragState | null,
  workspace: string,
  project: string,
): { place: "before" | "after"; refused: boolean } | undefined {
  if (!s || s.status === "none") return undefined;
  const t = s.target;
  if (!t?.sibling || !t.place || t.workspace !== workspace || t.sibling !== project) return undefined;
  return { place: t.place, refused: s.status === "refused" };
}

const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
  a?.workspace === b?.workspace &&
  a?.project === b?.project &&
  a?.todoId === b?.todoId &&
  a?.sibling === b?.sibling &&
  a?.place === b?.place;

/**
 * 指针下能放下的地方：拖待办时指针在同一项目里的另一条待办上是调整顺序（上半截放在它前面，下半截放在后面），
 * 拖项目时指针在另一个项目那一行的上沿 / 下沿是放在它前面 / 后面（edgePlace），否则是指针下的项目（拖项目时是工作区）；
 * collapsed 是指针下折叠起来的工作区
 */
function hitTest(x: number, y: number, item: DragItem): { target: DropTarget | null; collapsed?: string } {
  const el = document.elementFromPoint(x, y);
  if (el && item.kind === "todo") {
    const row = el.closest<HTMLElement>(".todo-row[data-sel], .list-row[data-sel]");
    const s = row && parseSelKey(row.dataset.sel!);
    if (row && s?.todoId && s.workspace === item.workspace && s.project === item.project) {
      if (s.todoId === item.todo.id) return { target: null };
      const r = row.getBoundingClientRect();
      const place = y < r.top + r.height / 2 ? "before" : "after";
      return { target: { workspace: s.workspace, project: s.project, todoId: s.todoId, place } };
    }
  }
  const wsEl = el?.closest<HTMLElement>(".sidebar [data-drop-ws]");
  if (!el || !wsEl) return { target: null };
  const workspace = wsEl.dataset.dropWs!;
  const collapsed = wsEl.getAttribute("aria-expanded") === "false" ? workspace : undefined;
  const project = el.closest<HTMLElement>("[data-drop-project]")?.dataset.dropProject;
  if (item.kind === "project") {
    // 在另一个项目那一行的上沿 / 下沿：放在它旁边（在它自己那一行上同原来）
    const row = el.closest<HTMLElement>(".project-row[data-sel]");
    const s = row && parseSelKey(row.dataset.sel!);
    if (row && s?.project && !(s.workspace === item.workspace && s.project === item.project)) {
      const r = row.getBoundingClientRect();
      const place = edgePlace(y - r.top, r.height);
      if (place) return { target: { workspace: s.workspace, project: parentOf(s.project), sibling: s.project, place }, collapsed };
    }
    // 在某个项目（连同它的子项目、待办）上是放进这个顶层项目，在工作区那一行等项目以外的地方是移到顶层
    return { target: project === undefined ? { workspace } : { workspace, project: parentOf(project) ?? project }, collapsed };
  }
  return { target: project ? { workspace, project } : null, collapsed };
}

/** 调整顺序能不能放在 target 那条旁边：已完成的和未完成的、置顶的和没置顶的各排各的 */
function judgeReorder(
  todo: TodoSummary,
  target: DropTarget,
  trees: readonly WorkspaceTree[],
  reorderBlocked: string | null,
): { status: DropStatus; hint: string } {
  if (reorderBlocked) return { status: "none", hint: reorderBlocked };
  const other = trees
    .find((t) => t.name === target.workspace)
    ?.projects.find((p) => p.name === target.project)
    ?.todos.find((t) => t.id === target.todoId);
  if (!other) return { status: "none", hint: "拖到其他待办上调整顺序" };
  if (other.done !== todo.done) return { status: "none", hint: "已完成的排在未完成的后面，只能在同一类里调整顺序" };
  if (other.pinned !== todo.pinned)
    return { status: "none", hint: "置顶的排在最前面，只能和同样置顶（或都没置顶）的调整顺序" };
  return { status: "ok", hint: `放在「${displayTitle(other).text}」${target.place === "before" ? "前面" : "后面"}` };
}

/**
 * 放在 target 能不能放下、跟着指针的说明怎么写。reorderBlocked 是不能调整顺序（搜索、筛选时）的原因：
 * 这时待办不能拖到同一项目里的待办旁边，项目不能放在别的项目旁边
 */
export function judge(
  item: DragItem,
  target: DropTarget | null,
  trees: readonly WorkspaceTree[],
  reorderBlocked: string | null,
): { status: DropStatus; hint: string } {
  if (item.kind === "todo" && target?.todoId) return judgeReorder(item.todo, target, trees, reorderBlocked);
  if (item.kind === "project") {
    if (!target) return { status: "none", hint: "拖到别的项目上放进去成为子项目，或拖到工作区那一行上移到顶层" };
    if (target.sibling && reorderBlocked) return { status: "none", hint: reorderBlocked };
    const same = target.workspace === item.workspace;
    const beside = target.sibling && `放在「${leafName(target.sibling)}」${target.place === "before" ? "前面" : "后面"}`;
    // 在同一层：调整顺序
    if (beside && same && parentOf(item.project) === target.project) return { status: "ok", hint: beside };
    const problem = projectMoveProblem({
      project: item.project,
      from: trees.find((t) => t.name === item.workspace)?.projects ?? [],
      to: trees.find((t) => t.name === target.workspace)?.projects ?? [],
      sameWorkspace: same,
      parent: target.project,
    });
    // 那里已有同名的、有子项目的放不进别的项目：标红；已经在那里、放进自己：不算能放的地方
    if (problem)
      return {
        status: problem.code === "taken" || problem.code === "hasSubs" ? "refused" : "none",
        hint: problem.code === "taken" && !target.project ? `「${target.workspace}」里已有同名项目` : problem.reason,
      };
    const into = target.project && `放进「${same ? "" : `${target.workspace} / `}${target.project}」`;
    if (beside) return { status: "ok", hint: `${into || (same ? "移出来" : `移动到工作区「${target.workspace}」`)}，${beside}` };
    if (into) return { status: "ok", hint: `${into}，成为子项目` };
    return { status: "ok", hint: same ? "移出来，放在顶层" : `移动到工作区「${target.workspace}」` };
  }
  if (item.kind === "todos") {
    if (!target?.project) return { status: "none", hint: "拖到左侧的项目上" };
    const n = item.items.filter((x) => x.workspace !== target.workspace || x.project !== target.project).length;
    if (!n) return { status: "none", hint: "都已在这个项目里" };
    return { status: "ok", hint: `把 ${n} 条移动到「${target.workspace} / ${projectLabel(target.project)}」` };
  }
  if (!target?.project) return { status: "none", hint: "拖到左侧的项目上，或拖到其他待办上调整顺序" };
  if (target.workspace === item.workspace && target.project === item.project)
    return { status: "none", hint: "已在这个项目里；拖到其他待办上可以调整顺序" };
  const where =
    target.workspace === item.workspace
      ? projectLabel(target.project)
      : `${target.workspace} / ${projectLabel(target.project)}`;
  return { status: "ok", hint: `移动到「${where}」` };
}

/** 拖完松开鼠标后浏览器还会发一个 click，别让它被当成单击（选中、打开）处理 */
export function swallowClick() {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

/** 拖动移动。返回的 ghost 是跟着指针的说明，要渲染出来 */
export function useDragMove(opts: {
  /** 侧栏里显示的工作区，看目标工作区里有没有同名项目 */
  trees: WorkspaceTree[];
  /** 展开折叠起来的工作区 */
  expand(workspace: string): void;
  /** 不能调整顺序（搜索、筛选时）的原因，能调整时是 null */
  reorderBlocked: string | null;
  onDrop(item: DragItem, target: DropTarget): void;
}): DragMove & { ghost: React.ReactNode } {
  const [state, setState] = useState<DragState | null>(null);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  const ghostRef = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const cancel = useRef<(() => void) | null>(null);

  // 跟着指针的说明直接改位置，不必每次移动都重新渲染；放在指针右下方，靠近窗口下边、右边时挪到上方、左边
  const place = () => {
    const g = ghostRef.current;
    if (!g) return;
    const { x, y } = pointer.current;
    const left = Math.max(4, Math.min(x + 14, window.innerWidth - g.offsetWidth - 4));
    const top = y + 16 + g.offsetHeight > window.innerHeight - 4 ? y - g.offsetHeight - 8 : y + 16;
    g.style.transform = `translate(${left}px, ${top}px)`;
  };
  useLayoutEffect(place, [state]);

  // 拖动中离开了工作区视图（返回首页等）：结束拖动
  useEffect(() => () => cancel.current?.(), []);

  // 不变的函数：侧栏的行据此判断要不要重新渲染；里面只用 ref 和 setState
  const start = useCallback((e: React.MouseEvent, item: DragItem) => {
    // 行里的按钮、勾选框、折叠箭头照常点击
    if (e.button !== 0 || cancel.current || (e.target as Element).closest(".row-btn, .check, .chevron")) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;
    let current: DragState | null = null;
    let expandWs: string | undefined;
    let expandTimer = 0;
    let frame = 0;

    const update = () => {
      const { target, collapsed } = hitTest(pointer.current.x, pointer.current.y, item);
      if (collapsed !== expandWs) {
        window.clearTimeout(expandTimer);
        expandWs = collapsed;
        if (collapsed) expandTimer = window.setTimeout(() => optsRef.current.expand(collapsed), EXPAND_DELAY);
      }
      const { status, hint } = judge(item, target, optsRef.current.trees, optsRef.current.reorderBlocked);
      document.body.classList.toggle("drag-nodrop", status !== "ok");
      if (current && current.status === status && current.hint === hint && sameTarget(current.target, target)) return;
      current = { item, target, status, hint };
      setState(current);
    };

    // 指针在侧栏列表上下边缘附近时自动滚动，越靠边越快
    const autoScroll = () => {
      frame = requestAnimationFrame(autoScroll);
      const list = document.querySelector<HTMLElement>(".sidebar .tree");
      if (!list) return;
      const r = list.getBoundingClientRect();
      const { x, y } = pointer.current;
      if (x < r.left || x > r.right || y < r.top - SCROLL_ZONE || y > r.bottom + SCROLL_ZONE) return;
      const speed = (d: number) => Math.ceil(Math.min(d / SCROLL_ZONE, 1) * SCROLL_STEP);
      let dy = 0;
      if (y < r.top + SCROLL_ZONE) dy = -speed(r.top + SCROLL_ZONE - y);
      else if (y > r.bottom - SCROLL_ZONE) dy = speed(y - (r.bottom - SCROLL_ZONE));
      if (!dy) return;
      const before = list.scrollTop;
      list.scrollTop += dy;
      if (list.scrollTop !== before) update();
    };

    const onMove = (ev: MouseEvent) => {
      pointer.current = { x: ev.clientX, y: ev.clientY };
      // 在窗口外松开了鼠标
      if (!(ev.buttons & 1)) return stop();
      if (!dragging) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
        dragging = true;
        document.body.classList.add("drag-moving");
        frame = requestAnimationFrame(autoScroll);
      }
      place();
      update();
    };

    const onUp = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      const drop = current?.status === "ok" ? current : null;
      const dragged = dragging;
      stop();
      if (!dragged) return;
      swallowClick();
      if (drop?.target) optsRef.current.onDrop(drop.item, drop.target);
    };

    // Esc 取消拖动
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (dragging) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      stop();
    };

    const stop = () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", stop);
      window.clearTimeout(expandTimer);
      cancelAnimationFrame(frame);
      document.body.classList.remove("drag-moving", "drag-nodrop");
      cancel.current = null;
      setState(null);
    };

    cancel.current = stop;
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", stop);
  }, []);

  const item = state?.item;
  const ghost = state && item && (
    <div ref={ghostRef} className={`drag-ghost ${state.status}`}>
      <div className="drag-ghost-name">
        {item.kind === "project" ? <FolderFilled className="project-icon" /> : <FileTextOutlined />}
        <span>
          {item.kind === "todo"
            ? displayTitle(item.todo).text
            : item.kind === "todos"
              ? `${item.items.length} 条待办`
              : projectLabel(item.project)}
        </span>
      </div>
      <div className="drag-ghost-hint">{state.hint}</div>
    </div>
  );

  return { state, start, ghost };
}
