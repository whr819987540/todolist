import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { indent, newItemAbove, outdent } from "./lists";
import { apply, exec, makeState, readOnly } from "./testState";

// docs/requirements.md「编辑快捷键 → 缩进」：光标（选区）在列表项里时，把这一项连同它的子项缩进成上一项的子项 / 提到上一级
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

// docs/requirements.md「待办内容 → 正文用 Markdown 编辑」：回车自动续写列表和任务；在列表项的正文开头（列表符号、任务框后面）
// 按回车时，在上面新起一个同一级的空项，这一项连同光标挪到下一行：空项的任务框没勾、后面照样留着空格，仍是任务；
// 这一项的勾选状态不变；有序列表里这一项和后面接着编号的往后排一个号
describe("回车", () => {
  // 同编辑器里：先试 newItemAbove，不是那种情况时用 Markdown 自带的回车续写列表
  const enter = (v: Parameters<typeof newItemAbove>[0]) => newItemAbove(v) || insertNewlineContinueMarkup(v);
  /** 第 n 行（从 1 起）是不是任务列表的一项 */
  const isTask = (doc: string, n: number) => {
    const state = makeState(doc);
    const line = state.doc.line(n);
    let task = false;
    ensureSyntaxTree(state, state.doc.length)!.iterate({
      from: line.from,
      to: line.to,
      enter: (node) => {
        if (node.name === "Task" && node.from >= line.from) task = true;
      },
    });
    return task;
  };

  it("任务框和文字之间：上面新起一个空的任务，仍是任务", () => {
    const text = apply("- [ ] |甲", enter);
    expect(text).toBe("- [ ] \n- [ ] |甲");
    expect(isTask(text.replace("|", ""), 1)).toBe(true);
    expect(isTask(text.replace("|", ""), 2)).toBe(true);
  });

  it("勾选了的任务：空项没勾，这一项照样勾着", () => {
    expect(apply("- [x] |甲", enter)).toBe("- [ ] \n- [x] |甲");
    expect(apply("* [X] |甲", enter)).toBe("* [ ] \n* [X] |甲");
  });

  it("任务框后面有几个空格时照样留着", () => {
    expect(apply("- [ ]  |甲", enter)).toBe("- [ ]  \n- [ ]  |甲");
  });

  it("普通的列表项", () => {
    expect(apply("- |甲\n- 乙", enter)).toBe("- \n- |甲\n- 乙");
  });

  it("有序列表：这一项和后面接着编号的往后排", () => {
    expect(apply("1. |甲\n2. 乙\n3. 丙", enter)).toBe("1. \n2. |甲\n3. 乙\n4. 丙");
    expect(apply("1. 甲\n2. |乙\n3. 丙", enter)).toBe("1. 甲\n2. \n3. |乙\n4. 丙");
  });

  it("有序列表里的任务", () => {
    const text = apply("1. [x] |甲\n2. [ ] 乙", enter);
    expect(text).toBe("1. [ ] \n2. [x] |甲\n3. [ ] 乙");
    expect(isTask(text.replace("|", ""), 1)).toBe(true);
  });

  it("嵌套的、引用里的列表：空项和这一项同一级", () => {
    expect(apply("- 甲\n  - [ ] |乙", enter)).toBe("- 甲\n  - [ ] \n  - [ ] |乙");
    expect(apply("> - [ ] |甲", enter)).toBe("> - [ ] \n> - [ ] |甲");
  });

  it("同一行里套着子项（- - 甲）：空项是子项，这一项也还是子项", () => {
    expect(apply("- - |甲", enter)).toBe("- - \n  - |甲");
  });

  it("有空行隔开的列表：新的一项也隔着空行", () => {
    expect(apply("- 甲\n\n- [ ] |乙", enter)).toBe("- 甲\n\n- [ ] \n\n- [ ] |乙");
    expect(apply("> - 甲\n>\n> - |乙", enter)).toBe("> - 甲\n>\n> - \n>\n> - |乙");
  });

  it("不在正文开头时照常续写：文字中间、末尾", () => {
    expect(apply("- [ ] 甲|乙", enter)).toBe("- [ ] 甲\n- [ ] |乙");
    expect(apply("- [x] 甲|", enter)).toBe("- [x] 甲\n- [ ] |");
  });

  it("空项上回车照常退出列表", () => {
    expect(exec("- 甲\n- 乙\n- [ ] |", newItemAbove).handled).toBe(false);
    expect(apply("- 甲\n- 乙\n- [ ] |", enter)).toBe("- 甲\n- 乙\n|");
  });

  it("只读时不处理", () => {
    expect(exec("- [ ] |甲", newItemAbove, [readOnly]).handled).toBe(false);
  });
});
