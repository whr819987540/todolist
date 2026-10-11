// 待办的标签（tag，和右侧的标签页不是一回事）：规整标签名（同 Rust 端 store.rs 的 clean_tag）、
// 不区分大小写地比较和去重、侧栏里显示的工作区用过哪些标签、标签的颜色
import type { WorkspaceTree } from "./types";
import { compareName } from "./utils";

/** 标签名最多这么多个字 */
export const MAX_TAG_CHARS = 20;

/** 标签的颜色有几种（styles.css 的 .tag-c0 ～ .tag-c8，浅色、深色各一套） */
export const TAG_COLORS = 9;

/**
 * 规整一个标签名：去掉首尾空白和开头的 #（全角的 ＃ 也算）；不能为空、不超过 20 个字，不能有逗号（半角、全角）和换行。
 * 合规则时返回规整后的名字，否则返回原因
 */
export function cleanTag(raw: string): { tag: string } | { error: string } {
  const tag = raw.trim().replace(/^[#＃]+/, "").trim();
  if (!tag) return { error: "标签不能为空" };
  if ([...tag].length > MAX_TAG_CHARS) return { error: `标签不能超过 ${MAX_TAG_CHARS} 个字` };
  // eslint-disable-next-line no-control-regex
  if (/[,，\u0000-\u001f\u007f-\u009f]/.test(tag)) return { error: "标签里不能有逗号和换行" };
  return { tag };
}

/** 两个标签算同一个：不区分大小写 */
export const sameTag = (a: string, b: string) => a === b || a.toLowerCase() === b.toLowerCase();

export const hasTag = (tags: readonly string[], tag: string) => tags.some((t) => sameTag(t, tag));

/** 加上几个标签：已经有的（不区分大小写）不再加，加上的排在后面；什么都没加时返回原来的数组 */
export function addTags(tags: readonly string[], more: readonly string[]): readonly string[] {
  const out = [...tags];
  for (const t of more) if (!hasTag(out, t)) out.push(t);
  return out.length === tags.length ? tags : out;
}

/** 去掉几个标签（不区分大小写）；什么都没去掉时返回原来的数组 */
export function removeTags(tags: readonly string[], remove: readonly string[]): readonly string[] {
  const out = tags.filter((t) => !hasTag(remove, t));
  return out.length === tags.length ? tags : out;
}

/** 标签的颜色（0 ～ TAG_COLORS-1）：按名字（不分大小写）固定地取，同名的在哪里都是同一个颜色 */
export function tagColor(tag: string): number {
  let h = 0;
  for (const ch of tag.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % TAG_COLORS;
}

/** 一个标签的样式类：带颜色的圆角小块，颜色按名字固定（浅色、深色各一套，在 styles.css 里） */
export const tagClass = (tag: string) => `tag-chip tag-c${tagColor(tag)}`;

/** 用过的一个标签：显示的写法（用这个写法的待办最多的那个）和几条待办有它 */
export interface TagCount {
  name: string;
  count: number;
}

/** 这些工作区（侧栏里显示的）的全部待办 */
export const allTodos = (trees: readonly WorkspaceTree[]) => trees.flatMap((t) => t.projects.flatMap((p) => p.todos));

/**
 * 这些待办（侧栏里显示的工作区的、批量操作选中的）用到的标签：不区分大小写地合起来数，有它的待办多的在前，
 * 一样多的按名字排
 */
export function countTags(todos: readonly { tags: readonly string[] }[]): TagCount[] {
  // 小写 → 一共几条、各种写法各几条
  const all = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const t of todos)
    for (const tag of t.tags) {
      const key = tag.toLowerCase();
      let c = all.get(key);
      if (!c) all.set(key, (c = { count: 0, spellings: new Map() }));
      c.count++;
      c.spellings.set(tag, (c.spellings.get(tag) ?? 0) + 1);
    }
  return [...all.values()]
    .map(({ count, spellings }) => {
      let name = "";
      let most = 0;
      for (const [s, n] of spellings) if (n > most) [name, most] = [s, n];
      return { name, count };
    })
    .sort((a, b) => b.count - a.count || compareName(a.name, b.name));
}

/**
 * 输入标签时下拉里列出的：用过的标签（all，countTags 的结果）里包含输入的字的（不区分大小写，用得多的在前），
 * 已经有的（exclude）不列；还没输入时就是最常用的
 */
export function suggestTags(all: readonly TagCount[], input: string, exclude: readonly string[], limit = 8): string[] {
  const k = input.trim().replace(/^[#＃]+/, "").trim().toLowerCase();
  return all
    .filter((t) => (!k || t.name.toLowerCase().includes(k)) && !hasTag(exclude, t.name))
    .slice(0, limit)
    .map((t) => t.name);
}

/** 列表里放不下全部标签时：显示前 max 个，其余的数目 */
export function visibleTags(tags: readonly string[], max: number): { shown: readonly string[]; rest: number } {
  return tags.length <= max ? { shown: tags, rest: 0 } : { shown: tags.slice(0, max), rest: tags.length - max };
}
