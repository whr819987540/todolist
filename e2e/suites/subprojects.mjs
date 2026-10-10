// 子项目：项目下可以建子项目，子项目里还能再建（层数不限），存成项目文件夹里的子文件夹；侧栏里每多一级缩进一级、
// 列在父项目下面、它自己的待办前面，展开着的项目下面有竖线；父项目的统计包括各级子项目；编辑区上方、标签写成
// 「父项目 / 子项目 / …」，每一级都能点；键盘 ← 回到上一级；父项目改名后下面各级跟着；隐藏全部完成的项目时全部完成的
// 子项目单独藏；删除、撤销；用户在项目文件夹里建的文件夹也是子项目；拖动项目放进别的项目（有子项目的也行，深处的子项目
// 也行，它自己的子项目不行），右键「移动到」放进深处的子项目、移出来；层级多时的显示；路径太长时提示；首页搜索
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

  // 子项目里还能再建子项目：右键子项目「新建子项目」，再在它的概览里「新建子项目」
  await m.click(await m.at(["工作", "需求/前端"]), { right: true });
  const subItems = await m.ev(`await sleep(300);
    return [...document.querySelectorAll(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item")].map((e) => e.textContent)`);
  await m.press("Escape");
  check("子项目的右键菜单里也有「新建子项目」", subItems.includes("新建子项目") && subItems.includes("新建待办"), subItems);
  await menu(["工作", "需求/前端"], "新建子项目");
  await fillDialog("组件", "创建");
  await t.until(() => m.ev(`return !!row("工作", "需求/前端/组件")`));
  await m.ev(`button("新建子项目", await waitFor(() => document.querySelector(".overview-actions"))).click(); return 1`);
  await fillDialog("按钮", "创建");
  await t.until(() => m.ev(`return !!row("工作", "需求/前端/组件/按钮")`));
  const deep = await m.ev(`const paths = ["需求", "需求/前端", "需求/前端/组件", "需求/前端/组件/按钮"];
    const branch = (p) => row("工作", p).closest("[role=treeitem]");
    return {
      pads: paths.map((p) => parseFloat(row("工作", p).style.paddingLeft)),
      nested: paths.slice(1).every((p, i) => branch(paths[i]).contains(row("工作", p)) && branch(p) !== branch(paths[i])),
      guides: paths.slice(0, 3).every((p) => !!branch(p).querySelector(":scope > .project-children.guided")),
      label: row("工作", "需求/前端/组件/按钮").querySelector(".row-label").textContent,
    }`);
  check(
    "子项目里还能再建子项目：建成子文件夹里的子文件夹",
    t.exists("工作/需求/前端/组件") && t.exists("工作/需求/前端/组件/按钮"),
  );
  check(
    "侧栏里每多一级缩进一级，下一级在上一级的分支里、显示它自己的名字；展开着的项目下面有竖线",
    deep.pads.every((x, i) => i === 0 || x > deep.pads[i - 1]) && deep.nested && deep.guides && deep.label === "按钮",
    deep,
  );

  // 在最深的子项目的概览里快速添加
  await m.ev(`const input = await waitFor(() => document.querySelector(".quick-add input")); input.focus();
    setInput(input, "深处的待办"); await sleep(100); return 1`);
  await m.press("Enter");
  const deepTodo = await t.until(() =>
    m.ev(`return [...document.querySelectorAll(".tree-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel))
      .find(([w, p, id]) => p === "需求/前端/组件/按钮" && id)?.[2] ?? ""`),
  );
  const deepCounts = await m.ev(`return ["需求", "需求/前端", "需求/前端/组件", "需求/前端/组件/按钮"]
    .map((p) => row("工作", p).querySelector(".row-count").textContent)`);
  check(
    "在深处的子项目里快速添加：存在它的文件夹里；各级的未完成数包括下面各级的",
    !!deepTodo && t.exists(`工作/需求/前端/组件/按钮/${deepTodo}.md`) && deepCounts.join() === "6,2,1,1",
    { deepTodo, deepCounts },
  );

  // 编辑区上方的路径每一级都能点
  await m.ev(`row("工作", "需求/前端/组件/按钮", ${JSON.stringify(deepTodo)}).click();
    await waitFor(() => document.querySelector(".editor-title")?.value === "深处的待办"); await sleep(300); return 1`);
  const deepCrumb = await m.ev(`return [...document.querySelectorAll(".editor-crumb .ant-breadcrumb-link")].map((e) => e.textContent).join(" / ")`);
  await m.ev(`[...document.querySelectorAll(".editor-crumb a")].find((a) => a.textContent === "前端").click(); await sleep(500); return 1`);
  check(
    "打开深处的待办：编辑区上方写成「工作区 / 父项目 / … / 子项目」，点中间的一级打开那个项目",
    deepCrumb === "工作 / 需求 / 前端 / 组件 / 按钮" && (await selected()) === sel("工作", "需求/前端"),
    { deepCrumb, selected: await selected() },
  );

  // 键盘：深处的子项目上按 ← 先折叠，再按回到上一级
  await m.ev(`row("工作", "需求/前端/组件/按钮").click(); await sleep(500); return 1`);
  await m.press("Alt+ArrowLeft");
  await m.press("ArrowLeft");
  await m.press("ArrowLeft");
  await t.sleep(300);
  check("在深处的子项目上按 ←：先折叠，再按回到上一级的父项目", (await selected()) === sel("工作", "需求/前端/组件"), await selected());
  await m.ev(`row("工作", "需求/前端/组件/按钮").querySelector(".chevron").click(); await sleep(300); return 1`);

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

  // 父项目改名：下面各级子项目、打开着的标签跟着
  await m.ev(`row("工作", "需求/前端", ${JSON.stringify(subTodo)}).click(); await sleep(600); return 1`);
  await menu(["工作", "需求"], "重命名");
  await fillDialog("需求池", "确定");
  await t.until(() => m.ev(`return !!row("工作", "需求池/前端", ${JSON.stringify(subTodo)})`));
  const renamed = await m.ev(`return { tab: document.querySelector(".editor-tab.active")?.getAttribute("title") ?? "",
    title: document.querySelector(".editor-title")?.value,
    deepRow: !!row("工作", "需求池/前端/组件/按钮", ${JSON.stringify(deepTodo)}) }`);
  check(
    "父项目改名后，下面各级子项目和打开着的子项目里的待办跟着",
    t.exists(`工作/需求池/前端/${subTodo}.md`) &&
      t.exists(`工作/需求池/前端/组件/按钮/${deepTodo}.md`) &&
      renamed.deepRow &&
      renamed.tab.startsWith("工作 / 需求池 / 前端 / ") &&
      renamed.title === "子项目里的待办" &&
      (await selected()) === sel("工作", "需求池/前端", subTodo),
    renamed,
  );

  // 隐藏全部完成的项目：全部完成的子项目（连同下面各级都完成了）单独藏，父项目还在
  await m.ev(`row("工作", "需求池/前端/组件/按钮", ${JSON.stringify(deepTodo)}).querySelector(".check").click(); await sleep(600); return 1`);
  await m.ev(`row("工作", "需求池/前端", ${JSON.stringify(subTodo)}).click(); await sleep(400);
    row("工作", "需求池/前端", ${JSON.stringify(subTodo)}).querySelector(".check").click(); await sleep(600); return 1`);
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
    "隐藏全部完成的项目：右侧显示着时照常显示，切走后全部完成的子项目连同下面各级单独藏起来（只算一个），父项目还在",
    whileShown &&
      subHidden &&
      !(await m.ev(`return !!row("工作", "需求池/前端/组件/按钮")`)) &&
      (await m.ev(`return !!row("工作", "需求池")`)) &&
      hint.startsWith("已隐藏 1 个"),
    { whileShown, subHidden, hint },
  );
  await toggleHide();

  // 删除子项目（连同下面各级），撤销后回到原来的父项目里。删除前右侧打开着它下面最深处的待办
  await m.ev(`row("工作", "需求池/前端/组件/按钮", ${JSON.stringify(deepTodo)}).click();
    await waitFor(() => document.querySelector(".editor-title")?.value === "深处的待办"); await sleep(300); return 1`);
  await menu(["工作", "需求池/前端"], "删除项目");
  const confirm = await m.ev(`await sleep(300); return { title: document.querySelector(".ant-modal-confirm-title")?.textContent ?? "",
    content: document.querySelector(".ant-modal-confirm-content")?.textContent ?? "" }`);
  await m.ev(`button("删除", document.querySelector(".ant-modal-confirm-btns")).click(); await sleep(1000); return 1`);
  const gone = !t.exists("工作/需求池/前端") && !(await m.ev(`return !!row("工作", "需求池/前端")`));
  const afterDelete = await selected();
  check(
    "删除正看着的（打开着它下面的待办）子项目：右侧退回往上最近的还在的父项目",
    afterDelete === sel("工作", "需求池") && (await m.ev(`return !document.querySelector(".editor-title")`)),
    afterDelete,
  );
  await m.ev(`[...document.querySelectorAll(".ant-message-notice .undo-link")].at(-1).click(); await sleep(1500); return 1`);
  check(
    "删除子项目（确认里写明是哪个父项目里的、下面一共几个子项目），撤销后连同下面各级回到原来的父项目里",
    confirm.title.includes("需求池 / 前端") &&
      confirm.content.includes("2 个子项目") &&
      gone &&
      t.exists(`工作/需求池/前端/${subTodo}.md`) &&
      t.exists(`工作/需求池/前端/组件/按钮/${deepTodo}.md`) &&
      (await t.until(() => m.ev(`return !!row("工作", "需求池/前端")`))),
    { confirm, gone },
  );

  // 拖动项目放进别的项目：有子项目的（「日常」里有「外部建的」）也行，可以放进深处的子项目里，下面各级跟着
  const ghostHint = () => m.ev(`return document.querySelector(".drag-ghost-hint")?.textContent ?? ""`);
  const dropState = (sel) =>
    m.ev(`const b = row(...${JSON.stringify(sel)}).closest("[role=treeitem]");
      return b.classList.contains("drop-target") ? "ok" : b.classList.contains("drop-refused") ? "refused" : ""`);
  await m.expandAll();
  await m.expandAll();
  let into = await m.at(["工作", "需求池/前端/组件"]);
  await m.drag(await m.at(["工作", "日常"]), into, { release: false });
  const deepDrop = { hint: await ghostHint(), state: await dropState(["工作", "需求池/前端/组件"]) };
  await m.drop(into);
  check(
    "有子项目的项目拖到深处的子项目上：那个子项目整块高亮、说明放进去，松开后连同下面各级成了它的子项目",
    deepDrop.state === "ok" &&
      deepDrop.hint.includes("放进「需求池 / 前端 / 组件」，成为子项目") &&
      t.exists("工作/需求池/前端/组件/日常/D.md") &&
      t.exists("工作/需求池/前端/组件/日常/外部建的/外部.md") &&
      !t.exists("工作/日常") &&
      (await t.until(() => m.ev(`return !!row("工作", "需求池/前端/组件/日常/外部建的")`))),
    deepDrop,
  );

  // 不能放进它自己的子项目里
  await m.expandAll();
  into = await m.at(["工作", "需求池/前端"]);
  await m.drag(await m.at(["工作", "需求池"]), into, { release: false });
  const selfDrop = { hint: await ghostHint(), state: await dropState(["工作", "需求池/前端"]) };
  await m.drop(into);
  check(
    "项目拖到它自己的子项目上：不算能放的地方（不高亮），说明原因，松开后不动",
    selfDrop.state === "" &&
      selfDrop.hint.includes("不能放进它自己的子项目里") &&
      t.exists("工作/需求池/前端/组件/日常") &&
      !t.exists("工作/需求池/前端/需求池"),
    selfDrop,
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

  // 右键项目「移动到」：列出顶层和各级项目（写成路径），点了放进去
  const moveMenu = async (sel) => {
    await m.click(await m.at(sel), { right: true });
    await t.sleep(300);
    const title = await m.ev(`const e = [...document.querySelectorAll(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-submenu-title")]
        .find((x) => x.textContent.includes("移动到"));
      const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }`);
    await m.mouse("mouseMoved", title);
    return t.until(() =>
      m.ev(`const items = [...document.querySelectorAll(".ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden) .ant-dropdown-menu-item")]
        .map((e) => e.textContent.trim()); return items.length ? items : null`),
    );
  };
  const moveItems = await moveMenu(["工作", "需求池/零散"]);
  check(
    "右键子项目「移动到」：列出顶层（写明从哪个项目移出）和各级项目（写成「父项目 / 子项目」），不列它现在的父项目和它自己",
    !!moveItems &&
      moveItems.includes("顶层（移出「需求池」）") &&
      moveItems.includes("需求池 / 前端 / 组件") &&
      moveItems.includes("需求池 / 前端 / 组件 / 日常") &&
      !moveItems.includes("需求池") &&
      !moveItems.includes("需求池 / 零散"),
    moveItems,
  );
  await m.ev(`menuItem("需求池 / 前端 / 组件").click(); await sleep(1000); return 1`);
  check(
    "「移动到」深处的子项目：放进去成为它的子项目",
    t.exists("工作/需求池/前端/组件/零散") &&
      !t.exists("工作/需求池/零散") &&
      (await t.until(() => m.ev(`return !!row("工作", "需求池/前端/组件/零散")`))),
  );
  await moveMenu(["工作", "需求池/前端/组件/零散"]);
  await m.ev(`menuItem("顶层（移出「需求池 / 前端 / 组件」）").click(); await sleep(1000); return 1`);
  check(
    "「移动到 → 顶层」：深处的子项目移出来，变成普通项目",
    t.exists("工作/零散") &&
      !t.exists("工作/需求池/前端/组件/零散") &&
      (await t.until(() => m.ev(`return !!row("工作", "零散")`))),
  );

  // 层级多、名字长时路径会超过 Windows 的上限（259 个字符）：新建前提示路径太长，什么都不建。
  // 先一级一级建到再建一级就放不下（每级 60 个字，数据目录多长都行），再在界面上建
  const long = (c) => c.repeat(60);
  const deepest = await m.ev(`let parent = await invoke("create_project", { workspace: "工作", name: ${JSON.stringify(long("长"))} });
    for (let i = 0; i < 10; i++) {
      try { parent = await invoke("create_project", { workspace: "工作", name: ${JSON.stringify(long("深"))}, parent }); }
      catch { return parent; }
    }
    return parent`);
  await refresh();
  await m.expandAll();
  await m.expandAll();
  await menu(["工作", deepest], "新建子项目");
  await m.ev(`const input = await waitFor(() => document.querySelector(".ant-modal input"));
    setInput(input, ${JSON.stringify(long("深"))}); await sleep(100);
    button("创建", document.querySelector(".ant-modal-footer")).click(); await sleep(800); return 1`);
  const tooLong = await m.ev(`return document.querySelector(".ant-modal .dialog-error")?.textContent ?? ""`);
  await m.ev(`button("取消", document.querySelector(".ant-modal-footer"))?.click(); await sleep(300); return 1`);
  check(
    "层级多、名字长，再建一级路径就超过上限（227 个字符，给软件的回收站留了地方）：提示路径太长、会有多少个字符，什么都不建",
    tooLong.includes("路径太长") && tooLong.includes("227") && tooLong.includes("259") && !t.exists(`工作/${deepest}/${long("深")}`),
    { deepest: deepest.split("/").length, tooLong },
  );

  // 层级多时的显示：侧栏拖窄后少缩进几级，更深的不再往右挪、文件夹图标上标出是第几级，名字不被挤没；
  // 编辑区上方的路径放不下时中间折叠成「…」，悬停列出折叠掉的几级，点了打开那个项目
  const chain = ["一级", "二级", "三级", "四级", "五级", "六级", "七级"];
  const deepPath = await m.ev(`let parent = await invoke("create_project", { workspace: "工作", name: "多层" });
    for (const name of ${JSON.stringify(chain)}) parent = await invoke("create_project", { workspace: "工作", name, parent });
    await invoke("create_todo", { workspace: "工作", project: parent, title: "最深处的待办" });
    return parent`);
  await refresh();
  await m.expandAll();
  await m.expandAll();
  const resizer = await m.at(".resizer");
  await m.drag(resizer, { x: resizer.x - 60, y: resizer.y }, { steps: 6 });
  // 指针移开：停在哪一行上时那一行显示按钮、名字变窄
  await m.mouse("mouseMoved", { x: 900, y: 600 });
  await t.sleep(200);
  const narrow = await m.ev(`const levels = ["多层", ...${JSON.stringify(chain)}].map((_, i, a) => a.slice(0, i + 1).join("/"));
    const rows = levels.map((p) => row("工作", p));
    return {
      sidebar: document.querySelector(".sidebar").getBoundingClientRect().width,
      pads: rows.map((r) => parseFloat(r.style.paddingLeft)),
      badges: rows.map((r) => r.querySelector(".project-icon").dataset.level ?? ""),
      labels: rows.map((r) => Math.round(r.querySelector(".row-label").getBoundingClientRect().width)),
    }`);
  check(
    "侧栏拖窄后：前几级照样一级一级缩进，再深的不再往右挪、文件夹图标上标出是第几级，名字留着地方",
    narrow.sidebar <= 250 &&
      narrow.pads[1] > narrow.pads[0] &&
      narrow.pads[3] > narrow.pads[2] &&
      narrow.pads.at(-1) === narrow.pads[3] &&
      narrow.badges.slice(0, 4).every((b) => !b) &&
      narrow.badges.slice(4).join() === "5,6,7,8" &&
      narrow.labels.every((w) => w >= 60),
    narrow,
  );
  await m.ev(`document.querySelector(".resizer").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await sleep(300); return 1`);

  await m.viewport(860, 700);
  await m.ev(`row("工作", ${JSON.stringify(deepPath)}, await waitFor(() => [...document.querySelectorAll(".todo-row[data-sel]")]
      .map((r) => JSON.parse(r.dataset.sel)).find(([, p, id]) => p === ${JSON.stringify(deepPath)} && id)?.[2])).click();
    await waitFor(() => document.querySelector(".editor-title")?.value === "最深处的待办"); await sleep(500); return 1`);
  const crumb = await m.ev(`const c = document.querySelector(".editor-crumb");
    return { fits: c.scrollWidth <= c.clientWidth + 1, more: !!c.querySelector(".crumb-more"), title: c.getAttribute("title"),
      shown: [...c.querySelectorAll(".ant-breadcrumb-link")].map((e) => e.textContent) }`);
  await m.mouse("mouseMoved", await m.at(".editor-crumb .crumb-more"));
  const hiddenLevels = await t.until(() =>
    m.ev(`const items = [...document.querySelectorAll(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item")].map((e) => e.textContent);
      return items.length ? items : null`),
  );
  await m.ev(`menuItem("二级").click(); await sleep(500); return 1`);
  await m.viewport(1200, 900);
  check(
    "最小窗口宽度下打开很深的待办：编辑区上方的路径中间折叠成「…」、放得下、最后一级照样显示，悬停看完整路径",
    crumb.fits && crumb.more && crumb.shown.at(-1) === "七级" && crumb.title === `工作 / ${["多层", ...chain].join(" / ")}`,
    crumb,
  );
  check(
    "悬停「…」列出折叠掉的几级，点了打开那个项目",
    !!hiddenLevels && hiddenLevels.includes("二级") && (await selected()) === sel("工作", "多层/一级/二级"),
    { hiddenLevels, selected: await selected() },
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
