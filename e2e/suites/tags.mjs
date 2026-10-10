// 待办的标签（tag）：编辑区上方加上、去掉、联想，右键「标签…」，侧栏和项目概览里显示（颜色、「+N」、悬停），
// 标签页的悬停说明，搜索（关键字匹配标签名、#标签名只按标签找），批量添加 / 移除，移动后还在
export const title = "待办的标签";

export default async function (t) {
  const { main: m, check } = t;
  await m.viewport(1200, 900);
  await m.ev(`localStorage.setItem("listOptions:工作", JSON.stringify({ sortKey: "title", hideDone: false })); return 1`);
  await m.reload();
  await m.enter("工作");
  await m.expandAll();

  const meta = (p, id) => t.meta("工作", p).find((x) => x.id === id);
  const tagsOf = (p, id) => (meta(p, id)?.tags ?? []).join();
  const editorTags = () => m.ev(`return [...document.querySelectorAll(".editor-meta .tag-editor .tag-chip")].map((e) => e.textContent).join()`);
  const rowChips = (p, id) =>
    m.ev(`return [...(row("工作", ${JSON.stringify(p)}, ${JSON.stringify(id)})?.querySelectorAll(".tag-chip") ?? [])]
      .map((e) => ({ text: e.textContent, cls: e.className, title: e.title }))`);
  /** 在编辑区上方的「+ 标签」里输入 text 按 Enter（输入框已经开着时接着输入） */
  const addInEditor = async (text) => {
    await m.ev(`if (!document.querySelector(".editor-meta .tag-input")) document.querySelector(".editor-meta .tag-add").click();
      const input = await waitFor(() => document.querySelector(".editor-meta .tag-input input"));
      input.focus(); return !!input`);
    await m.type(text);
    await t.sleep(200);
    await m.press("Enter");
    await t.sleep(500);
  };

  // 编辑区上方加上、去掉
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  const before = meta("需求", "A");
  await addInEditor("工作");
  check("「+ 标签」里输入后按 Enter 加上，编辑区和侧栏里都显示", (await editorTags()) === "工作" && (await rowChips("需求", "A")).map((c) => c.text).join() === "工作", await editorTags());
  const after = meta("需求", "A");
  check("记在 .todos.json（tags），修改时间不变", after.tags?.join() === "工作" && after.updatedAt === before.updatedAt, { before, after });
  await addInEditor("#等回复");
  check("输入框留着可以接着加；开头的 # 去掉", tagsOf("需求", "A") === "工作,等回复", meta("需求", "A"));
  await m.clearToasts();
  await addInEditor("工作");
  check("已经有的不再加，提示一下", tagsOf("需求", "A") === "工作,等回复" && (await m.toast()).includes("已经有标签"), await m.toast());
  await m.clearToasts();
  await addInEditor("a,b");
  check("有逗号的不加，提示原因", tagsOf("需求", "A") === "工作,等回复" && (await m.toast()).includes("逗号"), await m.toast());
  await m.press("Ctrl+A");
  await m.press("Backspace");
  await addInEditor("第三个");
  check("加了第三个", tagsOf("需求", "A") === "工作,等回复,第三个", meta("需求", "A"));
  const chips = await rowChips("需求", "A");
  check(
    "侧栏行上只显示前 2 个，后面是「+1」，悬停「+1」看全部",
    chips.map((c) => c.text).join() === "工作,等回复,+1" && chips[2].title.includes("工作、等回复、第三个"),
    chips,
  );
  await m.press("Escape");
  await t.sleep(300);
  check("Esc 收起输入框", await m.ev(`return !document.querySelector(".editor-meta .tag-input") && !!document.querySelector(".editor-meta .tag-add")`));
  await m.ev(`const chip = [...document.querySelectorAll(".editor-meta .tag-editor .tag-chip")].find((e) => e.textContent === "第三个");
    chip.querySelector(".tag-close").click(); await sleep(600); return 1`);
  check("点标签上的 × 去掉", tagsOf("需求", "A") === "工作,等回复" && (await editorTags()) === "工作,等回复", meta("需求", "A"));

  // 联想：从用过的标签里选
  await m.ev(`return await openTodo("工作", "需求", "B")`);
  await m.ev(`document.querySelector(".editor-meta .tag-add").click();
    const input = await waitFor(() => document.querySelector(".editor-meta .tag-input input")); input.focus(); return 1`);
  await m.type("工");
  // 等下拉按输入的字筛好（一打开时列出的是最常用的）
  const options = await m.ev(`const shown = () => [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")].map((e) => e.textContent);
    await waitFor(() => shown().length && shown().every((x) => x.includes("工")));
    return shown()`);
  check("输入时下拉列出用过的、包含输入的字的标签", options.join() === "工作", options);
  await m.press("ArrowDown");
  await m.press("Enter");
  await t.sleep(600);
  check("↑↓ 选中、Enter 加上的是选中的那个（不是输入的字）", tagsOf("需求", "B") === "工作", meta("需求", "B"));
  await m.press("Escape");
  const [a1] = await rowChips("需求", "A");
  const [b1] = await rowChips("需求", "B");
  check("同名的标签在哪里都是同一个颜色", a1.cls === b1.cls && /tag-c\d/.test(a1.cls), { a1, b1 });

  // 右键「标签…」
  await m.click(await m.at(["工作", "需求", "C"]), { right: true });
  await m.ev(`const item = await waitFor(() => menuItem("标签…")); item.click(); return 1`);
  const opened = await m.ev(`return !!(await waitFor(() => document.querySelector(".ant-modal .tag-select")))`);
  check("右键「标签…」打开选标签的对话框", opened);
  await t.sleep(400);
  await m.type("急");
  await m.press("Enter");
  await m.type("工作");
  await t.sleep(300);
  await m.press("Enter");
  await m.ev(`button("确定", document.querySelector(".ant-modal")).click(); return 1`);
  const dialogTags = await t.until(() => tagsOf("需求", "C") === "急,工作");
  check("对话框里输入新的、选用过的，确定后保存", dialogTags, meta("需求", "C"));

  // 悬停提示、标签页的悬停说明、项目概览
  await m.mouse("mouseMoved", await m.at(["工作", "需求", "A"]));
  const tip = await m.ev(`return (await waitFor(() => document.querySelector(".todo-tip-tags")?.textContent, 3000)) ?? ""`);
  check("侧栏行的悬停提示里列出全部标签", tip === "标签：工作、等回复", tip);
  await m.mouse("mouseMoved", { x: 900, y: 600 });
  // 正打开着的 B（A 的预览标签已经被 B 替换了）
  const tabTitle = await m.ev(`return document.querySelector(".editor-tab[data-tab='" + JSON.stringify(["工作", "需求", "B"]) + "']")?.title ?? ""`);
  check("标签页的悬停说明里列出标签", tabTitle.includes("标签：工作"), tabTitle);
  await m.ev(`row("工作", "需求").click(); await waitFor(() => document.querySelector(".main .list-row[data-sel]")); return 1`);
  const overview = await m.ev(`return [...document.querySelectorAll(".main .list-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel)[2] + ":" + [...r.querySelectorAll(".tag-chip")].map((e) => e.textContent).join("/"))`);
  check("项目概览的待办列表里标题后面显示标签", overview.includes("A:工作/等回复") && overview.includes("C:急/工作"), overview);

  // 浅色、深色下颜色不同
  const colors = await m.ev(`const chip = row("工作", "需求", "A").querySelector(".tag-chip");
    const light = getComputedStyle(chip).backgroundColor;
    document.documentElement.dataset.theme = "dark"; const dark = getComputedStyle(chip).backgroundColor;
    document.documentElement.dataset.theme = "light"; return { light, dark }`);
  check("深色模式下换一套颜色", colors.light !== colors.dark, colors);

  // 搜索
  const search = async (kw) => {
    await m.press("Ctrl+Shift+F");
    await m.press("Ctrl+A");
    await m.type(kw);
    await t.sleep(900);
    return m.ev(`return [...document.querySelectorAll(".sidebar .todo-row[data-sel]")].map((r) => ({
      id: JSON.parse(r.dataset.sel)[2], hit: [...r.querySelectorAll(".tag-chip.hit")].map((x) => x.textContent).join(),
      mark: [...r.querySelectorAll("mark")].map((x) => x.textContent).join() }))`);
  };
  let rows = await search("回复");
  check("搜索关键字也匹配标签名，命中的标签高亮", rows.length === 1 && rows[0].id === "A" && rows[0].hit === "等回复", rows);
  rows = await search("#工作");
  check("#标签名：只按标签找", rows.map((r) => r.id).sort().join() === "A,B,C" && rows.every((r) => r.hit === "工作" && !r.mark), rows);
  rows = await search("#工");
  check("#标签名 要名字一样，只是包含不算", rows.length === 0, rows);
  rows = await search("#");
  check("只输入 # 时列出有标签的待办", rows.map((r) => r.id).sort().join() === "A,B,C", rows);
  await m.press("Escape");
  await m.ev(`document.querySelector(".anticon-home")?.closest("button")?.click(); await waitFor(() => document.querySelector(".home-search")); return 1`);
  await m.press("Ctrl+Shift+F");
  await m.type("#等回复");
  await t.sleep(1200);
  const home = await m.ev(`return [...document.querySelectorAll(".search-results .list-row")].map((r) => ({
    text: r.querySelector(".list-title-text")?.textContent, hit: [...r.querySelectorAll(".tag-chip.hit")].map((x) => x.textContent).join() }))`);
  check("首页搜索 #标签名 也只按标签找，结果里显示标签", home.length === 1 && home[0].text === "A" && home[0].hit === "等回复", home);

  // 批量添加 / 移除
  await m.enter("工作");
  await m.expandAll();
  await m.click(await m.at(["工作", "需求", "A"]));
  await m.click(await m.at(["工作", "日常", "D"]), { ctrl: true });
  await m.ev(`button("添加标签", document.querySelector(".batch-actions")).click();
    await waitFor(() => document.querySelector(".ant-modal .tag-select")); await sleep(400); return 1`);
  await m.type("批量");
  await m.press("Enter");
  await m.ev(`button("添加", document.querySelector(".ant-modal .ant-modal-footer")).click(); return 1`);
  const added = await t.until(() => tagsOf("需求", "A") === "工作,等回复,批量" && tagsOf("日常", "D") === "批量");
  check("批量添加标签：加到选中的每一条上", added, { A: meta("需求", "A"), D: meta("日常", "D") });
  await m.ev(`await waitFor(() => !document.querySelector(".ant-modal-wrap:not([style*='none']) .tag-select"));
    button("移除标签", document.querySelector(".batch-actions")).click();
    await waitFor(() => document.querySelector(".ant-modal .tag-select")); await sleep(300); return 1`);
  await m.click(await m.at(".ant-modal .tag-select"));
  const removeOptions = await m.ev(`return (await waitFor(() => {
    const list = [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")];
    return list.length ? list.map((e) => e.textContent) : null; })) ?? []`);
  check("移除标签：列出选中的待办上有的标签和几条有", removeOptions.some((x) => x.startsWith("批量") && x.includes("2 条")) && removeOptions.length === 3, removeOptions);
  await m.ev(`[...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")].find((e) => e.textContent.startsWith("批量")).click();
    await sleep(200); button("移除", document.querySelector(".ant-modal .ant-modal-footer")).click(); return 1`);
  const removed = await t.until(() => tagsOf("需求", "A") === "工作,等回复" && tagsOf("日常", "D") === "");
  check("批量移除标签：从选中的待办上去掉，别的标签不动", removed, { A: meta("需求", "A"), D: meta("日常", "D") });
  await m.press("Escape");

  // 移到别的项目后还在
  await m.invoke("move_todo", { workspace: "工作", project: "需求", id: "A", targetWorkspace: "工作", targetProject: "日常" });
  check("移到别的项目后标签还在", tagsOf("日常", "A") === "工作,等回复", meta("日常", "A"));
}
