// 按标签和优先级筛选：侧栏顶部的「筛选」弹出框（标签、优先级带条数，任一 / 全部），只列符合的待办、没有符合的项目不显示
// （右侧正在显示的照常、切走 1 秒后才藏），顶部那一行和 ×，和搜索一起用，点侧栏 / 编辑区里的标签按它筛选，项目概览跟着筛、
// 快速添加不符合时提示，筛选时不能拖动调整顺序，「全部折叠 / 全部展开」不算筛掉的，返回首页再进来还在、重新打开后没了
export const title = "按标签和优先级筛选";

export default async function (t) {
  const { main: m, check } = t;
  await m.viewport(1200, 900);
  for (const ws of ["工作", "生活"])
    await m.ev(`localStorage.setItem("listOptions:${ws}", JSON.stringify({ sortKey: "title", hideDone: false })); return 1`);
  await m.reload();
  const set = async (ws, p, id, tags, priority = 0) => {
    await m.invoke("set_todo_tags", { workspace: ws, project: p, id, tags });
    if (priority) await m.invoke("set_todo_priority", { workspace: ws, project: p, id, priority });
  };
  await set("工作", "需求", "A", ["工作", "急"], 3);
  await set("工作", "需求", "B", ["工作"], 1);
  await set("工作", "日常", "D", ["急"]);
  await set("生活", "杂事", "E", ["工作"]);
  await m.enter("工作");
  await m.selectAllWorkspaces();
  await m.expandAll();

  /** 侧栏里列出的待办（工作区/项目/id，排过序）；is(...) 是期望的（同样排序） */
  const todos = () =>
    m.ev(`return [...document.querySelectorAll(".sidebar .todo-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel).join("/")).sort().join()`);
  const is = (...list) => [...list].sort().join();
  const bar = () => m.ev(`return document.querySelector(".filter-bar-text")?.textContent.trim() ?? ""`);
  /** 打开筛选的弹出框（已经开着时不动） */
  const openPanel = async () => {
    if (!(await m.ev(`return !!document.querySelector(".ant-popover:not(.ant-popover-hidden) .filter-panel")`)))
      await m.click(await m.at(".filter-btn"));
    return m.ev(`return !!(await waitFor(() => document.querySelector(".ant-popover:not(.ant-popover-hidden) .filter-panel")))`);
  };
  /** 弹出框里的各项：文字和条数 */
  const panelItems = () =>
    m.ev(`return [...document.querySelectorAll(".ant-popover:not(.ant-popover-hidden) .filter-panel .filter-item")]
      .map((e) => e.querySelector(".ant-checkbox-wrapper").textContent.trim() + ":" + e.querySelector(".filter-count").textContent)`);
  /** 勾上 / 去掉弹出框里文字是 text 的那一项 */
  const toggle = async (text) => {
    await m.ev(`const item = await waitFor(() => [...document.querySelectorAll(".ant-popover:not(.ant-popover-hidden) .filter-panel .filter-item")]
        .find((e) => e.querySelector(".ant-checkbox-wrapper").textContent.trim() === ${JSON.stringify(text)}));
      item.querySelector("input[type=checkbox]").click(); await sleep(300); return 1`);
  };
  /** 点弹出框外面（侧栏顶部的标题）关掉它 */
  const closePanel = async () => {
    await m.click(await m.at(".sidebar-bar-title"));
    await t.sleep(300);
  };
  const clear = async () => {
    await m.ev(`document.querySelector(".filter-bar-clear")?.click(); await sleep(400); return 1`);
  };

  check("开始时没有筛选", !(await bar()) && !(await m.ev(`return document.querySelector(".filter-btn").classList.contains("is-active")`)));
  check("打开「筛选」的弹出框", await openPanel());
  const items = await panelItems();
  check(
    "列出侧栏里显示的工作区用到的标签（带条数，多的在前）和各档优先级",
    items.slice(0, 2).join() === "工作:3,急:2" && items.includes("高优先级:1") && items.includes("低优先级:1") && items.includes("中优先级:0"),
    items,
  );

  await toggle("工作");
  check("勾上「工作」：只列有这个标签的待办", (await todos()) === is("生活/杂事/E", "工作/需求/A", "工作/需求/B"), await todos());
  check(
    "没有符合的待办的项目不显示，按钮显示成开着的样子，顶部写明筛的是什么",
    !(await m.ev(`return !!row("工作", "日常") || !!row("生活", "购物")`)) &&
      (await m.ev(`return document.querySelector(".filter-btn").classList.contains("is-active")`)) &&
      (await bar()) === "筛选：标签 工作",
    await bar(),
  );
  await toggle("急");
  check(
    "再勾上「急」：标签之间默认是「任一」",
    (await todos()) === is("生活/杂事/E", "工作/日常/D", "工作/需求/A", "工作/需求/B") && (await bar()) === "筛选：标签 工作 或 急",
    { todos: await todos(), bar: await bar() },
  );
  await m.ev(`[...document.querySelectorAll(".filter-panel .ant-segmented-item")].find((e) => e.textContent === "全部").click(); await sleep(400); return 1`);
  check("切到「全部」：两个都有才算", (await todos()) === "工作/需求/A" && (await bar()) === "筛选：标签 工作 和 急", { todos: await todos(), bar: await bar() });
  await m.ev(`[...document.querySelectorAll(".filter-panel .ant-segmented-item")].find((e) => e.textContent === "任一").click(); await sleep(300); return 1`);
  await toggle("急");
  await toggle("低优先级");
  check("标签和优先级之间是「并且」", (await todos()) === "工作/需求/B" && (await bar()) === "筛选：标签 工作，优先级 低", { todos: await todos(), bar: await bar() });
  await toggle("工作");
  await toggle("低优先级");
  check("都去掉就没有筛选了", !(await bar()) && (await todos()).split(",").length >= 7, await todos());
  await closePanel();

  // 右侧正在显示的项目照常显示，切走后再显示 1 秒才藏起来
  await m.ev(`return await openTodo("生活", "购物", "GBK笔记")`);
  await m.ev(`row("生活", "杂事", "E").querySelector(".tag-chip").click(); await sleep(400); return 1`);
  check("点侧栏行上的标签：按这个标签筛选", (await bar()) === "筛选：标签 工作", await bar());
  check(
    "右侧正在显示的项目照常显示，里面写「没有符合筛选的待办」",
    await m.ev(`const r = row("生活", "购物"); return !!r && r.closest("[data-drop-project]").textContent.includes("没有符合筛选的待办")`),
  );
  await m.click(await m.at(["工作", "需求", "A"]));
  const stillThere = await m.ev(`return !!row("生活", "购物")`);
  const gone = await t.until(() => m.ev(`return !row("生活", "购物")`), 3000);
  check("切走后再显示一会儿才藏起来", stillThere && gone, { stillThere, gone });

  // 「全部折叠 / 全部展开」不算筛掉的：把看得见的项目都折叠起来后是「全部展开」（筛掉的项目还展开着）
  await m.ev(`for (const c of document.querySelectorAll(".tree .project-row .chevron.open")) c.click(); await sleep(400); return 1`);
  const collapseTitle = await m.ev(`return document.querySelector(".collapse-all-btn .anticon-column-height") ? "全部展开" : "全部折叠"`);
  check("看得见的项目都折叠了就是「全部展开」，筛掉的不算", collapseTitle === "全部展开", collapseTitle);
  await m.expandAll();

  // 编辑区上方的标签
  await m.ev(`const chip = await waitFor(() => [...document.querySelectorAll(".editor-meta .tag-editor .tag-chip")].find((e) => e.textContent === "急"));
    chip.click(); await sleep(400); return 1`);
  check("点编辑区上方的标签：按这个标签筛选", (await bar()) === "筛选：标签 急" && (await todos()) === is("工作/日常/D", "工作/需求/A"), {
    bar: await bar(),
    todos: await todos(),
  });

  // 和搜索一起用（A 的第一个标签是「工作」）
  await m.ev(`row("工作", "需求", "A").querySelector(".tag-chip").click(); await sleep(400); return 1`);
  await m.press("Ctrl+Shift+F");
  await m.type("待办");
  await t.sleep(900);
  check("和搜索一起用：都满足才列出", (await todos()) === is("工作/需求/A", "工作/需求/B"), await todos());
  await m.press("Ctrl+A");
  await m.type("日常");
  await t.sleep(900);
  check("搜索时项目名命中、其中没有符合筛选的待办的项目也不显示", !(await m.ev(`return !!row("工作", "日常")`)));
  await m.press("Escape");

  // 筛选时不能拖动调整顺序
  await m.drag(await m.at(["工作", "需求", "B"]), await m.at(["工作", "需求", "A"], -0.3), { release: false });
  const drag = await m.ev(`return { ghost: document.querySelector(".drag-ghost")?.textContent ?? "", refused: document.body.classList.contains("drag-nodrop") }`);
  await m.press("Escape");
  await m.drop(await m.at(["工作", "需求", "A"], -0.3));
  check("筛选时不能拖动调整顺序，说明原因", drag.refused && drag.ghost.includes("筛选时不能调整顺序"), drag);

  // 项目概览跟着筛
  await m.ev(`row("工作", "需求").click(); await waitFor(() => document.querySelector(".main .filter-note")); return 1`);
  const ov = await m.ev(`return { rows: [...document.querySelectorAll(".main .list-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel)[2]).sort().join(),
    note: document.querySelector(".main .filter-note")?.textContent ?? "" }`);
  check("项目概览的待办列表也跟着筛，上面写明显示几条、共几条", ov.rows === "A,B" && ov.note.includes("显示 2 条，共 4 条"), ov);
  await m.clearToasts();
  await m.ev(`const input = document.querySelector(".quick-add input"); input.focus(); return 1`);
  await m.type("快速添加的");
  await m.press("Enter");
  const toast = await t.until(async () => (await m.toast()).includes("不符合现在的筛选") && (await m.toast()));
  check("快速添加的不符合筛选时提示", !!toast, await m.toast());

  // 返回首页再进来还在；重新打开（页面重新加载）后没了
  await m.enter("工作");
  check("返回首页再进来，筛选还在", (await bar()) === "筛选：标签 工作");
  await clear();
  check("点顶部那一行的 × 清除筛选", !(await bar()) && (await m.ev(`return !!row("工作", "日常")`)));
  await m.ev(`row("工作", "需求", "A").querySelector(".tag-chip").click(); await sleep(300); return 1`);
  await m.reload();
  await m.enter("工作");
  check("只记在这次运行期间：重新打开后没有筛选", !(await bar()));
}
