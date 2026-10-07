// 经 WebView2 的 CDP（远程调试端口）控制测试版的页面：在页面里执行代码、发送真实的键盘 / 鼠标事件
import { CDP_PORT } from "./app.mjs";
import { PRELUDE } from "./page.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 键名 → [code, windowsVirtualKeyCode, key] */
const KEYS = {
  "`": ["Backquote", 192, "`"],
  "\\": ["Backslash", 220, "\\"],
  "=": ["Equal", 187, "="],
  "-": ["Minus", 189, "-"],
  "/": ["Slash", 191, "/"],
  "[": ["BracketLeft", 219, "["],
  "]": ["BracketRight", 221, "]"],
  Tab: ["Tab", 9, "Tab"],
  Enter: ["Enter", 13, "Enter"],
  Escape: ["Escape", 27, "Escape"],
  Delete: ["Delete", 46, "Delete"],
  Backspace: ["Backspace", 8, "Backspace"],
  ArrowUp: ["ArrowUp", 38, "ArrowUp"],
  ArrowDown: ["ArrowDown", 40, "ArrowDown"],
  ArrowLeft: ["ArrowLeft", 37, "ArrowLeft"],
  ArrowRight: ["ArrowRight", 39, "ArrowRight"],
  F3: ["F3", 114, "F3"],
  F5: ["F5", 116, "F5"],
};

/**
 * 连到页面：kind 为 "main"（主窗口）或 "quick"（快速记录小窗）。返回的对象：
 * - ev(code)：在页面里执行一段 async 函数体（可以用 page.mjs 里的工具函数），返回 return 的值
 * - press("Ctrl+Shift+F")、type(text)：真实的按键、输入
 * - click(p, { ctrl, shift, right })、drag：鼠标
 */
export async function connect(kind = "main") {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = targets.find((t) => t.type === "page" && (kind === "quick") === t.url.includes("quick.html"));
  if (!page) throw new Error(`找不到${kind === "quick" ? "快速记录小窗" : "主窗口"}的页面`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  const ev = async (code) => {
    const r = await send("Runtime.evaluate", {
      expression: `(async () => { ${PRELUDE}\n${code} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error(`页面里出错：${d.exception?.description ?? d.exception?.value ?? d.text}`);
    }
    return r.result?.result?.value;
  };

  const press = async (combo) => {
    const parts = combo.split("+");
    const k = parts.pop() || "+";
    const ctrl = parts.includes("Ctrl");
    const alt = parts.includes("Alt");
    const shift = parts.includes("Shift");
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0);
    let code, vk, key;
    if (KEYS[k]) [code, vk, key] = KEYS[k];
    else if (/^\d$/.test(k)) [code, vk, key] = [`Digit${k}`, 48 + Number(k), shift && k === "1" ? "!" : k];
    else [code, vk, key] = [`Key${k.toUpperCase()}`, k.toUpperCase().charCodeAt(0), shift ? k.toUpperCase() : k.toLowerCase()];
    const base = { modifiers, key, code, windowsVirtualKeyCode: vk };
    // Enter 要带上文字（\r），输入框里才会换行
    if (k === "Enter" && !alt) await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: "\r", unmodifiedText: "\r" });
    else await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    if (!ctrl && !alt && key.length === 1) await send("Input.dispatchKeyEvent", { type: "char", ...base, text: key });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(80);
  };
  const type = (text) => send("Input.insertText", { text });

  const mouse = (type, p, extra = {}) => send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, ...extra });
  const click = async (p, { ctrl = false, shift = false, right = false } = {}) => {
    const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const button = right ? "right" : "left";
    await mouse("mouseMoved", p, { modifiers });
    await mouse("mousePressed", p, { button, buttons: right ? 2 : 1, clickCount: 1, modifiers });
    await mouse("mouseReleased", p, { button, buttons: 0, clickCount: 1, modifiers });
    await sleep(250);
  };
  /** 拖动：按下、分几步移到 to（带 buttons: 1，否则页面以为鼠标已经松开）；release 为 false 时停在那里不松开 */
  const drag = async (from, to, { steps = 12, release = true } = {}) => {
    await mouse("mouseMoved", from);
    await mouse("mousePressed", from, { button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
      await mouse("mouseMoved", p, { button: "left", buttons: 1 });
      await sleep(16);
    }
    if (release) await drop(to);
  };
  const drop = async (p) => {
    await mouse("mouseReleased", p, { button: "left", buttons: 0, clickCount: 1 });
    await sleep(800);
  };

  /** 元素中心的坐标：sel 是 CSS 选择器，或 [工作区, 项目, 待办]（侧栏的一行）；dy 是相对中心上下偏移几分之几行高 */
  const at = (sel, dy = 0) =>
    ev(`const e = ${Array.isArray(sel) ? `row(...${JSON.stringify(sel)})` : `document.querySelector(${JSON.stringify(sel)})`};
      if (!e) throw new Error("找不到 " + ${JSON.stringify(JSON.stringify(sel))});
      e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2 + r.height * ${dy}) };`);

  /** 现在显示着的提示（antd 的 message） */
  const toast = () => ev(`return [...document.querySelectorAll(".ant-message-notice")].map((e) => e.textContent).join(" | ")`);
  const clearToasts = () => ev(`document.querySelectorAll(".ant-message-notice").forEach((e) => e.remove()); return 1`);
  const invoke = (cmd, args = {}) => ev(`return await invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  const emit = (event) => ev(`await emit(${JSON.stringify(event)}); return 1`);

  /** 回首页，点工作区的卡片进入 */
  const enter = (workspace) =>
    ev(`document.querySelector(".anticon-home")?.closest("button")?.click(); await sleep(400);
      const card = await waitFor(() => [...document.querySelectorAll(".ws-card")].find((c) => c.textContent.includes(${JSON.stringify(workspace)})));
      if (!card) throw new Error("首页没有工作区 " + ${JSON.stringify(workspace)});
      card.click(); return !!(await waitFor(() => row(${JSON.stringify(workspace)})));`);
  /** 侧栏顶部「选中工作区」里全选 */
  const selectAllWorkspaces = () =>
    ev(`document.querySelector(".ws-switcher").click(); await sleep(400);
      button("全选", document.querySelector(".ws-picker-foot")).click();
      await sleep(400); document.querySelector(".ws-switcher").click(); await sleep(300); return 1`);
  /** 展开侧栏里全部折叠着的工作区、项目 */
  const expandAll = () => ev(`for (const c of document.querySelectorAll(".tree .chevron:not(.open)")) c.click(); await sleep(300); return 1`);
  /** 打开设置对话框的某个页签 */
  const openSettings = (tab) =>
    ev(`document.querySelector(".anticon-home")?.closest("button")?.click(); await sleep(300);
      document.querySelector(".anticon-setting").closest("button").click();
      const t = await waitFor(() => [...document.querySelectorAll(".ant-modal .ant-tabs-tab")].find((x) => x.textContent.includes(${JSON.stringify(tab)})));
      t.click(); await sleep(400); return 1`);
  const closeModal = () => ev(`document.querySelector(".ant-modal-close")?.click(); await sleep(300); return 1`);
  /** 刷新页面（相当于重新打开窗口，不重启程序） */
  const reload = async () => {
    await send("Page.reload");
    await sleep(2500);
  };
  /** 把页面视口设大一些：窗口小的时候展开几个工作区后，要拖到的行在侧栏可见区域外面 */
  const viewport = (width, height) =>
    width ? send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }) : send("Emulation.clearDeviceMetricsOverride");

  return {
    send, ev, press, type, mouse, click, drag, drop, at, toast, clearToasts, invoke, emit,
    enter, selectAllWorkspaces, expandAll, openSettings, closeModal, reload, viewport,
    close: () => ws.close(),
  };
}
