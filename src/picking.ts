// 批量操作的多选：在左侧列表里 Ctrl+单击加选 / 取消一条待办，Shift+单击选中从上次点的那条到这一条之间的一段。
// 选中的待办用行上的 data-sel（selKey）表示

/**
 * Ctrl+单击 key 那条：选中了就取消，没选中就加上。还没多选时从右侧正打开着的那条（current）开始，
 * 这样打开一条后再 Ctrl+单击另一条，就是选中了这两条
 */
export function togglePick(picked: readonly string[], key: string, current: string | null): string[] {
  const base = !picked.length && current && current !== key ? [current] : picked;
  return base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
}

/** Shift+单击：按显示顺序（order）选中 anchor 到 key 之间的一段（含两端）；有一头不在列表里（被折叠、筛掉了）时返回 null */
export function rangePick(order: readonly string[], anchor: string, key: string): string[] | null {
  const i = order.indexOf(anchor);
  const j = order.indexOf(key);
  if (i < 0 || j < 0) return null;
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}
