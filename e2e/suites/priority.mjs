// 优先级：编辑区上方的下拉、右键「优先级」子菜单（当前的打勾）、批量「设置优先级」，侧栏和项目概览里的小旗子，
// 悬停提示和标签页的悬停说明，「按优先级」排序（置顶的仍在前、已完成的仍沉底），修改时间不变，移动后还在
export const title = "优先级";

export default async function (t) {
  const { main: m, check } = t;
  await m.viewport(1200, 900);
  await m.ev(`localStorage.setItem("listOptions:工作", JSON.stringify({ sortKey: "title", hideDone: false })); return 1`);
  await m.reload();
  await m.enter("工作");
  await m.expandAll();

  const meta = (p, id) => t.meta("工作", p).find((x) => x.id === id);
  const flag = (p, id) =>
    m.ev(`const f = row("工作", ${JSON.stringify(p)}, ${JSON.stringify(id)})?.querySelector(".prio-flag"); return f ? f.getAttribute("class").match(/prio-\\d/)[0] : ""`);
  const order = () =>
    m.ev(`return [...document.querySelectorAll(".sidebar .todo-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel)).filter((s) => s[1] === "需求").map((s) => s[2])`);
  /** 右键菜单开着时，把指针移到子菜单 text 上，等子菜单弹出来，返回其中的项（文字、打没打勾） */
  const openSub = async (text) => {
    const p = await m.ev(`const e = await waitFor(() => [...document.querySelectorAll(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-submenu-title")]
        .find((x) => x.textContent.includes(${JSON.stringify(text)})));
      const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }`);
    await m.mouse("mouseMoved", p);
    return t.until(() =>
      m.ev(`const items = [...document.querySelectorAll(".ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden) .ant-dropdown-menu-item")]
        .map((e) => ({ text: e.textContent.trim(), checked: !!e.querySelector(".anticon-check") })); return items.length ? items : null`),
    );
  };

  // 编辑区上方的下拉
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  const before = meta("需求", "A");
  check("编辑区上方显示「无优先级」", (await m.ev(`return document.querySelector(".editor-meta .prio-select")?.textContent ?? ""`)).includes("无优先级"));
  await m.click(await m.at(".editor-meta .prio-select"));
  await m.ev(`const o = await waitFor(() => [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")]
      .find((e) => e.textContent === "高优先级"));
    o.click(); await sleep(600); return 1`);
  const after = meta("需求", "A");
  check("下拉里选「高优先级」：记在 .todos.json（priority: 3），修改时间不变", after.priority === 3 && after.updatedAt === before.updatedAt, { before, after });
  check("侧栏行的标题前有红旗子，编辑区上方显示「高优先级」", (await flag("需求", "A")) === "prio-3" &&
    (await m.ev(`return document.querySelector(".editor-meta .prio-select").textContent`)).includes("高优先级"));

  // 右键「优先级」子菜单
  await m.click(await m.at(["工作", "需求", "B"]), { right: true });
  let items = await openSub("优先级");
  check("右键「优先级」：从高到低四档，现在的（无）打勾", items?.map((x) => x.text + (x.checked ? "✓" : "")).join() === "高优先级,中优先级,低优先级,无优先级✓", items);
  await m.ev(`menuItem("中优先级").click(); await sleep(600); return 1`);
  check("选「中优先级」后是橙旗子", meta("需求", "B").priority === 2 && (await flag("需求", "B")) === "prio-2", meta("需求", "B"));
  await m.click(await m.at(["工作", "需求", "B"]), { right: true });
  items = await openSub("优先级");
  check("再右键时打勾的是「中优先级」", items?.find((x) => x.checked)?.text === "中优先级", items);
  await m.press("Escape");
  await t.sleep(300);

  // 批量「设置优先级」
  await m.click(await m.at(["工作", "需求", "C"]));
  await m.click(await m.at(["工作", "需求", "长文档"]), { ctrl: true });
  await m.clearToasts();
  await m.ev(`button("设置优先级", document.querySelector(".batch-actions")).click();
    const item = await waitFor(() => menuItem("低优先级")); item.click(); return 1`);
  const batchDone = await t.until(async () => meta("需求", "C").priority === 1 && meta("需求", "长文档").priority === 1 && (await m.toast()).includes("已把 2 条设为低优先级"));
  check("批量「设置优先级」", batchDone, { C: meta("需求", "C"), long: meta("需求", "长文档"), toast: await m.toast() });
  check("低优先级是蓝旗子", (await flag("需求", "C")) === "prio-1");
  await m.press("Escape");
  await t.sleep(300);

  // 悬停提示、标签页的悬停说明
  await m.mouse("mouseMoved", await m.at(["工作", "需求", "A"]));
  const tip = await m.ev(`return (await waitFor(() => document.querySelector(".todo-tip")?.textContent, 3000)) ?? ""`);
  check("侧栏行的悬停提示里写明优先级", tip.includes("高优先级"), tip);
  await m.mouse("mouseMoved", { x: 900, y: 600 });
  const tabTitle = await m.ev(`return document.querySelector(".editor-tab[data-tab='" + JSON.stringify(["工作", "需求", "C"]) + "']")?.title ?? ""`);
  check("标签页的悬停说明里写明优先级", tabTitle.includes("优先级：低"), tabTitle);

  // 按优先级排序
  await m.ev(`document.querySelector(".sidebar-bar .anticon-sort-ascending").closest("button").click();
    const item = await waitFor(() => menuItem("按优先级")); item.click(); await sleep(500); return 1`);
  const sorted = await order();
  check(
    "排序按钮里「按优先级」：高的在前，同一档里新建的在前",
    sorted[0] === "A" && sorted[1] === "B" && sorted.slice(2).sort().join() === "C,长文档",
    sorted,
  );
  check("每个工作区记在本机", await m.ev(`return JSON.parse(localStorage.getItem("listOptions:工作")).sortKey === "priority"`));
  await m.invoke("set_todo_done", { workspace: "工作", project: "需求", id: "A", done: true });
  await m.invoke("set_todo_pinned", { workspace: "工作", project: "需求", id: "长文档", pinned: true });
  await m.emit("tauri://focus");
  await t.until(async () => (await order())[0] === "长文档");
  const mixed = await order();
  check("仍是置顶的在前、已完成的沉底", mixed.join() === "长文档,B,C,A", mixed);
  await m.ev(`row("工作", "需求").click(); await waitFor(() => document.querySelector(".main .list-row[data-sel] .prio-flag")); return 1`);
  const overview = await m.ev(`return [...document.querySelectorAll(".main .list-row[data-sel]")].map((r) =>
    JSON.parse(r.dataset.sel)[2] + ":" + (r.querySelector(".prio-flag")?.getAttribute("class").match(/prio-\\d/)[0] ?? ""))`);
  check("项目概览里同样按优先级排、有小旗子", overview.join() === "长文档:prio-1,B:prio-2,C:prio-1,A:prio-3", overview);

  // 深色模式下换一套颜色
  const colors = await m.ev(`const f = document.querySelector(".main .prio-3");
    const light = getComputedStyle(f).color;
    document.documentElement.dataset.theme = "dark"; const dark = getComputedStyle(f).color;
    document.documentElement.dataset.theme = "light"; return { light, dark }`);
  check("深色模式下旗子换成亮一些的颜色", colors.light !== colors.dark, colors);

  // 移到别的项目后还在
  await m.invoke("move_todo", { workspace: "工作", project: "需求", id: "B", targetWorkspace: "工作", targetProject: "日常" });
  check("移到别的项目后优先级还在", meta("日常", "B")?.priority === 2, meta("日常", "B"));
}
