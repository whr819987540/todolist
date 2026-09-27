// 快捷键的保存格式：修饰键（Ctrl、Alt、Shift，按此顺序）+ 主键，用 + 连接，例如 "Ctrl+Alt+T"。
// 主键名与 KeyboardEvent.code 一致，字母和数字去掉 Key / Digit 前缀；Rust 端的 global-hotkey 也能解析。

/** 可以作为主键的按键：字母、数字、F1~F24、小键盘数字和下列按键 */
const NAMED_KEYS = new Set([
  "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote",
  "Comma", "Period", "Slash", "Space", "Enter", "Tab", "Backspace", "Delete", "Insert", "Home", "End",
  "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal",
]);

/** KeyboardEvent.code → 主键名；修饰键等不能当主键的返回 null */
export function keyName(code: string): string | null {
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(code);
  if (m) return m[1] ?? m[2];
  if (/^(?:F(?:[1-9]|1\d|2[0-4])|Numpad\d)$/.test(code) || NAMED_KEYS.has(code)) return code;
  return null;
}

type KeyState = Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "code">;

/** 当前按下的修饰键 */
export function modifiers(e: KeyState): string[] {
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter((x): x is string => !!x);
}

/** 按键事件对应的快捷键；只按了修饰键时返回 null */
export function eventShortcut(e: KeyState): string | null {
  const key = keyName(e.code);
  return key ? [...modifiers(e), key].join("+") : null;
}

/** 统一大小写和写法（设置文件可能被手动改成 "ctrl+alt+KeyD" 之类） */
function normalize(s: string): string {
  const mods = new Set<string>();
  let key = "";
  for (const raw of s.split("+")) {
    const t = raw.trim().toUpperCase();
    if (t === "CTRL" || t === "CONTROL") mods.add("CTRL");
    else if (t === "ALT" || t === "OPTION") mods.add("ALT");
    else if (t === "SHIFT") mods.add("SHIFT");
    else key = t.replace(/^KEY([A-Z])$/, "$1").replace(/^DIGIT(\d)$/, "$1");
  }
  return [...["CTRL", "ALT", "SHIFT"].filter((m) => mods.has(m)), key].join("+");
}

export function sameShortcut(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normalize(a) === normalize(b);
}

const KEY_LABELS: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  NumpadAdd: "Num +", NumpadSubtract: "Num -", NumpadMultiply: "Num *", NumpadDivide: "Num /", NumpadDecimal: "Num .",
};

export const keyLabel = (k: string) => KEY_LABELS[k] ?? k.replace(/^Numpad(\d)$/, "Num $1");

/** "Ctrl+Alt+T" → "Ctrl + Alt + T" */
export const shortcutLabel = (s: string) => s.split("+").map(keyLabel).join(" + ");

/** 软件内置或文本编辑常用的组合，不能设成自定义快捷键 */
const RESERVED: Record<string, string> = {
  "Ctrl+S": "保存", "Ctrl+F": "搜索", "Ctrl+N": "新建", "Ctrl+R": "刷新",
  "Ctrl+A": "全选", "Ctrl+C": "复制", "Ctrl+V": "粘贴", "Ctrl+X": "剪切",
  "Ctrl+Z": "撤销", "Ctrl+Y": "重做", "Ctrl+Shift+Z": "重做",
  "Alt+ArrowLeft": "切换到左侧列表", "Alt+ArrowRight": "切换到右侧编辑区",
  "Alt+ArrowUp": "选中上一项", "Alt+ArrowDown": "选中下一项",
  "Ctrl+Slash": "切换实时渲染 / 源码模式",
};

/** 录到的快捷键不能用时返回原因 */
export function checkShortcut(s: string): string | null {
  const parts = s.split("+");
  if (!parts.includes("Ctrl") && !parts.includes("Alt")) return "需要包含 Ctrl 或 Alt，例如 Ctrl + Alt + T";
  const used = RESERVED[s];
  return used ? `${shortcutLabel(s)} 是常用的「${used}」快捷键，请换一个` : null;
}
