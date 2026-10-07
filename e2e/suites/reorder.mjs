// 手动排序：在同一项目里拖动待办调整位置
export const title = "手动排序（拖动）";

export default async function (t) {
  const { main: m, check } = t;
  await m.viewport(1200, 900);
  await m.ev(`localStorage.setItem("listOptions:工作", JSON.stringify({ sortKey: "title", hideDone: false })); return 1`);
  await m.reload();
  await m.enter("工作");
  await m.expandAll();
  await m.ev(`row("工作").click(); await sleep(300); return 1`);

  const order = () =>
    m.ev(`return [...document.querySelectorAll(".sidebar .tree-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel)).filter((s) => s[1] === "需求" && s[2]).map((s) => s[2])`);
  const dragInfo = () =>
    m.ev(`return { ghost: document.querySelector(".drag-ghost")?.textContent ?? "",
      line: [...document.querySelectorAll(".drop-before, .drop-after")].map((e) => JSON.parse(e.dataset.sel)[2] + ":" + (e.classList.contains("drop-before") ? "before" : "after")),
      refused: document.body.classList.contains("drag-nodrop") }`);
  const refresh = async () => {
    await m.emit("tauri://focus");
    await t.sleep(800);
  };
  const updated = Object.fromEntries(t.meta("工作", "需求").map((x) => [x.id, x.updatedAt]));

  // 中文按拼音排在英文前面
  check("开始时按标题排序", (await order()).join() === "长文档,A,B,C", await order());
  const from = await m.at(["工作", "需求", "C"]);
  await m.drag(from, await m.at(["工作", "需求", "A"], -0.3), { release: false });
  let d = await dragInfo();
  check("拖到另一条的上半截：插入线画在它前面，说明「放在「A」前面」", d.ghost.includes("放在「A」前面") && d.line.join() === "A:before", d);
  const lower = await m.at(["工作", "需求", "A"], 0.3);
  await m.mouse("mouseMoved", lower, { button: "left", buttons: 1 });
  await t.sleep(100);
  d = await dragInfo();
  check("下半截：放在后面", d.ghost.includes("放在「A」后面") && d.line.join() === "A:after", d);
  await m.clearToasts();
  await m.drop(lower);
  check("松开后位置变了", (await order()).join() === "长文档,A,C,B", await order());
  check("没在手动排序时提示「已改为手动排序」，排序按钮里换成手动排序",
    (await m.toast()).includes("已改为手动排序") && JSON.parse(await m.ev(`return localStorage.getItem("listOptions:工作")`)).sortKey === "manual");
  const meta = t.meta("工作", "需求");
  check("顺序记在 .todos.json，修改时间不变", meta.every((x) => x.updatedAt === updated[x.id] && Number.isInteger(x.order)), meta);

  // 项目概览里拖
  await m.ev(`row("工作", "需求").click(); await sleep(500); return 1`);
  const ov = (id) => `.main .list-row[data-sel='${JSON.stringify(["工作", "需求", id])}']`;
  await m.drag(await m.at(ov("B")), await m.at(ov("长文档"), -0.3));
  check("在项目概览里拖动也能调整", (await order()).join() === "B,长文档,A,C", await order());
  check("项目概览的顺序跟着变",
    (await m.ev(`return [...document.querySelectorAll(".main .list-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel)[2]).join()`)) === "B,长文档,A,C");

  // 已完成的、置顶的各排各的
  await m.invoke("set_todo_done", { workspace: "工作", project: "需求", id: "C", done: true });
  await refresh();
  await m.drag(await m.at(["工作", "需求", "C"]), await m.at(["工作", "需求", "A"], -0.3), { release: false });
  d = await dragInfo();
  await m.drop(await m.at(["工作", "需求", "A"], -0.3));
  check("已完成的不能拖到未完成的旁边，说明原因", d.refused && d.ghost.includes("已完成的排在未完成的后面"), d);
  await m.invoke("set_todo_done", { workspace: "工作", project: "需求", id: "C", done: false });
  await m.invoke("set_todo_pinned", { workspace: "工作", project: "需求", id: "A", pinned: true });
  await refresh();
  await m.drag(await m.at(["工作", "需求", "A"]), await m.at(["工作", "需求", "C"], 0.3), { release: false });
  d = await dragInfo();
  await m.drop(await m.at(["工作", "需求", "C"], 0.3));
  check("置顶的不能拖到没置顶的旁边，说明原因", d.refused && d.ghost.includes("置顶的排在最前面"), d);
  await m.invoke("set_todo_pinned", { workspace: "工作", project: "需求", id: "A", pinned: false });
  await refresh();

  // 搜索时不能调整顺序
  await m.press("Ctrl+Shift+F");
  await m.type("第");
  await t.sleep(800);
  await m.drag(await m.at(["工作", "需求", "B"]), await m.at(["工作", "需求", "A"], -0.3), { release: false });
  d = await dragInfo();
  await m.drop(await m.at(["工作", "需求", "A"], -0.3));
  check("搜索时不能调整顺序", d.refused && d.ghost.includes("搜索时不能调整顺序"), d);
  await m.ev(`document.querySelector(".sidebar input").focus(); return 1`);
  await m.press("Escape");

  const created = await m.invoke("create_todo", { workspace: "工作", project: "需求", title: "新建的", content: "" });
  await refresh();
  check("手动排序下新建的待办在最前面", (await order())[0] === created.id, await order());
  await m.drag(await m.at(["工作", "需求", created.id]), await m.at(["工作", "日常"]));
  check("拖到别的项目上照常是移动，移过去的没有位置（排在最前）",
    t.exists(`工作/日常/${created.id}.md`) && t.meta("工作", "日常").find((x) => x.id === created.id)?.order === undefined);

  const before = await order();
  await m.reload();
  await m.enter("工作");
  await m.expandAll();
  check("重新打开后顺序不变", (await order()).join() === before.join(), { before, after: await order() });
  await m.viewport(0);
}
