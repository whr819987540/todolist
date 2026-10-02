import { describe, expect, it } from "vitest";
import { indent, outdent } from "./lists";
import { apply, exec, readOnly } from "./testState";

// CLAUDE.md「编辑快捷键 → 缩进」：光标（选区）在列表项里时，把这一项连同它的子项缩进成上一项的子项 / 提到上一级
// （列表的第一项不能再缩进，最外层不能再提），有序列表跟着重新编号（原本就不是连续编号的，如全写成 1.，不动）；
// 不在列表里时 Tab 插入两个空格（选中多行时整体缩进）、Ctrl+] 缩进所在的行、Shift+Tab / Ctrl+[ 减少所在行的缩进。
// 记号：| 光标，«» 选区

const tab = (v: Parameters<typeof indent>[0]) => indent(v, "Tab");
const ctrlBracket = (v: Parameters<typeof indent>[0]) => indent(v, "Ctrl+BracketRight");

describe("列表项缩进（Tab / Ctrl+]）", () => {
  it("缩进成上一项的子项", () => {
    expect(apply("- 甲\n- 乙|", tab)).toBe("- 甲\n  - 乙|");
    expect(apply("- 甲\n- 乙|", ctrlBracket)).toBe("- 甲\n  - 乙|");
  });

  it("子项跟着一起缩进", () => {
    expect(apply("- 甲\n- 乙|\n  - 乙的子项\n- 丙", tab)).toBe("- 甲\n  - 乙|\n    - 乙的子项\n- 丙");
  });

  it("对齐到上一项正文开始的地方", () => {
    expect(apply("1. 甲\n2. 乙|", tab)).toBe("1. 甲\n   1. 乙|");
  });

  it("列表的第一项不能再缩进（不插入空格）", () => {
    const r = exec("- 甲|\n- 乙", tab);
    expect(r.text).toBe("- 甲|\n- 乙");
    expect(r.handled).toBe(true);
  });

  it("子列表的第一项也不能再缩进", () => {
    expect(apply("- 甲\n  - 乙|", tab)).toBe("- 甲\n  - 乙|");
  });

  it("选中多项时一起缩进", () => {
    expect(apply("- 甲\n- «乙\n- 丙»", tab)).toBe("- 甲\n  - «乙\n  - 丙»");
  });

  it("任务列表照样缩进", () => {
    expect(apply("- [ ] 甲\n- [x] 乙|", tab)).toBe("- [ ] 甲\n  - [x] 乙|");
  });
});

describe("列表项提到上一级（Shift+Tab / Ctrl+[）", () => {
  it("提到上一级，子项跟着一起", () => {
    expect(apply("- 甲\n  - 乙|\n    - 乙的子项", outdent)).toBe("- 甲\n- 乙|\n  - 乙的子项");
  });

  it("最外层不能再提", () => {
    const r = exec("- 甲\n- 乙|", outdent);
    expect(r.text).toBe("- 甲\n- 乙|");
    expect(r.handled).toBe(true);
  });

  it("引用里的列表", () => {
    expect(apply("> - 甲\n> - 乙|", tab)).toBe("> - 甲\n>   - 乙|");
    expect(apply("> - 甲\n>   - 乙|", outdent)).toBe("> - 甲\n> - 乙|");
  });
});

describe("有序列表重新编号", () => {
  it("缩进后：移走的那项在新位置从 1 编号，原来后面的接着前一项编号", () => {
    expect(apply("1. 甲\n2. 乙|\n3. 丙\n4. 丁", tab)).toBe("1. 甲\n   1. 乙|\n2. 丙\n3. 丁");
  });

  it("选中几项一起缩进：成为新的子列表，从 1 编号", () => {
    expect(apply("1. 甲\n2. «乙\n3. 丙»\n4. 丁", tab)).toBe("1. 甲\n   1. «乙\n   2. 丙»\n2. 丁");
  });

  it("缩进后接在已有子列表的后面", () => {
    expect(apply("1. 甲\n   1. 子一\n2. 乙|\n3. 丙", tab)).toBe("1. 甲\n   1. 子一\n   2. 乙|\n2. 丙");
  });

  it("提到上一级后：接在父项后面编号，后面的跟着往后排", () => {
    expect(apply("1. 甲\n   1. 乙|\n2. 丙", outdent)).toBe("1. 甲\n2. 乙|\n3. 丙");
  });

  it("提到上一级后，原来子列表里后面的项从 1 重新编号", () => {
    expect(apply("1. 甲\n   1. 乙|\n   2. 丙\n2. 丁", outdent)).toBe("1. 甲\n2. 乙|\n   1. 丙\n3. 丁");
  });

  it("从子列表中间提到上一级：后面的项按上一级的编号往后排，和它原来的序号无关", () => {
    expect(apply("1. 甲\n   1. 子一\n   2. 乙|\n2. 丙", outdent)).toBe("1. 甲\n   1. 子一\n2. 乙|\n3. 丙");
    expect(apply("1. 甲\n   5. 乙|\n2. 丙", outdent)).toBe("1. 甲\n2. 乙|\n3. 丙");
  });

  it("原本不是连续编号的（全写成 1.）不动：缩进", () => {
    expect(apply("1. 甲\n1. 乙|\n1. 丙", tab)).toBe("1. 甲\n   1. 乙|\n1. 丙");
  });

  it("原本不是连续编号的（全写成 1.）不动：缩进到全写成 1. 的子列表里", () => {
    expect(apply("1. 甲\n   1. 子一\n   1. 子二\n1. 乙|", tab)).toBe("1. 甲\n   1. 子一\n   1. 子二\n   1. 乙|");
  });

  it("原本不是连续编号的（全写成 1.）不动：提到上一级", () => {
    expect(apply("1. 甲\n   1. 乙|\n1. 丙", outdent)).toBe("1. 甲\n1. 乙|\n1. 丙");
  });

  it("无序列表不编号", () => {
    expect(apply("- 甲\n- 乙|\n- 丙", tab)).toBe("- 甲\n  - 乙|\n- 丙");
  });
});

describe("不在列表里", () => {
  it("Tab 插入两个空格", () => {
    expect(apply("甲|乙", tab)).toBe("甲  |乙");
  });

  it("Tab 选中多行时整体缩进", () => {
    expect(apply("«甲\n乙»", tab)).toBe("  «甲\n  乙»");
  });

  it("Ctrl+] 缩进所在的行", () => {
    expect(apply("甲|乙", ctrlBracket)).toBe("  甲|乙");
  });

  it("Shift+Tab / Ctrl+[ 减少所在行的缩进", () => {
    expect(apply("    甲|乙", outdent)).toBe("  甲|乙");
  });

  it("列表项里的代码块中同不在列表里：Tab 插入两个空格", () => {
    expect(apply("- 甲\n\n  ```\n  co|de\n  ```", tab)).toBe("- 甲\n\n  ```\n  co  |de\n  ```");
  });

  it("只读时什么也不做，但按键算已处理（焦点不跳出编辑区）", () => {
    const r = exec("甲|乙", tab, [readOnly]);
    expect(r.text).toBe("甲|乙");
    expect(r.handled).toBe(true);
  });
});
