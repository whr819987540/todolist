import { describe, expect, it } from "vitest";
import {
  clearFormat,
  deleteWord,
  headingDown,
  headingUp,
  selectLine,
  selectWord,
  setHeading,
  setParagraph,
  toggleCodeBlock,
  toggleInline,
  toggleLink,
  toggleList,
  toggleQuote,
} from "./formatting";
import { apply, exec, readOnly } from "./testState";

// 按 CLAUDE.md「编辑快捷键」和 README 的快捷键表写的用例。
// 记号：| 光标，«» 选区（« 是不动的一端，» 是光标所在的一端）

const bold = (v: Parameters<typeof toggleInline>[0]) => toggleInline(v, "bold");
const italic = (v: Parameters<typeof toggleInline>[0]) => toggleInline(v, "italic");
const strike = (v: Parameters<typeof toggleInline>[0]) => toggleInline(v, "strike");
const code = (v: Parameters<typeof toggleInline>[0]) => toggleInline(v, "code");
const underline = (v: Parameters<typeof toggleInline>[0]) => toggleInline(v, "underline");

describe("格式：选中的文字不是这种格式时加上", () => {
  it("加粗、斜体、删除线、行内代码、下划线（<u> 标签）", () => {
    expect(apply("买«牛奶»和面包", bold)).toBe("买**«牛奶»**和面包");
    expect(apply("买«牛奶»和面包", italic)).toBe("买*«牛奶»*和面包");
    expect(apply("买«牛奶»和面包", strike)).toBe("买~~«牛奶»~~和面包");
    expect(apply("买«牛奶»和面包", code)).toBe("买`«牛奶»`和面包");
    expect(apply("买«牛奶»和面包", underline)).toBe("买<u>«牛奶»</u>和面包");
  });

  it("反向选区加上后仍是反向选中原来的文字", () => {
    expect(apply("买»牛奶«和面包", bold)).toBe("买**»牛奶«**和面包");
  });

  it("只给选中的部分加，别处原有的写法不动", () => {
    expect(apply("__甲__ «乙» *丙*", bold)).toBe("__甲__ **«乙»** *丙*");
  });

  it("跨行时每行分别加，行首的列表符号、引用、标题标记留在外面", () => {
    expect(apply("«第一行\n第二行»", bold)).toBe("**«第一行**\n**第二行»**");
    expect(apply("- «甲\n- 乙»", bold)).toBe("- **«甲**\n- **乙»**");
    expect(apply("«> 引用\n## 标题»", italic)).toBe("«> *引用*\n## *标题*»");
  });

  it("跨行时只给还不是这种格式的行加", () => {
    expect(apply("«**甲**\n乙»", bold)).toBe("«**甲**\n**乙»**");
  });

  it("空行不加标记", () => {
    expect(apply("«甲\n\n乙»", bold)).toBe("**«甲**\n\n**乙»**");
  });
});

describe("格式：选中的文字都已经是这种格式时去掉", () => {
  it("选中标记里面的文字", () => {
    expect(apply("买**«牛奶»**和面包", bold)).toBe("买«牛奶»和面包");
    expect(apply("买*«牛奶»*和面包", italic)).toBe("买«牛奶»和面包");
    expect(apply("买~~«牛奶»~~和面包", strike)).toBe("买«牛奶»和面包");
    expect(apply("买`«牛奶»`和面包", code)).toBe("买«牛奶»和面包");
    expect(apply("买<u>«牛奶»</u>和面包", underline)).toBe("买«牛奶»和面包");
  });

  it("连同标记一起选中", () => {
    expect(apply("买«**牛奶**»和面包", bold)).toBe("买«牛奶»和面包");
    expect(apply("买«<u>牛奶</u>»和面包", underline)).toBe("买«牛奶»和面包");
  });

  it("跨行时每行都已是这种格式才去掉", () => {
    expect(apply("«**甲**\n**乙**»", bold)).toBe("«甲\n乙»");
  });
});

describe("格式：没选中文字时", () => {
  it("光标不在这种格式里：插入一对标记，光标放在中间", () => {
    expect(apply("买|面包", bold)).toBe("买**|**面包");
    expect(apply("买|面包", italic)).toBe("买*|*面包");
    expect(apply("买|面包", strike)).toBe("买~~|~~面包");
    expect(apply("买|面包", code)).toBe("买`|`面包");
    expect(apply("买|面包", underline)).toBe("买<u>|</u>面包");
  });

  it("光标在这种格式里：去掉这个格式，光标留在原来的文字处", () => {
    expect(apply("买**牛|奶**和面包", bold)).toBe("买牛|奶和面包");
    expect(apply("买*牛|奶*和面包", italic)).toBe("买牛|奶和面包");
    expect(apply("买~~牛|奶~~和面包", strike)).toBe("买牛|奶和面包");
    expect(apply("买`牛|奶`和面包", code)).toBe("买牛|奶和面包");
    expect(apply("买<u>牛|奶</u>和面包", underline)).toBe("买牛|奶和面包");
  });

  it("光标在别的格式里时照常插入", () => {
    expect(apply("买*牛|奶*", bold)).toBe("买*牛**|**奶*");
  });
});

describe("超链接", () => {
  it("选中网址：变成 [网址](网址)，选中前面的文字以便改写", () => {
    expect(apply("见 «https://example.com/a» 说明", toggleLink)).toBe(
      "见 [«https://example.com/a»](https://example.com/a) 说明",
    );
    expect(apply("«mailto:a@b.com»", toggleLink)).toBe("[«mailto:a@b.com»](mailto:a@b.com)");
  });

  it("选中其他文字：变成 [文字]()，光标放进括号里填地址", () => {
    expect(apply("见«官网»说明", toggleLink)).toBe("见[官网](|)说明");
  });

  it("没选中文字：插入一对标记，光标放在中间", () => {
    expect(apply("见|说明", toggleLink)).toBe("见[|]()说明");
  });

  it("光标在链接里：去掉链接，只留文字", () => {
    expect(apply("见[官|网](https://a.cn)说明", toggleLink)).toBe("见官|网说明");
  });
});

describe("清除格式", () => {
  it("去掉选中部分碰到的加粗、斜体、删除线、行内代码、链接和 <u> 等标签", () => {
    expect(apply("«**甲** *乙* ~~丙~~ `丁` [戊](https://a.cn) <u>己</u>»", clearFormat)).toBe(
      "«甲 乙 丙 丁 戊 己»",
    );
  });

  it("没选中时去掉光标所在的格式", () => {
    expect(apply("前 **加|粗** 后", clearFormat)).toBe("前 加|粗 后");
  });

  it("嵌套的格式都去掉", () => {
    expect(apply("«***甲***»", clearFormat)).toBe("«甲»");
  });

  it("只动选中的部分", () => {
    expect(apply("**甲** «*乙*» ~~丙~~", clearFormat)).toBe("**甲** «乙» ~~丙~~");
  });
});

describe("代码块里不做格式、段落操作", () => {
  const block = "```js\nconst a|b = 1;\n```";
  it.each([
    ["加粗", bold],
    ["超链接", toggleLink],
    ["清除格式", clearFormat],
    ["标题", (v: Parameters<typeof setHeading>[0]) => setHeading(v, 1)],
    ["引用", toggleQuote],
    ["列表", (v: Parameters<typeof toggleList>[0]) => toggleList(v, false)],
  ])("%s", (_name, command) => {
    const r = exec(block, command);
    expect(r.text).toBe(block);
    // 按键已处理，不再落到 CodeMirror 自带的同名按键上
    expect(r.handled).toBe(true);
  });
});

describe("只读时不修改", () => {
  it("格式和段落命令", () => {
    for (const command of [bold, toggleLink, clearFormat, toggleQuote, toggleCodeBlock, deleteWord]) {
      expect(apply("«甲乙»", command, [readOnly])).toBe("«甲乙»");
    }
  });
});

describe("标题", () => {
  it("Ctrl+1～6 变成对应级别的标题", () => {
    expect(apply("会议|纪要", (v) => setHeading(v, 1))).toBe("# 会议|纪要");
    expect(apply("会议|纪要", (v) => setHeading(v, 3))).toBe("### 会议|纪要");
    expect(apply("会议|纪要", (v) => setHeading(v, 6))).toBe("###### 会议|纪要");
  });

  it("已经是这一级时变回正文", () => {
    expect(apply("## 会议|纪要", (v) => setHeading(v, 2))).toBe("会议|纪要");
  });

  it("是别的级别时换成这一级", () => {
    expect(apply("# 会议|纪要", (v) => setHeading(v, 4))).toBe("#### 会议|纪要");
  });

  it("Ctrl+0 变回正文", () => {
    expect(apply("### 会议|纪要", setParagraph)).toBe("会议|纪要");
    expect(apply("会议|纪要", setParagraph)).toBe("会议|纪要");
  });

  it("作用于选中的各行，空行不加", () => {
    expect(apply("«甲\n\n乙»", (v) => setHeading(v, 2))).toBe("«## 甲\n\n## 乙»");
  });

  it("引用里的标题写在 > 后面", () => {
    expect(apply("> 会议|纪要", (v) => setHeading(v, 2))).toBe("> ## 会议|纪要");
  });

  it("Ctrl+= 提升一级：正文 → 标题 6 → … → 标题 1，标题 1 不再变", () => {
    expect(apply("会议|纪要", headingUp)).toBe("###### 会议|纪要");
    expect(apply("###### 会议|纪要", headingUp)).toBe("##### 会议|纪要");
    expect(apply("## 会议|纪要", headingUp)).toBe("# 会议|纪要");
    expect(apply("# 会议|纪要", headingUp)).toBe("# 会议|纪要");
  });

  it("Ctrl+- 降低一级：标题 1 → … → 标题 6 → 正文，正文不再变", () => {
    expect(apply("# 会议|纪要", headingDown)).toBe("## 会议|纪要");
    expect(apply("##### 会议|纪要", headingDown)).toBe("###### 会议|纪要");
    expect(apply("###### 会议|纪要", headingDown)).toBe("会议|纪要");
    expect(apply("会议|纪要", headingDown)).toBe("会议|纪要");
  });
});

describe("引用", () => {
  it("加上，再按一次去掉", () => {
    expect(apply("一句|话", toggleQuote)).toBe("> 一句|话");
    expect(apply("> 一句|话", toggleQuote)).toBe("一句|话");
  });

  it("作用于选中的各行", () => {
    expect(apply("«甲\n乙»", toggleQuote)).toBe("«> 甲\n> 乙»");
    expect(apply("«> 甲\n> 乙»", toggleQuote)).toBe("«甲\n乙»");
  });
});

describe("有序 / 无序列表", () => {
  const ordered = (v: Parameters<typeof toggleList>[0]) => toggleList(v, true);
  const bullet = (v: Parameters<typeof toggleList>[0]) => toggleList(v, false);

  it("无序列表：加上，再按一次去掉", () => {
    expect(apply("买|菜", bullet)).toBe("- 买|菜");
    expect(apply("- 买|菜", bullet)).toBe("买|菜");
  });

  it("有序列表：选中的各行从 1 编号，再按一次去掉", () => {
    expect(apply("«甲\n乙\n丙»", ordered)).toBe("«1. 甲\n2. 乙\n3. 丙»");
    expect(apply("«1. 甲\n2. 乙\n3. 丙»", ordered)).toBe("«甲\n乙\n丙»");
  });

  it("在两种列表之间切换", () => {
    expect(apply("«- 甲\n- 乙»", ordered)).toBe("«1. 甲\n2. 乙»");
    expect(apply("«1. 甲\n2. 乙»", bullet)).toBe("«- 甲\n- 乙»");
  });

  it("任务框保留；去掉列表时连同任务框一起去掉", () => {
    expect(apply("- [ ] 买|菜", ordered)).toBe("1. [ ] 买|菜");
    expect(apply("- [x] 买|菜", bullet)).toBe("买|菜");
  });

  it("紧接在有序列表后面时接着编号", () => {
    expect(apply("1. 甲\n2. 乙\n丙|", ordered)).toBe("1. 甲\n2. 乙\n3. 丙|");
  });
});

describe("代码块", () => {
  it("用 ``` 把所在的行包起来，再按一次（光标在代码块里）去掉", () => {
    expect(apply("let a| = 1;", toggleCodeBlock)).toBe("```\nlet a| = 1;\n```");
    expect(apply("```\nlet a| = 1;\n```", toggleCodeBlock)).toBe("let a| = 1;");
  });

  it("包住选中的各行", () => {
    expect(apply("前\n«甲\n乙»\n后", toggleCodeBlock)).toBe("前\n```\n«甲\n乙»\n```\n后");
  });

  it("空行上直接变成空代码块，光标放在里面", () => {
    expect(apply("前\n|\n后", toggleCodeBlock)).toBe("前\n```\n|\n```\n后");
  });

  it("带语言的代码块也能去掉", () => {
    expect(apply("```ts\nlet a| = 1;\n```\n后", toggleCodeBlock)).toBe("let a| = 1;\n后");
  });
});

describe("选择与删除", () => {
  it("Ctrl+D 选中当前词：英文按单词", () => {
    expect(apply("hello wo|rld", selectWord)).toBe("hello «world»");
  });

  it("Ctrl+D 选中当前词：中文按词（同双击）", () => {
    expect(apply("我们明|天去公园", selectWord)).toBe("我们«明天»去公园");
  });

  it("Ctrl+D 已经选中文字时不变", () => {
    expect(apply("he«llo» world", selectWord)).toBe("he«llo» world");
  });

  it("Ctrl+Shift+D 删除当前词", () => {
    expect(apply("hello wo|rld", deleteWord)).toBe("hello |");
    expect(apply("我们明|天去公园", deleteWord)).toBe("我们|去公园");
  });

  it("Ctrl+L 选中当前行，再按往下多选一行", () => {
    const once = apply("甲\n乙|乙\n丙", selectLine);
    expect(once).toBe("甲\n«乙乙»\n丙");
    expect(apply(once, selectLine)).toBe("甲\n«乙乙\n丙»");
  });
});
