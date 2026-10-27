// 自动更新的端到端测试用的：本机的假更新服务器、假的安装程序。
//
// 测试版检查更新时连 http://127.0.0.1:UPDATE_PORT/latest.json、认测试用的签名（app.mjs 的 testConfig）。
// 「安装程序」是测试时用 PowerShell 编出来的小程序，只把收到的命令行写进 ARGS_FILE 就退出，不真的安装；
// 用测试用的私钥（e2e/updater/test.key，没有密码）签名，同发布时 tauri build 给安装包签名
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { IDENTIFIER, ROOT, UPDATE_PORT, WORK } from "./app.mjs";
import { ps } from "./win.mjs";

const DIR = join(WORK, "updater");
const SETUP = join(DIR, "setup.exe");
const OTHER = join(DIR, "other.bin");
/** 假安装程序把收到的命令行写在这里 */
export const ARGS_FILE = join(DIR, "installer-args.txt");
/** 软件运行安装程序之前记下的标记（update.rs 的 MARKER_FILE），在这台电脑上的配置目录里 */
export const MARKER = join(process.env.APPDATA ?? "", IDENTIFIER, "update-pending.json");

/** 测试版的版本号（tauri.conf.json） */
export const appVersion = () => JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")).version;

/**
 * 用测试用的私钥给 file 签名，返回签名（同 .sig 文件的内容）。给了 version 时签名里记下这个版本号（同发布时 tauri build
 * 签的），软件会拿它和 latest.json 宣布的版本比
 */
function sign(file, version) {
  rmSync(`${file}.sig`, { force: true });
  const args = ["signer", "sign", "-f", join(ROOT, "e2e", "updater", "test.key"), "-p", "", ...(version ? ["--app-version", version] : []), file];
  execFileSync(process.execPath, [join(ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js"), ...args], { stdio: "ignore" });
  return readFileSync(`${file}.sig`, "utf8").trim();
}

/** 编出假安装程序并签名 */
function buildInstaller() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const source = `using System; using System.IO;
public static class FakeSetup { public static void Main() { File.WriteAllText(@"${ARGS_FILE}", Environment.CommandLine); } }`;
  ps(`Add-Type -OutputType ConsoleApplication -OutputAssembly '${SETUP.replace(/'/g, "''")}' -TypeDefinition '${source.replace(/'/g, "''")}'`);
  if (!existsSync(SETUP)) throw new Error("没能编出假的安装程序");
  writeFileSync(OTHER, "不是安装包");
  return { setup: sign(SETUP), other: sign(OTHER) };
}

/**
 * 启动假更新服务器。offer({ version, notes, badSignature, signedFor }) 换成「发布了」这个版本（badSignature 时给的签名对不上
 * 安装包；signedFor 时签名对得上，但签名里记的是 signedFor 这个版本），offer(null) 是 latest.json 不存在（404）；
 * requests 是收到的请求的路径
 */
export async function startUpdateServer() {
  const sigs = buildInstaller();
  const bytes = readFileSync(SETUP);
  let manifest = null;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/latest.json" && manifest) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(manifest));
    } else if (req.url === "/setup.exe") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
      res.end(bytes);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(UPDATE_PORT, "127.0.0.1", resolve);
  });
  return {
    requests,
    offer(release) {
      manifest = release && {
        version: release.version,
        notes: release.notes ?? "",
        pub_date: new Date().toISOString(),
        platforms: {
          "windows-x86_64": {
            signature: release.badSignature ? sigs.other : release.signedFor ? sign(SETUP, release.signedFor) : sigs.setup,
            url: `http://127.0.0.1:${UPDATE_PORT}/setup.exe`,
          },
        },
      };
    },
    /** 关掉服务器，连同保持着的连接 */
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** 清掉上次留下的标记和假安装程序的记录 */
export function resetUpdateTraces() {
  rmSync(MARKER, { force: true });
  rmSync(ARGS_FILE, { force: true });
}

/** 写一个标记：假装上次运行时开始了从 from 到 to 的更新 */
export function writeMarker(from, to) {
  mkdirSync(join(MARKER, ".."), { recursive: true });
  writeFileSync(MARKER, JSON.stringify({ from, to }));
}
