import { describe, expect, it } from "vitest";
import {
  CONFIGURABLE_EDIT_SHORTCUTS,
  type EditCommandId,
  EDIT_SHORTCUTS,
  editBindingTable,
  editShortcutConflict,
  effectiveEditShortcuts,
} from "./editShortcuts";
import { checkShortcut, normalizeShortcut } from "./shortcuts";

// docs/requirements.md「编辑快捷键」：默认按键与 Typora（Windows）相同；每条都能修改、恢复默认或不使用；
// 改过的存在设置文件里（只记改过的，没改过的跟着默认值走）；所有快捷键之间不能重复。

/** docs/requirements.md 里列出的默认按键 */
const TYPORA_DEFAULTS: Record<EditCommandId, string> = {
  bold: "Ctrl+B",
  italic: "Ctrl+I",
  underline: "Ctrl+U",
  strike: "Alt+Shift+5",
  code: "Ctrl+Shift+Backquote",
  link: "Ctrl+K",
  clearFormat: "Ctrl+Backslash",
  heading1: "Ctrl+1",
  heading2: "Ctrl+2",
  heading3: "Ctrl+3",
  heading4: "Ctrl+4",
  heading5: "Ctrl+5",
  heading6: "Ctrl+6",
  paragraph: "Ctrl+0",
  headingUp: "Ctrl+Equal",
  headingDown: "Ctrl+Minus",
  quote: "Ctrl+Shift+Q",
  orderedList: "Ctrl+Shift+BracketLeft",
  bulletList: "Ctrl+Shift+BracketRight",
  codeBlock: "Ctrl+Shift+K",
  indent: "Ctrl+BracketRight",
  outdent: "Ctrl+BracketLeft",
  selectWord: "Ctrl+D",
  deleteWord: "Ctrl+Shift+D",
  selectLine: "Ctrl+L",
};

/** 应用快捷键的默认值（settings.rs） */
const APP_DEFAULTS = ["Ctrl+Alt+T", "Ctrl+Alt+D", "Ctrl+Alt+O"];

describe("默认按键", () => {
  it("和 Typora 一样", () => {
    expect(effectiveEditShortcuts(undefined)).toEqual(TYPORA_DEFAULTS);
  });

  it("每条默认按键都能通过录制时的检查：不是保留的组合，和别的快捷键、固定按键都不重复", () => {
    const fixed = EDIT_SHORTCUTS.flatMap((s) => s.fixed ?? []);
    for (const s of CONFIGURABLE_EDIT_SHORTCUTS) {
      const others = [
        ...APP_DEFAULTS,
        ...CONFIGURABLE_EDIT_SHORTCUTS.filter((o) => o !== s).map((o) => o.defaultKey),
        ...fixed,
      ].map((key) => ({ key, label: key }));
      expect(checkShortcut(s.defaultKey, others), s.label).toBeNull();
    }
  });

  it("固定按键：Tab / Shift+Tab 缩进，Ctrl+Z / Ctrl+Y 撤销重做，Ctrl+Enter 跳出代码块，Ctrl+F / Ctrl+H 查找替换", () => {
    const fixed = Object.fromEntries(EDIT_SHORTCUTS.filter((s) => s.fixed).map((s) => [s.label, s.fixed]));
    expect(fixed["增加缩进"]).toEqual(["Tab"]);
    expect(fixed["减少缩进"]).toEqual(["Shift+Tab"]);
    expect(fixed["撤销"]).toEqual(["Ctrl+Z"]);
    expect(fixed["重做"]).toContain("Ctrl+Y");
    expect(fixed["跳出代码块"]).toEqual(["Ctrl+Enter"]);
    expect(fixed["查找"]).toEqual(["Ctrl+F"]);
    expect(fixed["替换"]).toEqual(["Ctrl+H"]);
    expect(fixed["查找下一个 / 上一个"]).toEqual(["F3", "Shift+F3"]);
  });
});

describe("设置里改过的盖在默认值上", () => {
  it("改过的用新按键，null 是不使用，没改过的跟着默认值", () => {
    const map = effectiveEditShortcuts({ bold: "Ctrl+Alt+B", italic: null });
    expect(map.bold).toBe("Ctrl+Alt+B");
    expect(map.italic).toBeNull();
    expect(map.underline).toBe("Ctrl+U");
  });

  it("认不出的命令名不影响别的", () => {
    const map = effectiveEditShortcuts({ noSuchCommand: "Ctrl+Q" });
    expect(map).toEqual(TYPORA_DEFAULTS);
  });
});

describe("按键 → 命令", () => {
  const lookup = (table: Map<string, EditCommandId>, key: string) => table.get(normalizeShortcut(key));

  it("默认按键和固定按键都能查到", () => {
    const table = editBindingTable(effectiveEditShortcuts(undefined));
    expect(lookup(table, "Ctrl+B")).toBe("bold");
    expect(lookup(table, "Tab")).toBe("indent");
    expect(lookup(table, "Shift+Tab")).toBe("outdent");
    expect(lookup(table, "Ctrl+BracketRight")).toBe("indent");
  });

  it("不使用的查不到", () => {
    const table = editBindingTable(effectiveEditShortcuts({ bold: null }));
    expect(lookup(table, "Ctrl+B")).toBeUndefined();
  });

  it("设置文件里手改成重复的：固定按键优先，其余按列表里先出现的算", () => {
    const table = editBindingTable(effectiveEditShortcuts({ bold: "Tab", italic: "Ctrl+U" }));
    expect(lookup(table, "Tab")).toBe("indent");
    expect(lookup(table, "Ctrl+U")).toBe("italic");
  });

  it("设置文件里手改成软件内置的组合（F5 / Ctrl+R 刷新、Ctrl+S 保存等）的不绑定", () => {
    const table = editBindingTable(effectiveEditShortcuts({ bold: "Ctrl+R", italic: "F5", underline: "ctrl+s" }));
    expect(lookup(table, "Ctrl+R")).toBeUndefined();
    expect(lookup(table, "F5")).toBeUndefined();
    expect(lookup(table, "Ctrl+S")).toBeUndefined();
  });
});

describe("设置里对重复的编辑快捷键的提示", () => {
  const app = [
    { key: "Ctrl+Alt+T", label: "显示 / 隐藏主窗口" },
    { key: "Ctrl+Alt+D", label: "标记完成 / 未完成" },
  ];
  const conflict = (changed: Record<string, string | null>, id: EditCommandId) =>
    editShortcutConflict(id, effectiveEditShortcuts(changed), app);

  it("没重复时没有提示", () => {
    expect(conflict({}, "bold")).toBeUndefined();
    expect(conflict({ bold: null }, "bold")).toBeUndefined();
  });

  it("和刷新（F5 / Ctrl+R）重复：这个不起作用", () => {
    expect(conflict({ bold: "Ctrl+R" }, "bold")).toBe("Ctrl + R 是常用的「刷新」快捷键，这个不起作用");
    expect(conflict({ bold: "F5" }, "bold")).toBe("F5 是常用的「刷新」快捷键，这个不起作用");
  });

  it("和应用快捷键重复：执行的是应用快捷键", () => {
    expect(conflict({ bold: "Ctrl+Alt+D" }, "bold")).toBe("和「标记完成 / 未完成」重复，在正文里按下时执行的是「标记完成 / 未完成」");
  });

  it("和固定按键重复", () => {
    expect(conflict({ bold: "Shift+Tab" }, "bold")).toBe("和编辑快捷键「减少缩进」的固定按键重复，这个不起作用");
  });

  it("和前面的编辑快捷键重复：后面这个不起作用，前面那个照常", () => {
    expect(conflict({ italic: "Ctrl+B" }, "italic")).toBe("和编辑快捷键「加粗」重复，这个不起作用");
    expect(conflict({ italic: "Ctrl+B" }, "bold")).toBeUndefined();
  });
});
