// 待办的优先级：高 / 中 / 低 / 无（默认无），存成 3 / 2 / 1 / 0
import type { Priority } from "./types";

/** 从高到低，菜单、下拉里按这个顺序列出 */
export const PRIORITIES: readonly Priority[] = [3, 2, 1, 0];

export const PRIORITY_LABELS: Record<Priority, string> = { 3: "高", 2: "中", 1: "低", 0: "无" };

/** 「高优先级」「无优先级」 */
export const priorityText = (p: Priority) => `${PRIORITY_LABELS[p]}优先级`;
