// 右侧标签页：同时打开几条待办，点标签切换时光标、选区、滚动回到上次的地方；预览标签、关闭、Ctrl+Tab / Ctrl+W；
// 标签记在 .state.json，重启后还在；在外部被删了的待办刷新后关掉标签
export const title = "标签页";

export default async function (t) {
  const { check } = t;
  // 重启后换成新连上的页面
  let m = t.main;
  await m.viewport(1200, 900);
  await m.enter("工作");
  await m.expandAll();

  /** 标签栏的样子：A 是固定的标签，(A) 是预览的，* 是正显示着的 */
  const tabs = () =>
    m.ev(`return [...document.querySelectorAll(".editor-tab")].map((e) => {
      const id = JSON.parse(e.dataset.tab)[2];
      return (e.classList.contains("preview") ? "(" + id + ")" : id) + (e.classList.contains("active") ? "*" : "");
    }).join(" ")`);
  /** 标签上标题的地方（不是 ×） */
  const tabAt = (id) => m.at(`.editor-tab[data-tab='${JSON.stringify(["工作", "需求", id])}'] .editor-tab-label`);
  /** 标签靠左 / 靠右一点的地方（拖动时放在它前面 / 后面） */
  const tabEdge = (id, side) =>
    m.ev(`const r = document.querySelector(${JSON.stringify(`.editor-tab[data-tab='${JSON.stringify(["工作", "需求", id])}']`)}).getBoundingClientRect();
      return { x: Math.round(${side === "left" ? "r.left + 8" : "r.right - 8"}), y: Math.round(r.top + r.height / 2) }`);
  /** 正文加载好、标题是 id（测试数据里标题就是文件名） */
  const loaded = (id) =>
    t.until(() => m.ev(`return !!view() && view().state.doc.length > 0 && document.querySelector(".editor-title")?.value === ${JSON.stringify(id)}`));
  const dblclick = async (p) => {
    await m.mouse("mouseMoved", p);
    for (const clickCount of [1, 2]) {
      await m.mouse("mousePressed", p, { button: "left", buttons: 1, clickCount });
      await m.mouse("mouseReleased", p, { button: "left", buttons: 0, clickCount });
    }
    await t.sleep(400);
  };
  const middleClick = async (p) => {
    await m.mouse("mouseMoved", p);
    await m.mouse("mousePressed", p, { button: "middle", buttons: 4, clickCount: 1 });
    await m.mouse("mouseReleased", p, { button: "middle", buttons: 0, clickCount: 1 });
    await t.sleep(400);
  };
  /** 显示着「未保存」圆点的标签 */
  const dirtyTabs = () => m.ev(`return [...document.querySelectorAll(".editor-tab.dirty")].map((e) => JSON.parse(e.dataset.tab)[2]).join(" ")`);
  const bodyFocused = () => m.ev(`return !!document.activeElement?.closest(".cm-content")`);

  // 单击打开在预览标签里，再单击别的替换它
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  check("单击左侧的待办：打开在预览标签里", (await tabs()) === "(A)*", await tabs());
  await m.ev(`return await openTodo("工作", "需求", "B")`);
  check("再单击别的待办：预览标签被替换，不新开", (await tabs()) === "(B)*", await tabs());
  await dblclick(await m.at(["工作", "需求", "B"]));
  check("双击左侧的待办：标签固定下来", (await tabs()) === "B*", await tabs());
  await m.ev(`return await openTodo("工作", "需求", "C")`);
  check("固定的标签留着，新开的预览标签在它右边", (await tabs()) === "B (C)*", await tabs());
  await m.ev(`view().focus(); return 1`);
  await m.type("改");
  await t.sleep(300);
  check("修改了正文：预览标签固定下来", (await tabs()) === "B C*", await tabs());
  check("有没保存的修改：标签上显示圆点", (await dirtyTabs()) === "C", await dirtyTabs());

  // 切走再切回来：光标、选区、滚动都在原来的地方，焦点在正文里
  const before = await m.ev(`const v = view(); v.scrollDOM.scrollTop = 500; await sleep(300);
    // 可见区域里靠上的一行，选中其中几个字
    const line = v.lineBlockAtHeight(v.scrollDOM.scrollTop + 120);
    v.dispatch({ selection: { anchor: line.from + 2, head: line.from + 9 } }); await sleep(1200);
    const r = v.coordsAtPos(v.state.selection.main.head);
    return { anchor: v.state.selection.main.anchor, head: v.state.selection.main.head, scroll: v.scrollDOM.scrollTop, y: Math.round(r.top) }`);
  await m.click(await tabAt("B"));
  await loaded("B");
  check("点标签切到别的待办", (await tabs()) === "B* C" && (await bodyFocused()), await tabs());
  check("切走时保存了修改", await t.until(() => t.read("工作/需求/C.md").includes("改")));
  check("切走后标签上没有圆点了", (await dirtyTabs()) === "", await dirtyTabs());
  await m.click(await tabAt("C"));
  await loaded("C");
  await t.sleep(400);
  const after = await m.ev(`const v = view(); const r = v.coordsAtPos(v.state.selection.main.head);
    return { anchor: v.state.selection.main.anchor, head: v.state.selection.main.head, scroll: v.scrollDOM.scrollTop, y: Math.round(r.top) }`);
  check("点标签切回来：选区还在", after.anchor === before.anchor && after.head === before.head, { before, after });
  check("点标签切回来：滚动和光标在屏幕上的位置不变", Math.abs(after.scroll - before.scroll) <= 2 && Math.abs(after.y - before.y) <= 2, { before, after });
  check("点标签切回来：焦点在正文里，接着打字就在原来的光标处", await bodyFocused());
  await m.press("Ctrl+Z");
  await t.sleep(200);
  check("切回来后还能撤销之前的修改", !(await m.ev(`return view().state.doc.toString().includes("改")`)));
  const dirtyBeforeSave = await dirtyTabs();
  await m.press("Ctrl+S");
  check("Ctrl+S 保存后圆点没了", dirtyBeforeSave === "C" && !!(await t.until(async () => (await dirtyTabs()) === "")), dirtyBeforeSave);

  // Ctrl+Tab / Ctrl+Shift+Tab，到头了从另一头接着
  await m.press("Ctrl+Tab");
  await loaded("B");
  const next = await tabs();
  await m.press("Ctrl+Shift+Tab");
  await loaded("C");
  check("Ctrl+Tab / Ctrl+Shift+Tab 切到下一个 / 上一个标签，到头了从另一头接着", next === "B* C" && (await tabs()) === "B C*", next);
  check("Ctrl+Tab 切过去后焦点在正文里", await bodyFocused());

  // 焦点在右侧的待办里：Alt+← / Alt+→ 切到左边 / 右边的标签，最左边的标签上 Alt+← 回到左侧列表
  await m.press("Alt+ArrowLeft");
  await loaded("B");
  const altLeft = await tabs();
  // 连着按：编辑器重建的一瞬间焦点不在任何地方，仍按右侧算
  await m.press("Alt+ArrowRight");
  await m.press("Alt+ArrowLeft");
  await m.press("Alt+ArrowRight");
  await loaded("C");
  await t.sleep(300);
  check("焦点在正文里时 Alt+← / Alt+→ 切到左边 / 右边的标签（连着按也行）", altLeft === "B* C" && (await tabs()) === "B C*" && (await bodyFocused()), altLeft);
  await m.press("Alt+ArrowRight");
  await t.sleep(300);
  check("最右边的标签上 Alt+→ 不切换（焦点留在正文里）", (await tabs()) === "B C*" && (await bodyFocused()), await tabs());
  await m.ev(`document.querySelector(".editor-title").focus(); return 1`);
  await m.press("Alt+ArrowRight");
  await t.sleep(200);
  check("最右边的标签上，焦点在标题时 Alt+→ 同原来一样把焦点放进正文", await bodyFocused());
  await m.press("Alt+ArrowLeft");
  await loaded("B");
  await m.press("Alt+ArrowLeft");
  await t.sleep(300);
  check(
    "最左边的标签上 Alt+← 回到左侧列表",
    (await tabs()) === "B* C" && (await m.ev(`return !!document.activeElement?.closest(".sidebar")`)),
    await tabs(),
  );
  await m.press("Alt+ArrowRight");
  await t.sleep(300);
  check("左侧列表里 Alt+→ 焦点回到正文", await bodyFocused());
  await m.press("Alt+ArrowRight");
  await loaded("C");

  // 关闭：Ctrl+W 关掉正显示着的，切到右边的（没有时左边的）；鼠标中键；右键「关闭其他标签」
  await m.ev(`return await openTodo("工作", "需求", "长文档")`);
  await dblclick(await tabAt("长文档"));
  check("双击预览标签：固定下来", (await tabs()) === "B C 长文档*", await tabs());

  // 拖动标签调整顺序：放在指针下那个标签的前面（左半边）/ 后面（右半边）；Esc 取消；不切换标签
  await m.drag(await tabAt("长文档"), await tabEdge("B", "left"));
  check("拖动标签放到另一个标签前面", (await tabs()) === "长文档* B C", await tabs());
  await m.drag(await tabAt("B"), await tabEdge("C", "right"));
  check("拖动没显示着的标签放到最后：调整了顺序，不切换过去", (await tabs()) === "长文档* C B", await tabs());
  await m.drag(await tabAt("长文档"), await tabEdge("B", "left"), { release: false });
  const dropLine = await m.ev(`return !!document.querySelector(".editor-tab.drop-before, .editor-tab.drop-after")`);
  await m.press("Escape");
  await m.drop(await tabEdge("B", "left"));
  check("拖动时画出放下的位置，Esc 取消", dropLine && (await tabs()) === "长文档* C B", await tabs());
  await m.drag(await tabAt("长文档"), await tabEdge("B", "right"));
  check("拖回最后", (await tabs()) === "C B 长文档*", await tabs());
  await m.drag(await tabAt("B"), await tabEdge("C", "left"));
  await t.until(async () => (await tabs()) === "B C 长文档*");
  await m.press("Ctrl+W");
  await loaded("C");
  check("Ctrl+W 关掉最右边正显示着的标签，切到左边的", (await tabs()) === "B C*", await tabs());
  await m.click(await tabAt("B"));
  await loaded("B");
  await m.press("Alt+ArrowUp", { repeat: 5 });
  await loaded("C");
  await t.sleep(300);
  check(
    "焦点在正文里时 Alt+↑ 关掉正显示着的标签，切到右边的（按住不放只关一个）",
    (await tabs()) === "C*" && (await bodyFocused()),
    await tabs(),
  );
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  await middleClick(await tabAt("C"));
  check("鼠标中键关掉标签", (await tabs()) === "(A)*", await tabs());
  await dblclick(await tabAt("A"));
  await m.ev(`return await openTodo("工作", "需求", "B")`);
  await m.click(await tabAt("A"), { right: true });
  await m.ev(`menuItem("关闭其他标签").click(); await sleep(300); return 1`);
  await loaded("A");
  check("右键「关闭其他标签」：正显示着的被关掉时切到留下的", (await tabs()) === "A*", await tabs());
  await m.press("Ctrl+W");
  await t.sleep(400);
  check(
    "关掉最后一个标签：显示它所在的项目",
    (await tabs()) === "" && (await m.ev(`return !!document.querySelector(".overview") && !document.querySelector(".editor-tabs")`)),
  );
  // 按住 Alt+↑ 关掉最后一个标签：后面的重复按键什么都不做，不会接着在左侧列表里一行行往上选
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  await m.ev(`view().focus(); return 1`);
  await m.press("Alt+ArrowUp", { repeat: 5 });
  await t.sleep(400);
  const heldSel = await m.ev(`return document.querySelector(".tree-row.selected")?.dataset.sel`);
  check(
    "按住 Alt+↑ 关掉最后一个标签：只关这一个，左侧列表的选中项停在它所在的项目上",
    (await tabs()) === "" && heldSel === JSON.stringify(["工作", "需求", ""]),
    { tabs: await tabs(), sel: heldSel },
  );

  // 显示概览时标签栏仍在，没有高亮的，点标签回到那条待办
  await m.ev(`return await openTodo("工作", "需求", "B")`);
  await dblclick(await tabAt("B"));
  await m.ev(`row("工作", "需求").click(); await sleep(400); return 1`);
  check("显示项目概览时标签仍在，没有哪个高亮", (await tabs()) === "B" && (await m.ev(`return !!document.querySelector(".overview")`)), await tabs());
  await m.click(await tabAt("B"));
  await loaded("B");
  check("点标签回到那条待办", (await tabs()) === "B*");

  // 记在 .state.json，重启后还在
  await m.ev(`return await openTodo("工作", "需求", "C")`);
  await t.restart();
  m = t.main;
  const saved = JSON.parse(t.read(".state.json")).openTodos;
  check(
    "标签记在 .state.json（预览标签记着 preview）",
    JSON.stringify(saved) ===
      JSON.stringify([
        { workspace: "工作", project: "需求", todoId: "B" },
        { workspace: "工作", project: "需求", todoId: "C", preview: true },
      ]),
    saved,
  );
  await m.enter("工作");
  await t.until(async () => (await tabs()) === "B (C)*");
  check("重启后标签还在，进入工作区时打开上次的待办", (await tabs()) === "B (C)*", await tabs());

  // 在外部被删了的待办：刷新后关掉标签
  t.remove("工作/需求/B.md");
  await m.emit("tauri://focus");
  await t.until(async () => (await tabs()) === "(C)*");
  check("在外部被删了的待办，刷新后标签关掉", (await tabs()) === "(C)*", await tabs());
}
