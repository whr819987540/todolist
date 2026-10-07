// 批量操作：Ctrl / Shift+单击多选待办
export const title = "批量操作";

export default async function (t) {
  const { main: m, check } = t;
  await m.viewport(1200, 900);
  await m.ev(`for (const ws of ["工作", "生活"]) localStorage.setItem("listOptions:" + ws, JSON.stringify({ sortKey: "title", hideDone: false })); return 1`);
  await m.reload();
  await m.enter("工作");
  await m.selectAllWorkspaces();
  await m.expandAll();

  const picked = () => m.ev(`return [...document.querySelectorAll(".sidebar .tree-row.picked")].map((r) => JSON.parse(r.dataset.sel).join("/"))`);
  const panel = () => m.ev(`return document.querySelector(".overview.batch h2")?.textContent ?? null`);
  const at = (ws, p, id) => m.at([ws, p, id]);
  const pick = async (ws, p, id, how = "ctrl") => m.click(await at(ws, p, id), { [how]: true });
  const batchButton = (text) => m.ev(`button(${JSON.stringify(text)}, document.querySelector(".batch-actions")).click(); await sleep(800); return 1`);
  const todo = (ws, p, id) => t.meta(ws, p).find((x) => x.id === id);

  await m.ev(`return await openTodo("工作", "需求", "A")`);
  await pick("工作", "需求", "B");
  check("打开着 A 时 Ctrl+单击 B：两条都选中，右侧显示批量操作", (await picked()).join() === "工作/需求/A,工作/需求/B" && (await panel()) === "已选择 2 条待办", await picked());
  await pick("工作", "需求", "B");
  check("Ctrl+单击选中的那条取消它", (await panel()) === null);
  await m.click(await at("工作", "需求", "B"));
  await pick("生活", "杂事", "E", "shift");
  // 显示顺序：工作 / 日常（D）、需求（长文档、A、B、C），生活 / 购物（GBK笔记）、杂事（E）
  check("Shift+单击选中一段：按列表里显示的顺序，可以跨项目、跨工作区", (await picked()).join() === "工作/需求/B,工作/需求/C,生活/购物/GBK笔记,生活/杂事/E", await picked());

  await m.clearToasts();
  await batchButton("标记为已完成");
  check("批量标记为已完成", todo("工作", "需求", "B").done && todo("生活", "杂事", "E").done && (await m.toast()).includes("已把 4 条标记为已完成"));
  await batchButton("标记为未完成");
  check("批量标记为未完成", !todo("工作", "需求", "B").done && !todo("生活", "杂事", "E").done);
  await batchButton("置顶");
  check("批量置顶", todo("工作", "需求", "C").pinned && todo("生活", "杂事", "E").pinned);
  await batchButton("取消置顶");
  check("批量取消置顶", !todo("工作", "需求", "C").pinned);
  await m.ev(`button("移动到", document.querySelector(".batch-actions")).click(); await sleep(500); return 1`);
  const groups = await m.ev(`return [...document.querySelectorAll(".move-menu .ant-dropdown-menu-item-group-title")].map((e) => e.textContent)`);
  // 「学习」里没有项目，不列
  check("「移动到」按工作区分组列出侧栏里显示的工作区的项目", groups.join() === "工作,生活", groups);
  await m.press("Escape");
  await t.sleep(300);
  check("菜单开着时 Esc 只关菜单", (await panel()) !== null);
  await m.click(await at("工作", "需求", "C"), { right: true });
  await t.sleep(400);
  const menu = await m.ev(`return [...document.querySelectorAll(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item")].map((e) => e.textContent)`);
  check("在选中的待办上右键是批量的菜单", menu[0] === "4 条标记为已完成" && menu.includes("删除 4 条"), menu);
  await m.press("Escape");
  await t.sleep(300);
  check("右键菜单开着时 Esc 只关菜单", (await panel()) !== null);

  await m.ev(`document.activeElement?.blur(); return 1`);
  await m.press("Ctrl+Alt+D");
  await t.sleep(800);
  check("「标记完成 / 未完成」的快捷键作用于选中的这些", todo("工作", "需求", "B").done && todo("生活", "杂事", "E").done);
  await m.press("Ctrl+Alt+D");
  await t.sleep(800);
  await m.press("Escape");
  await t.sleep(300);
  check("Esc 取消选择", (await panel()) === null && !(await picked()).length);

  await m.click(await at("工作", "需求", "A"));
  await pick("工作", "需求", "B");
  await m.click(await at("工作", "需求", "C"));
  check("普通单击取消多选", (await panel()) === null);
  await pick("工作", "需求", "B");
  await m.ev(`document.querySelector(".sidebar [tabindex='0']")?.focus(); return 1`);
  await m.press("ArrowDown");
  await t.sleep(300);
  check("用键盘移动取消多选", (await panel()) === null);

  // 一起拖到别的项目，打开着的跟过去，右侧不闪「待办不存在」
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  await pick("工作", "需求", "B");
  await m.drag(await at("工作", "需求", "B"), await m.at(["生活", "购物"]), { release: false });
  const ghost = await m.ev(`return document.querySelector(".drag-ghost")?.textContent ?? ""`);
  await m.mouse("mouseReleased", await m.at(["生活", "购物"]), { button: "left", buttons: 0, clickCount: 1 });
  const flashes = [];
  for (let i = 0; i < 12; i++) {
    flashes.push(await m.ev(`return document.querySelector(".main")?.textContent.includes("不存在") ?? false`));
    await t.sleep(80);
  }
  await t.sleep(500);
  check("按住选中的一条拖到别的项目，选中的一起移过去", ghost.includes("2 条待办") && t.exists("生活/购物/A.md") && t.exists("生活/购物/B.md"), ghost);
  check("移的时候右侧不闪「待办不存在」，打开着的 A 跟过去", !flashes.some(Boolean) && (await m.ev(`return document.querySelector(".editor-title")?.value`)) === "A", flashes);
  await m.click(await at("生活", "购物", "A"));
  await pick("生活", "购物", "B");
  await m.ev(`button("移动到", document.querySelector(".batch-actions")).click(); await sleep(500);
    [...document.querySelectorAll(".move-menu .ant-dropdown-menu-item")].find((e) => e.textContent === "需求").click(); await sleep(1200); return 1`);
  check("批量「移动到」", t.exists("工作/需求/A.md") && t.exists("工作/需求/B.md"));

  // 部分没成功：提示失败的条数和原因，成功的照常算
  await m.click(await at("工作", "需求", "A"));
  await pick("工作", "需求", "B");
  t.remove("工作/需求/B.md");
  await m.clearToasts();
  await batchButton("置顶");
  const toast = await m.toast();
  check("部分没成功时提示失败的条数和原因，成功的照常算", /1 条没有成功/.test(toast) && todo("工作", "需求", "A").pinned, toast);
  await m.invoke("set_todo_pinned", { workspace: "工作", project: "需求", id: "A", pinned: false });
  t.write("工作/需求/B.md", "# 待办 B\n");
  await m.press("F5");
  await t.sleep(800);
  await m.click(await at("工作", "需求", "A"));
  await pick("工作", "需求", "B");
  t.remove("工作/需求/B.md");
  await m.press("F5");
  await t.sleep(1000);
  check("选中的有一条在外部删掉了，F5 后不再显示批量操作，剩下那条也不高亮", (await panel()) === null && !(await picked()).length);
  t.write("工作/需求/B.md", "# 待办 B\n");
  await m.press("F5");
  await t.sleep(800);

  // Delete 删除（先确认），一次撤销恢复全部
  await m.click(await at("工作", "需求", "A"));
  await pick("工作", "需求", "B");
  await m.ev(`document.activeElement?.blur(); return 1`);
  await m.press("Delete");
  await t.sleep(500);
  const confirm = await m.ev(`return document.querySelector(".ant-modal-confirm-title")?.textContent`);
  await m.ev(`button("删除", document.querySelector(".ant-modal-confirm-btns")).click(); await sleep(1000); return 1`);
  check("Delete 删除选中的（先确认）", confirm === "删除选中的 2 条待办？" && !t.exists("工作/需求/A.md") && !t.exists("工作/需求/B.md"), confirm);
  await m.ev(`[...document.querySelectorAll(".ant-message-notice .undo-link")].at(-1).click(); await sleep(1200); return 1`);
  check("批量删除后一次「撤销」恢复全部", t.exists("工作/需求/A.md") && t.exists("工作/需求/B.md"));

  await m.click(await at("工作", "需求", "A"));
  await pick("工作", "需求", "B");
  await m.enter("工作");
  check("返回首页再进来，多选已取消", (await panel()) === null && !(await picked()).length);
  await m.viewport(0);
}
