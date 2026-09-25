import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { useEffect, useState } from "react";
import type { SortKey, TodoSummary } from "./types";

dayjs.locale("zh-cn");

const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
export const compareName = (a: string, b: string) => collator.compare(a, b);

/** 完整时间：2026-09-26 14:30:12 */
export function fullTime(ms: number | null | undefined): string {
  return ms ? dayjs(ms).format("YYYY-MM-DD HH:mm:ss") : "—";
}

/** 紧凑时间：今天 14:30 / 昨天 14:30 / 09-26 14:30 / 2025-09-26 */
export function shortTime(ms: number, now = Date.now()): string {
  const d = dayjs(ms);
  const today = dayjs(now).startOf("day");
  if (!d.isBefore(today)) return d.format("今天 HH:mm");
  if (!d.isBefore(today.subtract(1, "day"))) return d.format("昨天 HH:mm");
  if (d.year() === today.year()) return d.format("MM-DD HH:mm");
  return d.format("YYYY-MM-DD");
}

/** 侧栏用的更紧凑格式（参照微信）：14:30 / 昨天 14:30 / 09-26 / 2025-09-26 */
export function compactTime(ms: number, now = Date.now()): string {
  const d = dayjs(ms);
  const today = dayjs(now).startOf("day");
  if (!d.isBefore(today)) return d.format("HH:mm");
  if (!d.isBefore(today.subtract(1, "day"))) return d.format("昨天 HH:mm");
  if (d.year() === today.year()) return d.format("MM-DD");
  return d.format("YYYY-MM-DD");
}

/** 相对时间：刚刚 / 5 分钟前 / 3 小时前，超过一天退回紧凑时间。compact 用于侧栏 */
export function relativeTime(ms: number, now = Date.now(), compact = false): string {
  const diff = now - ms;
  const sp = compact ? "" : " ";
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}${sp}分钟前`;
  if (diff < 86_400_000 && dayjs(ms).isSame(now, "day")) {
    return `${Math.floor(diff / 3_600_000)}${sp}小时前`;
  }
  return compact ? compactTime(ms, now) : shortTime(ms, now);
}

/** 每隔一段时间触发重渲染，让“x 分钟前”保持新鲜 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** 左侧显示用的文字：有标题用标题，否则用正文开头 */
export function displayTitle(t: TodoSummary): { text: string; fromContent: boolean } {
  const title = t.title.trim();
  if (title) return { text: title, fromContent: false };
  if (t.preview) return { text: t.preview, fromContent: true };
  return { text: "空白待办", fromContent: true };
}

export function sortTodos(todos: TodoSummary[], key: SortKey): TodoSummary[] {
  const byKey = (a: TodoSummary, b: TodoSummary) => {
    switch (key) {
      case "updated":
        return b.updatedAt - a.updatedAt;
      case "title":
        return compareName(displayTitle(a).text, displayTitle(b).text);
      default:
        return b.createdAt - a.createdAt;
    }
  };
  // 未完成在前，已完成沉底
  return [...todos].sort((a, b) => Number(a.done) - Number(b.done) || byKey(a, b));
}

export function matchTodo(t: TodoSummary, keyword: string): boolean {
  if (!keyword) return true;
  const k = keyword.toLowerCase();
  return t.title.toLowerCase().includes(k) || t.preview.toLowerCase().includes(k);
}

/** 字数：不计空白字符 */
export function countChars(text: string): number {
  let n = 0;
  for (const ch of text) if (!/\s/.test(ch)) n++;
  return n;
}

const AVATAR_COLORS = ["#1677ff", "#13a8a8", "#52c41a", "#fa8c16", "#722ed1", "#eb2f96", "#2f54eb", "#fa541c"];

export function avatarColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function firstChar(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}

/** 持久化到 localStorage 的 state（只存界面偏好，读写失败时退回内存值） */
export function useLocalState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const read = (): T => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  };
  const [value, setValue] = useState<T>(read);
  // key 变化（例如切换工作区）时重新读取
  const [loadedKey, setLoadedKey] = useState(key);
  if (loadedKey !== key) {
    setLoadedKey(key);
    setValue(read());
  }
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 忽略 */
    }
  }, [key, value]);
  return [value, setValue];
}
