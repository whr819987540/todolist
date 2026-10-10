// 导出：右键待办 / 编辑区上方的「…」/ 右键项目、工作区「导出」→「导出为 HTML」「导出为 PDF」（「另存为」对话框在页面里换成直接返回路径）；
// 导出的 HTML 里有标题、状态、所在的位置、渲染后的表格和任务框、嵌进去的相对路径图片、找不到的图片的占位，正文里的 script 去掉了；
// 导出前有没保存的修改时先存盘、导出的是最新的；项目连同子项目：确认框里的数目、目录和各节都在、顺序同侧栏（父项目自己的在前，
// 子项目一章在后）、不含已完成的；工作区按项目分章；上次导出到的目录记住；PDF 的文件头、页数（每条待办从新的一页开始）、图片，
// 打印用的窗口和临时文件用完就没了；取消、失败时的提示
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDP_PORT } from "../lib/app.mjs";

export const title = "导出";

/** 1×1 的 PNG */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c63f8cfc0f01f0005000101ff89993d1d0000000049454e44ae426082",
  "hex",
);

export default async function (t) {
  const { main: m, check } = t;
  const out = join(t.data, "..", "export-out");
  mkdirSync(out, { recursive: true });
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

  // 测试数据：带表格、任务框、相对路径图片（和找不到的图片）、script 的待办；「需求」下的子项目「前端」
  t.write(
    "工作/需求/图文.md",
    [
      "# 图文并茂",
      "",
      "| 名称 | 数量 |",
      "| :-- | --: |",
      "| 苹果 | 3 |",
      "",
      "- [x] 买好了",
      "- [ ] 还没买",
      "",
      "![截图](.assets/图文/截图.png)",
      "",
      "![不在](.assets/图文/没有.png)",
      "",
      "<script>window.hacked = 1</script>",
      "",
    ].join("\n"),
  );
  mkdirSync(t.file("工作/需求/.assets/图文"), { recursive: true });
  writeFileSync(t.file("工作/需求/.assets/图文/截图.png"), PNG);
  mkdirSync(t.file("工作/需求/前端"), { recursive: true });
  t.write("工作/需求/前端/页面.md", "前端的页面\n");

  await m.viewport(1200, 900);
  await m.enter("工作");
  await m.emit("tauri://focus");
  await t.sleep(800);
  // 刷新出来的子项目可能是折叠着的：每次看之前先展开
  const shown = await t.until(async () => {
    await m.expandAll();
    return m.ev(`return !!row("工作", "需求", "图文") && !!row("工作", "需求/前端")`);
  });
  if (!shown) throw new Error("侧栏里没刷新出测试数据（图文、子项目「前端」）");
  // 一条已完成（沉底）、一条置顶（在最前）；等侧栏跟着变
  await m.invoke("set_todo_done", { workspace: "工作", project: "需求", id: "A", done: true });
  await m.invoke("set_todo_pinned", { workspace: "工作", project: "需求", id: "C", pinned: true });
  await m.emit("tauri://focus");
  await t.until(() =>
    m.ev(`return !!row("工作", "需求", "A")?.querySelector(".check.checked") && !!row("工作", "需求", "C")?.querySelector(".pin-mark")`),
  );

  /** 换掉页面里 api 的一个方法（弹出对话框的那些），直接返回 value，记下调用时的参数 */
  const stub = (name, value) =>
    m.ev(`const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/api.ts")) ?? "/src/api.ts";
      const { api } = await import(url); window.__calls = [];
      api[${JSON.stringify(name)}] = async (...args) => { window.__calls.push(args); return ${JSON.stringify(value)}; }; return 1`);
  const calls = () => m.ev(`return window.__calls ?? []`);
  /** 菜单已经打开：把指针移到「导出」上展开子菜单，点「导出为 …」 */
  const pickExport = async (format) => {
    const at = await m.ev(`const e = await waitFor(() => menuItem("导出")); if (!e) return null;
      const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }`);
    if (!at) throw new Error("菜单里没有「导出」");
    await m.mouse("mouseMoved", at);
    await m.ev(`const item = await waitFor(() => menuItem(${JSON.stringify(`导出为 ${format}`)})); item.click(); await sleep(300); return 1`);
  };
  const rightClickExport = async (sel, format) => {
    await m.click(await m.at(sel), { right: true });
    await t.sleep(300);
    await pickExport(format);
  };
  const doneToast = (ms = 30000) => t.until(async () => /已导出|导出失败/.test(await m.toast()) && (await m.toast()), ms);
  /** 导出项目、工作区时的确认框：返回里面的文字；uncheck 时取消「包含已完成的待办」；点「导出…」 */
  const confirmExport = async ({ uncheck = false } = {}) => {
    const text = await m.ev(`const c = await waitFor(() => document.querySelector(".export-options")); return c?.textContent ?? ""`);
    const checked = await m.ev(`return document.querySelector(".export-include-done input")?.checked ?? null`);
    if (uncheck) await m.ev(`document.querySelector(".export-include-done input").click(); await sleep(200); return 1`);
    await m.ev(`button("导出", document.querySelector(".ant-modal-confirm-btns")).click(); await sleep(300); return 1`);
    return { text, checked };
  };
  /** 导出的文件里各节的标题，按出现的先后 */
  const headings = (html) => [...html.matchAll(/<h[12] class="(todo-title[^"]*|chapter-title)">([^<]*)</g)].map((x) => x[2]);

  // ----- 右键待办「导出为 HTML」 -----
  const single = join(out, "图文.html");
  await stub("pickExportTarget", single);
  await m.clearToasts();
  await rightClickExport(["工作", "需求", "图文"], "HTML");
  let toast = await doneToast();
  const [args] = await calls();
  check(
    "右键待办「导出」→「导出为 HTML」：选位置时带上待办（默认文件名由它的标题来），还没导出过时没有上次的目录",
    !!args && args[0] === "html" && args[1] === "工作" && args[2] === "需求" && args[3] === "图文" && args[4] === null,
    args,
  );
  check("导出完的提示写明完整路径、几条，带「打开」「在文件夹中显示」", toast.includes(single) && toast.includes("1 条") && /打开.*在文件夹中显示/.test(toast), toast);
  let html = read(single);
  check(
    "导出的 HTML：标题、状态、所在的位置、创建时间",
    html.includes(">图文</h1>") && html.includes("进行中") && html.includes("工作 / 需求") && /创建于 \d{4}-\d\d-\d\d \d\d:\d\d/.test(html),
    html.slice(0, 2000),
  );
  check(
    "正文渲染成表格（带对齐）和只读的任务框",
    html.includes("<table>") && html.includes("text-align:right") && /<input[^>]*checked[^>]*disabled|<input[^>]*disabled[^>]*checked/.test(html),
    html.slice(0, 4000),
  );
  check("相对路径的图片嵌成 data URI", html.includes(`src="data:image/png;base64,${PNG.toString("base64")}"`), html.length);
  check("找不到的图片显示占位，正文里的 script 去掉了", html.includes("图片不存在：.assets/图文/没有.png") && !html.includes("<script") && !html.includes("hacked"));
  const missing = await m.ev(`try { await invoke("open_exported", { path: "C:\\\\Windows\\\\notepad.exe" }); return "opened"; } catch (e) { return String(e); }`);
  check("「打开」只认导出过的文件", missing.includes("只能打开导出的文件"), missing);

  // ----- 有没保存的修改时从编辑区上方的「…」导出：先存盘，导出的是最新的 -----
  await m.ev(`return await openTodo("工作", "需求", "B")`);
  await m.ev(`const v = view(); v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); return 1`);
  await m.type("\n还没保存的新内容");
  const dirty = await t.until(async () => {
    const s = await m.ev(`return document.querySelector(".save-state")?.textContent ?? ""`);
    return s.includes("未保存") && s;
  });
  const fresh = join(out, "B.html");
  await stub("pickExportTarget", fresh);
  await m.clearToasts();
  await m.ev(`document.querySelector(".editor-actions .anticon-more").closest("button").click(); await sleep(400); return 1`);
  await pickExport("HTML");
  await doneToast();
  check(
    "导出前有没保存的修改：先存盘，导出的是最新的内容",
    !!dirty && read(fresh).includes("还没保存的新内容") && t.read("工作/需求/B.md").includes("还没保存的新内容"),
    { dirty },
  );
  const [again] = await calls();
  check("再导出时从上次导出到的目录打开", again?.[4] === out, again);

  // ----- 右键项目：连同子项目 -----
  const sidebarOrder = await m.ev(`return [...document.querySelectorAll(".tree-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel))
    .filter(([w, p, id]) => w === "工作" && p === "需求" && id).map(([, , id]) => id)`);
  const whole = join(out, "需求.html");
  await stub("pickExportTarget", whole);
  await m.clearToasts();
  await rightClickExport(["工作", "需求"], "HTML");
  const asked = await confirmExport();
  check(
    "导出项目先确认：一共几条（含子项目里的）、已完成几条，默认包含已完成的",
    asked.text.includes("一共 6 条待办（含子项目里的），其中已完成 1 条") && asked.checked === true,
    asked,
  );
  toast = await doneToast();
  html = read(whole);
  const order = headings(html);
  check("项目的封面：项目名、路径、待办数、导出时间", html.includes("cover-title\">需求<") && html.includes("工作 / 需求") && html.includes("6 条（已完成 1 条，未完成 5 条）") && html.includes("导出时间"), order);
  check(
    "父项目自己的待办在前，顺序同侧栏（置顶的在最前、已完成的沉底），子项目「前端」一章在后",
    JSON.stringify(order) === JSON.stringify([...sidebarOrder, "前端", "页面"]) && sidebarOrder[0] === "C" && sidebarOrder.at(-1) === "A",
    { order, sidebarOrder },
  );
  const toc = html.split('<nav class="toc">')[1]?.split("</nav>")[0] ?? "";
  const links = [...toc.matchAll(/href="#([^"]+)"/g)].map((x) => x[1]);
  check(
    "目录：每条待办和子项目都在，点了能跳到对应的一节",
    links.length === 7 && links.every((id) => html.includes(`id="${id}"`)) && toc.indexOf(">前端<") < toc.indexOf(">页面<"),
    links,
  );
  check("提示导出了几条", toast.includes("6 条") && toast.includes(whole), toast);

  // 不含已完成的
  const undone = join(out, "需求-未完成.html");
  await stub("pickExportTarget", undone);
  await m.clearToasts();
  await rightClickExport(["工作", "需求"], "HTML");
  await confirmExport({ uncheck: true });
  await doneToast();
  html = read(undone);
  check(
    "不选「包含已完成的待办」：已完成的不导出，封面写明去掉了几条",
    !headings(html).includes("A") && headings(html).includes("B") && html.includes("不含已完成的 1 条待办"),
    headings(html),
  );

  // ----- 右键工作区：每个顶层项目一章，子项目跟在后面 -----
  const ws = join(out, "工作.html");
  await stub("pickExportTarget", ws);
  await m.clearToasts();
  await rightClickExport(["工作"], "HTML");
  const wsAsked = await confirmExport();
  await doneToast();
  html = read(ws);
  const chapters = [...html.matchAll(/<h([12]) class="chapter-title">([^<]*)</g)].map((x) => `${x[1]}:${x[2]}`);
  check(
    "导出工作区：确认框写明数目，项目按侧栏的顺序各一章，子项目在它的父项目后面",
    wsAsked.text.includes("一共 7 条待办") && JSON.stringify(chapters) === JSON.stringify(["1:日常", "1:需求", "2:前端"]) && html.includes("cover-title\">工作<"),
    { chapters, text: wsAsked.text },
  );

  // ----- 导出成 PDF -----
  const pdfOf = (p) => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
  const pages = (pdf) => (pdf.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
  const onePdf = join(out, "图文.pdf");
  await stub("pickExportTarget", onePdf);
  await m.clearToasts();
  await rightClickExport(["工作", "需求", "图文"], "PDF");
  toast = await doneToast(120000);
  let pdf = pdfOf(onePdf);
  const [pdfArgs] = await calls();
  check("右键待办「导出为 PDF」：选位置时是 PDF，导出完提示存到了哪里", pdfArgs?.[0] === "pdf" && toast.includes(onePdf), { pdfArgs, toast });
  check(
    "导出成 PDF：文件以 %PDF 开头、大小合理、一页，嵌进去的图片印出来了",
    pdf.subarray(0, 5).toString() === "%PDF-" && pdf.length > 3000 && pages(pdf) === 1 && pdf.toString("latin1").includes("/Subtype /Image"),
    { size: pdf.length, pages: pages(pdf) },
  );
  const projectPdf = join(out, "需求.pdf");
  await stub("pickExportTarget", projectPdf);
  await m.clearToasts();
  await rightClickExport(["工作", "需求"], "PDF");
  await confirmExport();
  toast = await doneToast(120000);
  pdf = pdfOf(projectPdf);
  check(
    "导出项目成 PDF：封面和目录一页，每条待办（自己的 5 条）、子项目从新的一页开始，长的待办跨页，页数大致对",
    pdf.subarray(0, 5).toString() === "%PDF-" && pages(pdf) >= 7 && pages(pdf) <= 20,
    { toast, size: pdf.length, pages: pages(pdf) },
  );
  const leftovers = async () => {
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    return targets.filter((x) => x.url.startsWith("file:")).length;
  };
  check(
    "打印用的看不见的窗口关掉了，临时文件删掉了",
    (await t.until(async () => (await leftovers()) === 0)) && !readdirSync(tmpdir()).some((n) => /^todolist-export-\d+-\d+\.html$/.test(n)),
    await leftovers(),
  );

  // ----- 取消、失败 -----
  await stub("pickExportTarget", null);
  await m.clearToasts();
  await rightClickExport(["工作", "需求", "C"], "HTML");
  await t.sleep(1000);
  check("「另存为」里取消了：不导出、不提示", !(await m.toast()).includes("导出"), await m.toast());
  await stub("pickExportTarget", join(out, "没有这个目录", "x.html"));
  await m.clearToasts();
  await rightClickExport(["工作", "需求", "C"], "HTML");
  toast = await doneToast();
  check("导出失败时写明原因", /导出失败：.+/.test(toast), toast);
  await stub("pickExportTarget", join(out, "没有这个目录", "x.pdf"));
  await m.clearToasts();
  await rightClickExport(["工作", "需求", "C"], "PDF");
  toast = await doneToast(120000);
  check("导出 PDF 失败时也写明原因", /导出失败：.+/.test(toast), toast);
}
