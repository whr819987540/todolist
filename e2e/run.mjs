// Windows 上的端到端测试：构建测试版、逐个套件启动它（每个套件都用新的测试数据），经 CDP 和 Win32 API 操作并检查。
//
//   npm run e2e                       全部套件
//   npm run e2e -- quick recycle      只跑这几个
//   npm run e2e -- --no-build         不重新构建（只改了前端时）
//   npm run e2e -- --keep             跑完留着测试数据（%TEMP%\todolist-e2e\data）
//
// 详见 README.md 的「端到端测试（Windows）」
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as app from "./lib/app.mjs";
import { connect, sleep } from "./lib/cdp.mjs";
import { TEST_KEYS } from "./lib/fixtures.mjs";
import * as win from "./lib/win.mjs";

const SUITES = [
  "find",
  "search",
  "outline",
  "autostart",
  "startup",
  "quick",
  "shortcuts",
  "pin",
  "reorder",
  "batch",
  "recycle",
  "hidedone",
  "tabs",
  "regress",
];

const argv = process.argv.slice(2);
const wanted = argv.filter((a) => !a.startsWith("--"));
const unknown = wanted.filter((s) => !SUITES.includes(s));
if (unknown.length) {
  console.error(`没有这些套件：${unknown.join("、")}。可以用的：${SUITES.join("、")}`);
  process.exit(2);
}
if (process.platform !== "win32") {
  console.error("端到端测试只能在 Windows 上跑");
  process.exit(2);
}

const results = [];
/**
 * 模拟的全局快捷键不是真的按键，测试版要拿到前台只能靠 tao 的 set_focus（模拟按一下 Alt 再 SetForegroundWindow）。
 * 锁屏了、前台的程序是以管理员身份运行的（模拟按键送不进去）、或者有人正在别的程序里操作时，Windows 不让换前台
 */
const FOREGROUND_LOCKED =
  "Windows 没让测试版拿到前台：可能锁屏了、前台的程序是以管理员身份运行的，或有人正在用别的程序。解锁、换个普通程序在前台、别动键盘鼠标后重跑这个套件";
let lastSkipReason = "";
let failed = 0;
let current = "";

/** 交给套件的上下文 */
function makeContext() {
  const t = {
    TEST_KEYS,
    data: app.DATA,
    product: app.PRODUCT,
    pid: 0,
    main: null,
    sleep,
    file: (rel) => join(app.DATA, rel),
    exists: (rel) => existsSync(join(app.DATA, rel)),
    read: (rel) => readFileSync(join(app.DATA, rel), "utf8"),
    write: (rel, content) => writeFileSync(join(app.DATA, rel), content),
    remove: (rel) => rmSync(join(app.DATA, rel), { recursive: true, force: true }),
    /** 项目里 .todos.json 记着的待办 */
    meta: (ws, p) => JSON.parse(readFileSync(join(app.DATA, ws, p, ".todos.json"), "utf8")).todos,
    check(name, ok, extra) {
      if (!ok) failed++;
      results.push({ suite: current, name, ok });
      console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || extra === undefined ? "" : "\n      " + JSON.stringify(extra)}`);
    },
    /** 等到 fn() 为真（每 200 毫秒看一次），最多 ms 毫秒；返回最后一次的结果 */
    async until(fn, ms = 5000) {
      let r;
      for (let waited = 0; !(r = await fn()) && waited < ms; waited += 200) await sleep(200);
      return r;
    },
    /** 这次没法检查的（如 Windows 不让测试版拿到前台），列出来但不算失败 */
    skip(name, reason) {
      results.push({ suite: current, name, ok: true, skipped: true });
      // 同一个套件里原因一样的只说一次
      const key = `${current}\n${reason}`;
      console.log(`  - 跳过：${name}${key === lastSkipReason ? "" : `（${reason}）`}`);
      lastSkipReason = key;
    },
    /** 要看窗口是否在前台的检查：fgAllowed 为 false（套件开头试过，Windows 不让测试版拿前台）时跳过 */
    checkForeground(fgAllowed, name, ok, extra) {
      if (fgAllowed) t.check(name, ok, extra);
      else t.skip(name, FOREGROUND_LOCKED);
    },
    /** 快速记录小窗的页面（第一次用时连上） */
    async quick() {
      t._quick ??= await connect("quick");
      return t._quick;
    },
    win: {
      windows: () => win.windows(t.pid),
      hotkey: (key) => win.hotkey(t.pid, key),
      show: (cmd, title) => win.showWindow(t.pid, cmd, title),
      close: (title) => win.closeWindow(t.pid, title),
      icons: (title) => win.icons(t.pid, title),
      hotkeyFree: win.hotkeyFree,
      holdHotkey: win.holdHotkey,
      lockFile: win.lockFile,
      recycleBin: () => win.recycleBin(app.DATA),
      undelete: (name) => win.undelete(app.DATA, name),
      taskbarButtons: win.taskbarButtons,
      runEntry: () => win.runEntry(app.PRODUCT),
      approvedEntry: () => win.approvedEntry(app.PRODUCT),
      setApproved: (bytes) => win.setApproved(app.PRODUCT, bytes),
      removeAutostart: () => win.removeAutostart(app.PRODUCT),
      runEntryOf: win.runEntry,
    },
    exe: app.EXE,
    /** 退出测试版：和托盘「退出」一样先让页面存盘（quit-requested），等进程结束；没结束就强制结束 */
    async quit() {
      t._quick?.close();
      t._quick = null;
      if (t.main) {
        t.main.send("Runtime.evaluate", { expression: `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "quit-requested", payload: null })` });
        await sleep(300);
        t.main.close();
        t.main = null;
      }
      if (!(await app.waitExit(8000))) app.killLeftovers();
      await app.waitExit(3000);
    },
    /** 重新启动测试版：fresh 时先重建测试数据（settings 盖在默认的测试设置上）；args 是命令行参数；onSpawn 见 app.launch */
    async restart({ fresh = false, settings = {}, args = [], onSpawn } = {}) {
      await t.quit();
      if (fresh) app.resetData(settings);
      t.pid = await app.launch(args, onSpawn);
      t.main = await connect("main");
      if (fresh) {
        // 本机记的界面偏好（排序、折叠、大纲、草稿）也清掉
        await t.main.ev(`localStorage.clear(); return 1`);
        await t.main.reload();
      }
    },
  };
  return t;
}

async function main() {
  if (!argv.includes("--no-build")) app.build();
  if (!existsSync(app.EXE)) throw new Error(`没有测试版程序 ${app.EXE}，去掉 --no-build 先构建`);
  const vite = await app.ensureVite();
  app.killLeftovers();
  for (const [name, key] of [["显示 / 隐藏主窗口", TEST_KEYS.toggle], ["快速记录", TEST_KEYS.quick]]) {
    if (!win.hotkeyFree(key.split("+").pop())) console.warn(`注意：${key}（测试版的「${name}」）被别的程序占着，相关的检查会失败`);
  }
  const t = makeContext();
  try {
    for (const name of wanted.length ? wanted : SUITES) {
      current = name;
      const suite = await import(`./suites/${name}.mjs`);
      console.log(`\n■ ${suite.title ?? name}`);
      try {
        await t.restart({ fresh: true });
        await suite.default(t);
      } catch (e) {
        failed++;
        results.push({ suite: name, name: "（出错中断）", ok: false });
        console.log(`  ✗ 出错中断：${e.stack ?? e}`);
        await t.main?.viewport(0).catch(() => {});
      }
    }
  } finally {
    await t.quit();
    win.removeAutostart(app.PRODUCT);
    // 彻底删除、清空、放满 30 天的移到了 Windows 回收站：还原回测试数据目录再一起删掉，不在用户的回收站里留东西
    if (win.recycleBin(app.DATA).length) win.undelete(app.DATA);
    if (!argv.includes("--keep")) rmSync(app.WORK, { recursive: true, force: true });
    vite?.kill();
  }
  const skipped = results.filter((r) => r.skipped).length;
  const passed = results.filter((r) => r.ok && !r.skipped).length;
  console.log(`\n${failed ? `✗ ${failed} 项没通过` : "✓ 全部通过"}（共 ${results.length} 项检查，通过 ${passed} 项${skipped ? `，跳过 ${skipped} 项` : ""}）`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ [${r.suite}] ${r.name}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
