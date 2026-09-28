import { FileTextOutlined } from "@ant-design/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TodoSummary } from "../types";
import { displayTitle } from "../utils";

// 拖动移动：在左侧列表或项目概览里按住待办，拖到左侧的另一个项目上（可以是别的工作区的）松开。
// 用鼠标事件自己实现，不用 HTML5 拖放：WebView2 里拖放默认被 Tauri 接管（给拖文件进窗口用），
// 自己做也好控制放下的位置、跟着指针的说明和自动滚动。
// 能放下的地方是侧栏里标了 data-drop-ws（工作区）、data-drop-project（项目）的节点。

/** 拖动中的东西 */
export interface DragItem {
  kind: "todo";
  workspace: string;
  project: string;
  todo: TodoSummary;
}

/** 放下的地方 */
export interface DropTarget {
  workspace: string;
  project?: string;
}

/** ok：可以放下；none：指针不在能放的地方，或者就在原处 */
export type DropStatus = "ok" | "none";

export interface DragState {
  item: DragItem;
  /** 指针下的项目 */
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

/** 正在拖的是不是这条待办 */
export const isDraggingTodo = (s: DragState | null, workspace: string, project: string, id: string) =>
  s?.item.workspace === workspace && s.item.project === project && s.item.todo.id === id;

/** 这里是不是指针下可以放下的地方 */
export const isDropTarget = (s: DragState | null, workspace: string, project?: string) =>
  s?.status === "ok" && s.target?.workspace === workspace && s.target.project === project;

const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
  a?.workspace === b?.workspace && a?.project === b?.project;

/** 指针下能放下的项目；collapsed 是指针下折叠起来的工作区 */
function hitTest(x: number, y: number): { target: DropTarget | null; collapsed?: string } {
  const el = document.elementFromPoint(x, y);
  const wsEl = el?.closest<HTMLElement>(".sidebar [data-drop-ws]");
  if (!el || !wsEl) return { target: null };
  const workspace = wsEl.dataset.dropWs!;
  const project = el.closest<HTMLElement>("[data-drop-project]")?.dataset.dropProject;
  return {
    target: project ? { workspace, project } : null,
    collapsed: wsEl.getAttribute("aria-expanded") === "false" ? workspace : undefined,
  };
}

function judge(item: DragItem, target: DropTarget | null): { status: DropStatus; hint: string } {
  if (!target?.project) return { status: "none", hint: "拖到左侧的项目上" };
  if (target.workspace === item.workspace && target.project === item.project)
    return { status: "none", hint: "已在这个项目里" };
  const where = target.workspace === item.workspace ? target.project : `${target.workspace} / ${target.project}`;
  return { status: "ok", hint: `移动到「${where}」` };
}

/** 拖完松开鼠标后浏览器还会发一个 click，别让它被当成单击（选中、打开）处理 */
function swallowClick() {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

/** 拖动移动。返回的 ghost 是跟着指针的说明，要渲染出来 */
export function useDragMove(opts: {
  /** 展开折叠起来的工作区 */
  expand(workspace: string): void;
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

  const start = (e: React.MouseEvent, item: DragItem) => {
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
      const { target, collapsed } = hitTest(pointer.current.x, pointer.current.y);
      if (collapsed !== expandWs) {
        window.clearTimeout(expandTimer);
        expandWs = collapsed;
        if (collapsed) expandTimer = window.setTimeout(() => optsRef.current.expand(collapsed), EXPAND_DELAY);
      }
      const { status, hint } = judge(item, target);
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
  };

  const ghost = state && (
    <div ref={ghostRef} className={`drag-ghost ${state.status}`}>
      <div className="drag-ghost-name">
        <FileTextOutlined />
        <span>{displayTitle(state.item.todo).text}</span>
      </div>
      <div className="drag-ghost-hint">{state.hint}</div>
    </div>
  );

  return { state, start, ghost };
}
