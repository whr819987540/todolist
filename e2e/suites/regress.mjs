// 回归：这一批改到了附近代码的旧功能
export const title = "回归检查";

export default async function (t) {
  const { main: m, check, win } = t;
  const toggleKey = t.TEST_KEYS.toggle.split("+").pop();
  const main = () => win.windows().main;
  await m.viewport(1200, 900);

  // 全局快捷键现在按表分派：显示 / 隐藏主窗口和快速记录互不影响
  win.hotkey(toggleKey);
  await t.sleep(500);
  const front = main();
  win.hotkey(toggleKey);
  await t.sleep(500);
  const hidden = main();
  win.hotkey(toggleKey);
  await t.sleep(500);
  // 在前台时才藏起来：Windows 不让测试版拿前台时（见 run.mjs 的 FOREGROUND_LOCKED）第二下也是显示
  t.checkForeground(front.fg, "「显示 / 隐藏主窗口」：不在前台时调到前台，在前台时藏到托盘，再按又显示",
    front.visible && front.fg && !hidden.visible && main().visible, { front, hidden, now: main() });
  check("「显示 / 隐藏主窗口」：按下后主窗口显示出来", front.visible && main().visible);
  win.hotkey(t.TEST_KEYS.quick.split("+").pop());
  await t.sleep(400);
  check("按快速记录的快捷键不会动主窗口", main().visible && win.windows().quick?.visible);
  win.hotkey(t.TEST_KEYS.quick.split("+").pop());
  await t.sleep(300);

  win.close();
  await t.sleep(600);
  check("点关闭按钮只藏到托盘", !main().visible && t.pid && (await m.ev(`return 1`)) === 1);
  win.hotkey(toggleKey);
  await t.sleep(600);
  check("从托盘调回来", main().visible);

  await m.enter("工作");
  await m.expandAll();
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  await m.press("Ctrl+N");
  await t.sleep(800);
  const sel = await m.ev(`return document.activeElement?.classList.contains("editor-title") ? document.querySelector(".tree-row.selected")?.dataset.sel : null`);
  const id = sel && JSON.parse(sel)[2];
  check("Ctrl+N 在当前项目新建待办，聚焦标题", sel && JSON.parse(sel)[1] === "需求", sel);
  await m.type("回归测试新建的");
  await m.press("Alt+ArrowRight");
  await m.type("正文一行");
  await m.clearToasts();
  await m.press("Ctrl+S");
  await t.sleep(600);
  check("Ctrl+S 保存标题和正文", (await m.toast()).includes("已保存") && t.read(`工作/需求/${id}.md`) === "正文一行" && t.meta("工作", "需求").find((x) => x.id === id)?.title === "回归测试新建的");
  const live = await m.ev(`return document.querySelector(".statusbar").textContent.includes("实时渲染")`);
  await m.press("Ctrl+/");
  await t.sleep(300);
  const source = await m.ev(`return document.querySelector(".statusbar").textContent.includes("源码模式")`);
  await m.press("Ctrl+/");
  check("Ctrl+/ 切换实时渲染 / 源码模式", live && source);
  await m.press("Alt+ArrowLeft");
  const left = await m.ev(`return !!document.activeElement?.closest(".sidebar")`);
  await m.press("Alt+ArrowUp");
  await t.sleep(300);
  check("Alt+← 焦点到左侧列表，Alt+↑ 选中上一项", left && (await m.ev(`return document.querySelector(".tree-row.selected")?.dataset.sel`)) !== sel);
  await m.clearToasts();
  await m.press("F5");
  await t.sleep(800);
  check("F5 刷新", (await m.toast()).includes("已刷新"));

  await m.drag(await m.at(["工作", "需求", id]), await m.at(["工作", "日常"]));
  check("拖动待办到别的项目", t.exists(`工作/日常/${id}.md`) && !t.exists(`工作/需求/${id}.md`));
  await m.selectAllWorkspaces();
  await m.invoke("create_project", { workspace: "工作", name: "要搬走的" });
  await m.emit("tauri://focus");
  await t.sleep(800);
  await m.drag(await m.at(["工作", "要搬走的"]), await m.at(["生活"]));
  check("拖动项目到别的工作区", t.exists("生活/要搬走的") && !t.exists("工作/要搬走的"));

  // 外部修改冲突：有没保存的修改时获得焦点不重新加载，保存时弹出冲突对话框
  await m.ev(`return await openTodo("工作", "日常", "D")`);
  await m.ev(`const v = view(); v.focus(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\\n我在软件里加的" } }); return 1`);
  await t.sleep(200);
  t.write("工作/日常/D.md", "# 待办 D\n\n外部改的\n");
  await m.emit("tauri://focus");
  await t.sleep(600);
  check("有没保存的修改时，获得焦点不重新加载", await m.ev(`return view().state.doc.toString().includes("我在软件里加的")`));
  await m.press("Ctrl+S");
  await t.sleep(800);
  const modal = await m.ev(`return { title: document.querySelector(".ant-modal-title")?.textContent, buttons: [...document.querySelectorAll(".ant-modal-footer button")].map((b) => b.textContent) }`);
  check("保存时弹出冲突对话框，有三个选择", modal.title === "文件已在外部被修改" && modal.buttons.join("|") === "放弃我的修改，重新加载|用我的内容覆盖|另存为新待办", modal);
  await m.ev(`button("用我的内容覆盖", document.querySelector(".ant-modal-footer")).click(); await sleep(800); return 1`);
  check("「用我的内容覆盖」", t.read("工作/日常/D.md").includes("我在软件里加的"));

  for (const autoSave of [true, false]) {
    await m.invoke("set_save_options", { autoSave, saveDelaySecs: 180 });
    await m.reload();
    await m.enter("工作");
    await m.ev(`return await openTodo("工作", "日常", "D")`);
    const mark = autoSave ? "开着 auto save 加的" : "关着 auto save 加的";
    await m.ev(`const v = view(); v.focus(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\\n${mark}" } }); return 1`);
    await t.sleep(200);
    await m.emit("tauri://blur");
    await t.sleep(800);
    check(autoSave ? "auto save 开着：窗口失去焦点时保存" : "auto save 关着：失去焦点不保存", t.read("工作/日常/D.md").includes(mark) === autoSave);
  }

  // 托盘「退出」前保存正在编辑的内容（最后做）
  await m.ev(`const v = view(); v.focus(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\\n退出前加的" } }); return 1`);
  await t.sleep(200);
  await m.viewport(0);
  await t.quit();
  check("从托盘「退出」前保存正在编辑的内容", t.read("工作/日常/D.md").includes("退出前加的"));
}
