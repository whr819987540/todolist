// 快速记录小窗
import { hotkey as hotkeyOf, windows as windowsOf } from "../lib/win.mjs";

export const title = "快速记录";

const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_APPWINDOW = 0x40000;

export default async function (t) {
  const { main: m, check, win } = t;
  const q = await t.quick();
  const quickKey = t.TEST_KEYS.quick.split("+").pop();
  // 模拟按下快速记录的全局快捷键；别的程序（如会议软件）过一两秒抢走前台时小窗会藏起来，检查要趁早
  const hotkey = async () => {
    win.hotkey(quickKey);
    await t.sleep(350);
  };
  const state = () =>
    q.ev(`await sleep(300); return { text: document.querySelector(".quick-input").value, target: document.querySelector(".quick-target").textContent,
      focus: document.activeElement?.classList.contains("quick-input"), dark: document.documentElement.style.colorScheme }`);
  const clear = async () => {
    await q.ev(`const i = document.querySelector(".quick-input"); i.focus(); i.select(); return 1`);
    await q.press("Delete");
  };
  const openTargets = () =>
    q.ev(`document.querySelector(".quick-target .ant-select-content").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); await sleep(400); return 1`);
  const inbox = () => (t.exists("收件箱/快速记录/.todos.json") ? t.meta("收件箱", "快速记录") : []);

  await q.ev(`localStorage.removeItem("quickCaptureDraft"); return 1`);
  await hotkey();
  let w = win.windows();
  let s = await state();
  check("按快捷键弹出小窗，输入框有焦点", w.quick?.visible && s.focus, { w, s });
  // 这时 Windows 让不让测试版拿前台（不让时下面「在前台」一类的检查跳过）
  const fg = !!w.quick?.fg;
  t.checkForeground(fg, "弹出的小窗在前台", fg);
  check("小窗不出现在 Alt+Tab 里（工具窗口）", (w.quick.exStyle & WS_EX_TOOLWINDOW) !== 0 && (w.quick.exStyle & WS_EX_APPWINDOW) === 0, w.quick.exStyle.toString(16));
  check("小窗不出现在任务栏上", !win.taskbarButtons("快速记录").length, win.taskbarButtons("快速记录"));
  await openTargets();
  const groups = await q.ev(`return [...document.querySelectorAll(".ant-select-item-group")].map((g) => g.textContent)`);
  check("第一次用时默认存到「收件箱 / 快速记录」，注明保存时新建", s.target === "收件箱 / 快速记录" && groups[0] === "保存时新建", { target: s.target, groups });
  await q.press("Escape");
  await t.sleep(200);
  check("下拉框开着时 Esc 只关下拉框", win.windows().quick?.visible);

  await q.ev(`document.querySelector(".quick-input").focus(); return 1`);
  await q.type("回电话给张三");
  await q.press("Shift+Enter");
  await q.type("号码在名片上");
  check("Shift+Enter 换行", (await state()).text === "回电话给张三\n号码在名片上");
  // 输入法组合中的 Enter 只是上屏
  await q.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
  await q.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Process", code: "Enter", windowsVirtualKeyCode: 229 });
  await q.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await q.send("Input.insertText", { text: "" });
  await t.sleep(300);
  check("输入法组合中按 Enter 不保存", !inbox().length);
  await clear();
  await q.type("回电话给张三");
  await q.press("Shift+Enter");
  await q.type("号码在名片上");
  await q.press("Enter");
  await t.sleep(1200);
  const saved = inbox();
  check("Enter 保存：建出「收件箱 / 快速记录」，第一行是标题、其余是正文",
    saved.length === 1 && saved[0].title === "回电话给张三" && t.read(`收件箱/快速记录/${saved[0].id}.md`) === "号码在名片上", saved);
  check("保存后小窗藏起来", !win.windows().quick?.visible);
  check("主窗口跟着刷新", (await m.ev(`await sleep(300); return [...document.querySelectorAll(".ws-card")].some((c) => c.textContent.includes("收件箱"))`)));
  check("存好后草稿清空", (await q.ev(`return localStorage.getItem("quickCaptureDraft")`)) === null);

  await hotkey();
  await q.type("写了一半的草稿");
  await q.press("Escape");
  await t.sleep(300);
  check("Esc 藏起小窗", !win.windows().quick?.visible);
  await hotkey();
  s = await state();
  check("没存的草稿下次弹出还在", s.text === "写了一半的草稿" && s.focus, s);
  await hotkey();
  t.checkForeground(fg, "小窗在前台时再按一次快捷键藏起来", !win.windows().quick?.visible);
  // 点到别处：按「显示 / 隐藏主窗口」的快捷键把主窗口调到前台，小窗失去焦点
  await hotkey();
  win.hotkey(t.TEST_KEYS.toggle.split("+").pop());
  await t.sleep(600);
  w = win.windows();
  t.checkForeground(fg, "点到别处（失去焦点）时藏起来", w.main.fg && !w.quick?.visible, w);
  if (win.windows().quick?.visible) await q.press("Escape");

  // Ctrl+Enter 保存并在主窗口打开：主窗口在首页、在别的工作区、藏在托盘里
  const openCase = async (name, prepare, submit) => {
    await prepare();
    await hotkey();
    await clear();
    await q.type(name);
    await submit();
    await t.sleep(400);
    const w = win.windows().main;
    await t.sleep(1000);
    const title = await m.ev(`return document.querySelector(".editor-title")?.value`);
    check(`保存并在主窗口打开（${name}）：显示主窗口，打开了这条`, w.visible && !w.min && title === name, { w, title });
    t.checkForeground(fg, `保存并在主窗口打开（${name}）：主窗口在前台`, w.fg, w);
  };
  const ctrlEnter = () => q.press("Ctrl+Enter");
  await openCase("主窗口在首页", () => m.ev(`document.querySelector(".anticon-home")?.closest("button")?.click(); await sleep(300); return 1`), ctrlEnter);
  await openCase("主窗口在别的工作区", () => m.enter("生活"), () => q.ev(`button("保存并打开").click(); return 1`));
  await openCase("主窗口藏在托盘里", async () => {
    win.close();
    await t.sleep(600);
  }, ctrlEnter);

  // 换存到的项目；改名、移动后跟着变
  await hotkey();
  await openTargets();
  await q.ev(`[...document.querySelectorAll(".ant-select-item-option")].find((o) => o.textContent === "杂事").click(); await sleep(400); return 1`);
  await q.press("Escape");
  await hotkey();
  check("换「存到」的项目后再打开还是它", (await state()).target === "生活 / 杂事");
  await q.press("Escape");
  await m.invoke("rename_project", { workspace: "生活", name: "杂事", newName: "杂事2" });
  await hotkey();
  const renamed = (await state()).target;
  await q.press("Escape");
  await m.invoke("move_project", { workspace: "生活", name: "杂事2", targetWorkspace: "学习" });
  await hotkey();
  const moved = (await state()).target;
  await q.press("Escape");
  check("项目改名、移到别的工作区后，小窗里跟着变", renamed === "生活 / 杂事2" && moved === "学习 / 杂事2", { renamed, moved });

  // 设置「常规」里看到的是现在的，也能改
  await m.openSettings("常规");
  const shown = await m.ev(`return document.querySelector(".quick-target-setting").textContent`);
  check("设置「常规」里显示的是在小窗里改过、跟着改名移动过的", shown === "学习 / 杂事2", shown);
  await m.ev(`document.querySelector(".quick-target-setting .ant-select-content").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); await sleep(400);
    [...document.querySelectorAll(".ant-select-item-option")].find((o) => o.textContent === "快速记录").click(); await sleep(500); return 1`);
  await m.closeModal();
  await hotkey();
  check("在设置「常规」里改存到哪里，小窗跟着变", (await state()).target === "收件箱 / 快速记录");
  await q.press("Escape");

  await m.invoke("set_theme", { theme: "dark" });
  await hotkey();
  check("切到深色后小窗也是深色", (await state()).dark === "dark");
  await q.press("Escape");
  await m.invoke("set_theme", { theme: "light" });

  // 刚启动（小窗 3 秒后才预先建好）就按快捷键：在别的线程里建，不卡住程序
  let early = null;
  await t.restart({
    onSpawn: async (pid) => {
      await t.sleep(1200);
      hotkeyOf(pid, quickKey);
      await t.sleep(800);
      early = windowsOf(pid).quick;
    },
  });
  check("刚启动、小窗还没建好时按快捷键也能弹出来，程序不卡", early?.visible && (await t.main.ev(`return 1`)) === 1, early);
  win.hotkey(quickKey);
}
