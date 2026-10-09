// 外部修改冲突：有没保存的修改时窗口获得焦点、正文在外部被改过，立即弹出冲突对话框；离开这条待办（切到别的待办、
// 正显示着冲突对话框时被切走）、从托盘退出时存不上的（外部改过、待办或项目在外部被删了），自动另存为新待办，两份都保留；
// 重命名、删除之前存不上时不做
export const title = "外部修改冲突";

export default async function (t) {
  const { main: m, check } = t;
  await m.viewport(1200, 900);
  await m.enter("工作");
  await m.expandAll();

  /** 在正文末尾加一段（不保存），返回加完后的全文 */
  const append = (text) =>
    m.ev(`const v = view(); v.focus(); v.dispatch({ changes: { from: v.state.doc.length, insert: ${JSON.stringify(text)} } });
      await sleep(200); return v.state.doc.toString()`);
  const doc = () => m.ev(`return view()?.state.doc.toString() ?? null`);
  /** 显示着的冲突对话框的标题（关掉了的还在页面里，只是藏起来了） */
  const CONFLICT = `[...document.querySelectorAll(".ant-modal-title")].find((e) => e.textContent === "文件已在外部被修改" && e.getClientRects().length > 0)`;
  const conflictShown = () => m.ev(`return !!${CONFLICT}`);
  /** 点冲突对话框里的按钮 */
  const resolve = (text) =>
    m.ev(`button(${JSON.stringify(text)}, ${CONFLICT}.closest(".ant-modal").querySelector(".ant-modal-footer")).click();
      await sleep(600); return 1`);
  /** 项目里标题是 title 的待办（.todos.json 里记着的） */
  const todoTitled = (ws, p, title) => t.exists(`${ws}/${p}/.todos.json`) && t.meta(ws, p).find((x) => x.title === title);
  const toastHas = (text) => t.until(async () => (await m.toast()).includes(text));

  // 有没保存的修改时窗口获得焦点：外部改过就立即弹出冲突对话框，不动正在编辑的内容
  await m.ev(`return await openTodo("工作", "日常", "D")`);
  const mineD = await append("\n我在软件里加的");
  t.write("工作/日常/D.md", "# 待办 D\n\n外部改的\n");
  await m.emit("tauri://focus");
  check(
    "有没保存的修改时窗口获得焦点、正文在外部被改过：立即弹出冲突对话框，正在编辑的内容不动",
    (await t.until(conflictShown)) && (await doc()) === mineD,
  );
  await resolve("放弃我的修改");
  check("「放弃我的修改，重新加载」：换成外部的内容", await t.until(async () => (await doc()) === "# 待办 D\n\n外部改的\n"));

  // 外部只是把同样的内容重写了一遍（修改时间变了，如网盘同步）：不算冲突
  const mineD2 = await append("\n再加一行");
  t.write("工作/日常/D.md", "# 待办 D\n\n外部改的\n");
  await m.emit("tauri://focus");
  await t.sleep(800);
  check("外部重写了一遍、内容没变：获得焦点时不弹冲突对话框，正在编辑的内容不动", !(await conflictShown()) && (await doc()) === mineD2);
  await m.press("Ctrl+S");
  check("之后照常保存", await t.until(() => t.read("工作/日常/D.md") === mineD2));

  // 切到别的待办时才发现外部改过（窗口一直在前台）：自动另存为新待办
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  const mineA = await append("\n离开前在软件里加的");
  t.write("工作/需求/A.md", "# 待办 A\n\n外部改的 A\n");
  await m.clearToasts();
  await m.ev(`return await openTodo("工作", "需求", "B")`);
  const copyA = await t.until(() => todoTitled("工作", "需求", "A（我的版本）"));
  check(
    "编辑了正文没保存、文件在外部被改了，切到别的待办：另存为同一项目里的新待办「A（我的版本）」，内容是编辑的内容",
    !!copyA && t.read(`工作/需求/${copyA.id}.md`) === mineA,
    copyA,
  );
  check("原来那条是外部改的内容", t.read("工作/需求/A.md") === "# 待办 A\n\n外部改的 A\n");
  check(
    "左侧列表里列出新的那条，提示里写明新待办的标题",
    !!copyA && (await t.until(() => m.ev(`return !!row("工作", "需求", ${JSON.stringify(copyA?.id)})`))) && (await toastHas("「A（我的版本）」")),
    await m.toast(),
  );
  if (copyA) {
    // 打开新的那条：撤销记录跟过去了，能撤销刚才加的
    await m.ev(`row("工作", "需求", ${JSON.stringify(copyA.id)}).click();
      await waitFor(() => document.querySelector(".editor-title")?.value === "A（我的版本）" && view()?.state.doc.length > 0);
      await sleep(300); view().focus(); return 1`);
    await m.press("Ctrl+Z");
    check("打开新的那条能接着撤销之前的修改", !(await doc()).includes("离开前在软件里加的"));
    await m.press("Ctrl+Y");
  }

  // 正显示着冲突对话框时被切走（快速记录里按 Ctrl+Enter 打开刚记下的待办）：同样另存
  await m.ev(`return await openTodo("工作", "需求", "C")`);
  const mineC = await append("\n对话框开着时加的");
  t.write("工作/需求/C.md", "# 待办 C\n\n外部改的 C\n");
  await m.emit("tauri://focus");
  await t.until(conflictShown);
  await m.ev(`await invoke("plugin:event|emit", { event: "open-todo", payload: { workspace: "工作", project: "日常", todoId: "D" } }); return 1`);
  const copyC = await t.until(() => todoTitled("工作", "需求", "C（我的版本）"));
  check(
    "正显示着冲突对话框时被切走：同样另存为新待办，原来那条是外部改的内容",
    !!copyC && t.read(`工作/需求/${copyC.id}.md`) === mineC && t.read("工作/需求/C.md") === "# 待办 C\n\n外部改的 C\n",
    copyC,
  );
  check("切走后冲突对话框不在了", await t.until(async () => !(await conflictShown())));

  // 待办在外部被删了：离开时存不上，另存为同一项目里的新待办
  await m.ev(`return await openTodo("工作", "需求", "B")`);
  const mineB = await append("\n删之前加的");
  t.remove("工作/需求/B.md");
  await m.clearToasts();
  await m.ev(`return await openTodo("工作", "日常", "D")`);
  const copyB = await t.until(() => todoTitled("工作", "需求", "B（我的版本）"));
  check(
    "待办在外部被删了：离开时存不上，另存为同一项目里的新待办，提示里说明没能保存",
    !!copyB && t.read(`工作/需求/${copyB.id}.md`) === mineB && (await toastHas("没能保存")),
    { copyB, toast: await m.toast() },
  );

  // 项目也在外部被删了：另存到快速记录存到的项目（「收件箱 / 快速记录」，不在时新建）
  await m.selectAllWorkspaces();
  await m.expandAll();
  await m.ev(`return await openTodo("生活", "杂事", "E")`);
  const mineE = await append("\n项目被删之前加的");
  t.remove("生活/杂事");
  await m.clearToasts();
  await m.ev(`return await openTodo("工作", "日常", "D")`);
  const copyE = await t.until(() => todoTitled("收件箱", "快速记录", "E（我的版本）"));
  check(
    "所在的项目也在外部被删了：另存到快速记录存到的项目（不在时新建），提示里写明存到了哪里",
    !!copyE && t.read(`收件箱/快速记录/${copyE.id}.md`) === mineE && (await toastHas("收件箱 / 快速记录")),
    { copyE, toast: await m.toast() },
  );

  // 重命名、删除之前先存盘：存不上（外部改过）时不做，冲突对话框留着
  const menu = async (sel, text) => {
    await m.click(await m.at(sel), { right: true });
    await m.ev(`await sleep(300); menuItem(${JSON.stringify(text)}).click(); await sleep(300); return 1`);
  };
  /** 点名称对话框的「确定」 */
  const submitName = () =>
    m.ev(`const input = await waitFor(() => document.querySelector(".ant-modal input"));
      button("确定", input.closest(".ant-modal").querySelector(".ant-modal-footer")).click(); await sleep(1000); return 1`);
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  const mineR = await append("\n改名前加的");
  t.write("工作/需求/A.md", "# 待办 A\n\n改名前外部改的\n");
  await menu(["工作", "需求"], "重命名");
  await m.ev(`setInput(await waitFor(() => document.querySelector(".ant-modal input")), "需求池"); await sleep(100); return 1`);
  await submitName();
  const nameError = await m.ev(`return document.querySelector(".dialog-error")?.textContent ?? ""`);
  check(
    "打开着的待办存不上（外部改过）时不重命名它所在的项目：弹出冲突对话框，重命名的对话框留着、说明原因",
    (await t.until(conflictShown)) && t.exists("工作/需求/A.md") && !t.exists("工作/需求池") && nameError.includes("还没保存好"),
    nameError,
  );
  await resolve("用我的内容覆盖");
  check("在冲突对话框里选了「用我的内容覆盖」", await t.until(() => t.read("工作/需求/A.md") === mineR));
  await submitName();
  check(
    "处理完再点确定：照常改名，打开着的待办跟过去",
    await t.until(async () => t.exists("工作/需求池/A.md") && !t.exists("工作/需求") && (await m.ev(`return document.querySelector(".editor-title")?.value`)) === "A"),
  );

  await m.ev(`await waitFor(() => view()?.state.doc.length > 0); await sleep(300); return 1`);
  await append("\n删除前加的");
  t.write("工作/需求池/A.md", "# 待办 A\n\n删除前外部改的\n");
  await m.clearToasts();
  await menu(["工作", "需求池", "A"], "删除");
  await m.ev(`button("删除", await waitFor(() => document.querySelector(".ant-modal-confirm-btns"))).click(); await sleep(1000); return 1`);
  check(
    "打开着的待办存不上时不删除它：冲突对话框留着，提示为什么没删",
    (await t.until(conflictShown)) && t.exists("工作/需求池/A.md") && (await toastHas("先处理好再删除")),
    await m.toast(),
  );
  await resolve("放弃我的修改");

  // 正显示着冲突对话框时从托盘退出：另存为新待办后再退出（最后做）
  await m.ev(`return await openTodo("工作", "日常", "D")`);
  const mineQ = await append("\n退出前加的");
  t.write("工作/日常/D.md", "# 待办 D\n\n退出前外部改的\n");
  await m.emit("tauri://focus");
  await t.until(conflictShown);
  await m.viewport(0);
  await t.quit();
  const copyQ = todoTitled("工作", "日常", "D（我的版本）");
  check(
    "正显示着冲突对话框时从托盘退出：另存为新待办后再退出，原来那条是外部改的内容",
    !!copyQ && t.read(`工作/日常/${copyQ.id}.md`) === mineQ && t.read("工作/日常/D.md") === "# 待办 D\n\n退出前外部改的\n",
    copyQ,
  );
}
