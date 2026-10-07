// 正文里查找 / 替换（Ctrl+F / Ctrl+H）
export const title = "正文里查找 / 替换";

export default async function (t) {
  const { main: m, check } = t;
  await m.enter("工作");
  await m.ev(`return await openTodo("工作", "需求", "长文档")`);

  const panel = () =>
    m.ev(`const p = document.querySelector(".cm-find"); if (!p) return null;
      const [search, replace] = p.querySelectorAll("input"); const v = view(); const s = v.state.selection.main;
      return { search: search.value, replace: replace.value, count: p.querySelector(".cm-find-count").textContent,
        replaceShown: !p.querySelector(".cm-find-replace").hidden,
        focus: document.activeElement === search ? "search" : document.activeElement === replace ? "replace" : v.hasFocus ? "editor" : "other",
        sel: v.state.sliceDoc(s.from, s.to), opts: [...p.querySelectorAll(".cm-find-opt")].map((b) => (b.classList.contains("active") ? 1 : 0)).join("") };`);
  const cursorAt = (code) => m.ev(`const v = view(); v.focus(); ${code}; return 1`);
  const fillSearch = async (text) => {
    await m.ev(`const i = document.querySelector(".cm-find input"); i.focus(); i.select(); return 1`);
    await m.type(text);
    await t.sleep(150);
  };
  const toggleOpt = (i) => m.ev(`document.querySelectorAll(".cm-find-opt")[${i}].click(); await sleep(100); return 1`);

  await cursorAt(`v.dispatch({ selection: { anchor: 0 } })`);
  await m.press("Ctrl+F");
  let p = await panel();
  check("Ctrl+F 打开查找框，焦点在查找框", p?.focus === "search", p);
  await m.type("apple");
  await t.sleep(200);
  p = await panel();
  check("输入时跳到光标后面最近的结果，显示第几个 / 共几个", p.sel === "apple" && p.count === "1/120", p);
  await m.press("Enter");
  check("Enter 找下一个", (await panel()).count === "2/120");
  await m.press("Shift+Enter");
  check("Shift+Enter 找上一个", (await panel()).count === "1/120");
  await m.press("F3");
  await m.press("F3");
  check("F3 找下一个", (await panel()).count === "3/120");
  await m.press("Shift+F3");
  check("Shift+F3 找上一个", (await panel()).count === "2/120");
  await m.ev(`const v = view(); const i = v.state.doc.toString().lastIndexOf("APPLE"); v.dispatch({ selection: { anchor: i, head: i + 5 } }); return 1`);
  await m.press("Enter");
  check("到末尾后从头找", (await panel()).count === "1/120");

  await toggleOpt(0);
  p = await panel();
  check("区分大小写", p.count === "1/40" && p.opts === "100", p);
  await toggleOpt(0);
  await toggleOpt(2);
  await fillSearch("ban+ana [");
  check("正则写错时显示「正则有误」", (await panel()).count === "正则有误");
  await fillSearch("b[a-z]{2}ana");
  check("正则表达式", /\/40$/.test((await panel()).count));
  await toggleOpt(2);
  await fillSearch("APPLE");
  await toggleOpt(1);
  p = await panel();
  check("全字匹配", p.opts === "010" && /120/.test(p.count), p);
  await toggleOpt(1);

  // 输入法组合中不查，上屏后才查
  await cursorAt(`v.dispatch({ selection: { anchor: 0 } })`);
  await m.ev(`const i = document.querySelector(".cm-find input"); i.focus(); i.select(); return 1`);
  await m.press("Backspace");
  await m.send("Input.imeSetComposition", { text: "di", selectionStart: 2, selectionEnd: 2 });
  await t.sleep(150);
  const during = await panel();
  await m.send("Input.insertText", { text: "第三节" });
  await t.sleep(200);
  p = await panel();
  check("输入法组合中不查，上屏后才查", during.sel === "" && p.sel === "第三节", { during, p });

  // 替换
  await m.press("Ctrl+H");
  p = await panel();
  check("Ctrl+H 展开替换，焦点在「替换为」", p.replaceShown && p.focus === "replace", p);
  await fillSearch("banana");
  await m.ev(`const i = document.querySelectorAll(".cm-find input")[1]; i.focus(); i.select(); return 1`);
  await m.type("香蕉");
  await m.press("Enter");
  let doc = await m.ev(`return view().state.doc.toString()`);
  check("「替换为」里按 Enter 替换当前这个", (doc.match(/香蕉/g) ?? []).length === 1);
  await m.ev(`[...document.querySelectorAll(".cm-find-text-btn")].find((b) => b.textContent === "全部替换").click(); await sleep(200); return 1`);
  p = await panel();
  doc = await m.ev(`return view().state.doc.toString()`);
  check("全部替换，显示替换了几处", p.count === "已替换 39 处" && !doc.includes("banana"), p.count);
  await m.ev(`view().focus(); return 1`);
  await m.press("Ctrl+Z");
  await m.press("Ctrl+Z");
  doc = await m.ev(`return view().state.doc.toString()`);
  check("替换可以撤销", (doc.match(/banana/g) ?? []).length === 40);

  await m.ev(`document.querySelector(".cm-find input").focus(); return 1`);
  await m.press("Escape");
  check("Esc 关闭查找框，焦点回到正文", (await panel()) === null && (await m.ev(`return view().hasFocus`)));

  await cursorAt(`const i = v.state.doc.toString().indexOf("独角兽"); v.dispatch({ selection: { anchor: i, head: i + 3 } })`);
  await m.press("Ctrl+F");
  check("选中一段文字再 Ctrl+F，查它", (await panel()).search === "独角兽");
  await m.press("Escape");
  await cursorAt(`v.dispatch({ selection: { anchor: 0, head: 20 } })`);
  await m.press("Ctrl+F");
  check("选中的跨行时不拿来查，接着用上次的", (await panel()).search === "独角兽");
  await m.press("Escape");
  await cursorAt(`const i = v.state.doc.toString().indexOf("铺垫5 "); v.dispatch({ selection: { anchor: i, head: i + 3 } })`);
  await m.press("Ctrl+H");
  p = await panel();
  check("选中一个词再 Ctrl+H：查这个词，「替换为」还是上次填的", p.search === "铺垫5" && p.replace === "香蕉" && p.replaceShown, p);
  await m.press("Escape");

  await cursorAt(`v.dispatch({ selection: { anchor: 0 } })`);
  await m.press("Ctrl+F");
  await fillSearch("C:\\new\\temp");
  check("带反斜杠的文字按原样查", (await panel()).count === "1/1");
  await m.press("Escape");
  await cursorAt(`v.dispatch({ selection: { anchor: 0 } })`);
  await m.press("F3");
  p = await panel();
  check("查找框没开着时 F3 直接找下一个，焦点留在正文", p?.sel === "C:\\new\\temp" && p.focus === "editor", p);

  // 外部修改后重新加载，查找框还开着
  await m.press("Ctrl+F");
  t.write("工作/需求/长文档.md", t.read("工作/需求/长文档.md") + "\n外部加的一行 C:\\new\\temp\n");
  await m.emit("tauri://focus");
  await t.sleep(1200);
  p = await panel();
  check("查找框开着时外部改了正文，重新加载后查找框还开着", p?.search === "C:\\new\\temp" && /\/2$|共 2 个/.test(p.count), p);
  await m.press("Escape");

  await m.ev(`return await openTodo("工作", "需求", "A")`);
  await m.ev(`view().focus(); return 1`);
  await m.press("Ctrl+F");
  check("切到别的待办，Ctrl+F 接着用上次查的", (await panel()).search === "C:\\new\\temp");
  await m.press("Escape");
  await m.ev(`document.querySelector(".editor-title").focus(); return 1`);
  await m.press("Ctrl+F");
  check("焦点在标题上时 Ctrl+F 也能打开", (await panel())?.focus === "search");
  await m.press("Escape");
  await m.ev(`row("工作", "需求", "A").click(); await sleep(200); document.activeElement.blur?.(); return 1`);
  await m.ev(`document.querySelector(".sidebar [tabindex='0']")?.focus(); return 1`);
  await m.press("Ctrl+F");
  check("焦点在左侧列表时 Ctrl+F 也能打开", (await panel())?.focus === "search");
  await m.press("Escape");

  await m.ev(`row("工作").click(); await sleep(300); document.querySelector(".main").focus(); return 1`);
  await m.press("Ctrl+F");
  check("没有打开待办时 Ctrl+F 聚焦侧栏搜索框", await m.ev(`return !!document.activeElement?.closest(".sidebar") && document.activeElement.tagName === "INPUT"`));
  await m.press("Escape");
  await m.ev(`document.querySelector(".anticon-home")?.closest("button")?.click(); await sleep(400); document.body.focus(); return 1`);
  await m.press("Ctrl+F");
  check("首页 Ctrl+F 聚焦首页搜索框", /搜索工作区/.test(await m.ev(`return document.activeElement?.placeholder ?? ""`)));
  await m.press("Escape");

  // 认不出编码的文件只读：没有替换
  t.write("工作/日常/坏编码.md", Buffer.from([0x80, 0x81, 0xff, 0xfe, 0x00, 0x41, 0xc0, 0xc1, 0xf5, 0xff, 0x0a]));
  await m.enter("工作");
  await m.ev(`await waitFor(() => row("工作", "日常", "坏编码")); row("工作", "日常", "坏编码").click(); await sleep(1000); view().focus(); return 1`);
  await m.press("Ctrl+H");
  p = await panel();
  const readOnly = await m.ev(`return view().state.readOnly && document.querySelector(".cm-find-toggle").hidden`);
  check("只读的正文没有替换", readOnly && p && !p.replaceShown, p);
  await m.press("Escape");
}
