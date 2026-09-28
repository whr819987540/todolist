import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { capturePosition, type EditPosition, restorePosition } from "../editor/position";
import { createExtensions, type EditorMode, setMode, setReadOnly } from "../editor/setup";

export interface MarkdownEditorHandle {
  /** 换成磁盘上的新内容：撤销记录清空，光标和滚动尽量留在原来那段文字处；找不到光标处的文字时回到开头 */
  reset(doc: string): void;
  focus(): void;
}

interface Props {
  /** 只在创建时读取，之后的外部改动用 handle.reset */
  initialDoc: string;
  /** 上次的编辑位置，只在创建时读取：光标和滚动回到那里，正文被外部大改过、找不到时光标在开头 */
  initialPosition: EditPosition | null;
  mode: EditorMode;
  readOnly: boolean;
  placeholder: string;
  appShortcuts: (string | null | undefined)[];
  handleRef: React.RefObject<MarkdownEditorHandle | null>;
  onChange: (doc: string) => void;
  onBlur: () => void;
  onOpenLink: (url: string) => void;
  /** 光标移动、正文改动、滚动之后的编辑位置 */
  onPosition: (p: EditPosition) => void;
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
        onChange: (doc) => p().onChange(doc),
        onBlur: () => p().onBlur(),
        onOpenLink: (url) => p().onOpenLink(url),
        onPosition: (pos) => p().onPosition(pos),
      });
    const { initialDoc, initialPosition } = p();
    const restored = initialPosition && restorePosition(initialDoc, initialPosition);
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({ doc: initialDoc, selection: { anchor: restored?.head ?? 0 }, extensions: extensions() }),
    });
    if (restored?.scroll) view.dispatch({ effects: restored.scroll });
    viewRef.current = view;
    const handleRef = p().handleRef;
    handleRef.current = {
      reset(doc) {
        const scrollTop = view.scrollDOM.scrollTop;
        const { head, scroll } = restorePosition(doc, capturePosition(view));
        view.setState(EditorState.create({ doc, selection: { anchor: head }, extensions: extensions() }));
        view.scrollDOM.scrollTop = scroll ? scrollTop : 0;
        if (scroll) view.dispatch({ effects: scroll });
      },
      focus: () => view.focus(),
    };
    return () => {
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
