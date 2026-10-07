// 全文搜索（侧栏和首页）
export const title = "全文搜索";

export default async function (t) {
  const { main: m, check } = t;
  await m.enter("工作");
  await m.selectAllWorkspaces();

  const search = async (kw) => {
    await m.press("Ctrl+Shift+F");
    await m.press("Ctrl+A");
    await m.type(kw);
    await t.sleep(900);
    return m.ev(`return [...document.querySelectorAll(".sidebar .tree-row[data-sel]")].filter((r) => JSON.parse(r.dataset.sel)[2]).map((r) => ({
      sel: JSON.parse(r.dataset.sel).join("/"), snippet: r.querySelector(".todo-snippet")?.textContent ?? null,
      mark: [...r.querySelectorAll("mark")].map((x) => x.textContent).join(",") }))`);
  };

  let rows = await search("独角兽");
  check("侧栏搜索：只在正文后部出现的词也能搜到，标题下面显示附近的一段，关键字高亮",
    rows.length === 1 && rows[0].sel === "工作/需求/长文档" && rows[0].snippet?.includes("独角兽") && rows[0].mark.includes("独角兽"), rows);
  rows = await search("BANANA");
  check("不区分大小写", rows.some((r) => r.sel === "工作/需求/长文档"), rows);
  rows = await search("会议纪要");
  check("GBK 编码的正文也能搜到", rows.some((r) => r.sel === "生活/购物/GBK笔记" && r.snippet?.includes("会议纪要")), rows);
  await m.press("Escape");
  const esc = await m.ev(`return { value: document.querySelector(".sidebar input").value, list: !!document.activeElement?.closest(".sidebar") && document.activeElement.tagName !== "INPUT" }`);
  check("搜索框里 Esc 清空搜索，焦点回到左侧列表", esc.value === "" && esc.list, esc);

  // 在软件里改了正文、保存后按新内容搜
  await m.ev(`return await openTodo("工作", "需求", "B")`);
  await m.ev(`const v = view(); v.focus(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\\n新加的火龙果" } }); return 1`);
  await m.press("Ctrl+S");
  await t.sleep(500);
  rows = await search("火龙果");
  check("保存后用新内容能搜到", rows.some((r) => r.sel === "工作/需求/B"), rows);
  await m.press("Escape");
  await m.ev(`return await openTodo("工作", "需求", "B")`);
  await m.ev(`const v = view(); const i = v.state.doc.toString().indexOf("火龙果"); v.dispatch({ changes: { from: i, to: i + 3, insert: "榴莲" } }); return 1`);
  await m.press("Ctrl+S");
  await t.sleep(500);
  const old = await search("火龙果");
  rows = await search("榴莲");
  check("再改了保存：旧内容搜不到、新内容搜得到", old.length === 0 && rows.some((r) => r.sel === "工作/需求/B"), { old, rows });
  await m.press("Escape");

  // 外部改了正文：切回窗口后按新内容搜
  t.write("工作/日常/D.md", t.read("工作/日常/D.md") + "\n外部写入的猕猴桃\n");
  await m.emit("tauri://focus");
  await t.sleep(800);
  rows = await search("猕猴桃");
  check("外部改了正文，切回窗口后按新内容搜", rows.some((r) => r.sel === "工作/日常/D"), rows);
  await m.press("Escape");

  // 首页搜索
  await m.ev(`document.querySelector(".anticon-home")?.closest("button")?.click(); await sleep(500); return 1`);
  await m.press("Ctrl+Shift+F");
  await m.type("独角兽");
  await t.sleep(900);
  const home = await m.ev(`return [...document.querySelectorAll(".search-results .list-row")].map((r) => r.textContent)`);
  check("首页搜索也查正文全文，显示命中处附近的一段", home.some((x) => x.includes("长文档") && x.includes("独角兽")), home);
  await m.ev(`[...document.querySelectorAll(".search-results .list-row")].find((r) => r.textContent.includes("长文档")).click(); await sleep(1200); return 1`);
  check("点首页的搜索结果打开待办", (await m.ev(`return document.querySelector(".editor-title")?.value`)) === "长文档");

  // 回收站里的不会被搜到
  await m.ev(`await invoke("create_project", { workspace: "学习", name: "临时" });
    const x = await invoke("create_todo", { workspace: "学习", project: "临时", title: "要删掉的", content: "回收站里的山竹" });
    await invoke("delete_todo", { workspace: "学习", project: "临时", id: x.id }); return 1`);
  check("软件回收站里的不会被搜到", (await m.invoke("search_todos", { workspaces: null, keyword: "山竹" })).length === 0);
}
