import { syntaxTree } from "@codemirror/language";
import { type Range, type SelectionRange, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { linkTarget } from "./links";

// 实时渲染（类似 Typora / Obsidian）：正文始终是原样的 Markdown 文本，只是把 **、#、> 这类标记藏起来，
// 列表符号、任务框、分隔线换成对应的样子。光标（或选区）碰到的元素显示原文，方便修改。
// 只改显示，不改文本，所以切换模式、保存都不会动文件里的写法。

const BULLETS = ["•", "◦", "▪"];

class BulletWidget extends WidgetType {
  constructor(readonly level: number) {
    super();
  }
  eq(other: BulletWidget) {
    return other.level === this.level;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-bullet";
    el.textContent = BULLETS[this.level % BULLETS.length];
    return el;
  }
  // 点列表符号时照常放置光标
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
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-md-task";
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

function buildPreview(view: EditorView, sel: readonly SelectionRange[] | null): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  // 选区碰到 [from, to]（含两端）时显示原文
  const touches = (from: number, to: number) => !!sel?.some((r) => r.from <= to && r.to >= from);
  const touchesLines = (from: number, to: number) => touches(doc.lineAt(from).from, doc.lineAt(to).to);
  const hide = (from: number, to: number) => {
    if (to > from) out.push(hidden.range(from, to));
  };
  const isSpace = (pos: number) => doc.sliceString(pos, pos + 1) === " ";

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

          case "QuoteMark":
            if (!touchesLines(node.from, node.to)) hide(node.from, node.to + (isSpace(node.to) ? 1 : 0));
            return;

          case "ListMark": {
            const task = node.nextSibling?.name === "Task" ? node.nextSibling : null;
            const marker = task?.firstChild?.name === "TaskMarker" ? task.firstChild : null;
            const bullet = node.parent?.parent?.name === "BulletList";
            if (marker && task) {
              // "- [ ] " → 复选框；有序列表保留序号
              if (touches(bullet ? node.from : marker.from, marker.to)) return;
              if (bullet) hide(node.from, marker.from);
              const checked = /x/i.test(doc.sliceString(marker.from, marker.to));
              const end = marker.to + (isSpace(marker.to) ? 1 : 0);
              out.push(Decoration.replace({ widget: new TaskWidget(checked) }).range(marker.from, end));
              if (checked && task.to > end) out.push(taskDone.range(end, task.to));
              return;
            }
            if (bullet && !touches(node.from, node.to)) {
              let level = 0;
              for (let p = node.parent?.parent?.parent; p; p = p.parent) if (p.name === "BulletList") level++;
              out.push(
                Decoration.replace({ widget: new BulletWidget(level) }).range(
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
  return Decoration.set(out, true);
}

/** 请插件立即重算（鼠标松开、输入法组合结束后） */
const refresh = StateEffect.define<null>();

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /** 按着鼠标拖选时先不切换原文 / 渲染，免得文字在鼠标下移动，松开后再更新 */
    dragging = false;
    /** 输入法组合期间只做位置映射，结束后要重算 */
    stale = false;
    destroyed = false;

    constructor(readonly view: EditorView) {
      this.decorations = this.build();
    }

    build() {
      const { view } = this;
      // 编辑器没有焦点时全部渲染
      return buildPreview(view, view.hasFocus ? view.state.selection.ranges : null);
    }

    update(u: ViewUpdate) {
      // 输入法组合中改动光标附近的显示会打断输入，先只跟着文本移动位置
      if (u.view.composing) {
        if (u.docChanged) this.decorations = this.decorations.map(u.changes);
        this.stale = true;
        return;
      }
      const forced = u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)));
      const structural = u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state);
      const moved = (u.selectionSet || u.focusChanged) && !this.dragging;
      if (forced || structural || moved || this.stale) {
        this.stale = false;
        this.decorations = this.build();
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

