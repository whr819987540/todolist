// 隐藏全部完成的项目：侧栏「隐藏已完成」里的第二个选项；空项目不算，右侧正在显示的不藏，搜索时不藏，只影响侧栏
export const title = "隐藏全部完成的项目";

export default async function (t) {
  const { main: m, check } = t;
  await m.viewport(1200, 900);
  await m.enter("工作");
  await m.expandAll();

  const visible = (p) => m.ev(`return !!row("工作", ${JSON.stringify(p)})`);
  const hint = () => m.ev(`return document.querySelector(".hidden-projects")?.textContent.trim() ?? ""`);
  const refresh = async () => {
    await m.emit("tauri://focus");
    await t.sleep(800);
  };
  /** 点开侧栏顶部的「隐藏已完成」，点其中的一项 */
  const toggle = async (text) => {
    await m.click(await m.at(".hide-done-btn"));
    await m.ev(`const item = await waitFor(() => [...document.querySelectorAll(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item")]
        .find((e) => e.textContent.includes(${JSON.stringify(text)})));
      item.click(); await sleep(400); return 1`);
  };
  /** 在外部标完成 / 未完成，刷新后等侧栏上那一行的勾选框跟着变（行藏起来了也算） */
  const setDone = async (p, id, done) => {
    await m.invoke("set_todo_done", { workspace: "工作", project: p, id, done });
    await refresh();
    await t.until(() =>
      m.ev(`const r = row("工作", ${JSON.stringify(p)}, ${JSON.stringify(id)});
        return !r || r.querySelector(".check").classList.contains("checked") === ${done}`),
    );
  };

  // 「日常」里只有一条 D：标完成后就是全部完成的项目；先打开它放进标签里，后面看经标签打开时的样子
  await m.ev(`return await openTodo("工作", "日常", "D")`);
  await m.ev(`view().focus(); return 1`);
  await m.type(" ");
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  await setDone("日常", "D", true);
  await m.invoke("create_project", { workspace: "工作", name: "空项目" });
  await refresh();
  check("没开这一项时，全部完成的项目照常显示", await visible("日常"));

  await toggle("隐藏全部完成的项目");
  check("开了以后全部完成的项目不显示", !(await visible("日常")) && (await visible("需求")));
  check("没有待办的项目不算全部完成，照常显示", await visible("空项目"));
  check("工作区下面显示「已隐藏 1 个全部完成的项目，显示」", (await hint()) === "已隐藏 1 个全部完成的项目，显示", await hint());
  check("按钮显示成已隐藏的样子", await m.ev(`return document.querySelector(".hide-done-btn").classList.contains("is-active")`));
  check(
    "每个工作区各自记在本机",
    await m.ev(`return JSON.parse(localStorage.getItem("listOptions:工作")).hideDoneProjects === true`),
  );

  // 右侧正在显示的项目照常显示，切走后才藏
  await m.click(await m.at(`.editor-tab[data-tab='${JSON.stringify(["工作", "日常", "D"])}'] .editor-tab-label`));
  const viaTab = () =>
    m.ev(`return { project: !!row("工作", "日常"), todo: !!row("工作", "日常", "D"), title: document.querySelector(".editor-title")?.value }`);
  const opened = await t.until(async () => {
    const v = await viaTab();
    return v.title === "D" && v.project && v.todo;
  });
  check("经标签打开全部完成的项目里的待办：项目照常显示", opened, await viaTab());
  await m.ev(`row("工作", "需求", "A").click(); await sleep(400); return 1`);
  check("切到别处后藏起来", !(await visible("日常")));
  await m.ev(`row("工作").click(); await sleep(400);
    [...document.querySelectorAll(".overview .card")].find((c) => c.textContent.includes("日常")).click(); await sleep(400); return 1`);
  check("工作区概览里照常列出；点进去看项目概览时侧栏照常显示", await visible("日常"));
  await m.ev(`row("工作", "需求").click(); await sleep(400); return 1`);

  // 搜索时不藏
  await m.press("Ctrl+Shift+F");
  await m.type("日常");
  await t.sleep(600);
  check("侧栏搜索时，名字命中的全部完成的项目照常列出", await visible("日常"));
  await m.press("Escape");
  await t.sleep(300);
  check("清空搜索后又藏起来", !(await visible("日常")));

  // 里面有一条变成未完成：又显示出来
  await setDone("日常", "D", false);
  check("里面的待办改回未完成：又显示出来，提示没了", (await visible("日常")) && (await hint()) === "", await hint());
  await setDone("日常", "D", true);
  check("再标完成：又藏起来", !(await visible("日常")));

  // 「显示」：关掉这一项
  await m.ev(`document.querySelector(".hidden-projects a").click(); await sleep(400); return 1`);
  check(
    "点「显示」：这个工作区不再隐藏全部完成的项目",
    (await visible("日常")) && !(await m.ev(`return document.querySelector(".hide-done-btn").classList.contains("is-active")`)),
  );

  // 两项一起开：全部完成的项目整个不显示，别的项目里只显示未完成的待办
  await setDone("需求", "A", true);
  await toggle("隐藏已完成的待办");
  await toggle("隐藏全部完成的项目");
  const both = () =>
    m.ev(`return { daily: !!row("工作", "日常"), req: !!row("工作", "需求"), a: !!row("工作", "需求", "A"), b: !!row("工作", "需求", "B"), opts: localStorage.getItem("listOptions:工作") }`);
  const bothOk = await t.until(async () => {
    const b = await both();
    return !b.daily && b.req && !b.a && b.b;
  });
  check("两项一起开", bothOk, await both());
}
