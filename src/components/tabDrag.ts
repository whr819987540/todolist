import { useSyncExternalStore } from "react";

// 拖动中的标签（EditorTabs）：可以拖到分屏的另一边，各组的标签栏、另一边的编辑区（WorkspaceView）都按它画出拖着的标签和
// 放下的位置

/**
 * 拖动中：正在拖的标签（selKey，在第 from 组），放到第 to 组的哪个标签的前面 / 后面。target 为 null 时：to 是别的组
 * （指针在那一边的编辑区上）放在那一组的最后，to 是原来那一组（或指针不在任何一组上）是放回原处
 */
export interface TabDrag {
  key: string;
  from: number;
  to: number;
  target: string | null;
  place: "before" | "after";
}

let tabDrag: TabDrag | null = null;
const dragListeners = new Set<() => void>();
export function setTabDrag(d: TabDrag | null) {
  tabDrag = d;
  for (const fn of [...dragListeners]) fn();
}
const subscribeTabDrag = (fn: () => void) => {
  dragListeners.add(fn);
  return () => {
    dragListeners.delete(fn);
  };
};
/** 拖动中的标签；没在拖时是 null */
export const useTabDrag = () => useSyncExternalStore(subscribeTabDrag, () => tabDrag);

/** 拖到另一边的编辑区上（放在那一边的最后）：WorkspaceView 给那一边加上 drop-target */
export const dropsOnGroup = (d: TabDrag | null, group: number) =>
  !!d && d.to === group && d.from !== group && !d.target;
