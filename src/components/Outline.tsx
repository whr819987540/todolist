import { CloseOutlined } from "@ant-design/icons";
import { Tooltip } from "antd";
import { useEffect, useRef } from "react";
import { type OutlineItem, outlineDepth } from "../editor/outline";

/** 正文右侧的大纲：点标题跳过去，正在看的那个标题高亮 */
export default function Outline({
  items,
  active,
  onJump,
  onClose,
}: {
  items: readonly OutlineItem[];
  /** 正在看的标题在 items 里的位置，-1 表示还在第一个标题前面 */
  active: number;
  onJump: (item: OutlineItem) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // 正在看的标题滚到大纲的可见区域里
  useEffect(() => {
    listRef.current?.querySelector(".outline-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <aside className="outline" aria-label="大纲">
      <div className="outline-head">
        <span>大纲</span>
        <Tooltip title="隐藏大纲（Ctrl+Shift+1）" placement="left">
          <span className="outline-close" onClick={onClose}>
            <CloseOutlined />
          </span>
        </Tooltip>
      </div>
      <div className="outline-list" ref={listRef}>
        {items.map((item, i) => (
          <div
            key={`${item.pos}:${item.text}`}
            className={`outline-item level-${item.level}${i === active ? " active" : ""}`}
            style={{ paddingLeft: 14 + outlineDepth(items, item) * 14 }}
            title={item.text}
            onClick={() => onJump(item)}
          >
            {item.text}
          </div>
        ))}
      </div>
    </aside>
  );
}
