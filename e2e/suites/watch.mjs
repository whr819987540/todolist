// 监听数据目录：窗口一直在前台（不发 tauri://focus、不切换焦点）时，直接在数据目录里新建、改、删文件，几秒内侧栏、
// 正文、首页、回收站跟着变；有未保存的修改时外部改了正文立即弹出冲突对话框；软件自己保存时不重新加载；
// 藏在托盘里时不刷新，显示出来再刷新
import { mkdirSync } from "node:fs";

export const title = "监听数据目录";

export default async function (t) {
  const { main: m, check, win } = t;
  const toggleKey = t.TEST_KEYS.toggle.split("+").pop();
  await m.viewport(1200, 900);
  await m.enter("工作");
  await m.expandAll();

  const doc = () => m.ev(`return view()?.state.doc.toString() ?? null`);
  const hasRow = (ws, p, id) => m.ev(`return !!row(${JSON.stringify(ws)}, ${JSON.stringify(p)}, ${JSON.stringify(id)})`);
  /** 在正文末尾加一段（不保存），返回加完后的全文 */
  const append = (text) =>
    m.ev(`const v = view(); v.focus(); v.dispatch({ changes: { from: v.state.doc.length, insert: ${JSON.stringify(text)} }, selection: { anchor: v.state.doc.length + ${text.length} } });
      await sleep(200); return v.state.doc.toString()`);
  const CONFLICT = `[...document.querySelectorAll(".ant-modal-title")].find((e) => e.textContent === "文件已在外部被修改" && e.getClientRects().length > 0)`;
  const conflictShown = () => m.ev(`return !!${CONFLICT}`);
  const resolve = (text) =>
    m.ev(`button(${JSON.stringify(text)}, ${CONFLICT}.closest(".ant-modal").querySelector(".ant-modal-footer")).click();
      await sleep(600); return 1`);
  // 记下页面调了哪些命令，看监听到变化后有没有重新加载、核对正文。__TAURI_INTERNALS__.invoke 改不了（只读），
  // 它每次经 fetch 发到 http://ipc.localhost/命令名，记 fetch 的地址；那条路走不通时 Tauri 改用 window.ipc.postMessage，也记
  await m.ev(`const w = window.__e2e;
    if (!w.calls) {
      w.calls = [];
      const fetch0 = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith("http://ipc.localhost/") || url.startsWith("ipc://localhost/")) w.calls.push(decodeURIComponent(url.split("/").pop()));
        return fetch0(input, init);
      };
      const ipc = window.ipc;
      if (typeof ipc?.postMessage === "function") {
        const post0 = ipc.postMessage.bind(ipc);
        ipc.postMessage = (data) => {
          try { w.calls.push(JSON.parse(data).cmd); } catch { /* 不是命令 */ }
          return post0(data);
        };
      }
    }
    return 1`);
  const RELOADS = ["load_workspace", "list_workspaces", "read_todo"];
  const resetCalls = () => m.ev(`window.__e2e.calls.length = 0; return 1`);
  const reloadCalls = () => m.ev(`return window.__e2e.calls.filter((c) => ${JSON.stringify(RELOADS)}.includes(c))`);
  await resetCalls();
  await m.invoke("list_workspaces");
  if (!(await reloadCalls()).includes("list_workspaces")) throw new Error("没能记下页面调用的命令（IPC 不是经 fetch 发的？）");

  // 外部在项目文件夹里新建 .md、新建项目文件夹
  t.write("工作/日常/外部新建.md", "# 外部新建\n\n网盘同步下来的\n");
  check("窗口一直在前台时，外部在项目文件夹里新建的 .md 几秒内出现在侧栏", await t.until(() => hasRow("工作", "日常", "外部新建")));
  mkdirSync(t.file("工作/外部项目"));
  t.write("工作/外部项目/X.md", "# X\n");
  check("外部新建的项目文件夹出现在侧栏，里面的 .md 是待办", await t.until(() => hasRow("工作", "外部项目", "X")));

  // 打开着的待办的正文在外部被改了，这里没有未保存的修改：重新加载，光标按前后的文字找回，撤销记录清空
  await m.ev(`return await openTodo("工作", "日常", "D")`);
  await append("软件里加的");
  await m.press("Ctrl+S");
  await t.until(() => t.read("工作/日常/D.md").endsWith("软件里加的"));
  const changedD = "外部加的第一行\n" + t.read("工作/日常/D.md");
  t.write("工作/日常/D.md", changedD);
  check("打开着的待办的正文在外部被改了（没有未保存的修改）：不切换焦点也重新加载", await t.until(async () => (await doc()) === changedD));
  const cursor = await m.ev(`const v = view(); return { head: v.state.selection.main.head, length: v.state.doc.length }`);
  check("重新加载后光标按前后的文字找回（还在刚才加的那段后面）", cursor.head === cursor.length && cursor.head > 0, cursor);
  await m.ev(`view().focus(); return 1`);
  await m.press("Ctrl+Z");
  check("重新加载后撤销记录清空：Ctrl+Z 不会撤掉外部的内容", (await doc()) === changedD);

  // 外部只是把同样的内容重写了一遍（如网盘同步）：核对过，但什么都不做，撤销记录还在
  const mineD = await append("再加的");
  await m.press("Ctrl+S");
  await t.until(() => t.read("工作/日常/D.md") === mineD);
  await t.sleep(1000);
  await resetCalls();
  t.write("工作/日常/D.md", mineD);
  const checked = await t.until(async () => (await reloadCalls()).includes("read_todo"));
  await t.sleep(500);
  check("外部重写了一遍、内容没变：核对过正文，但不重新加载、不弹冲突对话框", checked && (await doc()) === mineD && !(await conflictShown()));
  await m.ev(`view().focus(); return 1`);
  await m.press("Ctrl+Z");
  check("内容没变的重写不清空撤销记录：Ctrl+Z 还能撤掉刚才加的", (await doc()) === changedD, await doc());
  await m.press("Ctrl+Y");

  // 有未保存的修改时外部改了正文：立即弹出冲突对话框，正在编辑的内容不动
  const mine = await append("\n没保存的修改");
  t.write("工作/日常/D.md", "# 待办 D\n\n外部又改了\n");
  check(
    "有未保存的修改时外部改了正文：不切换焦点也立即弹出冲突对话框，正在编辑的内容不动",
    (await t.until(conflictShown)) && (await doc()) === mine,
  );
  await resolve("放弃我的修改");
  check("「放弃我的修改，重新加载」：换成外部的内容", await t.until(async () => (await doc()) === "# 待办 D\n\n外部又改了\n"));

  // 软件自己写的不引起刷新：打字、保存、改标题、标记完成后不重新加载
  await t.sleep(1000);
  await resetCalls();
  await append("\n自己打的字");
  await m.press("Ctrl+S");
  await m.ev(`const input = document.querySelector(".editor-title"); input.focus(); return 1`);
  await m.type("（改）");
  await m.press("Ctrl+S");
  await m.press("Ctrl+Alt+D");
  await t.until(() => t.read("工作/日常/D.md").endsWith("自己打的字") && t.meta("工作", "日常").some((x) => x.id === "D" && x.done));
  await t.sleep(2000);
  const own = await reloadCalls();
  check("软件自己保存正文、标题，标记完成：监听不引起重新加载、核对正文（闲着时也不刷新）", own.length === 0, own);

  // 外部删掉项目：从侧栏消失
  t.remove("工作/外部项目");
  check("外部删掉的项目从侧栏消失", await t.until(async () => !(await hasRow("工作", "外部项目"))));

  // 打开着的待办在外部被删了：没有未保存的修改时退回所在的项目，标签关掉
  await m.ev(`return await openTodo("工作", "日常", "外部新建")`);
  t.remove("工作/日常/外部新建.md");
  check(
    "打开着的待办在外部被删了：退回所在的项目，标签关掉",
    await t.until(() =>
      m.ev(`return !document.querySelector(".editor-title") && document.querySelector(".tree-row.selected")?.dataset.sel === ${JSON.stringify(JSON.stringify(["工作", "日常", ""]))}
        && ![...document.querySelectorAll(".editor-tab")].some((e) => JSON.parse(e.dataset.tab)[2] === "外部新建")`),
    ),
  );

  // 有未保存的修改时打开着的待办在外部被删了：另存为同一项目里的新待办，修改不丢
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  const mineA = await append("\n删之前加的");
  t.remove("工作/需求/A.md");
  const copyA = await t.until(() => t.meta("工作", "需求").find((x) => x.title === "A（我的版本）"));
  check(
    "有未保存的修改时打开着的待办在外部被删了：另存为「A（我的版本）」，内容是编辑的内容",
    !!copyA && t.read(`工作/需求/${copyA.id}.md`) === mineA && (await t.until(() => hasRow("工作", "需求", copyA.id))),
    copyA,
  );

  // 首页：工作区卡片的统计、外部新建的工作区
  await m.ev(`document.querySelector(".anticon-home").closest("button").click(); await sleep(500); return 1`);
  const card = (name) =>
    m.ev(`return [...document.querySelectorAll(".ws-card")].find((c) => c.querySelector(".card-name")?.textContent === ${JSON.stringify(name)})?.textContent ?? ""`);
  const count = async (name) => Number((await card(name)).match(/(\d+) 条待办/)?.[1] ?? -1);
  const before = await count("生活");
  t.write("生活/杂事/首页时加的.md", "# 首页时加的\n");
  check("首页：外部加了待办，工作区卡片上的待办数跟着变", await t.until(async () => (await count("生活")) === before + 1), { before, now: await count("生活") });
  mkdirSync(t.file("外部工作区/项目"), { recursive: true });
  t.write("外部工作区/项目/Y.md", "# Y\n");
  check("首页：外部新建的工作区文件夹出现在卡片里", await t.until(async () => (await card("外部工作区")) !== ""));

  // 藏在托盘里时不刷新，显示出来时再刷新
  const shown = await count("生活");
  win.close();
  await t.sleep(800);
  await resetCalls();
  t.write("生活/杂事/藏着时加的.md", "# 藏着时加的\n");
  await t.sleep(2000);
  const hiddenCalls = await reloadCalls();
  check("主窗口藏在托盘里时，外部的变化不引起刷新", !win.windows().main.visible && hiddenCalls.length === 0, hiddenCalls);
  win.hotkey(toggleKey);
  check("显示出来后刷新：卡片上的待办数是外部改过的", await t.until(async () => (await count("生活")) === shown + 1), { shown, now: await count("生活") });

  // 回收站开着时，回收站在外部变了：列表跟着刷新
  const rid = await m.invoke("delete_todo", { workspace: "生活", project: "杂事", id: "E" });
  await m.ev(`button("回收站").click(); await sleep(800); return 1`);
  const binTitles = () => m.ev(`return [...document.querySelectorAll(".recycle-row .list-title")].map((e) => e.textContent)`);
  const listed = (await binTitles()).includes("E");
  t.remove(`.recycle/${rid}`);
  check(
    "回收站开着时，回收站里的东西在外部没了：列表跟着刷新",
    listed && (await t.until(async () => !(await binTitles()).includes("E"))),
    await binTitles(),
  );
  await m.closeModal();

  await m.viewport(0);
}
