import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type EditCommandId, EDIT_SHORTCUTS } from "../editShortcuts";
import { eventShortcut } from "../shortcuts";
import {
  clearFormat,
  deleteWord,
  headingDown,
  headingUp,
  selectLine,
  selectWord,
  setHeading,
  setParagraph,
  toggleCodeBlock,
  toggleInline,
  toggleLink,
  toggleList,
  toggleQuote,
} from "./formatting";
import { indent, outdent } from "./lists";

/** key 是按下的组合（同一条命令有几个按键时用来区分，如 Ctrl+1～6） */
type EditCommand = (view: EditorView, key: string) => boolean;

const COMMANDS: Record<EditCommandId, EditCommand> = {
  bold: (v) => toggleInline(v, "bold"),
  italic: (v) => toggleInline(v, "italic"),
  underline: (v) => toggleInline(v, "underline"),
  strike: (v) => toggleInline(v, "strike"),
  code: (v) => toggleInline(v, "code"),
  link: toggleLink,
  clearFormat,
  heading: (v, key) => setHeading(v, Number(key.slice(-1))),
  paragraph: setParagraph,
  headingUp,
  headingDown,
  quote: toggleQuote,
  orderedList: (v) => toggleList(v, true),
  bulletList: (v) => toggleList(v, false),
  codeBlock: toggleCodeBlock,
  indent,
  outdent,
  selectWord,
  deleteWord,
  selectLine,
};

const byKey = new Map<string, EditCommandId>();
for (const s of EDIT_SHORTCUTS) if (s.id) for (const k of s.keys) byKey.set(k, s.id);

/**
 * 编辑快捷键（editShortcuts.ts）。按键按物理位置认（KeyboardEvent.code），不受输入法、Shift 后的字符影响；
 * 优先于 CodeMirror 自带的按键（Ctrl+I、Ctrl+Shift+K 等在那里另有用处），但让给应用快捷键（setup.ts）
 */
export const editBindings = Prec.high(
  EditorView.domEventHandlers({
    keydown(e, view) {
      if (e.isComposing || view.composing) return false;
      const key = eventShortcut(e);
      const id = key && byKey.get(key);
      if (!id || !COMMANDS[id](view, key)) return false;
      e.preventDefault();
      return true;
    },
  }),
);
