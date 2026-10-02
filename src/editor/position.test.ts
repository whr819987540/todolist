import { describe, expect, it } from "vitest";
import { type EditPosition, locateAnchor, restorePosition, type TextAnchor } from "./position";

// CLAUDE.md「回到上次编辑位置」：正文在外部被改过时，按光标（选区两端）前后的原文找回位置，
// 选区另一端找不到时只放光标；被大幅修改、找不到时回到开头。

const CONTEXT = 32;

/** 像 capturePosition 一样记下 doc 里 pos 处的位置（前后各 32 个字符） */
function anchorAt(doc: string, pos: number): TextAnchor {
  return {
    pos,
    before: doc.slice(Math.max(0, pos - CONTEXT), pos),
    after: doc.slice(pos, pos + CONTEXT),
  };
}

function positionAt(doc: string, head: number, anchor?: number, viewTop = head): EditPosition {
  return {
    cursor: anchorAt(doc, head),
    ...(anchor !== undefined && anchor !== head && { anchor: anchorAt(doc, anchor) }),
    view: { ...anchorAt(doc, viewTop), top: -4 },
  };
}

const PARAS = [
  "第一段：周一上午开会，讨论下个季度的产品规划和人员安排。",
  "第二段：今天要把会议纪要整理出来，发给项目组的每个人确认。",
  "第三段：周五之前收齐大家的意见，再汇总成一份正式的文档。",
  "第四段：下周二和客户约了电话会议，需要提前准备演示用的材料。",
  "第五段：月底前完成测试环境的部署，并安排一次完整的回归测试。",
];
const DOC = PARAS.join("\n\n");
/** 第三段里「汇总」的位置 */
const AT = DOC.indexOf("汇总");

describe("找回一个位置", () => {
  it("正文没变时就在原处", () => {
    expect(locateAnchor(DOC, anchorAt(DOC, AT))).toBe(AT);
  });

  it("前面插入了文字：按前后的原文找回，跟着往后挪", () => {
    const changed = "新加的开头一段话。\n\n" + DOC;
    expect(locateAnchor(changed, anchorAt(DOC, AT))).toBe(AT + "新加的开头一段话。\n\n".length);
  });

  it("前面删掉了一段", () => {
    const removed = PARAS[0] + "\n\n";
    const changed = DOC.slice(removed.length);
    expect(locateAnchor(changed, anchorAt(DOC, AT))).toBe(AT - removed.length);
  });

  it("光标后面紧挨着的文字被改了：只用前面的原文也能找回", () => {
    const changed = DOC.slice(0, AT) + "【改过】" + DOC.slice(AT + 10);
    expect(locateAnchor(changed, anchorAt(DOC, AT))).toBe(AT);
  });

  it("光标前面紧挨着的文字被改了，同时前面多了一段：只用后面的原文找回", () => {
    const changed = "多一段。\n" + DOC.slice(0, AT - 10) + "【改过】" + DOC.slice(AT);
    expect(locateAnchor(changed, anchorAt(DOC, AT))).toBe(changed.indexOf(DOC.slice(AT, AT + 32)));
  });

  it("同样的文字有好几处时，取离原来位置最近的", () => {
    const line = "重复的一行文字，用来测试找回位置时取最近的那一处。";
    const doc = [line, line, line, line].join("\n");
    const pos = line.length + 1 + line.length + 1 + 5; // 第三行第 5 个字
    // 前面加一点文字，原文仍有四处一模一样的
    const changed = "加一行\n" + doc;
    expect(locateAnchor(changed, anchorAt(doc, pos))).toBe(pos + "加一行\n".length);
  });

  it("被大幅修改、找不到时返回 null", () => {
    expect(locateAnchor("完全不同的另一篇正文", anchorAt(DOC, AT))).toBeNull();
  });
});

describe("找回编辑位置（光标、选区、滚动）", () => {
  it("正文没变：光标、选区原样找回，滚动到原来看到的地方", () => {
    const r = restorePosition(DOC, positionAt(DOC, AT, AT + 6));
    expect(r.head).toBe(AT);
    expect(r.anchor).toBe(AT + 6);
    expect(r.scroll).not.toBeNull();
  });

  it("前面插入了文字：选区两端都跟着挪", () => {
    const changed = "开头多了一句话。\n" + DOC;
    const shift = "开头多了一句话。\n".length;
    const r = restorePosition(changed, positionAt(DOC, AT, AT + 6));
    expect([r.anchor, r.head]).toEqual([AT + 6 + shift, AT + shift]);
  });

  it("选区另一端找不到时只放光标", () => {
    // 选区的另一端在第 5 段末尾，第 5 段被整个换掉了
    const end = DOC.length;
    const changed = DOC.slice(0, DOC.indexOf("第五段")) + "最后一段整个重写成了别的内容。";
    const r = restorePosition(changed, positionAt(DOC, AT, end));
    expect(r.head).toBe(AT);
    expect(r.anchor).toBe(AT);
  });

  it("光标找不到时回到开头：光标在最前面，滚到顶", () => {
    const r = restorePosition("完全不同的另一篇正文", positionAt(DOC, AT, AT + 6));
    expect(r).toEqual({ anchor: 0, head: 0, scroll: null });
  });

  it("没有选区时只放光标", () => {
    const r = restorePosition(DOC, positionAt(DOC, AT));
    expect(r.anchor).toBe(r.head);
  });
});
