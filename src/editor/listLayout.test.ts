import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import {
  INDENT,
  type ListLine,
  listLine,
  listLineStyle,
  type MarkerPart,
  markerParts,
  quoteGroups,
  sourcePrefix,
  TASK,
} from "./listLayout";
import { makeState } from "./testState";

// docs/requirements.md「待办内容 → 实时渲染里的列表」：每一级缩进约两个字宽，列表符号、序号、任务框放在正文左边那一格里；
// 一项折行后，折下来的行和第一行的正文开头对齐；缩进到正文的续行、列表项里的第二段和代码块也对齐到正文；
// 两位数的序号和一位数的一样对齐，三位数以上的整个列表一起加宽；引用里的列表照样缩进。只改显示，行首的空格藏起来但不改文本

const lines = (doc: string) => {
  const state = makeState(doc);
  const tree = ensureSyntaxTree(state, state.doc.length, 1000)!;
  return { state, ls: Array.from({ length: state.doc.lines }, (_, i) => listLine(state, state.doc.line(i + 1), tree)) };
};
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * 每一行排在哪里（em，从正文那一栏的左边算；引用里的不算引用竖线和它右边的空当）：符 列表符号那一格从哪里开始，
 * 文 文字从哪里开始（第一行折下来的行也从这里开始）；藏起来的空白写成 ␣，后面是还显示着的文字；不在列表里的行是 null
 */
function layout(doc: string) {
  const { state, ls } = lines(doc);
  return ls.map((l, i) => {
    if (!l) return null;
    const line = state.doc.line(i + 1);
    const x = l.margin + l.inner;
    const parts = l.markers.length ? [`符${round(x)}`, `文${round(x + l.hang)}`] : [`文${round(x + l.extra)}`];
    const hidden = l.hidden.map((h) => state.sliceDoc(h.from, h.to).replace(/ /g, "␣")).join("|");
    if (hidden) parts.push(hidden);
    parts.push(state.sliceDoc(l.markers.length ? l.textFrom : (l.hidden[l.hidden.length - 1]?.to ?? line.from), line.to));
    return parts.join(" ");
  });
}

const markers = (doc: string, n = 1) => {
  const { state, ls } = lines(doc);
  return ls[n - 1]!.markers.map((m) => ({
    ...m,
    mark: state.sliceDoc(m.from, m.to),
    content: state.sliceDoc(m.contentFrom, state.doc.line(n).to),
  }));
};

describe("每一级缩进的位置", () => {
  it("嵌套几级就缩进几级（每级约两个字），列表符号在正文左边那一格", () => {
    expect(INDENT).toBe(2);
    expect(layout("- 甲\n  - 乙\n    - 丙\n      - 丁")).toEqual([
      "符0 文2 甲",
      "符2 文4 ␣␣ 乙",
      "符4 文6 ␣␣␣␣ 丙",
      "符6 文8 ␣␣␣␣␣␣ 丁",
    ]);
  });

  it("按几级算，不按空格数：有序列表的子项缩进 3 格、子项多缩进了几格也是下一级", () => {
    expect(layout("1. 甲\n   - 乙\n10. 丙\n    - 丁\n- 戊\n   - 己")).toEqual([
      "符0 文2 甲",
      "符2 文4 ␣␣␣ 乙",
      "符0 文2 丙",
      "符2 文4 ␣␣␣␣ 丁",
      "符0 文2 戊",
      "符2 文4 ␣␣␣ 己",
    ]);
  });

  it("两位数的序号和一位数的一样：正文对齐，序号占同一格", () => {
    const doc = Array.from({ length: 11 }, (_, i) => `${i + 1}. 第${i + 1}项`).join("\n");
    expect(new Set(layout(doc).map((l) => l!.replace(/ 第\d+项$/, "")))).toEqual(new Set(["符0 文2"]));
    expect(markers(doc, 10)[0]).toMatchObject({ mark: "10.", ordered: true, content: "第10项", slot: 2 });
  });

  it("有三位数以上的序号时，那一格整个列表一起加宽：同一列表的正文仍对齐，子项跟着往右", () => {
    const all = layout("98. 甲\n99. 乙\n100. 丙\n     - 子项\n\n- 别的列表");
    const x = Number(all[0]!.split(" ")[1].slice(1));
    expect(x).toBeGreaterThan(2);
    expect(all.slice(0, 3).map((l) => l!.split(" ").slice(0, 2).join(" "))).toEqual([`符0 文${x}`, `符0 文${x}`, `符0 文${x}`]);
    expect(all[3]).toBe(`符${x} 文${round(x + 2)} ␣␣␣␣␣ 子项`);
    expect(all[5]).toBe("符0 文2 别的列表");
  });

  it("同一行里套着子项（- - 甲）：两个符号各占一格，子项的续行对齐到同一个地方", () => {
    expect(layout("- - 甲\n    乙")).toEqual(["符0 文4 甲", "文4 ␣␣␣␣ 乙"]);
    expect(markers("- - 甲").map((m) => m.mark)).toEqual(["-", "-"]);
  });

  it("不在列表里的行不管", () => {
    expect(layout("段落\n\n- 甲\n\n后面的段落\n    缩进的代码")).toEqual([null, null, "符0 文2 甲", null, null, null]);
  });
});

describe("列表符号和正文的开头", () => {
  it("无序、有序列表：符号后面的空格之后是正文", () => {
    expect(markers("- 甲")[0]).toMatchObject({ mark: "-", ordered: false, task: null, content: "甲", bulletLevel: 0 });
    expect(markers("1)  甲")[0]).toMatchObject({ mark: "1)", ordered: true, content: "甲" });
    expect(markers("* 甲\n  + 乙", 2)[0]).toMatchObject({ mark: "+", bulletLevel: 1 });
  });

  it("任务列表：正文从任务框后面开始", () => {
    expect(markers("- [ ] 没做完")[0]).toMatchObject({ task: { checked: false }, content: "没做完" });
    expect(markers("- [x] 做完了")[0]).toMatchObject({ task: { checked: true }, content: "做完了" });
  });

  it("空的列表项", () => {
    expect(markers("- ")[0]).toMatchObject({ mark: "-", content: "" });
    expect(markers("-")[0]).toMatchObject({ mark: "-", content: "" });
  });
});

describe("续行、第二段和代码块对齐到正文", () => {
  it("缩进到正文的续行属于这一项（多缩进的空格也藏起来）", () => {
    expect(layout("- 甲\n  - 乙\n    乙的续行\n      多缩进了两格\n  甲的第二段")).toEqual([
      "符0 文2 甲",
      "符2 文4 ␣␣ 乙",
      "文4 ␣␣␣␣ 乙的续行",
      "文4 ␣␣␣␣␣␣ 多缩进了两格",
      "文2 ␣␣ 甲的第二段",
    ]);
  });

  it("懒续行（没缩进的接着写）照它自己的缩进放：一点没缩进的不动，缩进到上一级正文的对齐到上一级", () => {
    expect(layout("- 甲\n  - 乙\n没缩进\n  缩进到甲")).toEqual(["符0 文2 甲", "符2 文4 ␣␣ 乙", null, "文2 ␣␣ 缩进到甲"]);
  });

  it("列表项里的代码块只藏列表的缩进，代码自己的缩进照原样；代码块里的空行也对齐", () => {
    expect(layout("- 甲\n\n  ```\n  if (x)\n\n      y();\n  ```")).toEqual([
      "符0 文2 甲",
      "文2 ",
      "文2 ␣␣ ```",
      "文2 ␣␣ if (x)",
      "文2 ",
      "文2 ␣␣     y();",
      "文2 ␣␣ ```",
    ]);
  });

  it("代码行用制表符缩进时，制表符跨过列表那一列就不藏（留给代码自己的缩进）", () => {
    expect(layout("- 甲\n\n  ```\n\tcode\n  ```")[3]).toBe("文2 \tcode");
  });

  it("有序列表里的任务：正文从任务框后面开始，这一项的续行、第二段也对齐到那里；子项按级数缩进", () => {
    expect(layout("1. [ ] 甲\n   甲的续行\n\n   甲的第二段\n   - 子项\n2. 乙")).toEqual([
      `符0 文${2 + TASK} 甲`,
      `文${2 + TASK} ␣␣␣ 甲的续行`,
      `文${2 + TASK} `,
      `文${2 + TASK} ␣␣␣ 甲的第二段`,
      "符2 文4 ␣␣␣ 子项",
      "符0 文2 乙",
    ]);
  });

  it("无序列表的任务框占列表符号那一格，不多占", () => {
    expect(layout("- [ ] 甲\n  甲的续行")).toEqual(["符0 文2 甲", "文2 ␣␣ 甲的续行"]);
  });
});

describe("引用和列表", () => {
  const margins = (doc: string) => lines(doc).ls.map((l) => l && round(l.margin));

  it("引用里的列表：缩进在引用竖线右边（竖线不动）；> 后面那个空格归引用，不在要藏的缩进里", () => {
    const doc = "> - 甲\n>   - 乙\n>     乙的续行";
    expect(layout(doc)).toEqual(["符0 文2 甲", "符2 文4 ␣␣ 乙", "文4 ␣␣␣␣ 乙的续行"]);
    expect(margins(doc)).toEqual([0, 0, 0]);
  });

  it("列表项里的引用：引用竖线跟着缩进到正文", () => {
    const doc = "- 甲\n  > 引用\n  >\n  > 引用第二段";
    expect(layout(doc)).toEqual(["符0 文2 甲", "文2 ␣␣ > 引用", "文2 ␣␣ >", "文2 ␣␣ > 引用第二段"]);
    expect(margins(doc)).toEqual([0, 2, 2, 2]);
  });

  it("内容从引用开始的列表项（- > 引用）：第一行的 > 放在列表符号那一格后面，正文从 > 后面开始", () => {
    const { state, ls } = lines("- > 引用\n  > 第二行");
    const q = ls[0]!.quoteMark;
    expect(q && state.sliceDoc(q.from, q.to)).toBe("> ");
    expect(state.sliceDoc(ls[0]!.textFrom, state.doc.line(1).to)).toBe("引用");
    expect(ls[1]!.quoteMark).toBe(null);
  });
});

describe("行首的 > 显示原文时放在哪里", () => {
  // docs/requirements.md「实时渲染里的引用」：光标进出引用的那一行、显示出 > 时，> 放在引用竖线和文字之间的空当里，文字不动；
  // 套着的引用（>> 或 > >）空当按层数加宽；列表项里的引用（在列表缩进后面的 >）挂在左边列表缩进的空白里
  const groups = (doc: string, n = 1) => {
    const state = makeState(doc);
    const tree = ensureSyntaxTree(state, state.doc.length, 1000)!;
    const line = state.doc.line(n);
    const hidden = listLine(state, line, tree)?.hidden ?? [];
    return quoteGroups(state, line, tree, hidden).map((g) => `${g.kind} ${g.count} ${JSON.stringify(state.sliceDoc(g.from, g.to))}`);
  };

  it("行首连着的几个 > 放在一起（>> 和 > > 都算），按个数加宽", () => {
    expect(groups("> 甲")).toEqual(['gutter 1 "> "']);
    expect(groups(">> 甲")).toEqual(['gutter 2 ">> "']);
    expect(groups("> > 甲")).toEqual(['gutter 2 "> > "']);
    expect(groups(">\n> 甲", 2)).toEqual(['gutter 1 "> "']);
  });

  it("列表项里的引用：缩进后面的 > 单独一组，挂在列表缩进的空白里；只有它的照样放在引用竖线旁边", () => {
    expect(groups("> - 甲\n>   > 乙", 2)).toEqual(['gutter 1 "> "', 'inner 1 "> "']);
    expect(groups("- 甲\n  > 乙", 2)).toEqual(['gutter 1 "> "']);
  });

  it("不在行首的 > 不管（内容从引用开始的列表项另外放）", () => {
    expect(groups("- > 甲")).toEqual([]);
    expect(groups("甲 > 乙")).toEqual([]);
  });
});

describe("源码模式折行后对齐到哪里", () => {
  // 源码模式：缩进照原样的空格，一项折行时折下来的行对齐到第一行的正文开头（列表符号、任务框后面），续行对齐到它自己的文字开头；
  // 代码块里的行用等宽字体排，按等宽字体量
  const prefixes = (doc: string) => {
    const state = makeState(doc);
    const tree = ensureSyntaxTree(state, state.doc.length, 1000)!;
    return Array.from({ length: state.doc.lines }, (_, i) => {
      const p = sourcePrefix(state, state.doc.line(i + 1), tree);
      return p && `${JSON.stringify(p.text)}${p.code ? " 代码" : ""}`;
    });
  };

  it("第一行对齐到列表符号、任务框后面，续行、引用里的行对齐到行首的空白和 > 后面", () => {
    expect(prefixes("- [ ] 甲\n  续行\n> 1. 乙\n>    乙的续行\n- > 引用")).toEqual([
      '"- [ ] "',
      '"  "',
      '"> 1. "',
      '">    "',
      '"- > "',
    ]);
  });

  it("代码块里的行（连同 ``` 那两行）按等宽字体量，对齐到代码文字开头", () => {
    expect(prefixes("- 甲\n\n  ```\n      y();\n  ```")).toEqual(['"- "', null, '"  " 代码', '"      " 代码', '"  " 代码']);
  });

  it("不在列表里的行、空行、只有列表符号的行不管", () => {
    expect(prefixes("段落\n\n- \n  缩进的段落")).toEqual([null, null, null, '"  "']);
  });
});

describe("悬挂缩进的样式（把 CSS 变量算出来看位置）", () => {
  // 正文字号当 1，引用竖线 0.2、竖线右边的空当 0.8
  const VARS: Record<string, number> = { "--fs-editor": 1, "--md-quote-bar": 0.2, "--md-quote-gap": 0.8 };
  const evalCss = (css: string) =>
    Function(`return ${css.replace(/calc\(/g, "(").replace(/var\((--[\w-]+)\)/g, (_, v) => String(VARS[v])).replace(/px/g, "*0")}`)() as number;
  /** 一行在页面上的位置：符号那一格、第一行的正文、折下来的行、引用竖线（行在引用里时） */
  const geometry = (l: ListLine, quoted: boolean) => {
    const vars = Object.fromEntries(listLineStyle(l).split("; ").map((d) => d.split(": ")));
    const margin = evalCss(vars["--md-li-margin"]);
    const pad = evalCss(vars["--md-li-pad"]);
    const hang = evalCss(vars["--md-li-hang"]);
    const qfirst = !!l.quoteMark;
    const bar = VARS["--md-quote-bar"];
    const gap = VARS["--md-quote-gap"];
    // .cm-md-quote：竖线（这一行内容从引用开始时不画在行首）+ 空当 + 列表的缩进
    const padding = quoted ? (qfirst ? 0 : bar) + gap + pad : pad;
    const rowStart = margin + padding - hang;
    const first = l.markers.length ? rowStart + l.hang + (qfirst ? bar + gap : 0) : rowStart;
    const barX = qfirst ? margin + evalCss(vars["--md-li-qbar"]) : quoted ? margin : null;
    return { marker: round(rowStart), first: round(first), wrap: round(margin + padding), bar: barX === null ? null : round(barX) };
  };
  const geometries = (doc: string, quoted: boolean[]) => lines(doc).ls.map((l, i) => geometry(l!, quoted[i]));

  it("第一行的正文和折下来的行对齐，列表符号那一格在正文左边", () => {
    expect(geometries("- 甲\n  - 乙\n    续行\n1. [ ] 任务", [false, false, false, false])).toEqual([
      { marker: 0, first: 2, wrap: 2, bar: null },
      { marker: 2, first: 4, wrap: 4, bar: null },
      { marker: 4, first: 4, wrap: 4, bar: null },
      { marker: 0, first: 2 + TASK, wrap: 2 + TASK, bar: null },
    ]);
  });

  it("引用里的列表：竖线在最左边，列表的缩进在竖线和空当右边", () => {
    const g = geometries("> - 甲\n>   - 乙", [true, true]);
    expect(g.map((x) => x.bar)).toEqual([0, 0]);
    expect(round(g[1].first - g[0].first)).toBe(2);
    expect(g.every((x) => x.first === x.wrap)).toBe(true);
  });

  it("- > 引用：第一行的竖线画在列表符号那一格后面，和下一行的竖线接上；两行的文字对齐", () => {
    const g = geometries("- > 引用\n  > 第二行", [true, true]);
    expect(g[0].bar).toBe(2);
    expect(g[1].bar).toBe(2);
    expect(g[0].first).toBe(g[1].first);
    expect(g[0].wrap).toBe(g[1].first);
  });
});

describe("列表符号什么时候显示原文", () => {
  // 光标碰到列表符号时显示原文；有序列表的序号、任务框各管各的；序号不碰到时也换成一块（看上去和原文一样）
  const parts = (doc: string, cursor: number | null) => {
    const { state, ls } = lines(doc);
    const touches = (from: number, to: number) => cursor !== null && cursor >= from && cursor <= to;
    return markerParts(ls[0]!.markers[0], touches).map((p: MarkerPart) => `${p.kind}:${state.sliceDoc(p.from, p.to)}`);
  };

  it("无序列表：光标碰到符号时显示原文，在正文开头时显示符号", () => {
    expect(parts("- 甲", null)).toEqual(["bullet:- "]);
    expect(parts("- 甲", 0)).toEqual(["raw:- "]);
    expect(parts("- 甲", 1)).toEqual(["raw:- "]);
    expect(parts("- 甲", 2)).toEqual(["bullet:- "]);
  });

  it("有序列表：光标碰到序号时显示原文，不碰到时也是一块（正文开头打字不会跑进序号那一格）", () => {
    expect(parts("10. 甲", null)).toEqual(["number:10. "]);
    expect(parts("10. 甲", 3)).toEqual(["raw:10. "]);
    expect(parts("10. 甲", 4)).toEqual(["number:10. "]);
  });

  it("无序任务：碰到符号到任务框时整个显示原文，否则是复选框；做完的划掉", () => {
    expect(parts("- [x] 甲", null)).toEqual(["hide:- ", "box:[x] ", "done:甲"]);
    expect(parts("- [x] 甲", 3)).toEqual(["raw:- [x] "]);
  });

  it("有序任务：序号和任务框各自碰到时才显示原文", () => {
    expect(parts("1. [ ] 甲", null)).toEqual(["number:1. ", "box:[ ] "]);
    expect(parts("1. [ ] 甲", 0)).toEqual(["raw:1. ", "box:[ ] "]);
    expect(parts("1. [ ] 甲", 4)).toEqual(["number:1. ", "rawBox:[ ] "]);
  });
});
