// 编辑快捷键：正文编辑区里的 Markdown 编辑操作，按键与 Typora（Windows）相同。
// 和应用快捷键（设置里可改的，以及 Ctrl+N、Ctrl+S 这类内置的）分开：只在正文编辑器里生效，不能修改；
// 应用快捷键不能设成这些组合。按键写法同 shortcuts.ts，命令在 editor/editBindings.ts

export type EditCommandId =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "code"
  | "link"
  | "clearFormat"
  | "heading"
  | "paragraph"
  | "headingUp"
  | "headingDown"
  | "quote"
  | "orderedList"
  | "bulletList"
  | "codeBlock"
  | "selectWord"
  | "deleteWord"
  | "selectLine";

export interface EditShortcut {
  /** 由 editBindings 执行的命令；没有的是编辑器别处已处理的按键，只在列表里展示 */
  id?: EditCommandId;
  label: string;
  /** 按键，写法同 eventShortcut 的结果（修饰键按 Ctrl、Alt、Shift 的顺序） */
  keys: readonly string[];
  /** 展示用的写法，默认同 keys */
  shown?: readonly string[];
}

export const EDIT_SHORTCUT_GROUPS: readonly { title: string; items: readonly EditShortcut[] }[] = [
  {
    title: "格式",
    items: [
      { id: "bold", label: "加粗", keys: ["Ctrl+B"] },
      { id: "italic", label: "斜体", keys: ["Ctrl+I"] },
      { id: "underline", label: "下划线", keys: ["Ctrl+U"] },
      { id: "strike", label: "删除线", keys: ["Alt+Shift+5"] },
      { id: "code", label: "行内代码", keys: ["Ctrl+Shift+Backquote"] },
      { id: "link", label: "超链接", keys: ["Ctrl+K"] },
      { id: "clearFormat", label: "清除格式", keys: ["Ctrl+Backslash"] },
    ],
  },
  {
    title: "段落",
    items: [
      {
        id: "heading",
        label: "标题 1～6",
        keys: ["Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4", "Ctrl+5", "Ctrl+6"],
        shown: ["Ctrl+1～6"],
      },
      { id: "paragraph", label: "正文", keys: ["Ctrl+0"] },
      { id: "headingUp", label: "提升标题级别", keys: ["Ctrl+Equal"] },
      { id: "headingDown", label: "降低标题级别", keys: ["Ctrl+Minus"] },
      { id: "quote", label: "引用", keys: ["Ctrl+Shift+Q"] },
      { id: "orderedList", label: "有序列表", keys: ["Ctrl+Shift+BracketLeft"] },
      { id: "bulletList", label: "无序列表", keys: ["Ctrl+Shift+BracketRight"] },
      { id: "codeBlock", label: "代码块", keys: ["Ctrl+Shift+K"] },
    ],
  },
  {
    title: "选择与删除",
    items: [
      { id: "selectWord", label: "选中当前词", keys: ["Ctrl+D"] },
      { id: "deleteWord", label: "删除当前词", keys: ["Ctrl+Shift+D"] },
      { id: "selectLine", label: "选中当前行", keys: ["Ctrl+L"] },
    ],
  },
  {
    title: "其他",
    items: [
      { label: "撤销", keys: ["Ctrl+Z"] },
      { label: "重做", keys: ["Ctrl+Y", "Ctrl+Shift+Z"] },
      { label: "跳出代码块", keys: ["Ctrl+Enter"] },
      { label: "打开链接", keys: [], shown: ["Ctrl+单击"] },
    ],
  },
];

export const EDIT_SHORTCUTS: readonly EditShortcut[] = EDIT_SHORTCUT_GROUPS.flatMap((g) => g.items);
