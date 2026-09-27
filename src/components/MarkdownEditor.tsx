import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { createExtensions, type EditorMode, setMode, setReadOnly } from "../editor/setup";

export interface MarkdownEditorHandle {
  /** 换成磁盘上的新内容：撤销记录清空，光标和滚动位置尽量留在原处 */
  reset(doc: string): void;
  focus(): void;
}

interface Props {
  /** 只在创建时读取，之后的外部改动用 handle.reset */
  initialDoc: string;
  mode: EditorMode;
  readOnly: boolean;
  placeholder: string;
  appShortcuts: (string | null | undefined)[];
  handleRef: React.RefObject<MarkdownEditorHandle | null>;
  onChange: (doc: string) => void;
  onBlur: () => void;
  onOpenLink: (url: string) => void;
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
      });
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({ doc: p().initialDoc, extensions: extensions() }),
    });
    viewRef.current = view;
    const handleRef = p().handleRef;
    handleRef.current = {
      reset(doc) {
        const top = view.scrollDOM.scrollTop;
        const head = Math.min(view.state.selection.main.head, doc.length);
        view.setState(EditorState.create({ doc, selection: { anchor: head }, extensions: extensions() }));
        view.scrollDOM.scrollTop = top;
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
