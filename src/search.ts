import { useEffect, useState } from "react";
import { api } from "./api";
import type { TodoSummary } from "./types";
import { displayTitle } from "./utils";

// 全文搜索：侧栏和首页的搜索除了在前端匹配项目名、待办标题和正文开头，还让 Rust 端在正文全文里查关键字
// （正文缓存在内存里，文件没变就不重新读），把正文里有关键字的待办也列出来，并显示命中处附近的一段

/** 全文搜索的结果：工作区 → 待办（hitKey）→ 正文里命中处附近的一段 */
export type ContentHits = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** 一个工作区里没有命中的（侧栏的行据此判断要不要重新渲染，要是同一个对象） */
export const NO_HITS: ReadonlyMap<string, string> = new Map();

export const hitKey = (project: string, id: string) => `${project}\u0000${id}`;

/** 输入停下来多久再查（ms）；数据变了（保存、刷新）后重新查也等这么久 */
const SEARCH_DELAY = 200;

const sameMap = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>) =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** 按工作区分组；和上一次查的结果一样的工作区沿用原来的对象 */
function group(list: { workspace: string; project: string; id: string; snippet: string }[], before: ContentHits | null) {
  const hits = new Map<string, Map<string, string>>();
  for (const h of list) {
    let m = hits.get(h.workspace);
    if (!m) hits.set(h.workspace, (m = new Map()));
    m.set(hitKey(h.project, h.id), h.snippet);
  }
  const out = new Map<string, ReadonlyMap<string, string>>();
  for (const [ws, m] of hits) {
    const old = before?.get(ws);
    out.set(ws, old && sameMap(old, m) ? old : m);
  }
  return out;
}

/**
 * 在正文全文里查关键字。workspaces 为 null 时查全部工作区；version 变了（数据刷新、保存之后）重新查。
 * 还没查完时返回 null（这时先只按标题和正文开头匹配）；关键字变了，旧的结果立刻作废
 */
export function useContentSearch(
  workspaces: readonly string[] | null,
  keyword: string,
  version: unknown,
): ContentHits | null {
  const kw = keyword.trim();
  const [result, setResult] = useState<{ kw: string; hits: ContentHits } | null>(null);
  // 工作区列表按内容比较，每次渲染新建的数组不会让它重新查
  const wsKey = workspaces && JSON.stringify(workspaces);
  useEffect(() => {
    if (!kw) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      const list = wsKey ? (JSON.parse(wsKey) as string[]) : null;
      api.searchTodos(list, kw).then(
        (found) => {
          if (stale) return;
          setResult((before) => ({ kw, hits: group(found, before?.kw === kw ? before.hits : null) }));
        },
        // 查不了正文时只按标题和正文开头匹配，不能一直显示「正在搜索」
        () => stale || setResult({ kw, hits: new Map() }),
      );
    }, SEARCH_DELAY);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [kw, wsKey, version]);
  return result && result.kw === kw ? result.hits : null;
}

/**
 * 搜索时待办下面显示的一段正文：显示出来的标题（或没有标题时的正文开头）里已经有关键字时不用；
 * 否则用全文搜索找到的那一段，全文搜索还没查完时先在正文开头里找
 */
export function searchSnippet(t: TodoSummary, keyword: string, hit: string | undefined): string | null {
  const k = keyword.trim().toLowerCase();
  if (!k || displayTitle(t).text.toLowerCase().includes(k)) return null;
  if (hit) return hit;
  const i = t.preview.toLowerCase().indexOf(k);
  if (i < 0) return null;
  const start = Math.max(0, i - 12);
  return (start > 0 ? "…" : "") + t.preview.slice(start, i + k.length + 60);
}
