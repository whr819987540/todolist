import { historyField, redoDepth, undoDepth } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { EditShortcutMap } from "../editShortcuts";
import { keepFindOpen, openFind } from "../editor/find";
import { type ImageResolver, insertImages, showDropCaret } from "../editor/images";
import { jumpToHeading, type OutlineItem, outlineItems } from "../editor/outline";
import { capturePosition, type EditPosition, restorePosition } from "../editor/position";
import { createExtensions, type EditorMode, setMode, setReadOnly } from "../editor/setup";
import type { UndoSnapshot } from "../workspaceState";

export interface MarkdownEditorHandle {
  /** 换成磁盘上的新内容：撤销记录清空，光标（选区）和滚动尽量留在原来那段文字处；找不到光标处的文字时回到开头 */
  reset(doc: string): void;
  focus(): void;
  /** 打开查找框（replace 为 true 时展开替换） */
  openFind(replace: boolean): boolean;
  /** 现在正文里的标题 */
  outline(): OutlineItem[];
  /** 跳到 pos 处的标题：光标放在那一行末尾，标题滚到顶部 */
  jumpTo(pos: number): void;
  /** 现在的正文和撤销记录；没有可以撤销、重做的修改时是 null */
  snapshot(): UndoSnapshot | null;
  /** 在 pos 处（不给时在光标处，替换选中的文字）插入几张图片（![说明](地址)），每张一行，焦点放进正文 */
  insertImages(images: string[], pos?: number): void;
  /** 视口里 (x, y) 处（CSS 像素）对着正文的哪个位置；不在正文的显示区域里时是 null */
  posAt(x: number, y: number): number | null;
  /** 拖着图片时在 pos 处画一条竖线标出放下的位置，null 时去掉 */
  dropCaret(pos: number | null): void;
}

interface Props {
  /** 只在创建时读取，之后的外部改动用 handle.reset */
  initialDoc: string;
  /** 上次的编辑位置，只在创建时读取：光标（选区）和滚动回到那里，正文被外部大改过、找不到时光标在开头 */
  initialPosition: EditPosition | null;
  /** 上次留下的撤销记录（UndoSnapshot.history），只在创建时读取；null 表示从头记 */
  initialHistory: unknown;
  /** 建好后焦点放进来（光标在 initialPosition 处，不滚动），只在创建时读取 */
  autoFocus: boolean;
  mode: EditorMode;
  readOnly: boolean;
  placeholder: string;
  appShortcuts: (string | null | undefined)[];
  /** 现在的编辑快捷键，改了立即生效 */
  editShortcuts: EditShortcutMap;
  handleRef: React.RefObject<MarkdownEditorHandle | null>;
  onChange: (doc: string) => void;
  onBlur: () => void;
  onOpenLink: (url: string) => void;
  /** 光标移动、正文改动、滚动之后的编辑位置 */
  onPosition: (p: EditPosition) => void;
  /** 正在看的位置（光标在可见区域里时是光标处，否则是可见区域顶部） */
  onReadingPos: (pos: number) => void;
  /** 实时渲染时怎么找到正文里的图片，只在创建时读取 */
  images: ImageResolver;
  /** 粘贴了图片（剪贴板里没有文字）；files 里只有图片，空的是剪贴板里只有不是图片的文件 */
  onPasteImages: (files: File[]) => void;
  /** 编辑器销毁前（切到别的待办、返回首页等），交出正文和撤销记录 */
  onDestroy: (snap: UndoSnapshot | null) => void;
}

/** CodeMirror 编辑 Markdown 原文：实时渲染或源码模式，正文一律原样保存 */
export default function MarkdownEditor(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });

  useEffect(() => {
    const p = () => propsRef.current;
    const extensions = () =>
      createExtensions({
        mode: p().mode,
        readOnly: p().readOnly,
        placeholder: p().placeholder,
        appShortcuts: () => p().appShortcuts,
        editShortcuts: () => p().editShortcuts,
        onChange: (doc) => p().onChange(doc),
        onBlur: () => p().onBlur(),
        onOpenLink: (url) => p().onOpenLink(url),
        onPosition: (pos) => p().onPosition(pos),
        onReadingPos: (pos) => p().onReadingPos(pos),
        images: p().images,
        onPasteImages: (files) => p().onPasteImages(files),
      });
    /** 选中 anchor 到 head（相同时只放光标）；给了撤销记录时接着用 */
    const createState = (doc: string, anchor: number, head: number, history: unknown = null) => {
      const config = { extensions: extensions() };
      const selection = EditorSelection.single(anchor, head);
      if (history != null) {
        try {
          const json = { doc, selection: selection.toJSON(), history };
          return EditorState.fromJSON(json, config, { history: historyField });
        } catch {
          /* 认不出的撤销记录不要了 */
        }
      }
      return EditorState.create({ doc, selection, ...config });
    };
    const { initialDoc, initialPosition, initialHistory } = p();
    const restored = initialPosition && restorePosition(initialDoc, initialPosition);
    const view = new EditorView({
      parent: hostRef.current!,
      state: createState(initialDoc, restored?.anchor ?? 0, restored?.head ?? 0, initialHistory),
    });
    if (restored?.scroll) view.dispatch({ effects: restored.scroll });
    // 在这里而不是外层聚焦：开发时 StrictMode 会把编辑器建好、销毁、再建一次，外层拿到的可能是销毁了的那个
    if (p().autoFocus) view.focus();
    viewRef.current = view;
    const snapshot = (): UndoSnapshot | null => {
      const { state } = view;
      if (!undoDepth(state) && !redoDepth(state)) return null;
      const { doc, history } = state.toJSON({ history: historyField });
      return { doc, history };
    };
    const handleRef = p().handleRef;
    handleRef.current = {
      reset(doc) {
        const scrollTop = view.scrollDOM.scrollTop;
        const { anchor, head, scroll } = restorePosition(doc, capturePosition(view));
        // 换掉整个状态时查找框会关掉，按原来的条件重新打开
        keepFindOpen(view, () => view.setState(createState(doc, anchor, head)));
        view.scrollDOM.scrollTop = scroll ? scrollTop : 0;
        if (scroll) view.dispatch({ effects: scroll });
      },
      focus: () => view.focus(),
      openFind: (replace) => openFind(view, replace),
      outline: () => outlineItems(view.state),
      jumpTo: (pos) => jumpToHeading(view, pos),
      snapshot,
      insertImages(images, pos) {
        insertImages(view, images, pos);
        view.focus();
      },
      posAt(x, y) {
        const r = view.scrollDOM.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
        return view.posAtCoords({ x, y }, false);
      },
      dropCaret: (pos) => showDropCaret(view, pos),
    };
    return () => {
      p().onDestroy(snapshot());
      view.destroy();
      viewRef.current = null;
      handleRef.current = null;
    };
  }, []);

  // 切换模式只换显示方式，光标、撤销记录都保留
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setMode(props.mode) });
  }, [props.mode]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setReadOnly(props.readOnly) });
  }, [props.readOnly]);

  return <div className="editor-cm" ref={hostRef} />;
}
