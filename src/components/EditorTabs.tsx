import { CloseOutlined, PushpinFilled } from "@ant-design/icons";
import { Dropdown, type MenuProps } from "antd";
import { useEffect, useRef, useState } from "react";
import { type OpenTodo, sameTodo, type TodoRef } from "../tabs";
import type { TodoSummary } from "../types";
import { PRIORITY_LABELS } from "../priority";
import { projectLabel } from "../projects";
import { displayTitle } from "../utils";
import { swallowClick } from "./DragMove";
import { selKey } from "./sidebar/tree";

/** 显示出来的一个标签：打开着的待办连同它现在的标题等 */
export interface ShownTab extends OpenTodo {
  todo: TodoSummary;
}

interface Props {
  /** 侧栏里显示着的工作区的标签，按顺序 */
  tabs: readonly ShownTab[];
  /** 右侧正显示着的待办；显示概览等时是 null */
  active: TodoRef | null;
  /** 正显示着的待办有没存好的修改：标签上 × 的位置显示圆点 */
  activeDirty: boolean;
  onActivate: (t: ShownTab) => void;
  onClose: (closing: readonly ShownTab[]) => void;
  /** 预览标签固定下来 */
  onKeep: (t: ShownTab) => void;
  /** 拖动标签：moving 挪到 target 的前面 / 后面 */
  onMove: (moving: TodoRef, target: TodoRef, place: "before" | "after") => void;
}

/** 拖动中：正在拖的标签（selKey），放在哪个标签的前面 / 后面；放回原处时 target 是 null */
interface TabDrag {
  key: string;
  target: string | null;
  place: "before" | "after";
}

const DIRTY_HINT = "有没保存的修改，关掉、切走时会先保存";
const PREVIEW_HINT = "预览：打开别的待办时会被替换；修改内容或双击后一直保留";

/** 按下后横着移动超过这么多像素才算拖动 */
const THRESHOLD = 5;
/** 拖动时指针离标签栏左右两头这么近（px）时自动滚动，每帧滚这么多 */
const SCROLL_ZONE = 32;
const SCROLL_STEP = 8;

/**
 * 右侧编辑区上方的标签：每个是一条打开着的待办，点击切过去（光标、滚动回到上次的地方），× / 鼠标中键 / Ctrl+W 关掉，
 * 右键关掉其他的、右侧的、全部，按住拖动调整顺序。预览标签的标题是斜体
 */
export default function EditorTabs({ tabs, active, activeDirty, onActivate, onClose, onKeep, onMove }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<TabDrag | null>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  const latest = useRef({ tabs, onMove });
  useEffect(() => {
    latest.current = { tabs, onMove };
  });
  // 拖动中离开了工作区视图（返回首页等）：结束拖动
  useEffect(() => () => stopDrag.current?.(), []);

  // 正显示着的标签滚动到看得见的地方
  const activeKey = active ? selKey(active) : null;
  useEffect(() => {
    barRef.current?.querySelector(".editor-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, tabs.length]);

  /** 在标签上按下左键：移动几个像素后开始拖，没怎么动就还是单击 */
  const startDrag = (e: React.MouseEvent, t: ShownTab) => {
    if (e.button !== 0 || stopDrag.current || (e.target as Element).closest(".editor-tab-close")) return;
    const key = selKey(t);
    const x0 = e.clientX;
    const y0 = e.clientY;
    let x = x0;
    let dragging = false;
    let current: TabDrag | null = null;
    let frame = 0;

    // 指针在哪个标签的左半边就放在它前面，过了最后一个标签的中线放在最后
    const update = () => {
      const els = [...(barRef.current?.querySelectorAll<HTMLElement>(".editor-tab") ?? [])];
      let at = els.findIndex((el) => {
        const r = el.getBoundingClientRect();
        return x < r.left + r.width / 2;
      });
      let place: TabDrag["place"] = "before";
      if (at < 0) {
        at = els.length - 1;
        place = "after";
      }
      const from = els.findIndex((el) => el.dataset.tab === key);
      const back = at === from || (place === "before" ? at === from + 1 : at === from - 1);
      const target = back ? null : (els[at]?.dataset.tab ?? null);
      if (current && current.target === target && current.place === place) return;
      current = { key, target, place };
      setDrag(current);
    };

    // 指针靠近标签栏左右两头时自动滚动
    const autoScroll = () => {
      frame = requestAnimationFrame(autoScroll);
      const bar = barRef.current;
      if (!bar) return;
      const r = bar.getBoundingClientRect();
      const dx = x < r.left + SCROLL_ZONE ? -SCROLL_STEP : x > r.right - SCROLL_ZONE ? SCROLL_STEP : 0;
      if (!dx) return;
      const before = bar.scrollLeft;
      bar.scrollLeft += dx;
      if (bar.scrollLeft !== before) update();
    };

    const onMoveEv = (ev: MouseEvent) => {
      x = ev.clientX;
      // 在窗口外松开了鼠标
      if (!(ev.buttons & 1)) return stop();
      if (!dragging) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
        dragging = true;
        document.body.classList.add("drag-moving");
        frame = requestAnimationFrame(autoScroll);
      }
      update();
    };

    const onUp = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      const drop = current;
      const dragged = dragging;
      stop();
      if (!dragged) return;
      swallowClick();
      const { tabs, onMove } = latest.current;
      const moving = tabs.find((x) => selKey(x) === key);
      const target = drop?.target && tabs.find((x) => selKey(x) === drop.target);
      if (moving && target) onMove(moving, target, drop.place);
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
      window.removeEventListener("mousemove", onMoveEv, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", stop);
      cancelAnimationFrame(frame);
      document.body.classList.remove("drag-moving");
      stopDrag.current = null;
      setDrag(null);
    };

    stopDrag.current = stop;
    window.addEventListener("mousemove", onMoveEv, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", stop);
  };

  const menu = (t: ShownTab, i: number): MenuProps => ({
    items: [
      { key: "close", label: "关闭", extra: "Ctrl+W" },
      { key: "others", label: "关闭其他标签", disabled: tabs.length < 2 },
      { key: "right", label: "关闭右侧标签", disabled: i === tabs.length - 1 },
      { key: "all", label: "关闭全部标签" },
      ...(t.preview ? [{ type: "divider" as const }, { key: "keep", label: "保持打开" }] : []),
    ],
    onClick: ({ key, domEvent }) => {
      // 菜单挂在标签上：点击菜单项的事件会沿 React 树冒泡到标签的 onClick
      domEvent.stopPropagation();
      if (key === "close") onClose([t]);
      else if (key === "others") onClose(tabs.filter((x) => x !== t));
      else if (key === "right") onClose(tabs.slice(i + 1));
      else if (key === "all") onClose(tabs);
      else if (key === "keep") onKeep(t);
    },
  });

  return (
    <div
      className="editor-tabs"
      role="tablist"
      ref={barRef}
      // 竖着滚滚轮时横着滚动标签
      onWheel={(e) => {
        if (barRef.current && !e.deltaX) barRef.current.scrollLeft += e.deltaY;
      }}
    >
      {tabs.map((t, i) => {
        const key = selKey(t);
        const { text, fromContent } = displayTitle(t.todo);
        const isActive = !!active && sameTodo(t, active);
        const dirty = isActive && activeDirty;
        const cls = [
          "editor-tab",
          isActive && "active",
          t.preview && "preview",
          t.todo.done && "done",
          dirty && "dirty",
          drag?.key === key && "drag-source",
          drag?.target === key && `drop-${drag.place}`,
        ];
        return (
          <Dropdown key={key} menu={menu(t, i)} trigger={["contextMenu"]}>
            <div
              role="tab"
              aria-selected={isActive}
              data-tab={key}
              className={cls.filter(Boolean).join(" ")}
              title={[
                `${t.workspace} / ${projectLabel(t.project)} / ${text}`,
                t.todo.priority > 0 && `优先级：${PRIORITY_LABELS[t.todo.priority]}`,
                t.todo.tags.length > 0 && `标签：${t.todo.tags.join("、")}`,
                dirty && DIRTY_HINT,
                t.preview && PREVIEW_HINT,
              ]
                .filter(Boolean)
                .join("\n")}
              onClick={() => onActivate(t)}
              onDoubleClick={() => t.preview && onKeep(t)}
              // 左键按住拖动；中键按下时不让 WebView 进入自动滚动，松开时关掉
              onMouseDown={(e) => (e.button === 1 ? e.preventDefault() : startDrag(e, t))}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                onClose([t]);
              }}
            >
              <span className={`editor-tab-label${fromContent ? " from-content" : ""}`}>
                {t.todo.pinned && <PushpinFilled className="pin-mark" />}
                {text}
              </span>
              <span
                className="editor-tab-close"
                role="button"
                aria-label="关闭"
                title={dirty ? `${DIRTY_HINT}（Ctrl+W 关闭）` : "关闭（Ctrl+W）"}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose([t]);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <CloseOutlined />
              </span>
            </div>
          </Dropdown>
        );
      })}
    </div>
  );
}
