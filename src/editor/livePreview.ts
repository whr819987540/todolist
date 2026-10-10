import { syntaxTree } from "@codemirror/language";
import { type Extension, type Line, Prec, type Range, type SelectionRange, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { keepCaretVisible, leftOverIndent } from "./listCaret";
import { type ListLine, type ListMarker, listLine, listLineStyle, markerParts } from "./listLayout";
import { linkTarget } from "./links";

// 实时渲染（类似 Typora / Obsidian）：正文始终是原样的 Markdown 文本，只是把 **、#、> 这类标记藏起来，
// 列表符号、任务框、分隔线换成对应的样子。光标（或选区）碰到的元素显示原文，方便修改。
// 只改显示，不改文本，所以切换模式、保存都不会动文件里的写法。
// 列表同 Typora：每级缩进固定的宽度，列表符号放在正文左边的一格里，折行后和正文对齐（listLayout.ts）

const BULLETS = ["•", "◦", "▪"];

/** 宽 n 个 em（以正文字号计） */
const emWidth = (n: number) => `calc(var(--fs-editor) * ${n})`;

class BulletWidget extends WidgetType {
  /** slot：放在行首那一格里的列表符号，是那一格的宽度（em）；0 是同一行里排不进格子的列表符号，照原来的宽度排 */
  constructor(
    readonly level: number,
    readonly slot: number,
  ) {
    super();
  }
  eq(other: BulletWidget) {
    return other.level === this.level && other.slot === this.slot;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.slot ? "cm-md-li-bullet" : "cm-md-bullet";
    if (this.slot) el.style.width = emWidth(this.slot);
    el.textContent = BULLETS[this.level % BULLETS.length];
    return el;
  }
  // 点列表符号时照常放置光标
  ignoreEvent() {
    return false;
  }
}

/** 有序列表的序号（光标没碰到时）：看上去和原文一样，靠右放在那一格里 */
class NumberWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly slot: number,
  ) {
    super();
  }
  eq(other: NumberWidget) {
    return other.text === this.text && other.slot === this.slot;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-li-num";
    el.style.width = emWidth(this.slot);
    const num = el.appendChild(document.createElement("span"));
    num.className = "cm-md-li-numtext";
    num.textContent = `${this.text} `;
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** 内容从引用开始的列表项（"- > 引用"）第一行的 >：占引用竖线和它后面的空当那么宽，光标在这一行时显示出 > */
class QuoteGapWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: QuoteGapWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-li-qgap";
    el.textContent = this.text;
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** 把 pos 处的 [ ] 和 [x] 互换 */
function toggleTask(view: EditorView, pos: number) {
  if (view.state.readOnly) return;
  const text = view.state.sliceDoc(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(text)) return;
  view.dispatch({
    changes: { from: pos + 1, to: pos + 2, insert: text[1] === " " ? "x" : " " },
    userEvent: "input",
  });
}

class TaskWidget extends WidgetType {
  /** slot：无序列表的任务框占列表符号那一格；有序列表的任务框跟在序号后面 */
  constructor(
    readonly checked: boolean,
    readonly slot: boolean,
  ) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked && other.slot === this.slot;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = this.slot ? "cm-md-task cm-md-task-slot" : "cm-md-task";
    box.checked = this.checked;
    box.tabIndex = -1;
    // 不移动光标、不抢焦点；勾选状态由文本决定，改完文本后整个控件会重建
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      toggleTask(view, view.posAtDOM(box));
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-hr";
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

const hidden = Decoration.replace({});
const rule = Decoration.replace({ widget: new RuleWidget() });
const taskDone = Decoration.mark({ class: "cm-md-task-done" });
const underline = Decoration.mark({ class: "cm-md-u" });
/** 有序任务的 [ ] 显示原文时占任务框那么宽 */
const taskSlot = Decoration.mark({ class: "cm-md-li-taskmark" });

const cached = new Map<string, Decoration>();
function cachedDeco(key: string, make: () => Decoration) {
  let d = cached.get(key);
  if (!d) cached.set(key, (d = make()));
  return d;
}

/** 显示原文时的列表符号 / 序号：仍占行首那一格，正文不左右跳。task：原文里有任务框（"- [x] "），字距收紧一点才放得下 */
const markSlot = (slot: number, task: boolean) =>
  cachedDeco(`mark ${slot} ${task}`, () =>
    Decoration.mark({
      class: task ? "cm-md-li-mark cm-md-li-mark-task" : "cm-md-li-mark",
      attributes: { style: `min-width: ${emWidth(slot)}` },
    }),
  );

function listLineDeco(l: ListLine) {
  const style = listLineStyle(l);
  const cls = l.quoteMark ? "cm-md-li cm-md-li-qfirst" : "cm-md-li";
  return cachedDeco(`line ${cls} ${style}`, () => Decoration.line({ class: cls, attributes: { style } }));
}

interface Preview {
  decorations: DecorationSet;
  /** 显示原文的列表符号那一格：放在 outerDecorations 里，不会被别的装饰（如查找的高亮）切成几段、变成几格 */
  outer: DecorationSet;
}

/** 可见范围里的每一行（不重复） */
function visibleLines(view: EditorView, f: (line: Line) => void) {
  let last = 0;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      if (line.number > last) f(line);
      last = line.number;
      pos = line.to + 1;
    }
  }
}

function buildPreview(view: EditorView, sel: readonly SelectionRange[] | null): Preview {
  const { state } = view;
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  const outer: Range<Decoration>[] = [];
  // 选区碰到 [from, to]（含两端）时显示原文
  const touches = (from: number, to: number) => !!sel?.some((r) => r.from <= to && r.to >= from);
  const touchesLines = (from: number, to: number) => touches(doc.lineAt(from).from, doc.lineAt(to).to);
  const hide = (from: number, to: number) => {
    if (to > from) out.push(hidden.range(from, to));
  };
  const isSpace = (pos: number) => doc.sliceString(pos, pos + 1) === " ";

  // 列表：每一行的悬挂缩进、藏起行首的缩进；行首的列表符号放进那一格（光标碰到时显示原文，仍在那一格里）
  const tree = syntaxTree(state);
  const lineMarks = new Set<number>();
  const marker = (m: ListMarker) => {
    lineMarks.add(m.from);
    for (const p of markerParts(m, touches)) {
      if (p.kind === "bullet") out.push(Decoration.replace({ widget: new BulletWidget(m.bulletLevel, m.slot) }).range(p.from, p.to));
      else if (p.kind === "number")
        out.push(Decoration.replace({ widget: new NumberWidget(doc.sliceString(m.from, m.to), m.slot) }).range(p.from, p.to));
      else if (p.kind === "raw") outer.push(markSlot(m.slot, !!m.task && !m.ordered).range(p.from, p.to));
      else if (p.kind === "box") out.push(Decoration.replace({ widget: new TaskWidget(!!m.task?.checked, !m.ordered) }).range(p.from, p.to));
      else if (p.kind === "rawBox") outer.push(taskSlot.range(p.from, p.to));
      else if (p.kind === "hide") hide(p.from, p.to);
      else out.push(taskDone.range(p.from, p.to));
    }
  };
  const quoteGaps = new Set<number>();
  visibleLines(view, (line) => {
    const l = listLine(state, line, tree);
    if (!l) return;
    out.push(listLineDeco(l).range(line.from));
    for (const h of l.hidden) hide(h.from, h.to);
    l.markers.forEach(marker);
    const q = l.quoteMark;
    if (q) {
      quoteGaps.add(q.from);
      const text = touches(line.from, line.to) ? doc.sliceString(q.from, q.to) : "";
      out.push(Decoration.replace({ widget: new QuoteGapWidget(text) }).range(q.from, q.to));
    }
  });

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (ref) => {
        const node = ref.node;
        const name = node.name;

        if (name.startsWith("ATXHeading")) {
          if (touchesLines(node.from, node.to)) return;
          // 行首的 "# " 和行尾可选的 " ##"
          for (const mark of node.getChildren("HeaderMark")) {
            if (mark.from === node.from) hide(mark.from, mark.to + (isSpace(mark.to) ? 1 : 0));
            else hide(mark.from - (isSpace(mark.from - 1) ? 1 : 0), mark.to);
          }
          return;
        }
        if (name.startsWith("SetextHeading")) {
          const mark = node.getChild("HeaderMark");
          if (mark && !touches(node.from, node.to)) hide(mark.from, mark.to);
          return;
        }

        switch (name) {
          case "Emphasis":
          case "StrongEmphasis":
          case "Strikethrough":
          case "InlineCode":
            if (!touches(node.from, node.to)) {
              for (let c = node.firstChild; c; c = c.nextSibling) {
                if (c.name.endsWith("Mark")) hide(c.from, c.to);
              }
            }
            return;

          case "Link": {
            if (touches(node.from, node.to)) return;
            // 只留下 [ ] 里的文字：藏起 "[" 和 "](地址)" / "][引用]"
            const [open, close] = node.getChildren("LinkMark");
            if (!open || !close) return;
            hide(open.from, open.to);
            hide(close.from, node.to);
            const url = linkTarget(state, node);
            out.push(
              Decoration.mark({
                class: "cm-md-link",
                attributes: { title: url ? `${url}\nCtrl + 单击打开` : "Ctrl + 单击打开" },
              }).range(open.to, close.from),
            );
            return;
          }

          case "Autolink":
            if (!touches(node.from, node.to)) {
              for (const mark of node.getChildren("LinkMark")) hide(mark.from, mark.to);
            }
            return;

          case "Escape":
            if (!touches(node.from, node.to)) hide(node.from, node.from + 1);
            return;

          case "HTMLTag": {
            // <u>…</u>（Ctrl+U 加的下划线）：藏起两个标签，中间加下划线；其他 HTML 标签照原样显示
            if (!/^<u>$/i.test(doc.sliceString(node.from, node.to))) return false;
            let close = node.nextSibling;
            while (close && !(close.name === "HTMLTag" && /^<\/u>$/i.test(doc.sliceString(close.from, close.to)))) {
              close = close.nextSibling;
            }
            if (!close || touches(node.from, close.to)) return false;
            hide(node.from, node.to);
            hide(close.from, close.to);
            if (close.from > node.to) out.push(underline.range(node.to, close.from));
            return false;
          }

          case "QuoteMark":
            if (quoteGaps.has(node.from)) return;
            if (!touchesLines(node.from, node.to)) hide(node.from, node.to + (isSpace(node.to) ? 1 : 0));
            return;

          case "ListMark": {
            // 行首的列表符号上面已经排好了；这里是同一行里第二个（如 "- - 甲"），照原来的样子
            if (lineMarks.has(node.from)) return;
            const task = node.nextSibling?.name === "Task" ? node.nextSibling : null;
            const marker = task?.firstChild?.name === "TaskMarker" ? task.firstChild : null;
            const bullet = node.parent?.parent?.name === "BulletList";
            if (marker && task) {
              // "- [ ] " → 复选框；有序列表保留序号
              if (touches(bullet ? node.from : marker.from, marker.to)) return;
              if (bullet) hide(node.from, marker.from);
              const checked = /x/i.test(doc.sliceString(marker.from, marker.to));
              const end = marker.to + (isSpace(marker.to) ? 1 : 0);
              out.push(Decoration.replace({ widget: new TaskWidget(checked, false) }).range(marker.from, end));
              if (checked && task.to > end) out.push(taskDone.range(end, task.to));
              return;
            }
            if (bullet && !touches(node.from, node.to)) {
              let level = 0;
              for (let p = node.parent?.parent?.parent; p; p = p.parent) if (p.name === "BulletList") level++;
              out.push(
                Decoration.replace({ widget: new BulletWidget(level, 0) }).range(
                  node.from,
                  node.to + (isSpace(node.to) ? 1 : 0),
                ),
              );
            }
            return;
          }

          case "HorizontalRule":
            if (!touchesLines(node.from, node.to)) out.push(rule.range(node.from, node.to));
            return;

          case "FencedCode": {
            // 光标不在代码块里时藏起 ``` 两行的内容，行本身留作代码块的上下留白
            if (touches(node.from, node.to)) return false;
            const marks = node.getChildren("CodeMark");
            const open = marks[0];
            const close = marks.length > 1 ? marks[marks.length - 1] : null;
            if (open) hide(open.from, doc.lineAt(open.from).to);
            if (close && doc.lineAt(close.from).number !== doc.lineAt(open.from).number) hide(close.from, close.to);
            return false;
          }
        }
      },
    });
  }
  return { decorations: Decoration.set(out, true), outer: Decoration.set(outer, true) };
}

/** 请插件立即重算（鼠标松开、输入法组合结束后） */
const refresh = StateEffect.define<null>();

const previewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    outer: DecorationSet;
    /** 按着鼠标拖选时先不切换原文 / 渲染，免得文字在鼠标下移动，松开后再更新 */
    dragging = false;
    /** 输入法组合期间只做位置映射，结束后要重算 */
    stale = false;
    destroyed = false;

    constructor(readonly view: EditorView) {
      ({ decorations: this.decorations, outer: this.outer } = this.build());
    }

    build() {
      const { view } = this;
      // 编辑器没有焦点时全部渲染
      return buildPreview(view, view.hasFocus ? view.state.selection.ranges : null);
    }

    update(u: ViewUpdate) {
      // 输入法组合中改动光标附近的显示会打断输入，先只跟着文本移动位置
      if (u.view.composing) {
        if (u.docChanged) {
          this.decorations = this.decorations.map(u.changes);
          this.outer = this.outer.map(u.changes);
        }
        this.stale = true;
        return;
      }
      const forced = u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)));
      const structural = u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state);
      const moved = (u.selectionSet || u.focusChanged) && !this.dragging;
      if (forced || structural || moved || this.stale) {
        this.stale = false;
        ({ decorations: this.decorations, outer: this.outer } = this.build());
      }
    }

    requestRefresh() {
      setTimeout(() => {
        if (!this.destroyed) this.view.dispatch({ effects: refresh.of(null) });
      });
    }

    destroy() {
      this.destroyed = true;
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) => EditorView.outerDecorations.of((view) => view.plugin(plugin)?.outer ?? Decoration.none),
    eventHandlers: {
      mousedown(e) {
        if (e.button !== 0) return;
        this.dragging = true;
        const up = () => {
          window.removeEventListener("mouseup", up, true);
          this.dragging = false;
          this.requestRefresh();
        };
        window.addEventListener("mouseup", up, true);
      },
      compositionend() {
        this.requestRefresh();
      },
    },
  },
);

export const livePreview: Extension = [
  previewPlugin,
  keepCaretVisible,
  Prec.high(
    keymap.of([
      { key: "ArrowLeft", run: (v) => leftOverIndent(v, false), shift: (v) => leftOverIndent(v, true) },
      { key: "Mod-ArrowLeft", run: (v) => leftOverIndent(v, false), shift: (v) => leftOverIndent(v, true) },
    ]),
  ),
];
