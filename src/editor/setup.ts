import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Compartment, EditorState, type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import type { EditShortcutMap } from "../editShortcuts";
import { eventShortcut, sameShortcut } from "../shortcuts";
import { appearance } from "./appearance";
import { codeFenceKeymap } from "./codeFences";
import { editBindings } from "./editBindings";
import { ctrlClickLinks } from "./links";
import { livePreview } from "./livePreview";
import { type EditPosition, trackPosition } from "./position";

/** live：实时渲染（隐藏标记，光标处显示原文）；source：源码模式（显示全部标记，只做语法高亮） */
export type EditorMode = "live" | "source";

export interface EditorOptions {
  mode: EditorMode;
  readOnly: boolean;
  placeholder: string;
  /** 设置里可自定义的应用快捷键：编辑器不处理，留给外层 */
  appShortcuts: () => (string | null | undefined)[];
  /** 现在的编辑快捷键（设置里可以改） */
  editShortcuts: () => EditShortcutMap;
  onChange: (doc: string) => void;
  onBlur: () => void;
  onOpenLink: (url: string) => void;
  /** 光标移动、正文改动、滚动之后的编辑位置 */
  onPosition: (p: EditPosition) => void;
}

const modeConf = new Compartment();
const readOnlyConf = new Compartment();

const modeExtension = (mode: EditorMode) => (mode === "live" ? livePreview : []);

export const setMode = (mode: EditorMode) => modeConf.reconfigure(modeExtension(mode));
export const setReadOnly = (readOnly: boolean) => readOnlyConf.reconfigure(EditorState.readOnly.of(readOnly));

/** 应用自己的区域切换键（WorkspaceView）：编辑器里默认是移动行 / 按语法移动光标，这里让给应用 */
const APP_KEYS = ["Alt+ArrowLeft", "Alt+ArrowRight", "Alt+ArrowUp", "Alt+ArrowDown"];

/**
 * 报告正文改动和失去焦点。输入法组合（拼音还没上屏）期间拼音也在文档里，这时的改动不报告，
 * 上屏后再一起报告，免得把拼音当成正文存盘；组合中失去焦点也等上屏后再报告。
 */
function changeReporter(o: EditorOptions): Extension {
  let changed = false;
  let blurred = false;
  const settle = (view: EditorView) => {
    if (view.composing) return;
    if (changed) {
      changed = false;
      o.onChange(view.state.doc.toString());
    }
    if (blurred) {
      blurred = false;
      if (!view.hasFocus) o.onBlur();
    }
  };
  return [
    EditorView.updateListener.of((u) => {
      if (u.docChanged) changed = true;
      settle(u.view);
    }),
    EditorView.domEventHandlers({
      // 上屏的字往往在组合结束前就已进了文档，之后不一定再有改动，组合结束后补一次
      compositionend: (_e, view) => {
        setTimeout(() => view.dom.isConnected && settle(view));
      },
      blur: (_e, view) => {
        blurred = true;
        settle(view);
      },
    }),
  ];
}

export function createExtensions(o: EditorOptions): Extension[] {
  return [
    // 应用的快捷键交给外层，编辑器不处理（否则 Alt+↑ 会同时移动行和切换左侧选中项）
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: (e) => {
          const combo = eventShortcut(e);
          return !!combo && [...APP_KEYS, ...o.appShortcuts()].some((s) => sameShortcut(combo, s));
        },
      }),
    ),
    // 编辑快捷键：Ctrl+B 加粗、Tab 缩进列表等，同 Typora
    editBindings(o.editShortcuts),
    history(),
    // 跳出代码块；要先于 Markdown 自带的回车续写列表
    Prec.highest(codeFenceKeymap),
    keymap.of([
      // Ctrl+/ 留给切换模式
      ...defaultKeymap.filter((b) => b.key !== "Mod-/"),
      ...historyKeymap,
    ]),
    // 含 GFM：表格、任务列表、删除线、网址自动识别；回车续写列表、退格删除列表标记
    markdown({ base: markdownLanguage, completeHTMLTags: false }),
    EditorState.tabSize.of(2),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", "aria-label": "待办正文" }),
    placeholder(o.placeholder),
    appearance,
    modeConf.of(modeExtension(o.mode)),
    readOnlyConf.of(EditorState.readOnly.of(o.readOnly)),
    ctrlClickLinks(o.onOpenLink),
    changeReporter(o),
    trackPosition(o.onPosition),
  ];
}
