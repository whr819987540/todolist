// 构建安装包并安装到本机（已安装时按升级覆盖）
// 用法：npm run release [-- <x.y.z | patch | minor | major>]，带参数时先改版本号
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const confPath = join(root, "src-tauri", "tauri.conf.json");
const cargoPath = join(root, "src-tauri", "Cargo.toml");
const bundleDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

function run(cmd, hint = "") {
  console.log(`\n> ${cmd}`);
  const r = spawnSync(cmd, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) fail(`${cmd} 失败${hint}`);
}

/** 只替换第一处，找不到时报错，避免版本号悄悄没改上 */
function replaceFirst(path, pattern, replacement) {
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) fail(`${path} 里没找到版本号`);
  writeFileSync(path, text.replace(pattern, replacement));
}

function readConf() {
  return JSON.parse(readFileSync(confPath, "utf8"));
}

/** 当前用户是否有名为 exe 的进程在运行（安装程序按进程名结束程序，不看路径） */
function isRunning(exe) {
  const r = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${exe}`, "/FO", "CSV", "/NH"], { encoding: "latin1" });
  return r.stdout.toLowerCase().includes(`"${exe.toLowerCase()}"`);
}

/** 安装程序（currentUser 模式）在 HKCU 下登记的卸载项 */
function isInstalled(productName) {
  const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productName}`;
  return spawnSync("reg", ["query", key], { stdio: "ignore" }).status === 0;
}

// 1. 改版本号：npm 负责 package.json / package-lock.json，其余两处同步过去；Cargo.lock 构建时自动更新
const bump = process.argv[2];
if (bump) {
  if (!/^(\d+\.\d+\.\d+|patch|minor|major)$/.test(bump)) {
    fail(`版本号参数不对：${bump}\n  用法：npm run release [-- <x.y.z | patch | minor | major>]`);
  }
  run(`npm version ${bump} --no-git-tag-version`);
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  replaceFirst(confPath, /("version":\s*")[^"]*"/, `$1${version}"`);
  replaceFirst(cargoPath, /^version = "[^"]*"/m, `version = "${version}"`);
  console.log(`版本号已改为 ${version}`);
}

const { productName, version, mainBinaryName } = readConf();
const exe = `${mainBinaryName}.exe`;

// 2. 构建
run(
  "npm run tauri build",
  `\n  如果提示拒绝访问（os error 5），先退出正在运行的 src-tauri\\target\\release\\${exe} 再重试`,
);
const setup = readdirSync(bundleDir).find(
  (f) => f.startsWith(`${productName}_${version}_`) && f.endsWith("-setup.exe"),
);
if (!setup) fail(`${bundleDir} 里没有 ${version} 版的安装包`);

// 3. 安装程序会直接结束正在运行的程序，先等用户从托盘退出，让程序自己保存正在编辑的内容
if (isRunning(exe)) {
  console.log(`\n${productName}正在运行：请右键托盘图标选「退出」，退出后自动继续安装（Ctrl+C 取消）`);
  while (isRunning(exe)) await sleep(1000);
}

// 4. /P 只显示进度条；/R 装完启动程序；/UPDATE 覆盖安装，不先卸载旧版、不重建用户删掉的快捷方式
const installed = isInstalled(productName);
const args = ["/P", "/R", ...(installed ? ["/UPDATE"] : [])];
console.log(`\n> ${setup} ${args.join(" ")}`);
const r = spawnSync(join(bundleDir, setup), args, { stdio: "ignore" });
if (r.status !== 0) fail(`安装失败（退出码 ${r.status ?? r.error?.message}）`);
console.log(`\n✔ ${productName} ${version} 已${installed ? "升级" : "安装"}并启动`);
