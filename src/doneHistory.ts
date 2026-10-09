import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { projectLabel } from "./projects";
import type { DoneTodo } from "./types";
import { displayTitle } from "./utils";

// 完成记录：按完成日期（本地时间的自然日）分组列出完成了的待办，顶部是时间范围、查找和统计。
// 这里是时间范围、分组、日期标签、查找和统计的规则（纯函数），界面在 components/DoneHistory.tsx

/** 时间范围：最近 7 天（默认）、最近 30 天、全部 */
export type HistoryRange = "7d" | "30d" | "all";

export const HISTORY_RANGES: { value: HistoryRange; label: string }[] = [
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
  { value: "all", label: "全部" },
];

export const DEFAULT_RANGE: HistoryRange = "7d";

export const isHistoryRange = (v: unknown): v is HistoryRange => v === "7d" || v === "30d" || v === "all";

/** 范围里有几天（包括今天）；「全部」是 null */
export const rangeDays = (range: HistoryRange): number | null => (range === "7d" ? 7 : range === "30d" ? 30 : null);

/** 那天的零点（本地时间） */
export const dayStart = (ms: number) => dayjs(ms).startOf("day").valueOf();

/**
 * 范围从哪一刻算起：今天和之前的 n - 1 天，从那天的零点（本地时间）起；「全部」是 null。
 * 按日历往前数，不是减去 n × 24 小时（夏令时切换的那天不是 24 小时）
 */
export function rangeStart(range: HistoryRange, now: number): number | null {
  const days = rangeDays(range);
  return days === null ? null : dayjs(now).startOf("day").subtract(days - 1, "day").valueOf();
}

/** 在范围里：「全部」都算，包括没有完成时间的；最近几天的要有完成时间、不早于 start */
export function inRange(x: DoneTodo, start: number | null): boolean {
  if (start === null) return true;
  return x.todo.doneAt !== null && x.todo.doneAt >= start;
}

/** 一天的组名：今天 / 昨天 / 10月7日 星期三；不是今年的写上年份：2025年12月31日 星期三 */
export function dayLabel(day: number, now: number): string {
  const d = dayjs(day).locale("zh-cn");
  const today = dayjs(now).startOf("day");
  if (d.isSame(today, "day")) return "今天";
  if (d.isSame(today.subtract(1, "day"), "day")) return "昨天";
  return d.format(d.year() === today.year() ? "M月D日 dddd" : "YYYY年M月D日 dddd");
}

/** 柱状图下面的日期：今天 / 10/7 */
export const barLabel = (day: number, now: number) => (day === dayStart(now) ? "今天" : dayjs(day).format("M/D"));

export const UNKNOWN_DAY = "完成时间不详";

/** 完成记录里的一组：同一天完成的 */
export interface DayGroup {
  /** 那天的零点（本地时间）；「完成时间不详」的是 null */
  day: number | null;
  label: string;
  items: DoneTodo[];
}

/**
 * 按完成日期（本地时间的自然日）分组：最近的那天在前，组里按完成时间倒序；
 * 没有完成时间的放在最后的「完成时间不详」一组，按修改时间倒序
 */
export function groupByDay(items: readonly DoneTodo[], now: number): DayGroup[] {
  const byDay = new Map<number, DoneTodo[]>();
  const unknown: DoneTodo[] = [];
  for (const x of items) {
    if (x.todo.doneAt === null) {
      unknown.push(x);
      continue;
    }
    const day = dayStart(x.todo.doneAt);
    const list = byDay.get(day);
    if (list) list.push(x);
    else byDay.set(day, [x]);
  }
  const groups: DayGroup[] = [...byDay]
    .sort(([a], [b]) => b - a)
    .map(([day, list]) => ({
      day,
      label: dayLabel(day, now),
      items: list.sort((a, b) => b.todo.doneAt! - a.todo.doneAt!),
    }));
  if (unknown.length)
    groups.push({ day: null, label: UNKNOWN_DAY, items: unknown.sort((a, b) => b.todo.updatedAt - a.todo.updatedAt) });
  return groups;
}

/** 所在的位置：工作区 / 父项目 / 子项目 */
export const placeOf = (x: DoneTodo) => `${x.workspace} / ${projectLabel(x.project)}`;

/** 查找：标题（没有标题时的正文开头）或所在的工作区、项目里有关键字，不区分大小写；没有关键字时都算 */
export function matchHistory(x: DoneTodo, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  return !k || `${displayTitle(x.todo).text} ${placeOf(x)}`.toLowerCase().includes(k);
}

/** 今天完成了几条 */
export function countToday(items: readonly DoneTodo[], now: number): number {
  const today = dayStart(now);
  return items.filter((x) => x.todo.doneAt !== null && dayStart(x.todo.doneAt) === today).length;
}

/** 柱状图：范围里每一天完成了几条，从早到晚，最后一天是今天；「全部」时不画，是空的 */
export function dailyCounts(items: readonly DoneTodo[], range: HistoryRange, now: number): { day: number; count: number }[] {
  const days = rangeDays(range);
  if (days === null) return [];
  const counts = new Map<number, number>();
  for (const x of items) {
    if (x.todo.doneAt === null) continue;
    const day = dayStart(x.todo.doneAt);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const today = dayjs(now).startOf("day");
  return Array.from({ length: days }, (_, i) => {
    const day = today.subtract(days - 1 - i, "day").valueOf();
    return { day, count: counts.get(day) ?? 0 };
  });
}
