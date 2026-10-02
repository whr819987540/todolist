import { Dropdown, Tooltip, type MenuProps } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TodoSummary, WorkspaceTree } from "../../types";
import TodoTip from "./TodoTip";
import { parseSelKey } from "./tree";

/** 打开行的右键菜单（侧栏共用一个，见 useRowPopups） */
export type OpenMenu = (e: React.MouseEvent, menu: MenuProps) => void;

/** 指针在待办行上停多久（ms）显示悬停提示，同原来每行一个 Tooltip 时的 mouseEnterDelay */
const TIP_DELAY = 800;

/**
 * 侧栏里所有待办行共用的悬停提示和右键菜单。
 * 悬停提示：指针在一行上停一会儿后，在这一行右边显示（锚点是一个和这一行一样大小位置的透明元素）；离开、滚动时隐藏。
 * 右键菜单：在指针处显示，点了菜单项、点了别处时关闭
 */
export function useRowPopups(trees: WorkspaceTree[]) {
  const [tip, setTip] = useState<{ key: string; rect: DOMRect } | null>(null);
  // seq：每次右键加一，换一个 Dropdown，菜单按新的位置重新对齐
  const [menu, setMenu] = useState<{ x: number; y: number; menu: MenuProps; open: boolean; seq: number } | null>(null);
  const timer = useRef(0);
  const hovered = useRef<HTMLElement | null>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const hideTip = useCallback(() => {
    hovered.current = null;
    window.clearTimeout(timer.current);
    setTip(null);
  }, []);

  const onMouseOver = useCallback((e: React.MouseEvent) => {
    const row = (e.target as Element).closest<HTMLElement>(".todo-row");
    if (row === hovered.current) return;
    hovered.current = row;
    window.clearTimeout(timer.current);
    setTip(null);
    if (row)
      timer.current = window.setTimeout(() => {
        if (row.isConnected && !document.body.classList.contains("drag-moving"))
          setTip({ key: row.dataset.sel!, rect: row.getBoundingClientRect() });
      }, TIP_DELAY);
  }, []);

  const openMenu = useCallback<OpenMenu>(
    (e, m) => {
      e.preventDefault();
      hideTip();
      setMenu((old) => ({ x: e.clientX, y: e.clientY, menu: m, open: true, seq: (old?.seq ?? 0) + 1 }));
    },
    [hideTip],
  );
  const closeMenu = () => setMenu((m) => (m ? { ...m, open: false } : m));

  let tipTodo: TodoSummary | undefined;
  if (tip) {
    const s = parseSelKey(tip.key);
    tipTodo = trees
      .find((t) => t.name === s.workspace)
      ?.projects.find((x) => x.name === s.project)
      ?.todos.find((x) => x.id === s.todoId);
  }

  const node = (
    <>
      {tip && tipTodo && (
        <Tooltip key={tip.key} open title={<TodoTip t={tipTodo} />} placement="right">
          <div
            className="row-popup-anchor"
            style={{ left: tip.rect.left, top: tip.rect.top, width: tip.rect.width, height: tip.rect.height }}
          />
        </Tooltip>
      )}
      {menu && (
        <Dropdown
          key={menu.seq}
          open={menu.open}
          trigger={["click"]}
          placement="bottomLeft"
          menu={{
            ...menu.menu,
            onClick: (info) => {
              closeMenu();
              menu.menu.onClick?.(info);
            },
          }}
          onOpenChange={(o) => !o && closeMenu()}
        >
          {/* 1px 大小：rc-trigger 不给零大小的元素对齐弹出层 */}
          <div className="row-popup-anchor" style={{ left: menu.x, top: menu.y, width: 1, height: 1 }} />
        </Dropdown>
      )}
    </>
  );

  return { node, onMouseOver, hideTip, openMenu };
}
