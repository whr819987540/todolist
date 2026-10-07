// 设置「快捷键」：快速记录的全局快捷键；以前已经把别的快捷键设成 Ctrl+Alt+N 的设置文件
export const title = "全局快捷键设置";

export default async function (t) {
  const { main: m, check, win } = t;
  const quick = t.TEST_KEYS.quick;
  const quickKey = quick.split("+").pop();

  await m.openSettings("快捷键");
  const pane = `[...document.querySelectorAll(".ant-modal [role=tabpanel]")].find((p) => p.querySelector(".shortcut-box"))`;
  const order = await m.ev(`return [...${pane}.querySelectorAll(".setting-group, .setting-item > .setting-label")].slice(0, 4).map((e) => e.textContent)`);
  check("「快速记录」在全局快捷键一组里", order.join("|") === "全局快捷键|显示 / 隐藏主窗口|快速记录|应用内快捷键", order);
  const row = () =>
    m.ev(`const i = [...${pane}.querySelectorAll(".setting-item")].filter((x) => x.querySelector(".shortcut-box"))[1];
      return { value: i.querySelector(".shortcut-box").textContent.split(" ").join(""), err: i.querySelector(".error-text")?.textContent ?? "", warn: i.querySelector(".warning-text")?.textContent ?? "" }`);
  const record = () =>
    m.ev(`[...${pane}.querySelectorAll(".setting-item")].filter((x) => x.querySelector(".shortcut-box"))[1].querySelector(".shortcut-box").click(); await sleep(300); return 1`);
  const rowButton = (text) =>
    m.ev(`button(${JSON.stringify(text)}, [...${pane}.querySelectorAll(".setting-item")].filter((x) => x.querySelector(".shortcut-box"))[1]).click(); await sleep(800); return 1`);

  check("注册成功时没有占用提示", (await row()).value === quick && !(await row()).warn);
  check("没在录制时快捷键被测试版占着", !win.hotkeyFree(quickKey));
  await record();
  check("录制快捷键时全局快捷键都暂停（按下去不会弹出小窗、藏起主窗口）", win.hotkeyFree(quickKey) && win.hotkeyFree(t.TEST_KEYS.toggle.split("+").pop()));
  await m.press(t.TEST_KEYS.toggle);
  check("和别的快捷键重复时当场提示", /已用于「显示 \/ 隐藏主窗口」/.test((await row()).err), await row());
  const held = await win.holdHotkey("K", 6);
  await m.clearToasts();
  await m.press("Ctrl+Alt+K");
  await t.sleep(800);
  const toast = await m.toast();
  check("被别的程序占用时提示注册失败，仍用原来的", /注册失败/.test(toast) && (await row()).value === quick, { toast, row: await row() });
  await held.released;
  check("录制结束后又占着原来的", !win.hotkeyFree(quickKey));

  await record();
  await m.press("Ctrl+Alt+U");
  await t.sleep(800);
  let s = await m.invoke("get_settings");
  check("改成 Ctrl+Alt+U：存进设置并注册", s.settings.quickCaptureShortcut === "Ctrl+Alt+U" && s.quickCaptureShortcutRegistered && !win.hotkeyFree("U") && win.hotkeyFree(quickKey));
  win.hotkey("U");
  await t.sleep(400);
  check("按新的快捷键弹出小窗", win.windows().quick?.visible);
  win.hotkey("U");
  await t.sleep(300);

  // 默认的 Ctrl+Alt+N 可能被安装版占着：那样恢复默认会提示注册失败、仍用原来的
  const defaultFree = win.hotkeyFree("N");
  await m.clearToasts();
  await rowButton("恢复默认");
  s = await m.invoke("get_settings");
  if (defaultFree) check("恢复默认（Ctrl+Alt+N）", s.settings.quickCaptureShortcut === "Ctrl+Alt+N" && s.quickCaptureShortcutRegistered && win.hotkeyFree("U"));
  else check("恢复默认时默认按键被别的程序占着：提示注册失败，仍用原来的", /注册失败/.test(await m.toast()) && s.settings.quickCaptureShortcut === "Ctrl+Alt+U");
  await rowButton("不使用");
  s = await m.invoke("get_settings");
  check("不使用：放开快捷键", s.settings.quickCaptureShortcut === null && /未设置/.test((await row()).value) && win.hotkeyFree("U"));
  await m.openSettings("常规");
  const desc = await m.ev(`return [...document.querySelectorAll(".ant-modal .setting-desc")].map((e) => e.textContent).find((x) => x.includes("弹出小输入框"))`);
  check("不使用时「常规」里说明从托盘菜单打开", /托盘菜单/.test(desc ?? ""), desc);
  await m.closeModal();

  // 编辑快捷键：录制 Ctrl+F、Ctrl+H 时提示被占用，「固定按键」里列出查找、替换
  await m.openSettings("快捷键");
  const fixed = await m.ev(`return ${pane}.textContent`);
  check("「固定按键」里列出了查找、替换、查找下一个", /查找Ctrl\+F/.test(fixed.split(" ").join("")) && /替换Ctrl\+H/.test(fixed.split(" ").join("")) && fixed.includes("查找下一个"));
  const editHint = async (combo) => {
    await m.ev(`${pane}.querySelector(".shortcut-compact .shortcut-box").click(); await sleep(200); return 1`);
    await m.press(combo);
    await t.sleep(200);
    const h = await m.ev(`return ${pane}.querySelector(".shortcut-compact .error-text")?.textContent ?? ""`);
    await m.press("Escape");
    return h;
  };
  const hf = await editHint("Ctrl+F");
  const hh = await editHint("Ctrl+H");
  check("录制编辑快捷键时 Ctrl+F、Ctrl+H 提示被占用", /查找/.test(hf) && /替换/.test(hh), { hf, hh });
  await m.closeModal();

  // 加快速记录之前的设置文件：别的快捷键已经是 Ctrl+Alt+N，快速记录让给它
  await t.quit();
  const old = JSON.parse(t.read(".settings.json"));
  delete old.quickCaptureShortcut;
  delete old.quickCaptureTarget;
  old.toggleShortcut = "Ctrl+Alt+N";
  t.write(".settings.json", JSON.stringify(old));
  await t.restart();
  s = await t.main.invoke("get_settings");
  check("以前把别的快捷键设成了 Ctrl+Alt+N：快速记录设为不使用，没有冲突", s.settings.toggleShortcut === "Ctrl+Alt+N" && s.settings.quickCaptureShortcut === null, s.settings);
}
