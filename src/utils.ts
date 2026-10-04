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

/** 时长：45 秒 / 3 分钟 / 1 分 30 秒 */
export function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const rest = secs % 60;
  if (!m) return `${rest} 秒`;
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分钟`;
}

/** 每隔一段时间触发重渲染，让“x 分钟前”保持新鲜 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
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

/** 另存为新待办时标题后面加的 */
export const MY_VERSION = "（我的版本）";

/**
 * 外部修改冲突时「另存为新待办」的标题：原来的标题加上「（我的版本）」；没有标题时取正文第一行
 * （去掉标题、引用、列表、任务框这些行首标记，太长的截短）
 */
export function myVersionTitle(title: string, content: string): string {
  let base = title.trim();
  if (!base) {
    const line = content.split("\n").find((l) => l.trim()) ?? "";
    base = line
      .trim()
      .replace(/^(?:[#>]+\s*|[-*+]\s+|\d+[.)]\s+)*(?:\[[ xX]\]\s+)?/, "")
      .trim();
    if (base.length > 30) base = `${base.slice(0, 30)}…`;
  }
  return base ? `${base}${MY_VERSION}` : "我的版本";
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
  // 未完成在前，已完成沉底；各自里面置顶的在前
  return [...todos].sort((a, b) => Number(a.done) - Number(b.done) || Number(b.pinned) - Number(a.pinned) || byKey(a, b));
}

export function matchTodo(t: TodoSummary, keyword: string): boolean {
  if (!keyword) return true;
  const k = keyword.toLowerCase();
  return t.title.toLowerCase().includes(k) || t.preview.toLowerCase().includes(k);
}

/** 和正则 \s 一样的空白字符（UTF-16 码元） */
function isSpace(c: number): boolean {
  if (c <= 0x20) return c === 0x20 || (c >= 0x09 && c <= 0x0d);
  if (c < 0xa0) return false;
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/**
 * 状态栏的字数和行数。字数不计空白字符，一个字（含 emoji 等 UTF-16 代理对）算一个；
 * 逐个码元判断，不对每个字符跑正则，几十 KB 的正文也很快
 */
export function textStats(text: string): { chars: number; lines: number } {
  let chars = 0;
  let lines = text ? 1 : 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) lines++;
    // 代理对的后半个和前半个算同一个字
    if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
      const prev = text.charCodeAt(i - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) continue;
    }
    if (!isSpace(c)) chars++;
  }
  return { chars, lines };
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
