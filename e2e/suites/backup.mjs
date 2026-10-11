// 待办数据的备份与恢复：启动后自动备份到数据目录旁边的 data-backups、设置里的状态，手动备份到本地（「另存为」「打开」对话框
// 换成直接返回路径）、备份里有什么（含项目的顺序 .projects.json、图片的附件目录），拿错了的备份和不安全的路径，恢复（先存盘、
// 换掉数据、项目的顺序跟着换回来、回收站不动、修改时间不变、整页重新加载、恢复出来的 .state.json 不被覆盖、快速记录小窗列出新的项目），
// 自动备份的保留份数、数据没变时跳过（只调整了项目的顺序也算变了）、失败时在设置里写明原因
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeZip, zipEntries, zipText } from "../lib/win.mjs";

export const title = "待办数据的备份与恢复";

export default async function (t) {
  const { check } = t;
  let m = t.main;
  const BK = t.backups;
  const work = join(t.data, "..");
  /** 备份目录里按自动备份命名的 */
  const auto = () => (existsSync(BK) ? readdirSync(BK).filter((n) => /^TodoList-data-\d{8}-\d{6}(-\d+)?\.zip$/.test(n)).sort() : []);
  const beforeRestore = () => (existsSync(BK) ? readdirSync(BK).filter((n) => n.includes("恢复前")) : []);
  const settingsFile = () => JSON.parse(t.read(".settings.json"));
  /** 换掉页面里 api 的一个方法（弹出对话框的那些），直接返回 value */
  const stub = (name, value) =>
    m.ev(`const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/api.ts")) ?? "/src/api.ts";
      const { api } = await import(url); api[${JSON.stringify(name)}] = async () => ${JSON.stringify(value)}; return 1`);
  /** 在当前界面上（不回首页，正在编辑的待办不会因为切走而保存）打开设置的「备份与恢复」，等自动备份的状态读出来 */
  const openBackupTab = () =>
    m.ev(`await waitFor(() => !document.querySelector(".settings-tabs"), 3000);
      document.querySelector(".anticon-setting").closest("button").click();
      const tab = await waitFor(() => [...document.querySelectorAll(".ant-modal .ant-tabs-tab")].find((x) => x.textContent.includes("备份与恢复")));
      tab.click(); await waitFor(() => document.querySelector(".auto-backup-status") && document.querySelector(".backup-dir")?.value); await sleep(300); return 1`);
  const statusText = () => m.ev(`return document.querySelector(".auto-backup-status")?.textContent ?? ""`);
  const dirShown = () => m.ev(`const e = document.querySelector(".backup-dir"); return e?.value ?? e?.querySelector("input")?.value ?? ""`);
  const clickConfirm = (text) =>
    m.ev(`const b = await waitFor(() => button(${JSON.stringify(text)}, document.querySelector(".ant-modal-confirm-btns") ?? document.createElement("div")));
      b.click(); await sleep(300); return 1`);
  const confirmContent = () => m.ev(`const c = await waitFor(() => document.querySelector(".ant-modal-confirm-content")); return c?.textContent ?? ""`);
  const closeConfirms = () => m.ev(`for (const b of document.querySelectorAll(".ant-modal-confirm-btns .ant-btn-primary")) b.click(); await sleep(400); return 1`);

  // ----- 启动后自动备份 -----
  await t.until(() => auto().length > 0, 20000);
  const first = auto();
  check("默认开启自动备份：启动后几秒就备份到数据目录旁边的 data-backups", first.length === 1, { BK, first });
  const firstEntries = first.length ? zipEntries(join(BK, first[0])) : [];
  check(
    "备份里有说明 backup.json、各工作区（空的也在）和待办正文",
    ["backup.json", "工作/", "学习/", "工作/需求/A.md", "生活/购物/GBK笔记.md"].every((e) => firstEntries.includes(e)),
    firstEntries,
  );
  check("备份里没有设置文件", firstEntries.length && !firstEntries.some((e) => e.includes(".settings.json")), firstEntries);

  await m.openSettings("备份与恢复");
  let status = await t.until(async () => /上次自动备份/.test(await statusText()) && (await statusText()));
  check("设置里显示上次自动备份的时间和份数", /上次自动备份：\d{4}-\d\d-\d\d \d\d:\d\d:\d\d，备份目录里共 1 份/.test(status), status);
  const shownDir = await t.until(dirShown);
  check("备份目录默认是数据目录旁边的「数据目录名-backups」", shownDir === BK, shownDir);
  await m.closeModal();

  // ----- 手动备份到本地 -----
  mkdirSync(t.file("工作/需求/.assets"), { recursive: true });
  writeFileSync(t.file("工作/需求/.assets/图.png"), Buffer.from([137, 80, 78, 71]));
  writeFileSync(t.file("工作/需求/.A.md.tmp"), "保存到一半");
  await m.invoke("delete_todo", { workspace: "工作", project: "日常", id: "D" });
  // 项目手动排序：工作区里「需求」在「日常」前面，「需求」里的子项目「后端」在「前端」前面（记在两个 .projects.json 里）
  for (const name of ["前端", "后端"]) await m.invoke("create_project", { workspace: "工作", name, parent: "需求" });
  await m.invoke("reorder_projects", { workspace: "工作", parent: null, names: ["需求", "日常"] });
  await m.invoke("reorder_projects", { workspace: "工作", parent: "需求", names: ["后端", "前端"] });
  const orderAtBackup = { top: t.read("工作/.projects.json"), sub: t.read("工作/需求/.projects.json") };
  // 打开 A：.state.json 里记着它的标签（预览标签），强制写盘
  await m.enter("工作");
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  await m.emit("tauri://blur");
  await m.emit("tauri://close-requested");
  await t.until(() => JSON.stringify(JSON.parse(t.read(".state.json")).openTodos ?? []).includes('"A"'));
  const stateAtBackup = JSON.parse(t.read(".state.json")).openTodos;
  const bMtime = Math.floor(statSync(t.file("工作/需求/B.md")).mtimeMs);

  mkdirSync(join(work, "manual"), { recursive: true });
  const manual = join(work, "manual", "TodoList-data-手动.zip");
  await stub("pickDataBackupTarget", manual);
  await openBackupTab();
  await m.clearToasts();
  await m.ev(`document.querySelector(".data-backup-file").click(); return 1`);
  await t.until(async () => /已备份/.test(await m.toast()), 15000);
  let toast = await m.toast();
  check("手动备份到本地：提示写明完整路径和几个工作区、几条待办", toast.includes(manual) && toast.includes("3 个工作区、6 条待办"), toast);
  const manualEntries = existsSync(manual) ? zipEntries(manual) : [];
  check(
    "备份里有项目里点开头的附件目录、.todos.json 和 .state.json",
    ["工作/需求/.assets/图.png", "工作/需求/.todos.json", ".state.json"].every((e) => manualEntries.includes(e)),
    manualEntries,
  );
  check(
    "备份里有项目的顺序：工作区里的、父项目里的 .projects.json",
    existsSync(manual) && zipText(manual, "工作/.projects.json") === orderAtBackup.top && zipText(manual, "工作/需求/.projects.json") === orderAtBackup.sub,
    { entries: manualEntries.filter((e) => e.endsWith(".projects.json")), orderAtBackup },
  );
  check(
    "备份里没有软件回收站、保存时的临时文件、设置文件",
    manualEntries.length && !manualEntries.some((e) => e.startsWith(".recycle") || e.endsWith(".tmp") || e.includes("settings")),
    manualEntries,
  );

  await stub("pickDataBackupTarget", t.file("工作/备份.zip"));
  await m.clearToasts();
  await m.ev(`document.querySelector(".data-backup-file").click(); return 1`);
  await t.until(async () => /数据目录里面/.test(await m.toast()));
  check("不能备份到数据目录里面", /数据目录里面/.test(await m.toast()) && !t.exists("工作/备份.zip"), await m.toast());

  // ----- 拿错了的备份、不安全的路径 -----
  await stub("pickBackupFile", manual);
  await m.clearToasts();
  await m.ev(`button("从本地文件恢复设置").click(); return 1`);
  await clickConfirm("恢复");
  await t.until(async () => /待办数据的备份/.test(await m.toast()));
  toast = await m.toast();
  check("恢复设置时选了数据备份：提示这是待办数据的备份", /这是待办数据的备份.*从本地文件恢复数据/.test(toast), toast);

  const oldSettings = join(work, "manual", "TodoList-settings-old.zip");
  makeZip(oldSettings, { ".settings.json": "{}" });
  await stub("pickDataBackupFile", oldSettings);
  await m.clearToasts();
  await m.ev(`document.querySelector(".data-restore-file").click(); return 1`);
  await t.until(async () => /设置的备份/.test(await m.toast()));
  toast = await m.toast();
  check("恢复数据时选了设置备份：提示这是设置的备份", /这是设置的备份.*从本地文件恢复设置/.test(toast), toast);

  const evil = join(work, "manual", "evil.zip");
  makeZip(evil, { "backup.json": '{"kind":"data","createdAt":1}', "工作/x.md": "x", "../逃出去.md": "逃出去" });
  await stub("pickDataBackupFile", evil);
  await m.ev(`document.querySelector(".data-restore-file").click(); return 1`);
  await clickConfirm("恢复");
  const evilError = await m.ev(`const c = await waitFor(() => document.querySelector(".ant-modal-confirm-error .ant-modal-confirm-content"), 15000); return c?.textContent ?? ""`);
  check(
    "zip 里有 .. 的路径：整个不恢复，说明原因，现在的数据不动",
    /不安全的路径/.test(evilError) && !existsSync(join(work, "逃出去.md")) && t.exists("工作/需求/A.md") && !beforeRestore().length,
    evilError,
  );
  await closeConfirms();
  await m.closeModal();

  // ----- 恢复 -----
  // 备份之后：附件删了、项目换回按名称、子项目的顺序在外部改了、新建了工作区和项目、C 的正文改了还没保存（auto save 关着）
  rmSync(t.file("工作/需求/.assets"), { recursive: true, force: true });
  await m.invoke("set_projects_manual", { workspace: "工作", manual: false });
  t.write("工作/需求/.projects.json", JSON.stringify({ order: ["前端", "后端"] }));
  await m.invoke("create_workspace", { name: "临时" });
  await m.invoke("create_project", { workspace: "临时", name: "新项目" });
  // 快速记录小窗弹出时列出现在的项目（有「临时」）
  const quickKey = t.TEST_KEYS.quick.split("+").pop();
  const q = await t.quick();
  const quickGroups = async () => {
    t.win.hotkey(quickKey);
    await t.sleep(600);
    await q.ev(`document.querySelector(".quick-target .ant-select-content").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); await sleep(400); return 1`);
    const groups = await q.ev(`return [...document.querySelectorAll(".ant-select-item-group")].map((g) => g.textContent)`);
    await q.press("Escape");
    await q.invoke("hide_quick_capture");
    return groups;
  };
  const groupsBefore = await quickGroups();
  check("（恢复前）快速记录小窗里有新建的「临时」", groupsBefore.includes("临时"), groupsBefore);

  await m.emit("tauri://focus");
  // 侧栏里同时显示着备份里没有的「临时」：恢复中途刷新的话会读到它不在了
  await m.selectAllWorkspaces();
  check("（恢复前）侧栏里显示着「临时」", !!(await t.until(() => m.ev(`return !!row("临时")`))));
  await m.ev(`return await openTodo("工作", "需求", "C")`);
  await m.ev(`const v = view(); v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); return 1`);
  await m.type("恢复前没保存的修改");
  await t.sleep(300);
  check("（恢复前）C 的修改还没存盘", !t.read("工作/需求/C.md").includes("恢复前没保存的修改"));
  const recycledBefore = readdirSync(t.file(".recycle")).length;

  await stub("pickDataBackupFile", manual);
  await m.ev(`window.__beforeRestore = 1; return 1`);
  await openBackupTab();
  await m.ev(`document.querySelector(".data-restore-file").click(); return 1`);
  const confirmText = await confirmContent();
  check(
    "恢复前确认：写明备份的时间、几个工作区几条待办，会替换现在的全部待办数据，现在的先备份到备份目录",
    /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d 的备份（3 个工作区、6 条待办）/.test(confirmText) && confirmText.includes("替换现在的全部待办数据") && confirmText.includes(BK),
    confirmText,
  );
  // 恢复中途（工作区被整个换掉之后、整页重新加载之前）监听会看到一大批变化：不能刷新出「工作区「临时」不存在」之类的
  // 提示。页面里记下这期间出现过的提示（sessionStorage 跨过重新加载还在）
  await m.ev(`sessionStorage.removeItem("e2eToasts"); const seen = [];
    new MutationObserver(() => {
      for (const n of document.querySelectorAll(".ant-message-notice")) {
        const text = n.textContent;
        if (text && !seen.includes(text)) { seen.push(text); sessionStorage.setItem("e2eToasts", JSON.stringify(seen)); }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true }); return 1`);
  await clickConfirm("恢复");
  const reloaded = await t.until(
    async () => m.ev(`return window.__beforeRestore === undefined && !!document.querySelector(".ws-card")`).catch(() => false),
    20000,
  );
  check("恢复后整页重新加载，回到首页", !!reloaded);
  // 监听到的变化（恢复完一会儿才报）可能落在重新加载之后：等它过去
  await t.sleep(2500);
  const toastsDuring = JSON.parse((await m.ev(`return sessionStorage.getItem("e2eToasts")`)) ?? "[]");
  const toastsAfter = await m.toast();
  check(
    "恢复中途、重新加载前后都没有刷新出「工作区不存在」之类的错误提示",
    !toastsDuring.some((x) => /不存在|失败/.test(x)) && !/不存在|失败/.test(toastsAfter),
    { toastsDuring, toastsAfter },
  );
  const notice = await m.ev(`const c = await waitFor(() => document.querySelector(".ant-modal-confirm-success .ant-modal-confirm-content")); return c?.textContent ?? ""`);
  const before = beforeRestore();
  check("提示恢复了几个工作区、几条待办，以及恢复前的数据备份在哪里", notice.includes("恢复了 3 个工作区、6 条待办") && before.length === 1 && notice.includes(before[0]), { notice, before });
  const cards = await m.ev(`return [...document.querySelectorAll(".ws-card .card-name")].map((c) => c.textContent)`);
  check("首页是备份里的工作区，后来建的不在了", !cards.includes("临时") && ["工作", "生活", "学习"].every((w) => cards.includes(w)) && !t.exists("临时"), cards);
  check("正文、附件换成备份里的", !t.read("工作/需求/C.md").includes("恢复前没保存的修改") && t.exists("工作/需求/.assets/图.png"));
  const tree = await m.invoke("load_workspace", { workspace: "工作" });
  const rank = (p) => tree.projects.find((x) => x.name === p)?.order;
  check(
    "项目的顺序换回备份里的：手动排序，需求在日常前面、后端在前端前面",
    t.read("工作/.projects.json") === orderAtBackup.top && t.read("工作/需求/.projects.json") === orderAtBackup.sub &&
      tree.manualOrder && rank("需求") < rank("日常") && rank("需求/后端") < rank("需求/前端"),
    { manual: tree.manualOrder, ranks: tree.projects.map((p) => [p.name, p.order]) },
  );
  check("文件的修改时间和备份时一样", Math.floor(statSync(t.file("工作/需求/B.md")).mtimeMs) === bMtime, [statSync(t.file("工作/需求/B.md")).mtimeMs, bMtime]);
  check("软件回收站里的东西不动", readdirSync(t.file(".recycle")).length === recycledBefore && recycledBefore === 1);
  const beforeZip = before.length ? join(BK, before[0]) : "";
  check(
    "恢复前先保存了正在编辑的待办，连同后来建的一起备份到「…-恢复前.zip」",
    !!beforeZip && zipText(beforeZip, "工作/需求/C.md").includes("恢复前没保存的修改") && zipEntries(beforeZip).includes("临时/新项目/"),
  );
  check("恢复前的备份不算自动备份", auto().length === 1, auto());
  await closeConfirms();
  // 恢复前内存里的界面状态（打开着 C）不会在稍后写盘时覆盖恢复出来的
  await t.sleep(6500);
  const stateAfter = JSON.parse(t.read(".state.json")).openTodos;
  check(".state.json 是备份里的，没有被内存里的界面状态覆盖", JSON.stringify(stateAfter) === JSON.stringify(stateAtBackup), { stateAfter, stateAtBackup });
  const groupsAfter = await quickGroups();
  check("快速记录小窗再弹出时列出恢复后的项目", !groupsAfter.includes("临时") && groupsAfter.includes("工作"), groupsAfter);

  // ----- 自动备份：保留份数、数据没变时跳过、失败时写明原因 -----
  await m.openSettings("备份与恢复");
  await m.ev(`const i = document.querySelector(".auto-backup-keep input"); i.focus(); i.select(); setInput(i, "2"); await sleep(300); i.blur(); return 1`);
  await t.until(() => settingsFile().autoBackupKeep === 2);
  check("「保留最近几份」存在设置文件里", settingsFile().autoBackupKeep === 2, settingsFile());
  await m.closeModal();
  // 备份目录里换成三份很久以前的（最新的一份就是恢复用的那份，数据和它一样）
  for (const n of auto()) rmSync(join(BK, n));
  for (const n of ["20200101", "20200102", "20200103"]) copyFileSync(manual, join(BK, `TodoList-data-${n}-000000.zip`));
  await t.restart();
  m = t.main;
  await t.sleep(9000);
  check("满 24 小时了，但数据和上次备份时一样：跳过", auto().length === 3, auto());
  await m.openSettings("备份与恢复");
  status = await t.until(async () => /没有变化/.test(await statusText()) && (await statusText()));
  check("设置里说明数据没有变化", /没有变化/.test(status), await statusText());

  // 只调整了项目的顺序（只有 .projects.json 变了）也算数据变了
  await m.invoke("reorder_projects", { workspace: "工作", parent: null, names: ["日常", "需求"] });
  const options = { enabled: true, dir: "", keep: 2, webdav: false };
  await m.invoke("set_auto_backup", options);
  await t.until(() => auto().length === 2 && !auto()[1].startsWith("TodoList-data-2020"), 15000);
  const kept = auto();
  check(
    "数据变了（只调整了项目的顺序也算）就备份；只留最近 2 份，删掉最旧的，恢复前的那份不删",
    kept.length === 2 && kept[0] === "TodoList-data-20200103-000000.zip" && !kept[1].startsWith("TodoList-data-2020") && beforeRestore().length === 1,
    { kept, before: beforeRestore() },
  );
  await t.until(async () => /共 2 份/.test(await statusText()));
  check("设置里跟着更新", /共 2 份/.test(await statusText()), await statusText());

  // 换备份目录（选文件夹的对话框换成直接返回路径）：不能选在数据目录里面
  await stub("pickBackupDir", t.file("工作"));
  await m.clearToasts();
  await m.ev(`button("更改").click(); return 1`);
  await t.until(async () => /数据目录里面/.test(await m.toast()));
  check("备份目录不能选在数据目录里面", /数据目录里面/.test(await m.toast()) && settingsFile().autoBackupDir === "", await m.toast());
  // 备份目录建不起来（上一级是个文件）：新目录里还没有备份，马上要备份，备份失败；不弹窗，设置里写明原因
  const blocked = join(work, "blocker", "备份");
  writeFileSync(join(work, "blocker"), "挡着");
  await stub("pickBackupDir", blocked);
  await m.clearToasts();
  await m.ev(`button("更改").click(); return 1`);
  await t.until(() => settingsFile().autoBackupDir === blocked);
  await t.until(async () => /失败/.test(await statusText()), 15000);
  const failure = await m.ev(`return document.querySelector(".auto-backup-status .error-text")?.textContent ?? ""`);
  const popups = await m.ev(`return document.querySelectorAll(".ant-modal-confirm, .ant-message-notice").length`);
  check("自动备份失败不弹窗，设置里写明原因", /自动备份失败：无法创建备份目录/.test(failure) && popups === 0, { failure, popups });
  await m.ev(`document.querySelector(".backup-dir-reset").click(); await sleep(500); return 1`);
  await t.until(async () => settingsFile().autoBackupDir === "" && (await dirShown()) === BK);
  check("备份目录恢复默认", settingsFile().autoBackupDir === "" && (await dirShown()) === BK, await dirShown());
  await m.ev(`document.querySelector(".auto-backup-switch").click(); await sleep(500); return 1`);
  await t.until(async () => settingsFile().autoBackup === false && /自动备份已关闭/.test(await statusText()));
  check("关掉自动备份：存在设置文件里", settingsFile().autoBackup === false && /自动备份已关闭/.test(await statusText()), await statusText());
  await m.closeModal();
}
