// 右侧分屏（docs/requirements.md「右侧分屏」）：快捷键左右 / 上下分屏、同一个方向再按合并回一边，新的一边先显示正在编辑的
// 待办；两边各开不同的待办、打开到有焦点的一边；同一条待办两边同步、只存一次、共用撤销记录；一边的标签都关掉后回到不分屏；
// 拖分隔条、双击恢复；Alt+← / Alt+→ 在两边之间移动焦点；Ctrl+W 作用于有焦点的一边；记在 .state.json，重启后还在
export const title = "右侧分屏";

export default async function (t) {
  const { check } = t;
  let m = t.main;
  await m.viewport(1200, 900);
  await m.enter("工作");
  await m.expandAll();

  /** 第 i 边（从左 / 上数）的编辑器 */
  const GV = `const gview = (i) => document.querySelectorAll(".editor-group")[i]?.querySelector(".cm-content")?.cmTile?.root?.view;`;
  /** 两边的样子：每边的标签（A 固定，(A) 预览，* 正显示着），有焦点的一边后面写 [焦点]，| 隔开 */
  const layout = () =>
    m.ev(`return [...document.querySelectorAll(".editor-group")].map((g) =>
      [...g.querySelectorAll(".editor-tab")].map((e) => {
        const id = JSON.parse(e.dataset.tab)[2];
        return (e.classList.contains("preview") ? "(" + id + ")" : id) + (e.classList.contains("active") ? "*" : "");
      }).join(" ") + (g.classList.contains("focused") && document.querySelectorAll(".editor-group").length > 1 ? " [焦点]" : "")
    ).join(" | ")`);
  /** 焦点（document.activeElement）在第几边的正文里；不在正文里时 -1 */
  const bodyIn = () =>
    m.ev(`const g = document.activeElement?.closest(".cm-content") && document.activeElement.closest(".editor-group");
      return g ? [...document.querySelectorAll(".editor-group")].indexOf(g) : -1`);
  const docOf = (i) => m.ev(`${GV} return gview(${i})?.state.doc.toString() ?? null`);
  /** 点第 i 边的正文（可见区域靠上的地方），焦点到那一边 */
  const clickBody = async (i) => {
    const p =
      await m.ev(`const r = document.querySelectorAll(".editor-group")[${i}].querySelector(".cm-scroller").getBoundingClientRect();
      return { x: Math.round(r.left + 40), y: Math.round(r.top + 20) }`);
    await m.click(p);
  };
  /** 正文第 line 行行尾放光标、焦点放进第 i 边的正文 */
  const caretAt = (i, line) =>
    m.ev(
      `${GV} const v = gview(${i}); const l = v.state.doc.line(${line}); v.dispatch({ selection: { anchor: l.to } }); v.focus(); await sleep(200); return 1`,
    );
  const groupBoxes = () =>
    m.ev(
      `return [...document.querySelectorAll(".editor-group")].map((g) => { const r = g.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })`,
    );
  /** 弹出了外部修改冲突的对话框 */
  const conflicted = () =>
    m.ev(
      `return [...document.querySelectorAll(".ant-modal")].some((e) => e.textContent.includes("文件已在外部被修改"))`,
    );

  // 打开 A，左右分屏：新的一边在右边，先显示 A（固定的标签），焦点在它的正文里，光标和原来那一边一样
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  await caretAt(0, 20);
  const head0 = await m.ev(`${GV} return gview(0).state.selection.main.head`);
  await m.press("Alt+Shift+=");
  await t.until(async () => (await layout()) === "(A)* | A* [焦点]");
  check(
    "Alt+Shift+=（+ / = 键）左右分屏：右边新的一边先显示正在编辑的待办，焦点到新的一边",
    (await layout()) === "(A)* | A* [焦点]",
    await layout(),
  );
  const boxes = await groupBoxes();
  check(
    "两边左右排开，各占一半",
    boxes.length === 2 && boxes[1].x > boxes[0].x && Math.abs(boxes[0].w - boxes[1].w) <= 4,
    boxes,
  );
  check(
    "新的一边焦点在正文里，光标和原来那一边一样",
    (await t.until(async () => (await bodyIn()) === 1)) &&
      (await m.ev(`${GV} return gview(1).state.selection.main.head`)) === head0,
  );

  // 同一条待办两边同步：右边打字，左边跟着变；两边都有圆点；Ctrl+S 存下两边改的
  await m.type("右边加的");
  await t.until(async () => ((await docOf(0)) ?? "").includes("右边加的"));
  check(
    "同一条待办：一边打字，另一边马上跟着变",
    ((await docOf(0)) ?? "").includes("右边加的") && ((await docOf(1)) ?? "").includes("右边加的"),
  );
  check("在一边修改了：另一边的预览标签也固定下来", (await layout()) === "A* | A* [焦点]", await layout());
  const dots = await m.ev(`return document.querySelectorAll(".editor-tab.dirty").length`);
  check("两边开着同一条待办、有没存的修改：两边的标签上都有圆点", dots === 2, dots);
  await caretAt(0, 30);
  await m.type("左边加的");
  await t.sleep(300);
  await m.press("Ctrl+S");
  await t.until(() => t.read("工作/需求/A.md").includes("左边加的"));
  const file = t.read("工作/需求/A.md");
  check("Ctrl+S：两边改的都存进了文件", file.includes("右边加的") && file.includes("左边加的"));
  check(
    "存好后两边的圆点都没了",
    !!(await t.until(async () => (await m.ev(`return document.querySelectorAll(".editor-tab.dirty").length`)) === 0)),
  );

  // 撤销记录共用：在右边按 Ctrl+Z，撤销的是左边刚改的
  await clickBody(1);
  await m.press("Ctrl+Z");
  await t.sleep(300);
  check(
    "撤销记录共用：在另一边按 Ctrl+Z 撤销最近的修改（不论在哪一边改的），两边都撤回去",
    !((await docOf(1)) ?? "").includes("左边加的") &&
      !((await docOf(0)) ?? "").includes("左边加的") &&
      ((await docOf(0)) ?? "").includes("右边加的"),
  );
  await m.press("Ctrl+Y");
  await t.sleep(300);
  check("在另一边 Ctrl+Y 重做回来", ((await docOf(0)) ?? "").includes("左边加的"));
  await m.press("Ctrl+S");
  await t.sleep(300);

  // 只有一处存盘：两边轮流修改、轮流 Ctrl+S，后存的一边不会因为文件被「另一边」存过而冲突，也不会把先存的盖掉
  await caretAt(1, 40);
  await m.type("右边再加");
  await m.press("Ctrl+S");
  await t.until(() => t.read("工作/需求/A.md").includes("右边再加"));
  await caretAt(0, 50);
  await m.type("左边再加");
  await m.press("Ctrl+S");
  await t.until(() => t.read("工作/需求/A.md").includes("左边再加"));
  const both = t.read("工作/需求/A.md");
  const clash = await conflicted();
  check(
    "两边轮流修改、保存：只有一处存盘，不冲突、不互相覆盖",
    !clash && ["右边加的", "左边加的", "右边再加", "左边再加"].every((x) => both.includes(x)),
    { clash },
  );
  await clickBody(1);

  // 两边各开不同的待办：在左侧列表里打开的放进有焦点的一边（右边）
  await m.ev(`row("工作", "需求", "B").click(); await sleep(600); return 1`);
  await t.until(async () => (await layout()) === "A* | A (B)* [焦点]");
  check(
    "在左侧列表里打开的待办放进有焦点的一边，另一边不变",
    (await layout()) === "A* | A (B)* [焦点]",
    await layout(),
  );
  await clickBody(0);
  check(
    "点另一边：焦点移过去",
    (await t.until(async () => (await layout()) === "A* [焦点] | A (B)*")) && (await layout()) === "A* [焦点] | A (B)*",
    await layout(),
  );
  await m.ev(`row("工作", "需求", "C").click(); await sleep(600); return 1`);
  await t.until(async () => (await layout()) === "A (C)* [焦点] | A (B)*");
  check("焦点在左边时打开的放进左边", (await layout()) === "A (C)* [焦点] | A (B)*", await layout());

  // Alt+← / Alt+→ 在两边之间移动焦点：左边最右边的标签上 Alt+→ 进入右边，右边最左边的标签上 Alt+← 回到左边
  await clickBody(0);
  await m.press("Alt+ArrowRight");
  await t.sleep(400);
  check(
    "左边一边最右边的标签上 Alt+→：进入右边一边正显示着的标签，焦点在它的正文里",
    (await layout()) === "A (C)* | A (B)* [焦点]" && (await bodyIn()) === 1,
    await layout(),
  );
  await m.press("Alt+ArrowLeft");
  await t.sleep(400);
  const inRight = await layout();
  await m.press("Alt+ArrowLeft");
  await t.sleep(400);
  check(
    "右边一边里先切到左边的标签，到了最左边再按 Alt+← 回到左边一边正显示着的标签",
    inRight === "A (C)* | A* (B) [焦点]" && (await layout()) === "A (C)* [焦点] | A* (B)" && (await bodyIn()) === 0,
    { inRight, now: await layout() },
  );

  // Ctrl+W、Ctrl+Tab 作用于有焦点的一边
  await m.press("Ctrl+Tab");
  await t.sleep(400);
  const tabbed = await layout();
  await m.press("Ctrl+W");
  await t.sleep(400);
  check(
    "Ctrl+Tab、Ctrl+W 只作用于有焦点的一边",
    tabbed === "A* (C) [焦点] | A* (B)" && (await layout()) === "(C)* [焦点] | A* (B)",
    { tabbed, now: await layout() },
  );

  // 拖分隔条调整比例，双击恢复一半一半
  const bar = await m.at(".group-resizer");
  await m.drag(bar, { x: bar.x - 200, y: bar.y });
  const dragged = await groupBoxes();
  check("拖分隔条调整两边的比例", dragged[1].w - dragged[0].w > 300, dragged);
  const bar2 = await m.at(".group-resizer");
  await m.mouse("mouseMoved", bar2);
  for (const clickCount of [1, 2]) {
    await m.mouse("mousePressed", bar2, { button: "left", buttons: 1, clickCount });
    await m.mouse("mouseReleased", bar2, { button: "left", buttons: 0, clickCount });
  }
  await t.sleep(300);
  const reset = await groupBoxes();
  check("双击分隔条恢复一半一半", Math.abs(reset[0].w - reset[1].w) <= 4, reset);

  // 上下分屏：按另一个方向改成上下；再按一次合并回一边
  await m.press("Alt+Shift+-");
  await t.sleep(400);
  const col = await groupBoxes();
  check(
    "已经左右分屏时按 Alt+Shift+-：改成上下，两边的标签不变",
    col[1].y > col[0].y && (await layout()) === "(C)* [焦点] | A* (B)",
    { col, layout: await layout() },
  );
  await m.press("Alt+Shift+-");
  await t.sleep(400);
  check(
    "同一个方向再按一次：合并回一边（左边 / 上面的标签在前，并过来的预览标签固定下来，显示有焦点一边正显示着的）",
    (await layout()) === "(C)* A B",
    await layout(),
  );

  // 一边的标签都关掉后回到不分屏
  await m.press("Alt+Shift+=");
  await t.sleep(500);
  check("又分出右边一边：左边仍显示它正显示着的", (await layout()) === "(C)* A B | C* [焦点]", await layout());
  await m.press("Ctrl+W");
  await t.sleep(500);
  check(
    "一边的标签都关掉了：这一边消失，回到不分屏，焦点在留下的一边",
    (await layout()) === "(C)* A B" && (await bodyIn()) === 0,
    await layout(),
  );

  // 设置「快捷键」：分屏的两个在「应用内快捷键」一组，默认 Alt+Shift+= / -；改成和别的重复的时提示，改了立即生效，可以恢复默认
  await m.openSettings("快捷键");
  const pane = `[...document.querySelectorAll(".ant-modal [role=tabpanel]")].find((p) => p.querySelector(".shortcut-box"))`;
  const item = (label) =>
    `[...${pane}.querySelectorAll(".setting-item")].find((x) => x.querySelector(".setting-label")?.textContent === ${JSON.stringify(label)})`;
  const rowOf = (label) =>
    m.ev(
      `const i = ${item(label)}; return i && { value: i.querySelector(".shortcut-box").textContent.split(" ").join(""), err: i.querySelector(".error-text")?.textContent ?? "" }`,
    );
  const groupOf = (label) =>
    m.ev(
      `const i = ${item(label)}; let e = i; while (e && !e.classList?.contains("setting-group")) e = e.previousElementSibling; return e?.textContent ?? ""`,
    );
  const right = await rowOf("左右分屏");
  const down = await rowOf("上下分屏");
  check(
    "设置里「左右分屏」「上下分屏」在应用内快捷键一组，默认是 Alt + Shift + = 和 Alt + Shift + -",
    right?.value === "Alt+Shift+=" && down?.value === "Alt+Shift+-" && (await groupOf("左右分屏")) === "应用内快捷键",
    { right, down },
  );
  await m.ev(`${item("左右分屏")}.querySelector(".shortcut-box").click(); await sleep(300); return 1`);
  await m.press("Ctrl+Alt+D");
  await t.sleep(200);
  check(
    "改成和别的快捷键重复的：当场提示",
    /已用于「标记完成 \/ 未完成」/.test((await rowOf("左右分屏")).err),
    await rowOf("左右分屏"),
  );
  await m.press("Ctrl+Alt+\\");
  await t.until(async () => (await rowOf("左右分屏")).value === "Ctrl+Alt+\\");
  const s1 = await m.invoke("get_settings");
  check(
    "改成 Ctrl+Alt+\\：存进设置",
    s1.settings.splitRightShortcut === "Ctrl+Alt+Backslash",
    s1.settings.splitRightShortcut,
  );
  await m.closeModal();
  await m.enter("工作");
  await t.until(async () => (await groupBoxes()).length === 1);
  await clickBody(0);
  await m.press("Alt+Shift+=");
  await t.sleep(400);
  const oldKey = await groupBoxes();
  await m.press("Ctrl+Alt+\\");
  await t.sleep(400);
  const newKey = await groupBoxes();
  check(
    "改了立即生效：原来的 Alt+Shift+= 不再分屏，新的 Ctrl+Alt+\\ 左右分屏",
    oldKey.length === 1 && newKey.length === 2 && newKey[1].x > newKey[0].x,
    { oldKey, newKey },
  );
  await m.openSettings("快捷键");
  await m.ev(`button("恢复默认", ${item("左右分屏")}).click(); await sleep(800); return 1`);
  const s2 = await m.invoke("get_settings");
  check("恢复默认：Alt+Shift+=", s2.settings.splitRightShortcut === "Alt+Shift+Equal", s2.settings.splitRightShortcut);
  await m.closeModal();
  await m.enter("工作");
  await t.until(async () => (await groupBoxes()).length === 2);

  // 记在 .state.json，重启后还在（重启后的窗口不一定在前台，之后不再按键）
  await clickBody(0);
  await m.ev(`return await openTodo("工作", "需求", "B")`);
  await m.press("Alt+Shift+-");
  await t.sleep(500);
  await m.ev(`row("工作", "需求", "A").click(); await sleep(600); return 1`);
  const beforeRestart = await layout();
  await t.restart();
  m = t.main;
  const saved = JSON.parse(t.read(".state.json")).editorSplit;
  check("分屏的方向、两边的标签记在 .state.json", saved?.direction === "column" && saved?.tabs?.length > 0, saved);
  await m.viewport(1200, 900);
  await m.enter("工作");
  await t.until(async () => (await layout()) === beforeRestart);
  const after = await layout();
  const afterBoxes = await groupBoxes();
  check(
    "重启后分屏还在：两边的标签、方向、哪一边有焦点都和原来一样",
    after === beforeRestart && afterBoxes[1]?.y > afterBoxes[0]?.y,
    { beforeRestart, after },
  );
}
