// 端到端测试用的测试版程序：构建、启动、退出，测试数据和用完后的清理
//
// 测试版换了 identifier 和产品名（com.whr.todolist.e2e / 待办清单自动测试），和安装版、手动测试版互不干扰：
// 单实例、WebView2 缓存、窗口位置、开机启动项都分开。数据放在 %TEMP%\todolist-e2e\data，不碰真实数据。
// 程序是 debug 构建，前端从 Vite 开发服务器（:1420）加载，测试里可以 import 页面用的模块（如替换 api 的方法）

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seed } from "./fixtures.mjs";
import { ps } from "./win.mjs";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const IDENTIFIER = "com.whr.todolist.e2e";
export const PRODUCT = "待办清单自动测试";
export const TARGET_DIR = join(ROOT, "src-tauri", "target", "e2e");
export const EXE = join(TARGET_DIR, "debug", "todo-list.exe");
export const WORK = join(tmpdir(), "todolist-e2e");
export const DATA = join(WORK, "data");
export const CDP_PORT = 9223;
export const VITE_URL = "http://localhost:1420";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 测试版的配置，盖在 tauri.conf.json 上：换 identifier、产品名，主窗口的 WebView2 打开远程调试端口（CDP）。
 * 端口写在配置里，不用环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS：GitHub 的 Windows 机器上 WebView2 不认它。
 * 设了 additionalBrowserArgs 就不再带 wry 默认的参数，要一起写上；快速记录小窗在 lib.rs 里沿用主窗口的
 */
function testConfig() {
  const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  // TAURI_CONFIG 按 JSON Merge Patch 合并，数组整个替换，所以要给出完整的 windows
  const windows = conf.app.windows.map((w) =>
    w.label === "main"
      ? { ...w, additionalBrowserArgs: `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=${CDP_PORT}` }
      : w,
  );
  return { identifier: IDENTIFIER, productName: PRODUCT, app: { windows } };
}

/** 构建测试版（增量构建，没改 Rust 代码时几秒） */
export function build() {
  console.log("构建测试版程序…");
  execFileSync("cargo", ["build", "--manifest-path", join(ROOT, "src-tauri", "Cargo.toml"), "--target-dir", TARGET_DIR], {
    stdio: "inherit",
    env: { ...process.env, TAURI_CONFIG: JSON.stringify(testConfig()) },
  });
}

/** Vite 开发服务器：已经在跑就用它（要是这个工作副本的），否则启动一个，返回要不要在最后关掉它 */
export async function ensureVite() {
  if (await reachable(VITE_URL)) {
    console.log(`使用已经在运行的 Vite（${VITE_URL}），请确认它是这个工作副本的`);
    return null;
  }
  console.log("启动 Vite…");
  const vite = spawn(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--port", "1420", "--strictPort"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  for (let i = 0; i < 60 && !(await reachable(VITE_URL)); i++) await sleep(500);
  if (!(await reachable(VITE_URL))) throw new Error("Vite 没有启动起来");
  return vite;
}

async function reachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/** 正在运行的测试版的进程号（只认 EXE 这个路径的，不会碰到安装版和别的构建） */
export function runningPids() {
  const out = ps(
    `Get-CimInstance Win32_Process -Filter "name='todo-list.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE.replace(/'/g, "''")}' } | ForEach-Object { $_.ProcessId }`,
  );
  return out.split(/\s+/).filter(Boolean).map(Number);
}

/** 结束残留的测试版进程 */
export function killLeftovers() {
  for (const pid of runningPids()) {
    try {
      process.kill(pid);
    } catch {
      /* 已经退出了 */
    }
  }
}

/** 重建测试数据（程序没在运行时调用） */
export function resetData(settings = {}) {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  seed(DATA, settings);
}

/**
 * 启动测试版，等主窗口的页面加载好；args 是命令行参数（如 --autostart）。返回进程号。
 * onSpawn(pid) 在进程刚起来时就开始执行（不等页面加载），用来测刚启动时的情况，也等它做完再返回
 */
export async function launch(args = [], onSpawn) {
  if (runningPids().length) throw new Error("测试版还在运行，不能再启动一个（会交给它并退出）");
  const child = spawn(EXE, args, {
    detached: true,
    stdio: "ignore",
    // debug 构建是控制台程序，不藏起来会多弹出一个控制台窗口
    windowsHide: true,
    env: {
      ...process.env,
      TODOLIST_DATA_DIR: DATA,
    },
  });
  child.unref();
  const spawned = onSpawn?.(child.pid);
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      if (targets.some((t) => t.type === "page" && t.url.startsWith(VITE_URL) && !t.url.includes("quick.html"))) {
        await sleep(1500);
        await spawned;
        return child.pid;
      }
    } catch {
      /* 还没起来 */
    }
  }
  throw new Error("测试版的主窗口没有加载出来");
}

/** 等进程结束；超时返回 false */
export async function waitExit(ms = 10000) {
  for (let t = 0; t < ms; t += 250) {
    if (!runningPids().length) return true;
    await sleep(250);
  }
  return false;
}

export { existsSync };
