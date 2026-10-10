// 实时渲染的表格：光标不在表格里时显示成渲染后的表格（表头加粗、按分隔行对齐、单元格里的格式），列表里的显示原文，
// 很宽的在编辑区里横向滚动；单击格子光标放进那一格的原文、表格显示原文，光标移出去又渲染；源码模式只显示原文；
// 正文按原样保存
export const title = "表格";

export default async function (t) {
  const { main: m, check } = t;
  await m.viewport(1200, 900);
  const source = [
    "# 表格",
    "",
    "| 姓名 | 年龄 | 备注 |",
    "| :--- | :---: | ---: |",
    "| **张三** | 18 | `代码` |",
    "| [链接](https://example.com) | ~~删掉~~ |  |",
    "",
    "中间一段",
    "",
    `| ${Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 列`).join(" | ")} |`,
    `|${" --- |".repeat(12)}`,
    // 格子里是没法断开的长串
    `| ${Array.from({ length: 12 }, () => "a".repeat(60)).join(" | ")} |`,
    "",
    "- 列表里的",
    "",
    "  | a | b |",
    "  |---|---|",
    "  | 1 | 2 |",
    "",
  ].join("\n");
  t.write("工作/日常/表格.md", source);
  await m.enter("工作");
  await m.expandAll();
  await m.ev(`return await openTodo("工作", "日常", "表格")`);

  const blur = () => m.ev(`view().contentDOM.blur(); await sleep(300); return 1`);
  const tables = () => m.ev(`return document.querySelectorAll(".cm-md-table").length`);
  const doc = () => m.ev(`return view().state.doc.toString()`);

  await blur();
  check("光标不在表格里时显示成渲染后的表格；列表里的显示原文", (await tables()) === 2, await tables());
  const first = await m.ev(`const t = document.querySelector(".cm-md-table");
    const th = t.querySelector("th"); const row = t.querySelectorAll("tbody tr")[0].querySelectorAll("td");
    return {
      head: [...t.querySelectorAll("th")].map((e) => e.textContent),
      weight: Number(getComputedStyle(th).fontWeight),
      align: [...row].map((e) => getComputedStyle(e).textAlign),
      strong: row[0].querySelector("strong")?.textContent, code: row[2].querySelector("code")?.textContent,
      link: t.querySelector("a")?.textContent, del: t.querySelector("del")?.textContent,
    }`);
  check("表头加粗", first.head.join(",") === "姓名,年龄,备注" && first.weight >= 600, first);
  check("各列按分隔行左对齐、居中、右对齐", first.align.join(",") === "left,center,right", first);
  check(
    "单元格里的加粗、行内代码、链接、删除线也渲染",
    first.strong === "张三" && first.code === "代码" && first.link === "链接" && first.del === "删掉",
    first,
  );
  const wide = await m.ev(`const w = document.querySelectorAll(".cm-md-table-wrap")[1];
    return { scroll: w.scrollWidth, client: w.clientWidth, right: w.getBoundingClientRect().right,
      editor: view().contentDOM.getBoundingClientRect().right }`);
  check("很宽的表格在编辑区里横向滚动，不撑破编辑区", wide.scroll > wide.client && wide.right <= wide.editor + 1, wide);

  // 单击「张三」那一格：光标放进那一格原文的末尾，表格显示原文
  const cell = await m.at(".cm-md-table tbody td");
  await m.click(cell);
  await t.sleep(300);
  const after = await m.ev(`const v = view(); const head = v.state.selection.main.head;
    return { before: v.state.sliceDoc(head - 8, head), tables: document.querySelectorAll(".cm-md-table").length }`);
  check("单击格子：光标放进那一格原文的末尾，这个表格显示原文，别的照样渲染", after.before === "| **张三**" && after.tables === 1, after);
  await m.ev(`const v = view(); v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf("中间一段") } }); await sleep(300); return 1`);
  check("光标移出表格又显示成渲染后的表格", (await tables()) === 2);

  await m.press("Ctrl+/");
  await blur();
  check("源码模式只显示原文", (await tables()) === 0);
  await m.press("Ctrl+/");
  await m.press("Ctrl+S");
  await t.sleep(500);
  check("只改变显示，正文按原样保存", (await doc()) === source && t.read("工作/日常/表格.md") === source);

  // Ctrl+T 插入表格：光标所在的行是空行时放在这一行（上一行有字，空一行），光标在表头的第一格，接着打字就在那一格里；可以撤销
  await m.ev(`const v = view(); v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); await sleep(200); return 1`);
  await m.press("Ctrl+T");
  await m.type("新表头");
  await t.sleep(300);
  const empty = "| 新表头 |  |  |\n| --- | --- | --- |\n|  |  |  |";
  check(
    "Ctrl+T 在空行上插入 3 列、表头加一行内容的空表格，光标在表头的第一格",
    (await doc()) === `${source}\n${empty}`,
    (await doc()).slice(source.length),
  );
  await m.ev(`const v = view(); v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf("中间一段") } }); await sleep(300); return 1`);
  check("插入的表格也显示成渲染后的表格", (await tables()) === 3);
  await m.ev(`view().focus(); return 1`);
  await m.press("Ctrl+Z");
  await m.press("Ctrl+Z");
  check("插入表格可以撤销", (await doc()) === source, (await doc()).slice(source.length));
}
