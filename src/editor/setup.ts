import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Compartment, EditorState, type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import type { EditShortcutMap } from "../editShortcuts";
import { eventShortcut, sameShortcut } from "../shortcuts";
import { appearance } from "./appearance";
import { codeFenceKeymap } from "./codeFences";
import { editBindings } from "./editBindings";
import { findExtensions } from "./find";
import { clipboardImages, dropCaret, type ImageResolver, imageResolver } from "./images";
import { ctrlClickLinks } from "./links";
import { livePreview } from "./livePreview";
import { trackReadingPos } from "./outline";
import { type EditPosition, trackPosition } from "./position";
import { tablePreview } from "./tables";

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
  /** 正在看的位置变了（光标在可见区域里时是光标处，否则是可见区域顶部），大纲据此高亮当前标题 */
  onReadingPos: (pos: number) => void;
  /** 实时渲染时怎么找到正文里的图片（images.ts） */
  images: ImageResolver;
  /** 粘贴了图片（剪贴板里有图片、没有文字）：由外层存成文件、插入；files 里只有图片，空的是剪贴板里只有不是图片的文件 */
  onPasteImages: (files: File[]) => void;
}

const modeConf = new Compartment();
const readOnlyConf = new Compartment();

const modeExtension = (mode: EditorMode) => (mode === "live" ? [livePreview, tablePreview] : []);

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

/**
 * Markdown 解析（含 GFM：表格、任务列表、删除线、网址自动识别；回车续写列表、退格删除列表标记）和缩进宽度。
 * 编辑命令按它解析出的语法树增删标记，单元测试构造 EditorState 时用同一份
 */
export const markdownSupport = (): Extension[] => [
  markdown({ base: markdownLanguage, completeHTMLTags: false }),
  EditorState.tabSize.of(2),
];

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
    ...markdownSupport(),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", "aria-label": "待办正文" }),
    placeholder(o.placeholder),
    appearance,
    modeConf.of(modeExtension(o.mode)),
    readOnlyConf.of(EditorState.readOnly.of(o.readOnly)),
    ctrlClickLinks(o.onOpenLink),
    // 查找 / 替换（Ctrl+F、Ctrl+H 由 WorkspaceView 转过来，见 find.ts）
    findExtensions(),
    // 图片：实时渲染时据此显示，粘贴的交给外层存成文件，拖进来时画出放下的位置（images.ts）
    imageResolver.of(o.images),
    EditorView.domEventHandlers({
      paste: (e) => {
        const files = clipboardImages(e.clipboardData);
        if (!files) return false;
        e.preventDefault();
        o.onPasteImages(files);
        return true;
      },
    }),
    dropCaret,
    changeReporter(o),
    trackPosition(o.onPosition),
    trackReadingPos(o.onReadingPos),
  ];
}
