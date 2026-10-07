import { describe, expect, it } from "vitest";
import { activeIndex, outlineDepth, outlineItems } from "./outline";
import { makeState } from "./testState";

// docs/requirements.md「大纲」：列出正文里的标题，去掉加粗、链接这些标记；代码块里的 # 不算

const items = (doc: string) => outlineItems(makeState(doc)).map(({ level, text }) => `${level} ${text}`);

describe("大纲列出的标题", () => {
  it("# 标题和下面画线的标题", () => {
    expect(items("# 一级\n正文\n## 二级\n\n设置标题\n===\n\n小标题\n---\n\n###### 六级")).toEqual([
      "1 一级",
      "2 二级",
      "1 设置标题",
      "2 小标题",
      "6 六级",
    ]);
  });

  it("去掉加粗、斜体、行内代码、删除线、链接地址、<u> 标签和结尾的 #", () => {
    expect(items("## **加粗** *斜体* `代码` ~~删除~~ [链接](https://a.cn) <u>下划线</u> ##")).toEqual([
      "2 加粗 斜体 代码 删除 链接 下划线",
    ]);
  });

  it("引用、列表里的标题也算，代码块里的 # 不算，空标题不列", () => {
    expect(items("> ## 引用里\n\n- ### 列表里\n\n```\n# 代码里的注释\n```\n\n#\n\n# 最后")).toEqual([
      "2 引用里",
      "3 列表里",
      "1 最后",
    ]);
  });

  it("位置是标题那一行的开头", () => {
    const state = makeState("正文\n\n> ## 引用里");
    expect(outlineItems(state)[0].pos).toBe(state.doc.line(3).from);
  });

  it("裸网址留着，链接里的地址去掉", () => {
    expect(items("# 见 https://a.cn 和 [这里](https://b.cn)")).toEqual(["1 见 https://a.cn 和 这里"]);
  });
});

describe("正在看的是哪个标题", () => {
  const list = outlineItems(makeState("前言\n# 一\n正文\n## 二\n正文\n# 三\n正文"));
  const posOf = (text: string) => list.find((x) => x.text === text)!.pos;

  it("最后一个开头不晚于这个位置的标题", () => {
    expect(activeIndex(list, 0)).toBe(-1);
    expect(activeIndex(list, posOf("一"))).toBe(0);
    expect(activeIndex(list, posOf("二") + 3)).toBe(1);
    expect(activeIndex(list, posOf("三") - 1)).toBe(1);
    expect(activeIndex(list, 1e9)).toBe(2);
  });

  it("缩进按最高一级的标题算", () => {
    const sub = outlineItems(makeState("## 二\n### 三\n## 二"));
    expect(sub.map((x) => outlineDepth(sub, x))).toEqual([0, 1, 0]);
  });
});
