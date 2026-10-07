// 长文档的大纲
export const title = "大纲";

export default async function (t) {
  const { main: m, check } = t;
  // 编辑区不到 700px 宽时不显示大纲，先把视口设大
  await m.viewport(1200, 800);
  await m.enter("工作");
  await m.ev(`return await openTodo("工作", "需求", "长文档")`);
  await t.sleep(600);

  const outline = () =>
    m.ev(`const o = document.querySelector(".outline"); if (!o) return null;
      return { visible: getComputedStyle(o).display !== "none",
        items: [...o.querySelectorAll(".outline-item")].map((e) => ({ text: e.textContent, level: +e.className.match(/level-(\\d)/)[1], indent: parseInt(e.style.paddingLeft) })),
        active: o.querySelector(".outline-item.active")?.textContent ?? null };`);

  let o = await outline();
  check(
    "有 2 个以上标题时显示大纲，去掉加粗、链接等标记，代码块里的 # 不算",
    o?.visible && o.items.map((i) => i.text).join("|") === "长文档|第一节|第二节 加粗 链接|第三节",
    o,
  );
  check("按级别缩进", o.items[0].indent < o.items[1].indent && o.items[1].indent < o.items[3].indent, o.items);

  await m.ev(`[...document.querySelectorAll(".outline-item")].find((e) => e.textContent === "第二节 加粗 链接").click(); await sleep(500); return 1`);
  const jumped = await m.ev(`const v = view(); const h = v.state.selection.main.head; const line = v.state.doc.lineAt(h);
    return { atEnd: h === line.to, text: line.text, top: Math.round(v.coordsAtPos(line.from).top - v.scrollDOM.getBoundingClientRect().top) }`);
  check("点大纲里的标题跳过去：光标在那一行末尾，标题滚到顶部", jumped.atEnd && jumped.text.startsWith("## 第二节") && jumped.top >= -2 && jumped.top < 60, jumped);
  check("跳过去的那一节高亮", (await outline()).active === "第二节 加粗 链接");

  // 光标不在可见区域里时按可见区域顶部
  await m.ev(`const v = view(); v.dispatch({ selection: { anchor: 0 } }); v.scrollDOM.scrollTop = 0; await sleep(400);
    const d = v.state.doc; let n = 1; while (!d.line(n).text.startsWith("第一节第 20")) n++;
    v.scrollDOM.scrollTop = v.lineBlockAt(d.line(n).from).top; await sleep(400); return 1`);
  check("滚动正文时高亮跟着变", (await outline()).active === "第一节");
  await m.ev(`const v = view(); v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight; await sleep(400); return 1`);
  check("滚到文末时最后一个标题高亮", (await outline()).active === "第三节");

  await m.ev(`const v = view(); v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); return 1`);
  await m.type("\n\n## 新加的标题\n");
  await t.sleep(1500);
  check("打字加了标题，停一下大纲跟着变", (await outline()).items.some((i) => i.text === "新加的标题"));
  await m.press("Ctrl+Z");
  await t.sleep(1500);
  check("删掉后大纲也跟着变", !(await outline()).items.some((i) => i.text === "新加的标题"));

  await m.press("Ctrl+Shift+1");
  await t.sleep(300);
  check("Ctrl+Shift+1 隐藏大纲", (await outline()) === null);
  await m.reload();
  await m.enter("工作");
  await m.ev(`return await openTodo("工作", "需求", "长文档")`);
  await t.sleep(600);
  check("重新打开后还是隐藏的（本机记住）", (await outline()) === null);
  await m.ev(`document.querySelector(".statusbar-outline").click(); await sleep(400); return 1`);
  check("点状态栏的「大纲」显示", (await outline())?.visible);
  await m.ev(`document.querySelector(".editor-title").focus(); return 1`);
  await m.press("Ctrl+Shift+1");
  await t.sleep(300);
  check("焦点在标题上时 Ctrl+Shift+1 也能用", (await outline()) === null);
  await m.press("Ctrl+Shift+1");

  await m.ev(`return await openTodo("工作", "需求", "A")`);
  await t.sleep(500);
  check("只有 1 个标题时不显示大纲", (await outline()) === null);

  await m.ev(`return await openTodo("工作", "需求", "长文档")`);
  await m.viewport(980, 800);
  await t.sleep(400);
  const narrow = await outline();
  check("编辑区不到 700px 宽时不显示", narrow && !narrow.visible, narrow);
  await m.viewport(1200, 800);
  await t.sleep(400);
  check("变宽后又显示", (await outline())?.visible);
  await m.viewport(0);
}
