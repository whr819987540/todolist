// 端到端测试里的 Windows 操作（窗口状态、全局快捷键、注册表、回收站、任务栏、占用文件），都经 PowerShell 调 Win32 API。
// 只针对测试版的进程和测试数据目录，不碰别的程序；模拟快捷键是直接给测试版发 WM_HOTKEY，不经过键盘
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../win/win.ps1", import.meta.url));

/** 执行一段 PowerShell 命令，返回输出（UTF-8）；命令用 -EncodedCommand 传，中文不会乱 */
export function ps(command) {
  // 最后 exit 0：Remove-ItemProperty 这类命令要删的本来就没有时，-ErrorAction SilentlyContinue 不报错但退出码仍是 1
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; ${command}; exit 0`;
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function win(action, params = {}) {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Action", action];
  for (const [k, v] of Object.entries(params)) args.push(`-${k}`, String(v));
  return execFileSync("powershell", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const lines = (s) => s.split(/\r?\n/).filter(Boolean);

export const MAIN_TITLE = "待办清单";
export const QUICK_TITLE = "快速记录";

/** 进程的两个窗口（主窗口、快速记录小窗）现在的样子；没有的为 null */
export function windows(pid) {
  const out = {};
  for (const l of lines(win("windows", { ProcId: pid }))) {
    const [title, visible, max, min, fg, ex] = l.split("|");
    out[title] = { visible: visible === "True", max: max === "True", min: min === "True", fg: fg === "True", exStyle: parseInt(ex, 16) };
  }
  return { main: out[MAIN_TITLE] ?? null, quick: out[QUICK_TITLE] ?? null };
}

/** ShowWindow：3 最大化、9 还原、6 最小化 */
export const showWindow = (pid, cmd, title = MAIN_TITLE) => win("show", { ProcId: pid, Title: title, Cmd: cmd });
/** 点窗口右上角的关闭按钮（WM_CLOSE） */
export const closeWindow = (pid, title = MAIN_TITLE) => win("close", { ProcId: pid, Title: title });
/** 窗口的大图标、小图标句柄 */
export const icons = (pid, title = MAIN_TITLE) => win("icons", { ProcId: pid, Title: title }).split(" ").map(Number);
/** 模拟按下全局快捷键 Ctrl+Alt+key（key 是一个字母） */
export const hotkey = (pid, key) => win("hotkey", { ProcId: pid, Key: key });
/** Ctrl+Alt+key 现在没被任何程序占着 */
export const hotkeyFree = (key) => win("free", { Key: key }).endsWith("free=True");

/** 占住 Ctrl+Alt+key seconds 秒（模拟被别的程序占用），占上之后才返回 */
export function holdHotkey(key, seconds) {
  return holdWith("free", { Key: key, Hold: seconds }, "held");
}

/** 独占打开文件 seconds 秒（模拟正被别的程序占用），打开之后才返回；返回的 promise 在放开后完成 */
export function lockFile(path, seconds) {
  return holdWith("lock", { Path: path, Hold: seconds }, "locked");
}

function holdWith(action, params, ready) {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Action", action];
  for (const [k, v] of Object.entries(params)) args.push(`-${k}`, String(v));
  const child = spawn("powershell", args, { stdio: ["ignore", "pipe", "ignore"] });
  const released = new Promise((r) => child.on("close", r));
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes(ready)) resolve({ released });
    });
    child.on("close", () => reject(new Error(`${action} 没有成功：${out.trim()}`)));
  });
}

/** Windows 回收站里从 dataDir 删掉的东西：[{ name, from }]（不列用户自己删的） */
export const recycleBin = (dataDir) =>
  lines(win("bin", { DataDir: dataDir })).map((l) => {
    const [name, from] = l.split("|");
    return { name, from };
  });
/** 从 Windows 回收站还原从 dataDir 删掉的、名字是 name 的（name 为空时全部） */
export const undelete = (dataDir, name = "") => win("undelete", name ? { DataDir: dataDir, Name: name } : { DataDir: dataDir });
/** 任务栏上名字里带 name 的按钮 */
export const taskbarButtons = (name) => lines(win("taskbar", { Name: name }));

const RUN = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVED = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const quote = (s) => `'${s.replace(/'/g, "''")}'`;

/** 开机启动项（Run 里名为 name 的值），没有时为空字符串 */
export const runEntry = (name) =>
  ps(`(Get-ItemProperty -Path ${quote(RUN)} -Name ${quote(name)} -ErrorAction SilentlyContinue).${quote(name)}`);
/** 任务管理器里的启用 / 禁用标记（StartupApproved\Run 里名为 name 的值），没有时为 null */
export function approvedEntry(name) {
  const out = ps(`$v = (Get-ItemProperty -Path ${quote(APPROVED)} -Name ${quote(name)} -ErrorAction SilentlyContinue).${quote(name)}; if ($v) { ($v | ForEach-Object { $_.ToString() }) -join ',' }`);
  return out ? out.split(",").map(Number) : null;
}
/** 模拟在任务管理器里禁用 / 启用（写 StartupApproved） */
export const setApproved = (name, bytes) =>
  ps(`New-Item -Path ${quote(APPROVED)} -Force | Out-Null; Set-ItemProperty -Path ${quote(APPROVED)} -Name ${quote(name)} -Type Binary -Value ([byte[]](${bytes.join(",")}))`);
/** 删掉 name 的开机启动项和任务管理器标记 */
export const removeAutostart = (name) =>
  ps(`Remove-ItemProperty -Path ${quote(RUN)} -Name ${quote(name)} -ErrorAction SilentlyContinue; Remove-ItemProperty -Path ${quote(APPROVED)} -Name ${quote(name)} -ErrorAction SilentlyContinue`);

const ZIP = "Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem;";

/** zip 里的各项（包里的路径，文件夹以 / 结尾） */
export const zipEntries = (path) =>
  JSON.parse(
    ps(`${ZIP} $z = [IO.Compression.ZipFile]::OpenRead(${quote(path)}); try { ConvertTo-Json -Compress -InputObject @($z.Entries | ForEach-Object { $_.FullName }) } finally { $z.Dispose() }`) || "[]",
  );

/** zip 里一个文件的内容（UTF-8），没有这个文件时为空字符串 */
export const zipText = (path, entry) =>
  ps(`${ZIP} $z = [IO.Compression.ZipFile]::OpenRead(${quote(path)}); try { $e = $z.GetEntry(${quote(entry)}); if ($e) { $r = New-Object IO.StreamReader($e.Open()); $r.ReadToEnd(); $r.Dispose() } } finally { $z.Dispose() }`);

/** 拼一个 zip（已有的先删掉）：files 是 { 包里的路径: 内容 }，路径照原样写进去（可以是 ../ 这种不安全的） */
export function makeZip(path, files) {
  ps(`${ZIP} Remove-Item -LiteralPath ${quote(path)} -ErrorAction SilentlyContinue; $files = ${quote(JSON.stringify(files))} | ConvertFrom-Json;
    $z = [IO.Compression.ZipFile]::Open(${quote(path)}, 'Create');
    foreach ($p in $files.PSObject.Properties) { $w = New-Object IO.StreamWriter($z.CreateEntry($p.Name).Open()); $w.Write([string]$p.Value); $w.Dispose() }
    $z.Dispose()`);
}
