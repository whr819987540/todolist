// 自动更新：测试版连本机的假更新服务器（e2e/lib/updater.mjs），「安装程序」是测试时编出来的小程序，只记下收到的命令行。
// 启动后自动检查、右下角提示、「以后再说」、设置里检查更新；签名对不上、签名里记的版本不对时不安装；打开着的待办存不上时问还更不更新
// （主窗口藏在托盘里时先调出来），「先不更新」回到发现新版本的提示（点过「以后再说」、从设置里点的也是）；
// 「立即更新」时先保存打开着的待办，运行安装程序后软件退出；再打开时提示装好了没有（开机自启只在托盘里时也显示主窗口）；
// 关掉自动检查后启动时不检查
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
  /**
   * 保存打开着的待办存不上、另存为新待办也失败（on 为 false 时换回来）：换掉页面里 api 的保存正文、新建待办，都报错
   * （同 backup、export 套件换掉对话框）。不在磁盘上弄坏项目：窗口显示着时监听到项目没了会刷新、关掉打开着的待办
   * （离开时另存，存不上的放进剪贴板），到更新时就没有要存的了
   */
  const failSaving = (on) =>
    m().ev(`const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/api.ts")) ?? "/src/api.ts";
      const { api } = await import(url); const w = window.__e2e;
      w.realApi ??= { saveTodoContent: api.saveTodoContent, createTodo: api.createTodo };
      if (${on}) {
        api.saveTodoContent = async () => { throw "写不进去（端到端测试换掉了保存）"; };
        api.createTodo = async () => { throw "建不了新待办（端到端测试换掉了新建）"; };
      } else Object.assign(api, w.realApi);
      return 1`);
  /** 等问还更不更新的确认框弹出来（要先下载、保存），返回它的标题；一直没弹出来时是 "" */
  const unsavedAsked = () =>
    t.until(() => m().ev(`return document.querySelector(".ant-modal-confirm-btns") ? document.querySelector(".ant-modal-confirm-title")?.textContent ?? "?" : ""`), 20000);
  /** 在确认框里点「先不更新」，等确认框关掉（没弹出来时什么都不做） */
  const decline = async () => {
    await m().ev(`button("先不更新", document.querySelector(".ant-modal-confirm-btns") ?? document.createElement("div"))?.click(); return 1`);
    await t.until(() => m().ev(`return !document.querySelector(".ant-modal-confirm-btns")`));
  };
  /** 右下角是发现新版本 version 的提示，有「立即更新」「以后再说」 */
  const prompting = (version) =>
    m().ev(`const n = document.querySelector(".update-notice");
      return !!n && n.textContent.includes(${JSON.stringify(`发现新版本 ${version}`)}) && !!n.querySelector(".update-now") && !!n.querySelector(".update-later")`);

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

    // 签名对得上，但签名里记的版本和宣布的不一样（旧版的安装包配上了新的版本号）：同样不安装，写明两个版本号
    server.offer({ version: "99.0.0", signedFor: "98.0.0" });
    await clickIn(".check-update");
    await t.until(async () => (await stateText()).startsWith("发现新版本"));
    await clickIn(".settings-update-now");
    const mismatched = await t.until(async () => (await notice()).includes("签名里记的版本"), 15000);
    const mismatchText = await notice();
    check("签名里记的版本和宣布的版本对不上时不安装：写明两个版本号、可能被改过，软件没有退出",
      !!mismatched && mismatchText.includes("98.0.0") && mismatchText.includes("99.0.0") && mismatchText.includes("可能被改过") &&
        runningPids().length === 1 && !existsSync(ARGS_FILE), mismatchText);
    await m().closeModal();

    // 下载好后保存打开着的待办，存不上、另存为新待办也失败：问还更不更新；「先不更新」时回到发现新版本的提示
    server.offer({ version: "99.0.5", notes: "存不上时先不更新" });
    await m().enter("工作");
    await m().expandAll();
    await m().ev(`return await openTodo("工作", "需求", "A")`);
    // 先换掉再改：改了以后哪一次存盘都存不上，到更新时一定还有没存的修改
    await failSaving(true);
    await m().ev(`const v = view(); v.focus(); v.dispatch({ changes: { from: v.state.doc.length, insert: "存不上的一行\\n" } }); await sleep(200); return 1`);
    await m().invoke("check_update");
    await t.until(async () => (await notice()).includes("发现新版本 99.0.5"));
    await clickIn(".update-now");
    const asked = await unsavedAsked();
    check("下载好后保存打开着的待办存不上、另存也失败：问还更不更新", asked === "有修改没能保存", { asked, notice: await notice() });
    await decline();
    check("「先不更新」：不运行安装程序，回到发现新版本的提示（有「立即更新」「以后再说」）",
      !!(await t.until(() => prompting("99.0.5"))) && !existsSync(ARGS_FILE), await notice());

    // 先点「以后再说」，再从设置里点「立即更新」：「先不更新」后同样回到提示，不留下关不掉的「正在更新」
    await clickIn(".update-later");
    await t.until(async () => !(await notice()));
    // 不回首页打开设置：回首页时正在编辑的待办关掉（存不上的放进剪贴板），到更新时就没有要存的了
    await m().ev(`document.querySelector(".anticon-setting").closest("button").click(); return !!(await waitFor(() => document.querySelector(".settings-update-now")))`);
    await clickIn(".settings-update-now");
    const askedAgain = await unsavedAsked();
    await decline();
    check("点过「以后再说」、从设置里点「立即更新」：「先不更新」后也回到发现新版本的提示",
      askedAgain === "有修改没能保存" && !!(await t.until(() => prompting("99.0.5"))), { askedAgain, notice: await notice() });
    await m().closeModal();

    // 点了「立即更新」后把主窗口关到了托盘（这里先关再点）：先调出主窗口再问，不然确认框弹在看不见的窗口里、更新停在那里
    win.close();
    const hidden = await t.until(() => win.windows().main?.visible === false);
    await clickIn(".update-now");
    const askedHidden = await unsavedAsked();
    const shownWhenAsked = await t.until(() => win.windows().main?.visible === true);
    check("主窗口藏在托盘里时存不上：先调出主窗口，再问还更不更新",
      hidden && askedHidden === "有修改没能保存" && shownWhenAsked, { hidden, askedHidden, main: win.windows().main });
    await decline();
    check("调出来后选「先不更新」：同样回到发现新版本的提示", !!(await t.until(() => prompting("99.0.5"))), await notice());
    await failSaving(false);

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
