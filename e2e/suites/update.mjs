// 自动更新：测试版连本机的假更新服务器（e2e/lib/updater.mjs），「安装程序」是测试时编出来的小程序，只记下收到的命令行。
// 启动后自动检查、右下角提示、「以后再说」、设置里检查更新；签名对不上时不安装；「立即更新」时先保存打开着的待办，
// 运行安装程序后软件退出；再打开时提示装好了没有（开机自启只在托盘里时也显示主窗口）；关掉自动检查后启动时不检查
import { existsSync, readFileSync } from "node:fs";
import { runningPids } from "../lib/app.mjs";
import { appVersion, ARGS_FILE, MARKER, resetUpdateTraces, startUpdateServer, writeMarker } from "../lib/updater.mjs";

export const title = "自动更新";

// 用软件的默认值（打开自动检查更新）；测试数据里默认关着，别的套件不检查
export const settings = { autoUpdate: undefined };

export default async function (t) {
  const { check, win } = t;
  const m = () => t.main;
  const current = appVersion();
  const notice = () => m().ev(`return document.querySelector(".update-notice")?.textContent ?? ""`);
  const stateText = () => m().ev(`return document.querySelector(".update-state")?.textContent ?? ""`);
  const clickIn = (sel) => m().ev(`const e = await waitFor(() => document.querySelector(${JSON.stringify(sel)})); e?.click(); await sleep(300); return !!e`);
  const settingsFile = () => JSON.parse(t.read(".settings.json"));

  resetUpdateTraces();
  const server = await startUpdateServer();
  try {
    // 启动后自动检查（10 秒后），发现新版本时右下角提示
    server.offer({ version: "99.0.0", notes: "- 新加的功能\n- 修正的问题" });
    await t.restart();
    const shown = await t.until(async () => (await notice()).includes("发现新版本 99.0.0"), 30000);
    const text = await notice();
    check("启动后自动检查，发现新版本时右下角提示新版本、现在的版本和更新说明",
      !!shown && text.includes(`现在用的是 ${current}`) && text.includes("新加的功能"), { text, requests: server.requests });

    await clickIn(".update-later");
    check("「以后再说」收起提示", !!(await t.until(async () => !(await notice()))));
    await m().invoke("check_update");
    await t.sleep(800);
    check("再检查到同一个版本时这次运行期间不再提示", !(await notice()));

    await m().openSettings("常规");
    check("设置「常规」里显示当前版本、发现的新版本",
      (await m().ev(`return document.querySelector(".update-current")?.textContent`)) === `当前版本 ${current}` &&
        (await stateText()).startsWith("发现新版本 99.0.0"), await stateText());

    // 签名对不上（下载出错、被改过）：不安装，提示原因，软件照常运行
    server.offer({ version: "99.0.0", badSignature: true });
    await clickIn(".check-update");
    await t.until(async () => (await stateText()).startsWith("发现新版本"));
    await clickIn(".settings-update-now");
    await t.until(() => m().ev(`return !!document.querySelector(".update-retry")`), 15000);
    const failed = await notice();
    check("签名对不上时不安装：提示更新失败和原因，软件没有退出",
      failed.includes("更新失败") && failed.includes("签名对不上") && runningPids().length === 1 && !existsSync(ARGS_FILE), failed);
    await m().closeModal();

    // 立即更新：先保存打开着的待办（没开 auto save 也存），运行安装程序，软件退出
    server.offer({ version: "99.1.0", notes: "又一版" });
    await m().enter("工作");
    await m().expandAll();
    await m().ev(`return await openTodo("工作", "日常", "D")`);
    await m().ev(`const v = view(); v.focus(); v.dispatch({ changes: { from: v.state.doc.length, insert: "更新前没存的一行\\n" } }); await sleep(200); return 1`);
    await m().invoke("check_update");
    check("又发布了更新的版本：再提示", !!(await t.until(async () => (await notice()).includes("发现新版本 99.1.0"))));
    // 点了以后程序很快就退出：不等页面回话
    await m().ev(`const e = await waitFor(() => document.querySelector(".update-now")); setTimeout(() => e?.click(), 50); return !!e`);
    const exited = await t.until(() => runningPids().length === 0, 20000);
    const args = (await t.until(() => existsSync(ARGS_FILE), 5000)) ? readFileSync(ARGS_FILE, "utf8") : "";
    check("「立即更新」：下载、验过签名后运行安装程序（被动模式、按更新安装），软件退出",
      exited && / \/P\b/.test(args) && args.includes("/UPDATE"), { exited, args });
    check("更新前保存了打开着的待办里没存的修改", t.read("工作/日常/D.md").includes("更新前没存的一行"));
    const marker = existsSync(MARKER) ? JSON.parse(readFileSync(MARKER, "utf8")) : null;
    check("运行安装程序前记下了从哪个版本更新到哪个版本", marker?.from === current && marker?.to === "99.1.0", marker);

    // 再打开时还是原来的版本（这里的安装程序什么都没装）：提示没能更新
    t.main = null;
    await t.restart();
    const failedToast = await t.until(async () => (await m().toast()).includes("没能更新到 99.1.0"));
    check("安装没有完成时，再打开提示没能更新到新版本", !!failedToast, await m().toast());
    check("提示过的标记删掉了", !existsSync(MARKER));

    // 装好了：开机自启只在托盘里时也显示主窗口，提示已更新到哪个版本
    writeMarker("0.0.1", current);
    await t.restart({ args: ["--autostart"] });
    const doneToast = await t.until(async () => (await m().toast()).includes(`已更新到 ${current}`));
    check("更新好后重新打开：开机自启只在托盘里时也显示主窗口，提示已更新到哪个版本",
      !!doneToast && win.windows().main?.visible, { toast: await m().toast(), main: win.windows().main });

    // 已是最新版本
    server.offer({ version: current });
    await m().openSettings("常规");
    await clickIn(".check-update");
    check("服务器上的版本和现在的一样：已是最新版本", !!(await t.until(async () => (await stateText()).startsWith("已是最新版本"))), await stateText());

    // 关掉自动检查更新：启动后不检查；再打开时马上检查一次
    await clickIn(".auto-update-switch");
    check("关掉「自动检查更新」存进设置", settingsFile().autoUpdate === false);
    server.offer({ version: "99.2.0" });
    await t.restart();
    server.requests.length = 0;
    await t.sleep(14000);
    check("关掉自动检查更新后，启动后不检查", !server.requests.includes("/latest.json") && !(await notice()), server.requests);
    await m().openSettings("常规");
    await clickIn(".auto-update-switch");
    check("再打开时马上检查一次，发现新版本就提示", !!(await t.until(async () => (await notice()).includes("发现新版本 99.2.0"), 10000)));

    // 连不上更新服务器：设置里显示原因，不弹窗
    await server.close();
    server.offer(null);
    await clickIn(".check-update");
    await t.until(async () => (await stateText()).includes("检查失败") || !(await m().ev(`return document.querySelector(".check-update")?.classList.contains("ant-btn-loading")`)), 15000);
    // 之前检查到的新版本还留着，「立即更新」仍可用；检查失败的原因在状态里没有新版本时才显示，这里看 Rust 端记下的
    const status = await m().invoke("get_update_status");
    check("连不上更新服务器：记下原因，之前检查到的新版本留着", /连不上更新服务器/.test(status.error ?? "") && status.available?.version === "99.2.0", status);
  } finally {
    await server.close().catch(() => {});
    resetUpdateTraces();
  }
}
