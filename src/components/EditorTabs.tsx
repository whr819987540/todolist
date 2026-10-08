import { CloseOutlined, PushpinFilled } from "@ant-design/icons";
import { Dropdown, type MenuProps } from "antd";
import { useEffect, useRef } from "react";
import { type OpenTodo, sameTodo, type TodoRef } from "../tabs";
import type { TodoSummary } from "../types";
import { displayTitle } from "../utils";
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
  onActivate: (t: ShownTab) => void;
  onClose: (closing: readonly ShownTab[]) => void;
  /** 预览标签固定下来 */
  onKeep: (t: ShownTab) => void;
}

const PREVIEW_HINT = "预览：打开别的待办时会被替换；修改内容或双击后一直保留";

/**
 * 右侧编辑区上方的标签：每个是一条打开着的待办，点击切过去（光标、滚动回到上次的地方），× / 鼠标中键 / Ctrl+W 关掉，
 * 右键关掉其他的、右侧的、全部。预览标签的标题是斜体
 */
export default function EditorTabs({ tabs, active, onActivate, onClose, onKeep }: Props) {
  const barRef = useRef<HTMLDivElement>(null);

  // 正显示着的标签滚动到看得见的地方
  const activeKey = active ? selKey(active) : null;
  useEffect(() => {
    barRef.current?.querySelector(".editor-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, tabs.length]);

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
        const { text, fromContent } = displayTitle(t.todo);
        const isActive = !!active && sameTodo(t, active);
        return (
          <Dropdown key={selKey(t)} menu={menu(t, i)} trigger={["contextMenu"]}>
            <div
              role="tab"
              aria-selected={isActive}
              data-tab={selKey(t)}
              className={`editor-tab${isActive ? " active" : ""}${t.preview ? " preview" : ""}${t.todo.done ? " done" : ""}`}
              title={`${t.workspace} / ${t.project} / ${text}${t.preview ? `\n${PREVIEW_HINT}` : ""}`}
              onClick={() => onActivate(t)}
              onDoubleClick={() => t.preview && onKeep(t)}
              // 中键关掉；按下时不让 WebView 进入自动滚动
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
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
                title="关闭（Ctrl+W）"
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
