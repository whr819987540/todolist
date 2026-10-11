// 全文搜索（侧栏和首页）
export const title = "全文搜索";

export default async function (t) {
  const { main: m, check } = t;
  await m.enter("工作");
  await m.selectAllWorkspaces();

  /** 反复 read()，直到 until(结果) 成立（最多等 10 秒），返回最后一次的结果 */
  const poll = async (read, until) => {
    for (const end = Date.now() + 10000; ; await t.sleep(100)) {
      const v = await read();
      if (until(v) || Date.now() > end) return v;
    }
  };
  // 全文搜索在 Rust 端查，查完之前先列出标题、正文开头匹配的；刚启动时第一次查要读全部正文，GitHub 的机器上可能
  // 要一秒多，所以不等固定的时间，等到 until(列出的待办, 侧栏里的提示) 成立
  const search = async (kw, until) => {
    await m.press("Ctrl+Shift+F");
    await m.press("Ctrl+A");
    await m.type(kw);
    const got = await poll(() => m.ev(`return {
      rows: [...document.querySelectorAll(".sidebar .tree-row[data-sel]")].filter((r) => JSON.parse(r.dataset.sel)[2]).map((r) => ({
        sel: JSON.parse(r.dataset.sel).join("/"), snippet: r.querySelector(".todo-snippet")?.textContent ?? null,
        mark: [...r.querySelectorAll("mark")].map((x) => x.textContent).join(",") })),
      notes: [...document.querySelectorAll(".sidebar .tree-empty")].map((x) => x.textContent) }`), (v) => until(v.rows, v.notes));
    return got.rows;
  };
  /** 列出了这条待办 */
  const listed = (sel) => (rows) => rows.some((r) => r.sel === sel);
  /** 全文也查完了、一条都没有：只看列出的行不够，全文还没查完时也可能一条都没列出 */
  const none = (kw) => (rows, notes) =>
    rows.length === 0 && notes.some((n) => n.includes(`没有找到包含“${kw}”`)) && !notes.some((n) => n.includes("正在搜索"));

  let rows = await search("独角兽", listed("工作/需求/长文档"));
  check("侧栏搜索：只在正文后部出现的词也能搜到，标题下面显示附近的一段，关键字高亮",
    rows.length === 1 && rows[0].sel === "工作/需求/长文档" && rows[0].snippet?.includes("独角兽") && rows[0].mark.includes("独角兽"), rows);
  rows = await search("BANANA", listed("工作/需求/长文档"));
  check("不区分大小写", rows.some((r) => r.sel === "工作/需求/长文档"), rows);
  rows = await search("会议纪要", listed("生活/购物/GBK笔记"));
  check("GBK 编码的正文也能搜到", rows.some((r) => r.sel === "生活/购物/GBK笔记" && r.snippet?.includes("会议纪要")), rows);
  await m.press("Escape");
  const esc = await m.ev(`return { value: document.querySelector(".sidebar input").value, list: !!document.activeElement?.closest(".sidebar") && document.activeElement.tagName !== "INPUT" }`);
  check("搜索框里 Esc 清空搜索，焦点回到左侧列表", esc.value === "" && esc.list, esc);

  // 在软件里改了正文、保存后按新内容搜
  await m.ev(`return await openTodo("工作", "需求", "B")`);
  await m.ev(`const v = view(); v.focus(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\\n新加的火龙果" } }); return 1`);
  await m.press("Ctrl+S");
  await t.sleep(500);
  rows = await search("火龙果", listed("工作/需求/B"));
  check("保存后用新内容能搜到", rows.some((r) => r.sel === "工作/需求/B"), rows);
  await m.press("Escape");
  await m.ev(`return await openTodo("工作", "需求", "B")`);
  await m.ev(`const v = view(); const i = v.state.doc.toString().indexOf("火龙果"); v.dispatch({ changes: { from: i, to: i + 3, insert: "榴莲" } }); return 1`);
  await m.press("Ctrl+S");
  await t.sleep(500);
  // 再搜搜过的关键字时，记下查完之前标题下面显示过「火龙果」的待办（上次查到的、保存前的内容）
  await m.ev(`const box = document.querySelector(".sidebar"); window.__stale = new Set();
    const note = () => { for (const r of box.querySelectorAll(".tree-row[data-sel]"))
      if (r.querySelector(".todo-snippet")?.textContent.includes("火龙果")) window.__stale.add(JSON.parse(r.dataset.sel).join("/")); };
    window.__staleObs = new MutationObserver(note); window.__staleObs.observe(box, { childList: true, subtree: true, characterData: true }); return 1`);
  const old = await search("火龙果", none("火龙果"));
  const stale = await m.ev(`window.__staleObs.disconnect(); return [...window.__stale]`);
  rows = await search("榴莲", listed("工作/需求/B"));
  check("再改了保存：旧内容搜不到、新内容搜得到", old.length === 0 && rows.some((r) => r.sel === "工作/需求/B"), { old, rows });
  check("清空后再搜搜过的关键字：查完之前不先显示上次查到的（保存前的内容）", stale.length === 0, stale);
  await m.press("Escape");

  // 外部改了正文：切回窗口后按新内容搜
  t.write("工作/日常/D.md", t.read("工作/日常/D.md") + "\n外部写入的猕猴桃\n");
  await m.emit("tauri://focus");
  await t.sleep(800);
  rows = await search("猕猴桃", listed("工作/日常/D"));
  check("外部改了正文，切回窗口后按新内容搜", rows.some((r) => r.sel === "工作/日常/D"), rows);
  await m.press("Escape");

  // 首页搜索
  await m.ev(`document.querySelector(".anticon-home")?.closest("button")?.click(); await sleep(500); return 1`);
  await m.press("Ctrl+Shift+F");
  await m.type("独角兽");
  const home = await poll(() => m.ev(`return [...document.querySelectorAll(".search-results .list-row")].map((r) => r.textContent)`),
    (list) => list.some((x) => x.includes("长文档") && x.includes("独角兽")));
  check("首页搜索也查正文全文，显示命中处附近的一段", home.some((x) => x.includes("长文档") && x.includes("独角兽")), home);
  await m.ev(`[...document.querySelectorAll(".search-results .list-row")].find((r) => r.textContent.includes("长文档")).click(); await sleep(1200); return 1`);
  check("点首页的搜索结果打开待办", (await m.ev(`return document.querySelector(".editor-title")?.value`)) === "长文档");

  // 回收站里的不会被搜到
  await m.ev(`await invoke("create_project", { workspace: "学习", name: "临时" });
    const x = await invoke("create_todo", { workspace: "学习", project: "临时", title: "要删掉的", content: "回收站里的山竹" });
    await invoke("delete_todo", { workspace: "学习", project: "临时", id: x.id }); return 1`);
  check("软件回收站里的不会被搜到", (await m.invoke("search_todos", { workspaces: null, keyword: "山竹" })).length === 0);
}
