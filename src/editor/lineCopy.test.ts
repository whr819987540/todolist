import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { lineCopyText } from "./lineCopy";
import { makeState } from "./testState";

// docs/requirements.md「待办内容」：没选中文字时 Ctrl+C 复制光标所在的整行；列表项、任务、标题的行只复制后面的文字，
// 不带行首的列表符号 / 序号、任务框和标题的 #。null 是不接管、照 CodeMirror 自带的复制整行原文。记号：| 光标

const copied = (marked: string) => lineCopyText(makeState(marked));

describe("列表项、任务的行只复制后面的文字", () => {
  it("无序、有序列表项不带列表符号 / 序号", () => {
    expect(copied("- 买牛奶|")).toBe("买牛奶");
    expect(copied("* 星号|")).toBe("星号");
    expect(copied("+ 加号|")).toBe("加号");
    expect(copied("1. 第一项|")).toBe("第一项");
    expect(copied("10) 第十项|")).toBe("第十项");
  });

  it("任务不带列表符号和任务框，勾没勾都一样", () => {
    expect(copied("- [ ] 没做的|")).toBe("没做的");
    expect(copied("- [x] 做完的|")).toBe("做完的");
    expect(copied("- [X] 大写的|")).toBe("大写的");
    expect(copied("1. [ ] 有序的任务|")).toBe("有序的任务");
  });

  it("光标在行里哪里都一样（列表符号前面、正文开头、中间）", () => {
    expect(copied("|- [ ] 任务")).toBe("任务");
    expect(copied("- [ ] |任务")).toBe("任务");
    expect(copied("- [ ] 任|务")).toBe("任务");
  });

  it("嵌套的子项不带前面的缩进；同一行套着子项的两个符号都去掉", () => {
    expect(copied("- 甲\n  - 乙|")).toBe("乙");
    expect(copied("- 甲\n  - 乙\n    - [ ] 丙|")).toBe("丙");
    expect(copied("- - 同一行套着子项|")).toBe("同一行套着子项");
  });

  it("正文里的格式标记、后面的 - 和 # 照原样", () => {
    expect(copied("- **加粗** 和 ==高亮==|")).toBe("**加粗** 和 ==高亮==");
    expect(copied("- 甲 - 乙 #丙|")).toBe("甲 - 乙 #丙");
  });

  it("引用里的列表项连同前面的 > 一起去掉；列表项里的引用也是", () => {
    expect(copied("> - 引用里的项|")).toBe("引用里的项");
    expect(copied("> - [ ] 引用里的任务|")).toBe("引用里的任务");
    expect(copied("- > 项里的引用|")).toBe("项里的引用");
  });

  it("空的项复制出空的文字", () => {
    expect(copied("- |")).toBe("");
    expect(copied("- [ ] |")).toBe("");
  });
});

describe("标题的行不带 #", () => {
  it("各级标题去掉行首的 # 和后面的空格", () => {
    expect(copied("# 一级标题|")).toBe("一级标题");
    expect(copied("### 三级标题|")).toBe("三级标题");
    expect(copied("###### 六级|")).toBe("六级");
  });

  it("标题末尾收尾的 # 也去掉，正文中间的 # 不动", () => {
    expect(copied("## 两边都有 ##|")).toBe("两边都有");
    expect(copied("## C# 入门|")).toBe("C# 入门");
  });

  it("列表项本身是标题时，列表符号和 # 都去掉", () => {
    expect(copied("- # 标题项|")).toBe("标题项");
    expect(copied("10. ## 有序的标题项|")).toBe("有序的标题项");
  });

  it("不是标题的 #（# 后面没有空格，如标签）照原样", () => {
    expect(copied("#标签|")).toBeNull();
  });
});

describe("别的行照原样复制整行（交给 CodeMirror）", () => {
  it("普通的段落、普通的引用", () => {
    expect(copied("一段文字|")).toBeNull();
    expect(copied("> 普通的引用|")).toBeNull();
  });

  it("代码块里的 - 和 #", () => {
    const doc = "```\n# 注释|\n- 不是列表\n```";
    expect(copied(doc)).toBeNull();
    expect(copied("```\n# 注释\n- 不是列表|\n```")).toBeNull();
    expect(copied("- 列表项里的代码：\n\n  ```\n  # 注释|\n  ```")).toBeNull();
  });

  it("列表项的续行、下面画 === 的标题", () => {
    expect(copied("- 甲\n  续行|")).toBeNull();
    expect(copied("标题|\n===")).toBeNull();
    expect(copied("标题\n===|")).toBeNull();
  });

  it("选中了文字时照常复制选中的原文", () => {
    expect(copied("- «买牛»奶")).toBeNull();
    expect(copied("«- [ ] 任务»")).toBeNull();
  });
});

describe("多个光标", () => {
  // 正文 "- 甲\n段落\n# 乙"：第一行 0～3，第二行 4～6，第三行 7～10
  const state = makeState("- 甲\n段落\n# 乙", [EditorState.allowMultipleSelections.of(true)]);
  const at = (...cursors: number[]) =>
    lineCopyText(state.update({ selection: EditorSelection.create(cursors.map((c) => EditorSelection.cursor(c))) }).state);

  it("每个光标所在的行一份，用换行连起来；有一行要去掉标记时，普通的行照原样带上", () => {
    expect(at(1, 4, 9)).toBe("甲\n段落\n乙");
  });

  it("同一行里的几个光标只算一次", () => {
    expect(at(0, 3)).toBe("甲");
  });

  it("都是普通的行时交给 CodeMirror", () => {
    expect(at(4, 5)).toBeNull();
  });
});
