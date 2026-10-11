import { normalizeShortcut, reservedShortcut, sameShortcut, shortcutLabel, type TakenShortcut } from "./shortcuts";

// 编辑快捷键：正文编辑区里的 Markdown 编辑操作，默认按键与 Typora（Windows）相同。
// 和应用快捷键（显示 / 隐藏主窗口等，以及 Ctrl+N、Ctrl+S 这类内置的）分开：只在正文编辑器里生效。
// 可以在设置里修改、恢复默认或不使用，改过的记在设置文件的 editShortcuts 里；固定按键（列表里的 Tab 等）不能改。
// 按键写法同 shortcuts.ts，命令在 editor/editBindings.ts

export type EditCommandId =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "code"
  | "link"
  | "clearFormat"
  | `heading${1 | 2 | 3 | 4 | 5 | 6}`
  | "paragraph"
  | "headingUp"
  | "headingDown"
  | "quote"
  | "orderedList"
  | "bulletList"
  | "codeBlock"
  | "table"
  | "indent"
  | "outdent"
  | "selectWord"
  | "deleteWord"
  | "selectLine";

export interface EditShortcut {
  /** 由 editBindings 执行的命令；没有的是编辑器别处已处理的按键，只在列表里展示 */
  id?: EditCommandId;
  label: string;
  /** 默认快捷键（可以在设置里改），写法同 eventShortcut 的结果（修饰键按 Ctrl、Alt、Shift 的顺序） */
  defaultKey?: string;
  /** 固定按键，不能修改 */
  fixed?: readonly string[];
  /** 固定按键展示用的写法，默认同 fixed */
  shown?: readonly string[];
}

const heading = (n: 1 | 2 | 3 | 4 | 5 | 6): EditShortcut => ({
  id: `heading${n}`,
  label: `标题 ${n}`,
  defaultKey: `Ctrl+${n}`,
});

export const EDIT_SHORTCUT_GROUPS: readonly { title: string; items: readonly EditShortcut[] }[] = [
  {
    title: "格式",
    items: [
      { id: "bold", label: "加粗", defaultKey: "Ctrl+B" },
      { id: "italic", label: "斜体", defaultKey: "Ctrl+I" },
      { id: "underline", label: "下划线", defaultKey: "Ctrl+U" },
      { id: "strike", label: "删除线", defaultKey: "Alt+Shift+5" },
      { id: "code", label: "行内代码", defaultKey: "Ctrl+Shift+Backquote" },
      { id: "link", label: "超链接", defaultKey: "Ctrl+K" },
      { id: "clearFormat", label: "清除格式", defaultKey: "Ctrl+Backslash" },
    ],
  },
  {
    title: "段落",
    items: [
      heading(1),
      heading(2),
      heading(3),
      heading(4),
      heading(5),
      heading(6),
      { id: "paragraph", label: "正文", defaultKey: "Ctrl+0" },
      { id: "headingUp", label: "提升标题级别", defaultKey: "Ctrl+Equal" },
      { id: "headingDown", label: "降低标题级别", defaultKey: "Ctrl+Minus" },
      { id: "quote", label: "引用", defaultKey: "Ctrl+Shift+Q" },
      { id: "orderedList", label: "有序列表", defaultKey: "Ctrl+Shift+BracketLeft" },
      { id: "bulletList", label: "无序列表", defaultKey: "Ctrl+Shift+BracketRight" },
      { id: "codeBlock", label: "代码块", defaultKey: "Ctrl+Shift+K" },
      { id: "table", label: "插入表格", defaultKey: "Ctrl+T" },
      { id: "indent", label: "增加缩进", defaultKey: "Ctrl+BracketRight", fixed: ["Tab"] },
      { id: "outdent", label: "减少缩进", defaultKey: "Ctrl+BracketLeft", fixed: ["Shift+Tab"] },
    ],
  },
  {
    title: "选择与删除",
    items: [
      { id: "selectWord", label: "选中当前词", defaultKey: "Ctrl+D" },
      { id: "deleteWord", label: "删除当前词", defaultKey: "Ctrl+Shift+D" },
      { id: "selectLine", label: "选中当前行", defaultKey: "Ctrl+L" },
    ],
  },
  {
    title: "固定按键",
    items: [
      { label: "撤销", fixed: ["Ctrl+Z"] },
      { label: "重做", fixed: ["Ctrl+Y", "Ctrl+Shift+Z"] },
      { label: "跳出代码块", fixed: ["Ctrl+Enter"] },
      { label: "打开链接", fixed: [], shown: ["Ctrl+单击"] },
      { label: "查找", fixed: ["Ctrl+F"] },
      { label: "替换", fixed: ["Ctrl+H"] },
      { label: "查找下一个 / 上一个", fixed: ["F3", "Shift+F3"] },
    ],
  },
];

export const EDIT_SHORTCUTS: readonly EditShortcut[] = EDIT_SHORTCUT_GROUPS.flatMap((g) => g.items);

/** 可以修改的编辑快捷键 */
export const CONFIGURABLE_EDIT_SHORTCUTS = EDIT_SHORTCUTS.filter(
  (s): s is EditShortcut & { id: EditCommandId; defaultKey: string } => !!s.id && !!s.defaultKey,
);

/** 每条命令现在用的快捷键，null 是不使用 */
export type EditShortcutMap = Readonly<Record<EditCommandId, string | null>>;

/** 设置里改过的（命令 → 快捷键，null 是不使用）盖在默认值上 */
export function effectiveEditShortcuts(changed: Readonly<Record<string, string | null>> | undefined): EditShortcutMap {
  const out = {} as Record<EditCommandId, string | null>;
  for (const s of CONFIGURABLE_EDIT_SHORTCUTS) out[s.id] = changed && s.id in changed ? changed[s.id] : s.defaultKey;
  return out;
}

/**
 * 按键（normalizeShortcut 后）→ 命令：固定按键在前，重复的按先到的算。
 * 设置文件里手改成软件内置组合（Ctrl+S 保存、F5 / Ctrl+R 刷新、Ctrl+C 复制等）的不绑定，那些键照常做原来的事
 */
export function editBindingTable(map: EditShortcutMap): Map<string, EditCommandId> {
  const table = new Map<string, EditCommandId>();
  const add = (key: string | null | undefined, id: EditCommandId) => {
    const k = key && normalizeShortcut(key);
    if (k && !table.has(k)) table.set(k, id);
  };
  for (const s of EDIT_SHORTCUTS) if (s.id) for (const k of s.fixed ?? []) add(k, s.id);
  for (const s of CONFIGURABLE_EDIT_SHORTCUTS) {
    const key = map[s.id];
    if (key && !reservedShortcut(key)) add(key, s.id);
  }
  return table;
}

/**
 * 这一条编辑快捷键的按键和别的重复时（手改过设置文件等），说明实际执行的是哪个；不重复时返回 undefined。
 * app 是应用快捷键（显示 / 隐藏主窗口等）现在用的按键
 */
export function editShortcutConflict(
  id: EditCommandId,
  map: EditShortcutMap,
  app: readonly TakenShortcut[],
): string | undefined {
  const value = map[id];
  if (!value) return undefined;
  const appKey = app.find((a) => sameShortcut(a.key, value));
  if (appKey) return `和「${appKey.label}」重复，在正文里按下时执行的是「${appKey.label}」`;
  const reserved = reservedShortcut(value);
  if (reserved) return `${shortcutLabel(value)} 是常用的「${reserved}」快捷键，这个不起作用`;
  const fixed = EDIT_SHORTCUTS.find((e) => e.fixed?.some((k) => sameShortcut(k, value)));
  if (fixed) return `和编辑快捷键「${fixed.label}」的固定按键重复，这个不起作用`;
  const before = CONFIGURABLE_EDIT_SHORTCUTS.slice(0, CONFIGURABLE_EDIT_SHORTCUTS.findIndex((e) => e.id === id));
  const earlier = before.find((e) => sameShortcut(map[e.id], value));
  return earlier ? `和编辑快捷键「${earlier.label}」重复，这个不起作用` : undefined;
}
