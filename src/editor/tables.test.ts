import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { markdownSupport } from "./setup";
import { type Inline, renderedTables, type TableBlock, type TableCell, tableBlocks } from "./tables";

// 按 docs/requirements.md「待办内容 → 表格」写的用例：渲染后的表格里有什么（表头、对齐、单元格里的格式、格子数），
// 点格子时光标放在哪里，哪些表格渲染、光标（选区）在表格里时显示原文

/** 单元格里的文字（格式去掉，看结构用 content） */
const plain = (items: readonly Inline[]): string =>
  items
    .map((i) => {
      if (i.kind === "text" || i.kind === "code") return i.text;
      if (i.kind === "br") return "\n";
      if (i.kind === "image") return `[图:${i.src}]`;
      return plain(i.children);
    })
    .join("");
const texts = (cells: readonly TableCell[]) => cells.map((c) => plain(c.content));

/** 和编辑器一样的 Markdown 解析（testState 的 makeState 把 | 当成光标的记号，表格里用不了） */
function tablesOf(doc: string) {
  const state = EditorState.create({ doc, extensions: markdownSupport() });
  return { state, tables: tableBlocks(state) };
}

describe("渲染后的表格", () => {
  const doc = [
    "前面一段",
    "",
    "| 姓名 | 年龄 | 备注 |",
    "| :--- | :---: | ---: |",
    "| **张三** | *18* | `代码` |",
    "| [链接](https://a.com) | ~~删掉~~ | a\\|b<br>c &amp; ![图](.assets/x/a.png) |",
    "",
    "后面一段",
  ].join("\n");

  it("表头、各列按分隔行对齐", () => {
    const [t] = tablesOf(doc).tables;
    expect(texts(t.model.header)).toEqual(["姓名", "年龄", "备注"]);
    expect(t.model.align).toEqual(["left", "center", "right"]);
    expect(t.model.rows.map(texts)).toEqual([
      ["张三", "18", "代码"],
      ["链接", "删掉", "a|b\nc & [图:.assets/x/a.png]"],
    ]);
  });

  it("单元格里的加粗、斜体、行内代码、链接、删除线、图片、<br> 也渲染，\\| 是 |", () => {
    const [t] = tablesOf(doc).tables;
    const [r1, r2] = t.model.rows;
    expect(r1[0].content).toEqual([{ kind: "strong", children: [{ kind: "text", text: "张三" }] }]);
    expect(r1[1].content).toEqual([{ kind: "em", children: [{ kind: "text", text: "18" }] }]);
    expect(r1[2].content).toEqual([{ kind: "code", text: "代码" }]);
    expect(r2[0].content).toEqual([{ kind: "link", url: "https://a.com", children: [{ kind: "text", text: "链接" }] }]);
    expect(r2[1].content).toEqual([{ kind: "del", children: [{ kind: "text", text: "删掉" }] }]);
    expect(r2[2].content).toEqual([
      { kind: "text", text: "a|b" },
      { kind: "br" },
      { kind: "text", text: "c & " },
      { kind: "image", src: ".assets/x/a.png", alt: "图" },
    ]);
  });

  it("从第一行的行首到最后一行的行尾整个换掉", () => {
    const { state, tables } = tablesOf(doc);
    const [t] = tables;
    expect(state.sliceDoc(t.from, t.to)).toBe(doc.split("\n").slice(2, 6).join("\n"));
  });

  it("内容行的格子比表头少时空着，多出来的不显示；行首、行尾的 | 可有可无", () => {
    const [a] = tablesOf("| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |").tables;
    expect(a.model.rows.map(texts)).toEqual([
      ["1", "", ""],
      ["1", "2", "3"],
    ]);
    const [b] = tablesOf("a | b\n--|--\n1 | 2\n | x").tables;
    expect(texts(b.model.header)).toEqual(["a", "b"]);
    expect(b.model.rows.map(texts)).toEqual([
      ["1", "2"],
      // 行首的 | 前面是空白：不算一格（同 GFM）
      ["x", ""],
    ]);
    expect(b.model.align).toEqual([null, null]);
  });
});

describe("单击格子时光标放在哪里", () => {
  it("格子里文字的末尾；空的格子在两个 | 中间；行里少了的格子在行尾", () => {
    const doc = "| 姓名 |  | 备注 |\n|---|---|---|\n| 张三 |";
    const { state, tables } = tablesOf(doc);
    const [t] = tables;
    const at = (c: TableCell) => t.from + c.cursor;
    const [name, empty, note] = t.model.header;
    expect(state.sliceDoc(at(name) - 2, at(name))).toBe("姓名");
    expect(state.sliceDoc(at(empty) - 2, at(empty) + 2)).toBe("|  |");
    expect(state.sliceDoc(at(note) - 2, at(note))).toBe("备注");
    const [zhang, missing] = t.model.rows[0];
    expect(state.sliceDoc(at(zhang) - 2, at(zhang))).toBe("张三");
    expect(at(missing)).toBe(doc.length);
  });
});

describe("哪些表格渲染", () => {
  const doc = ["| a | b |", "|---|---|", "| 1 | 2 |", "", "正文", "", "| c | d |", "|---|---|", "| 3 | 4 |"].join("\n");
  const shown = (tables: TableBlock[], sel: EditorSelection | null) =>
    renderedTables(tables, sel ? sel.ranges : null).map((t) => texts(t.model.header)[0]);

  it("光标（选区）在表格里时这个表格显示原文，别的照样渲染", () => {
    const { tables } = tablesOf(doc);
    expect(shown(tables, EditorSelection.create([EditorSelection.cursor(doc.indexOf("正文"))]))).toEqual(["a", "c"]);
    expect(shown(tables, EditorSelection.create([EditorSelection.cursor(doc.indexOf("2"))]))).toEqual(["c"]);
    // 碰到表格的行尾也算在表格里；下一行不算
    const end = doc.indexOf("| 1 | 2 |") + "| 1 | 2 |".length;
    expect(shown(tables, EditorSelection.create([EditorSelection.cursor(end)]))).toEqual(["c"]);
    expect(shown(tables, EditorSelection.create([EditorSelection.cursor(end + 1)]))).toEqual(["a", "c"]);
    // 选区从正文选到第二个表格里
    expect(shown(tables, EditorSelection.create([EditorSelection.range(doc.indexOf("正文"), doc.indexOf("3"))]))).toEqual(["a"]);
  });

  it("编辑器没有焦点时全部渲染", () => {
    const { tables } = tablesOf(doc);
    expect(shown(tables, null)).toEqual(["a", "c"]);
  });

  it("列表、引用里的表格不渲染（显示原文）", () => {
    const nested = ["- 列表项", "", "  | a | b |", "  |---|---|", "  | 1 | 2 |", "", "> | c | d |", "> |---|---|", "> | 3 | 4 |"].join("\n");
    expect(tablesOf(nested).tables).toEqual([]);
  });
});
