// 实时渲染的 ==高亮==：光标不在时藏起两头的 ==、中间的字带底色（标题、正文、列表、表格里都是），a == b、只有一边的照原样；
// 光标碰到时显示出 ==；落在高亮里的查找结果画在高亮上面、颜色分得开；源码模式显示 ==、照样带底色；正文按原样保存
export const title = "高亮";

export default async function (t) {
  const { main: m, check } = t;
  await m.viewport(1200, 900);
  const source = [
    "# 本周==重点==",
    "",
    "这是==（重点）==，a == b 不算，if a==b 也不算。",
    "",
    "- ==列表里的==",
    "",
    "| 名称 |",
    "| --- |",
    "| ==格子里的== |",
    "",
    "最后一行",
  ].join("\n");
  t.write("工作/日常/高亮.md", source);
  await m.enter("工作");
  await m.expandAll();
  await m.ev(`return await openTodo("工作", "日常", "高亮")`);

  const blur = () => m.ev(`view().contentDOM.blur(); await sleep(300); return 1`);
  const marks = () => m.ev(`return [...document.querySelectorAll(".cm-content .cm-md-mark")].map((e) => e.textContent)`);
  // 第 n 行显示出来的字（表格前面的几行：表格整个换成一块，不是 .cm-line）
  const line = (n) => m.ev(`return document.querySelectorAll(".cm-content .cm-line")[${n - 1}]?.textContent`);
  const transparent = (c) => !c || c === "transparent" || /^rgba\(.*,\s*0\)$/.test(c);

  await blur();
  const shown = await marks();
  check(
    "光标不在时中间的字高亮：标题、正文、列表、表格里都是",
    JSON.stringify(shown) === JSON.stringify(["重点", "（重点）", "列表里的", "格子里的"]),
    shown,
  );
  const text = await line(3);
  check("两头的 == 藏起来，a == b、只有一边的照原样显示", text === "这是（重点），a == b 不算，if a==b 也不算。", text);
  const style = await m.ev(`const e = document.querySelector(".cm-content .cm-md-mark"); const s = getComputedStyle(e);
    const line = getComputedStyle(e.closest(".cm-line")); return { bg: s.backgroundColor, color: s.color, lineColor: line.color }`);
  check("高亮有底色，文字颜色同正文", !transparent(style.bg) && style.color === style.lineColor, style);
  const cell = await m.ev(`const e = document.querySelector(".cm-md-table td mark");
    return e && { text: e.textContent, bg: getComputedStyle(e).backgroundColor }`);
  check("表格的格子里也渲染成高亮，底色同正文里的", cell?.text === "格子里的" && cell.bg === style.bg, cell);

  // 光标放进正文那一处高亮里：显示出两头的 ==，底色还在。光标先放在高亮的开头，再真的按一下 → 进去：
  // 只用脚本放光标时，WebView2 里页面还没收到过输入、没有焦点（document.hasFocus() 是 false），编辑器当成没有焦点、全部渲染
  await m.ev(`const v = view(); v.focus(); v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf("（重点）") } }); return 1`);
  await m.press("ArrowRight");
  await t.sleep(300);
  const raw = await line(3);
  check("光标碰到时显示出两头的 ==", raw === "这是==（重点）==，a == b 不算，if a==b 也不算。", {
    raw,
    focus: await m.ev(`const v = view(); return { editor: v.hasFocus, page: document.hasFocus(),
      at: v.state.selection.main.head - v.state.doc.toString().indexOf("（重点）") }`),
  });
  check("显示原文时中间的字照样高亮", (await marks()).includes("（重点）"), await marks());

  // 查找「重点」：两处都在高亮里，查找结果画在高亮上面（在高亮的里层），没选中的那个颜色也和高亮不同
  await m.press("Ctrl+F");
  await m.type("重点");
  await t.sleep(300);
  const found = await m.ev(`return [...document.querySelectorAll(".cm-content .cm-searchMatch")].map((e) => ({
    inMark: !!e.closest(".cm-md-mark"), selected: e.classList.contains("cm-searchMatch-selected"), bg: getComputedStyle(e).backgroundColor }))`);
  check(
    "落在高亮里的查找结果画在高亮上面，颜色和高亮分得开",
    found.length === 2 && found.every((f) => f.inMark && !transparent(f.bg) && f.bg !== style.bg),
    { found, mark: style.bg },
  );
  await m.press("Escape");

  // 源码模式：显示 ==，中间的字照样高亮
  await m.press("Ctrl+/");
  await blur();
  const source1 = await line(1);
  check("源码模式显示两头的 ==，中间的字照样高亮", source1 === "# 本周==重点==" && (await marks()).includes("重点"), {
    line: source1,
    marks: await marks(),
  });
  await m.press("Ctrl+/");
  await m.ev(`view().focus(); return 1`);
  await m.press("Ctrl+S");
  await t.sleep(500);
  check("只改变显示，正文按原样保存", t.read("工作/日常/高亮.md") === source);
}
