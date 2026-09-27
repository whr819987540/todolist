import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

const LINK_NODES = new Set(["Link", "Image", "Autolink", "URL"]);

const normalizeLabel = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** 文中 [引用]: 地址 的定义 */
function findReference(state: EditorState, label: string): string | null {
  const key = normalizeLabel(label);
  for (let n = syntaxTree(state).topNode.firstChild; n; n = n.nextSibling) {
    if (n.name !== "LinkReference") continue;
    const l = n.getChild("LinkLabel");
    const url = n.getChild("URL");
    if (l && url && normalizeLabel(state.sliceDoc(l.from + 1, l.to - 1)) === key) {
      return state.sliceDoc(url.from, url.to);
    }
  }
  return null;
}

/** 链接指向的地址：[文字](地址)、[文字][引用]、<地址>、裸网址；找不到时返回 null */
export function linkTarget(state: EditorState, node: SyntaxNode): string | null {
  if (node.name === "URL") return state.sliceDoc(node.from, node.to);
  const url = node.getChild("URL");
  if (url) return state.sliceDoc(url.from, url.to);
  if (node.name !== "Link") return null;
  // [文字][引用]、[文字][]、[引用]
  const label = node.getChild("LinkLabel");
  if (label && label.to - label.from > 2) return findReference(state, state.sliceDoc(label.from + 1, label.to - 1));
  const marks = node.getChildren("LinkMark");
  return marks.length >= 2 ? findReference(state, state.sliceDoc(marks[0].to, marks[1].from)) : null;
}

function urlAt(state: EditorState, pos: number): string | null {
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (LINK_NODES.has(n.name)) return linkTarget(state, n);
    }
  }
  return null;
}

/** 能交给浏览器 / 邮件程序打开的地址；本地文件等其他地址返回 null */
export function webUrl(raw: string): string | null {
  const url = raw.trim().replace(/^<(.*)>$/, "$1");
  if (/^(https?:\/\/|mailto:)\S/i.test(url)) return url;
  if (/^www\.\S/i.test(url)) return `http://${url}`;
  if (/^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(url)) return `mailto:${url}`;
  return null;
}

/** 按住 Ctrl 单击链接时打开它（两种模式都生效） */
export function ctrlClickLinks(open: (url: string) => void) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!e.ctrlKey || e.button !== 0) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      const url = pos == null ? null : urlAt(view.state, pos);
      if (!url) return false;
      e.preventDefault();
      open(url);
      return true;
    },
  });
}
