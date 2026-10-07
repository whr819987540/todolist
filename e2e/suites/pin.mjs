// 置顶
export const title = "置顶";

export default async function (t) {
  const { main: m, check } = t;
  const order = (p) =>
    m.ev(`return [...document.querySelectorAll(".sidebar .tree-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel)).filter((s) => s[1] === ${JSON.stringify(p)} && s[2]).map((s) => s[2])`);
  const sortBy = async (key) => {
    await m.ev(`localStorage.setItem("listOptions:工作", JSON.stringify({ sortKey: "${key}", hideDone: false })); return 1`);
    await m.reload();
    await m.enter("工作");
    await m.expandAll();
  };
  const find = (p, id) => t.meta("工作", p).find((x) => x.id === id);

  await sortBy("title");
  const before = find("需求", "C");
  await m.click(await m.at(["工作", "需求", "C"]), { right: true });
  await m.ev(`await sleep(300); menuItem("置顶").click(); await sleep(600); return 1`);
  const o = await order("需求");
  const after = find("需求", "C");
  check("右键「置顶」：排到项目最前面，标题前有图钉", o[0] === "C" && (await m.ev(`return !!row("工作", "需求", "C").querySelector(".pin-mark")`)), o);
  check("记在 .todos.json（pinned: true），修改时间不变", after.pinned === true && after.updatedAt === before.updatedAt, { before, after });
  await m.ev(`return await openTodo("工作", "需求", "C")`);
  check("编辑区标「已置顶」", (await m.ev(`return [...document.querySelectorAll(".ant-tag")].map((x) => x.textContent).join()`)).includes("已置顶"));

  for (const key of ["created", "updated", "title", "manual"]) {
    await sortBy(key);
    check(`按「${key}」排序时置顶的也在最前`, (await order("需求"))[0] === "C");
  }
  await m.invoke("set_todo_done", { workspace: "工作", project: "需求", id: "A", done: true });
  await m.invoke("set_todo_done", { workspace: "工作", project: "需求", id: "B", done: true });
  await m.invoke("set_todo_pinned", { workspace: "工作", project: "需求", id: "B", pinned: true });
  await sortBy("title");
  check("已完成的仍在未完成的后面，置顶的已完成排在已完成里的最前面", (await order("需求")).join() === "C,长文档,B,A", await order("需求"));
  await m.ev(`row("工作", "需求").click(); await sleep(500); return 1`);
  const overview = await m.ev(`return [...document.querySelectorAll(".main .list-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel)[2] + (r.querySelector(".pin-mark") ? "*" : ""))`);
  check("项目概览里同样排在最前、有图钉", overview.join() === "C*,长文档,B*,A", overview);

  await m.invoke("move_todo", { workspace: "工作", project: "需求", id: "C", targetWorkspace: "工作", targetProject: "日常" });
  check("移到别的项目后仍然置顶", find("日常", "C")?.pinned === true);
  await m.emit("tauri://focus");
  await t.sleep(800);
  await m.click(await m.at(["工作", "日常", "C"]), { right: true });
  await m.ev(`await sleep(300); menuItem("取消置顶").click(); await sleep(600); return 1`);
  check("取消置顶后 .todos.json 里这一项没有了", !("pinned" in find("日常", "C")), find("日常", "C"));
}
