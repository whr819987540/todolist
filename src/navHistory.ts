// 后退 / 前进（鼠标侧键）：这次运行期间看过的地方，按顺序记在内存里，和浏览器一样。
// 一处是首页，或工作区里右侧显示的内容（工作区概览、项目概览、待办）。

import type { Selection } from "./components/sidebar/tree";
import type { TodoKey } from "./workspaceState";

/** null 是首页 */
export type Place = Selection | null;

/**
 * 怎么到这一处的。push：点击等，新记一处；replace：右侧自动改了显示（要显示的已不在、改名后跟过去等），
 * 替换当前这一处；keyboard：用键盘在左侧列表里移过来，连着移动时停不到 KB_PASS 就移走的不记
 */
export type How = "push" | "replace" | "keyboard";

interface Entry {
  place: Place;
  /** 用键盘移到这里的时间，不是用键盘来的为 0 */
  kbAt: number;
}

/** 最多记这么多处，超出时忘掉最早的 */
const MAX = 100;
/** 用键盘移到一处后，停不到这么久（ms）又用键盘移走的，不算看过 */
const KB_PASS = 1000;

let entries: Entry[] = [];
/** 当前在第几处；-1 表示还没有 */
let index = -1;

const keyOf = (p: Place): TodoKey | null => (p ? [p.workspace, p.project ?? "", p.todoId ?? ""] : null);
const same = (a: Place, b: Place) => JSON.stringify(keyOf(a)) === JSON.stringify(keyOf(b));

/** 重建记录：fn 返回 null 的删掉，相邻的重复处并成一处；当前位置留在原处，原处删了就退到它前面最近的一处 */
function rebuild(fn: (e: Entry) => Entry | null) {
  const out: Entry[] = [];
  let at = -1;
  entries.forEach((e, i) => {
    const m = fn(e);
    if (m && !(out.length && same(out[out.length - 1].place, m.place))) out.push(m);
    if (i <= index) at = out.length - 1;
  });
  entries = out;
  index = at;
}

/** 记下到了一处；和当前这处一样时不记（后退、前进过去的就是这样） */
export function visit(place: Place, how: How = "push") {
  const cur = entries[index];
  if (cur && same(cur.place, place)) return;
  const now = Date.now();
  const entry = { place, kbAt: how === "keyboard" ? now : 0 };
  if (cur && (how === "replace" || (how === "keyboard" && cur.kbAt && now - cur.kbAt < KB_PASS))) {
    entries[index] = entry;
    rebuild((e) => e);
    return;
  }
  // 在中间某处又去了新的地方：后面（前进方向）的都不要了
  entries = [...entries.slice(0, index + 1), entry].slice(-MAX);
  index = entries.length - 1;
}

/** 后退（-1）/ 前进（1）一处，返回要去的地方；已经到头时返回 undefined */
export function go(step: 1 | -1): Place | undefined {
  const i = index + step;
  if (i < 0 || i >= entries.length) return undefined;
  index = i;
  return entries[i].place;
}

/** 改名、移动、删除之后，记录跟过去；fn 返回 null 的删掉 */
export function mapPlaces(fn: (key: TodoKey) => TodoKey | null) {
  rebuild((e) => {
    const k = keyOf(e.place);
    if (!k) return e;
    const to = fn(k);
    return to && { ...e, place: { workspace: to[0], project: to[1] || undefined, todoId: to[2] || undefined } };
  });
}
