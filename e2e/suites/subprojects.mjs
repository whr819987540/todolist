// 子项目：项目下可以建子项目（只有一层），存成项目文件夹里的子文件夹；侧栏里缩进列在父项目下面、它自己的待办前面；
// 父项目的统计包括子项目；编辑区上方、标签写成「父项目 / 子项目」；键盘 ← 回到父项目；父项目改名后子项目跟着；
// 隐藏全部完成的项目时全部完成的子项目单独藏；删除、撤销；用户在项目文件夹里建的文件夹也是子项目；
// 拖动项目放进别的项目、有子项目的放不进去，右键「移动到」把子项目移出来；首页搜索
import { mkdirSync, writeFileSync } from "node:fs";

export const title = "子项目";

export default async function (t) {
  const { main: m, check } = t;
  await m.viewport(1200, 900);
  await m.enter("工作");
  await m.expandAll();

  const refresh = async () => {
    await m.emit("tauri://focus");
    await t.sleep(800);
  };
  const menu = async (sel, text) => {
    await m.click(await m.at(sel), { right: true });
    await m.ev(`await sleep(300); menuItem(${JSON.stringify(text)}).click(); await sleep(300); return 1`);
  };
  /** 在名称对话框里填好，点确定按钮 */
  const fillDialog = (value, ok) =>
    m.ev(`const input = await waitFor(() => document.querySelector(".ant-modal input"));
      setInput(input, ${JSON.stringify(value)}); await sleep(100);
      button(${JSON.stringify(ok)}, document.querySelector(".ant-modal-footer")).click(); await sleep(800); return 1`);
  const selected = () => m.ev(`return document.querySelector(".tree .tree-row.selected")?.dataset.sel`);
  const sel = (...k) => JSON.stringify([k[0], k[1] ?? "", k[2] ?? ""]);

  // 右键项目「新建子项目」
  await menu(["工作", "需求"], "新建子项目");
  await fillDialog("前端", "创建");
  await t.until(() => m.ev(`return !!row("工作", "需求/前端")`));
  const layout = await m.ev(`const sub = row("工作", "需求/前端"), parent = row("工作", "需求");
    const branch = parent.closest("[role=treeitem]");
    const rows = [...branch.querySelectorAll(".tree-row")];
    return {
      label: sub.querySelector(".row-label").textContent,
      nested: branch.contains(sub) && sub.closest("[role=treeitem]") !== branch,
      indent: parseFloat(sub.style.paddingLeft) > parseFloat(parent.style.paddingLeft),
      beforeTodos: rows.indexOf(sub) < rows.indexOf(row("工作", "需求", "A")),
    }`);
  check("右键项目「新建子项目」：建成项目文件夹里的子文件夹", t.exists("工作/需求/前端"));
  check(
    "侧栏里子项目缩进列在父项目下面、父项目自己的待办前面，显示它自己的名字",
    layout.label === "前端" && layout.nested && layout.indent && layout.beforeTodos,
    layout,
  );
  check("建好后右侧显示子项目的概览", (await selected()) === sel("工作", "需求/前端"), await selected());
  await m.click(await m.at(["工作", "需求/前端"]), { right: true });
  const subItems = await m.ev(`await sleep(300);
    return [...document.querySelectorAll(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item")].map((e) => e.textContent)`);
  await m.press("Escape");
  check(
    "子项目的右键菜单里没有「新建子项目」（只有一层）",
    !subItems.includes("新建子项目") && subItems.includes("新建待办"),
    subItems,
  );

  // 在子项目的概览里快速添加待办
  await m.ev(`const input = await waitFor(() => document.querySelector(".quick-add input")); input.focus();
    setInput(input, "子项目里的待办"); await sleep(100); return 1`);
  await m.press("Enter");
  const subTodo = await t.until(() =>
    m.ev(`return [...document.querySelectorAll(".tree-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel))
      .find(([w, p, id]) => p === "需求/前端" && id)?.[2] ?? ""`),
  );
  check("在子项目里快速添加：待办存在子项目文件夹里", !!subTodo && t.exists(`工作/需求/前端/${subTodo}.md`), subTodo);

  const counts = await m.ev(`return { parent: row("工作", "需求").querySelector(".row-count").textContent,
    sub: row("工作", "需求/前端").querySelector(".row-count").textContent }`);
  check("父项目行上的未完成数包括子项目里的", counts.parent === "5" && counts.sub === "1", counts);

  // 侧栏里删除工作区的确认：项目数同首页的卡片，只算顶层项目（需求、日常），待办数包括子项目里的（4 + 1 + 1）
  await menu(["工作"], "删除工作区");
  const wsConfirm = await m.ev(`return (await waitFor(() => document.querySelector(".ant-modal-confirm-content")))?.textContent ?? ""`);
  await m.ev(`button("取消", document.querySelector(".ant-modal-confirm-btns")).click(); await sleep(400); return 1`);
  check("侧栏里删除工作区的确认：项目数只算顶层项目，待办数包括子项目里的", wsConfirm.includes("其中的 2 个项目、6 条待办"), wsConfirm);

  // 父项目的概览
  await m.ev(`row("工作", "需求").click(); await sleep(600); return 1`);
  const overview = await m.ev(`return {
    cards: [...document.querySelectorAll(".overview .project-card .card-name")].map((e) => e.textContent),
    head: document.querySelector(".overview-title .muted")?.textContent ?? "" }`);
  check(
    "父项目的概览列出子项目的卡片，数目包括子项目里的",
    overview.cards.join() === "前端" && overview.head.includes("共 5 条（含子项目）"),
    overview,
  );

  // 打开子项目里的待办：编辑区上方、标签写成「父项目 / 子项目」
  await m.ev(`row("工作", "需求/前端", ${JSON.stringify(subTodo)}).click();
    await waitFor(() => document.querySelector(".editor-title")?.value === "子项目里的待办"); await sleep(300); return 1`);
  const where = await m.ev(`return {
    crumb: [...document.querySelectorAll(".editor-crumb .ant-breadcrumb-link")].map((e) => e.textContent).join(" / "),
    tab: document.querySelector(".editor-tab.active")?.getAttribute("title") ?? "" }`);
  check(
    "编辑区上方、标签的悬停写成「工作区 / 父项目 / 子项目」",
    where.crumb === "工作 / 需求 / 前端" && where.tab.startsWith("工作 / 需求 / 前端 / 子项目里的待办"),
    where,
  );

  // 键盘：子项目上按 ← 先折叠，再按回到父项目
  await m.ev(`row("工作", "需求/前端").click(); await sleep(500); return 1`);
  await m.press("Alt+ArrowLeft");
  await m.press("ArrowLeft");
  const folded = await m.ev(`return row("工作", "需求/前端").closest("[role=treeitem]").getAttribute("aria-expanded")`);
  await m.press("ArrowLeft");
  await t.sleep(300);
  check("左侧列表里在子项目上按 ←：先折叠，再按回到父项目", folded === "false" && (await selected()) === sel("工作", "需求"), {
    folded,
    selected: await selected(),
  });
  await m.ev(`row("工作", "需求/前端").querySelector(".chevron").click(); await sleep(300); return 1`);

  // 用户在项目文件夹里建的文件夹也是子项目
  mkdirSync(t.file("工作/日常/外部建的"), { recursive: true });
  writeFileSync(t.file("工作/日常/外部建的/外部.md"), "# 外部\n");
  await refresh();
  check(
    "在项目文件夹里建的文件夹刷新后显示成子项目，里面的 .md 是待办",
    await t.until(() => m.ev(`return !!row("工作", "日常/外部建的", "外部")`)),
  );

  // 父项目改名：子项目、打开着的标签跟着
  await m.ev(`row("工作", "需求/前端", ${JSON.stringify(subTodo)}).click(); await sleep(600); return 1`);
  await menu(["工作", "需求"], "重命名");
  await fillDialog("需求池", "确定");
  await t.until(() => m.ev(`return !!row("工作", "需求池/前端", ${JSON.stringify(subTodo)})`));
  const renamed = await m.ev(`return { tab: document.querySelector(".editor-tab.active")?.getAttribute("title") ?? "",
    title: document.querySelector(".editor-title")?.value }`);
  check(
    "父项目改名后，子项目和打开着的子项目里的待办跟着",
    t.exists(`工作/需求池/前端/${subTodo}.md`) &&
      renamed.tab.startsWith("工作 / 需求池 / 前端 / ") &&
      renamed.title === "子项目里的待办" &&
      (await selected()) === sel("工作", "需求池/前端", subTodo),
    renamed,
  );

  // 隐藏全部完成的项目：全部完成的子项目单独藏，父项目还在
  await m.ev(`row("工作", "需求池/前端", ${JSON.stringify(subTodo)}).querySelector(".check").click(); await sleep(600); return 1`);
  const toggleHide = async () => {
    await m.click(await m.at(".hide-done-btn"));
    await m.ev(`const item = await waitFor(() => [...document.querySelectorAll(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item")]
        .find((e) => e.textContent.includes("隐藏全部完成的项目")));
      item.click(); await sleep(400); return 1`);
  };
  await toggleHide();
  const whileShown = await m.ev(`return !!row("工作", "需求池/前端")`);
  await m.ev(`row("工作").click(); return 1`);
  const subHidden = await t.until(() => m.ev(`return !row("工作", "需求池/前端")`));
  const hint = await m.ev(`return document.querySelector(".hidden-projects")?.textContent.trim() ?? ""`);
  check(
    "隐藏全部完成的项目：右侧显示着时照常显示，切走后全部完成的子项目单独藏起来，父项目还在",
    whileShown && subHidden && (await m.ev(`return !!row("工作", "需求池")`)) && hint.startsWith("已隐藏 1 个"),
    { whileShown, subHidden, hint },
  );
  await toggleHide();

  // 删除子项目，撤销后回到原来的父项目里
  await menu(["工作", "需求池/前端"], "删除项目");
  const confirmTitle = await m.ev(`await sleep(300); return document.querySelector(".ant-modal-confirm-title")?.textContent ?? ""`);
  await m.ev(`button("删除", document.querySelector(".ant-modal-confirm-btns")).click(); await sleep(1000); return 1`);
  const gone = !t.exists("工作/需求池/前端") && !(await m.ev(`return !!row("工作", "需求池/前端")`));
  await m.ev(`[...document.querySelectorAll(".ant-message-notice .undo-link")].at(-1).click(); await sleep(1500); return 1`);
  check(
    "删除子项目（确认里写明是哪个父项目里的），撤销后回到原来的父项目里",
    confirmTitle.includes("需求池 / 前端") &&
      gone &&
      t.exists(`工作/需求池/前端/${subTodo}.md`) &&
      (await t.until(() => m.ev(`return !!row("工作", "需求池/前端")`))),
    { confirmTitle, gone },
  );

  // 拖动项目放进别的项目：有子项目的（「日常」里有「外部建的」）放不进去
  const ghostHint = () => m.ev(`return document.querySelector(".drag-ghost-hint")?.textContent ?? ""`);
  const dropState = (sel) =>
    m.ev(`const b = row(...${JSON.stringify(sel)}).closest("[role=treeitem]");
      return b.classList.contains("drop-target") ? "ok" : b.classList.contains("drop-refused") ? "refused" : ""`);
  let into = await m.at(["工作", "需求池"]);
  await m.drag(await m.at(["工作", "日常"]), into, { release: false });
  const refused = { hint: await ghostHint(), state: await dropState(["工作", "需求池"]) };
  await m.drop(into);
  check(
    "有子项目的项目拖到别的项目上：标红、说明原因，放不下",
    refused.state === "refused" && refused.hint.includes("有子项目") && t.exists("工作/日常/D.md"),
    refused,
  );

  await m.invoke("create_project", { workspace: "工作", name: "零散" });
  await refresh();
  into = await m.at(["工作", "需求池"]);
  await m.drag(await m.at(["工作", "零散"]), into, { release: false });
  const ok = { hint: await ghostHint(), state: await dropState(["工作", "需求池"]) };
  await m.drop(into);
  check(
    "项目拖到别的项目上：整块高亮，说明放进去成为子项目，松开后成了它的子项目",
    ok.state === "ok" &&
      ok.hint.includes("放进「需求池」，成为子项目") &&
      t.exists("工作/需求池/零散") &&
      !t.exists("工作/零散") &&
      (await t.until(() => m.ev(`return !!row("工作", "需求池/零散")`))),
    ok,
  );

  // 右键子项目「移动到 → 顶层」：移出来
  await m.click(await m.at(["工作", "需求池/零散"]), { right: true });
  await t.sleep(300);
  const title = await m.ev(`const e = [...document.querySelectorAll(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-submenu-title")]
      .find((x) => x.textContent.includes("移动到"));
    const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }`);
  await m.mouse("mouseMoved", title);
  const moveItems = await t.until(() =>
    m.ev(`const items = [...document.querySelectorAll(".ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden) .ant-dropdown-menu-item")]
      .map((e) => e.textContent.trim()); return items.length ? items : null`),
  );
  check(
    "右键子项目「移动到」：列出顶层（写明从哪个项目移出）和别的顶层项目，不列它现在的父项目",
    !!moveItems && moveItems.includes("顶层（移出「需求池」）") && moveItems.includes("日常") && !moveItems.includes("需求池"),
    moveItems,
  );
  await m.ev(`menuItem("顶层（移出「需求池」）").click(); await sleep(1000); return 1`);
  check(
    "「移动到 → 顶层」：子项目移出来，变成普通项目",
    t.exists("工作/零散") && !t.exists("工作/需求池/零散") && (await t.until(() => m.ev(`return !!row("工作", "零散")`))),
  );

  // 首页搜索：按子项目的名字找到，写明在哪个父项目里
  await m.ev(`document.querySelector(".anticon-home")?.closest("button")?.click(); await sleep(500); return 1`);
  await m.press("Ctrl+Shift+F");
  await m.type("前端");
  await t.sleep(900);
  const found = await m.ev(`return [...document.querySelectorAll(".search-results .list-row")].map((r) => r.textContent)`);
  check("首页搜索按子项目的名字找到，写明在哪个父项目里", found.some((x) => x.includes("前端") && x.includes("工作 / 需求池")), found);
  await m.press("Escape");
}
