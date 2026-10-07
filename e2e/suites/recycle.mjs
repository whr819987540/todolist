// 软件的回收站和撤销，彻底删除后在 Windows 回收站里的来回
import { readdirSync, readFileSync } from "node:fs";

export const title = "回收站和撤销";

export default async function (t) {
  const { main: m, check, win } = t;
  await m.viewport(1200, 900);
  await m.enter("工作");
  await m.selectAllWorkspaces();
  await m.expandAll();
  const recycled = () => (t.exists(".recycle") ? readdirSync(t.file(".recycle")) : []);
  const menu = async (sel, text) => {
    await m.click(await m.at(sel), { right: true });
    await m.ev(`await sleep(300); menuItem(${JSON.stringify(text)}).click(); return 1`);
  };
  const confirm = (text = "删除") =>
    m.ev(`await sleep(300); button(${JSON.stringify(text)}, document.querySelector(".ant-modal-confirm-btns, .ant-popconfirm-buttons")).click(); await sleep(1000); return 1`);
  const undo = () => m.ev(`[...document.querySelectorAll(".ant-message-notice .undo-link")].at(-1).click(); await sleep(1500); return 1`);
  const openBin = (where) =>
    m.ev(`${where === "home" ? `button("回收站").click()` : `document.querySelector(".sidebar-recycle").click()`}; await sleep(800); return 1`);
  const binTitles = () => m.ev(`return [...document.querySelectorAll(".recycle-row .list-title")].map((e) => e.textContent)`);
  const binAction = (titleText, action) =>
    m.ev(`const r = [...document.querySelectorAll(".recycle-row")].find((r) => r.querySelector(".list-title").textContent === ${JSON.stringify(titleText)});
      ${action === "restore" ? `button("恢复", r).click()` : `r.querySelector(".anticon-delete").closest("button").click()`}; await sleep(800); return 1`);

  // 删除正打开着的待办，撤销后重新打开
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  await m.clearToasts();
  await menu(["工作", "需求", "A"], "删除");
  await confirm();
  const [rid] = recycled();
  const entry = rid ? JSON.parse(readFileSync(t.file(`.recycle/${rid}/entry.json`), "utf8")) : null;
  check("删除的待办连同说明放进数据目录的 .recycle", entry?.kind === "todo" && entry.todo?.title === "A" && t.exists(`.recycle/${rid}/A.md`) && !t.exists("工作/需求/A.md"), entry);
  check("提示里有「撤销」", /已删除待办「A」撤销/.test(await m.toast()));
  await undo();
  check("撤销后回到原处，删的是正打开着的待办时重新打开它",
    t.exists("工作/需求/A.md") && !recycled().length && (await m.ev(`return document.querySelector(".editor-title")?.value`)) === "A");

  await menu(["工作", "日常"], "删除项目");
  await confirm();
  const projectGone = !t.exists("工作/日常");
  await undo();
  check("删除项目后撤销", projectGone && t.exists("工作/日常/D.md") && (await m.ev(`return !!row("工作", "日常")`)));

  await m.invoke("create_project", { workspace: "学习", name: "英语" });
  await m.invoke("create_todo", { workspace: "学习", project: "英语", title: "背单词", content: "abandon" });
  await m.emit("tauri://focus");
  await t.sleep(800);
  await menu(["学习"], "删除工作区");
  await confirm();
  const wsGone = !t.exists("学习") && !(await m.ev(`return !!row("学习")`));
  await undo();
  await t.sleep(500);
  check("删除工作区后撤销：重新出现在侧栏", wsGone && t.exists("学习/英语") && (await m.ev(`return !!row("学习")`)));

  await menu(["学习", "英语"], "删除项目");
  await confirm();
  await m.ev(`document.querySelector(".anticon-home")?.closest("button")?.click(); await sleep(500); return 1`);
  const cards = await m.ev(`return [...document.querySelectorAll(".ws-card")].map((c) => c.textContent)`);
  check("回收站不会被当成工作区，也不会被搜到",
    !cards.some((c) => c.includes("recycle")) && !(await m.invoke("search_todos", { workspaces: null, keyword: "abandon" })).length, cards);

  // 首页的「回收站」：恢复时标题、完成状态、置顶、创建时间都在
  const x = await m.invoke("create_todo", { workspace: "工作", project: "需求", title: "带说明的", content: "正文X" });
  await m.invoke("set_todo_done", { workspace: "工作", project: "需求", id: x.id, done: true });
  await m.invoke("set_todo_pinned", { workspace: "工作", project: "需求", id: x.id, pinned: true });
  const xBefore = t.meta("工作", "需求").find((y) => y.id === x.id);
  await m.invoke("delete_todo", { workspace: "工作", project: "需求", id: x.id });
  await openBin("home");
  check("首页的「回收站」：最近删除的在前", (await binTitles()).join() === "带说明的,英语", await binTitles());
  await m.ev(`setInput(document.querySelector(".recycle-search input"), "英语"); await sleep(300); return 1`);
  check("可以按名称查找", (await binTitles()).join() === "英语");
  await m.ev(`setInput(document.querySelector(".recycle-search input"), ""); await sleep(300); return 1`);
  await binAction("带说明的", "restore");
  const xAfter = t.meta("工作", "需求").find((y) => y.id === x.id);
  check("恢复到原来的位置：标题、完成状态、置顶、创建时间都在",
    xAfter?.title === "带说明的" && xAfter.done && xAfter.pinned && xAfter.createdAt === xBefore.createdAt && t.read(`工作/需求/${x.id}.md`) === "正文X", xAfter);
  await m.closeModal();

  // 原来的项目不在了 / 名字被占用了
  const y = await m.invoke("create_todo", { workspace: "生活", project: "购物", title: "孤儿", content: "" });
  const ry = await m.invoke("delete_todo", { workspace: "生活", project: "购物", id: y.id });
  const rp = await m.invoke("delete_project", { workspace: "生活", name: "购物" });
  let r = await m.invoke("restore_recycled", { ids: [ry] });
  check("原来的项目已经删了：恢复待办时重新建", r.restored[0]?.project === "购物" && t.exists(`生活/购物/${y.id}.md`), r);
  r = await m.invoke("restore_recycled", { ids: [rp] });
  check("同名的项目已经有了：恢复的加「（恢复）」", r.restored[0]?.project === "购物（恢复）" && r.restored[0].renamed && t.exists("生活/购物（恢复）/GBK笔记.md"), r);

  // 彻底删除 → Windows 回收站（名字是标题加 id），从那里还原后又能恢复
  await m.enter("工作");
  const z = await m.invoke("create_todo", { workspace: "工作", project: "需求", title: "要彻底删除的", content: "Z" });
  const rz = await m.invoke("delete_todo", { workspace: "工作", project: "需求", id: z.id });
  await openBin("sidebar");
  check("侧栏底部的「回收站」", (await binTitles())[0] === "要彻底删除的");
  await binAction("要彻底删除的", "purge");
  await confirm("删除");
  const inBin = win.recycleBin();
  check("彻底删除：连同说明移到 Windows 回收站，名字是「标题（id）」", inBin.some((b) => b.name === `要彻底删除的（${rz}）` && b.from === "\\.recycle") && !recycled().includes(rz), inBin);
  win.undelete(`要彻底删除的（${rz}）`);
  await t.sleep(800);
  await m.closeModal();
  await openBin("sidebar");
  check("从 Windows 回收站还原后又出现在软件的回收站里", (await binTitles()).includes("要彻底删除的"));
  await binAction("要彻底删除的", "restore");
  check("还能恢复到原来的位置", t.exists(`工作/需求/${z.id}.md`) && t.meta("工作", "需求").some((w) => w.id === z.id && w.title === "要彻底删除的"));

  const left = recycled().length;
  await m.clearToasts();
  await m.ev(`button("清空", document.querySelector(".recycle-foot")).click(); return 1`);
  await confirm("清空");
  check("清空回收站：都移到 Windows 回收站", !recycled().length && (await m.toast()).includes(`已清空回收站，${left} 项移到了 Windows 回收站`), await m.toast());
  await m.closeModal();

  // 文件被占用时删除失败，数据原样不动
  let lock = await win.lockFile(t.file("工作/需求/B.md"), 5);
  await m.clearToasts();
  await menu(["工作", "需求", "B"], "删除");
  await confirm();
  check("文件正被别的程序占用时删除待办：提示失败，原样不动",
    /删除失败/.test(await m.toast()) && t.exists("工作/需求/B.md") && t.meta("工作", "需求").some((w) => w.id === "B") && !recycled().length, await m.toast());
  await lock.released;
  lock = await win.lockFile(t.file("工作/日常/D.md"), 5);
  await m.clearToasts();
  await menu(["工作", "日常"], "删除项目");
  await confirm();
  check("项目里有文件被占用时删除项目：提示失败，原样不动", /删除失败/.test(await m.toast()) && t.exists("工作/日常/D.md") && !recycled().length, await m.toast());
  await lock.released;

  // 放满 30 天的：启动后移到 Windows 回收站；从那里还原的不会又被移走
  const old = await m.invoke("create_todo", { workspace: "工作", project: "日常", title: "放了很久的", content: "old" });
  const rold = await m.invoke("delete_todo", { workspace: "工作", project: "日常", id: old.id });
  const entryPath = `.recycle/${rold}/entry.json`;
  const e = JSON.parse(t.read(entryPath));
  e.deletedAt -= 31 * 86_400_000;
  await t.quit();
  t.write(entryPath, JSON.stringify(e));
  await t.restart();
  await t.sleep(4000);
  const expired = win.recycleBin().some((b) => b.name === `放了很久的（${rold}）`);
  check("放满 30 天的，启动后（3 秒）移到 Windows 回收站", expired && !recycled().includes(rold));
  win.undelete(`放了很久的（${rold}）`);
  await t.sleep(800);
  await t.restart();
  await t.sleep(4000);
  const back = await t.main.invoke("list_recycle");
  check("从 Windows 回收站还原回来的，下次启动不会又被移走", back.some((b) => b.title === "放了很久的"), back);
  r = await t.main.invoke("restore_recycled", { ids: [back.find((b) => b.title === "放了很久的").id] });
  check("还原回来的还能恢复到原来的位置", r.restored[0]?.project === "日常" && t.exists(`工作/日常/${r.restored[0].todoId}.md`), r);
}
