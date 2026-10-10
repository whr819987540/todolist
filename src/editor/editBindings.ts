import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type EditCommandId, type EditShortcutMap, editBindingTable } from "../editShortcuts";
import { eventShortcut, normalizeShortcut } from "../shortcuts";
import {
  clearFormat,
  deleteWord,
  headingDown,
  headingUp,
  insertTable,
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

/** key 是按下的组合（同一条命令有几个按键时用来区分，如 Tab 和 Ctrl+]） */
type EditCommand = (view: EditorView, key: string) => boolean;

const COMMANDS: Record<EditCommandId, EditCommand> = {
  bold: (v) => toggleInline(v, "bold"),
  italic: (v) => toggleInline(v, "italic"),
  underline: (v) => toggleInline(v, "underline"),
  strike: (v) => toggleInline(v, "strike"),
  code: (v) => toggleInline(v, "code"),
  link: toggleLink,
  clearFormat,
  heading1: (v) => setHeading(v, 1),
  heading2: (v) => setHeading(v, 2),
  heading3: (v) => setHeading(v, 3),
  heading4: (v) => setHeading(v, 4),
  heading5: (v) => setHeading(v, 5),
  heading6: (v) => setHeading(v, 6),
  paragraph: setParagraph,
  headingUp,
  headingDown,
  quote: toggleQuote,
  orderedList: (v) => toggleList(v, true),
  bulletList: (v) => toggleList(v, false),
  codeBlock: toggleCodeBlock,
  table: insertTable,
  indent,
  outdent,
  selectWord,
  deleteWord,
  selectLine,
};

/**
 * 编辑快捷键（editShortcuts.ts），current 给出现在每条命令用的快捷键（设置里改了立即生效）。
 * 按键按物理位置认（KeyboardEvent.code），不受输入法、Shift 后的字符影响；
 * 优先于 CodeMirror 自带的按键（Ctrl+I、Ctrl+Shift+K 等在那里另有用处），但让给应用快捷键（setup.ts）
 */
export function editBindings(current: () => EditShortcutMap) {
  let map: EditShortcutMap | null = null;
  let table = new Map<string, EditCommandId>();
  return Prec.high(
    EditorView.domEventHandlers({
      keydown(e, view) {
        if (e.isComposing || view.composing) return false;
        const key = eventShortcut(e);
        if (!key) return false;
        if (current() !== map) {
          map = current();
          table = editBindingTable(map);
        }
        const id = table.get(normalizeShortcut(key));
        if (!id || !COMMANDS[id](view, key)) return false;
        e.preventDefault();
        return true;
      },
    }),
  );
}
