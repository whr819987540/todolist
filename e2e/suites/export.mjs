// 导出：右键待办 / 编辑区上方的「…」（分屏两边各自的）/ 右键项目（多深的子项目都行）、工作区「导出」→「导出为 HTML」
// 「导出为 PDF」（「另存为」对话框在页面里换成直接返回路径）；导出的 HTML 里有标题、状态、所在的位置、渲染后的表格和任务框、嵌进去的相对路径
// 图片（深层项目里的也是）、找不到的图片的占位，正文里的 script 去掉了；导出前有没保存的修改时先存盘（分屏两边开着的都存）、
// 导出的是最新的；项目连同各级子项目：确认框里的数目、目录和各节都在、顺序同侧栏（项目自己的待办在前，各级子项目一层层作为
// 下一级的章，标题跟着加深）、不含已完成的；深层的子项目单独导出；工作区按项目一层层分章；上次导出到的目录记住；PDF 的文件头、
// 页数、图片（深层项目里的也是），打印用的窗口和临时文件用完就没了；取消、失败时的提示
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
/** 1×1 的红色 GIF（不透明）：深层项目里的图片，和上面的 PNG 分得开 */
const GIF = Buffer.from("474946383961010001008000" + "00ff0000000000" + "2c00000000010001000002024401003b", "hex");

export default async function (t) {
  const { main: m, check } = t;
  const out = join(t.data, "..", "export-out");
  mkdirSync(out, { recursive: true });
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

  // 测试数据：带表格、任务框、相对路径图片（和找不到的图片）、script 的待办；「需求」下的子项目「前端」，它下面还有一级「组件」，
  // 「组件」里的待办「按钮」有它自己那一级的 .assets 里的图片
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
  mkdirSync(t.file("工作/需求/前端/组件/.assets/按钮"), { recursive: true });
  t.write("工作/需求/前端/页面.md", "前端的页面\n");
  t.write("工作/需求/前端/组件/按钮.md", "按钮的样子\n\n![按钮](.assets/按钮/图.gif)\n");
  writeFileSync(t.file("工作/需求/前端/组件/.assets/按钮/图.gif"), GIF);

  await m.viewport(1200, 900);
  await m.enter("工作");
  await m.emit("tauri://focus");
  await t.sleep(800);
  // 刷新出来的子项目可能是折叠着的（展开一级才看得到下一级）：每次看之前先展开
  const shown = await t.until(async () => {
    await m.expandAll();
    return m.ev(`return !!row("工作", "需求", "图文") && !!row("工作", "需求/前端/组件", "按钮")`);
  });
  if (!shown) throw new Error("侧栏里没刷新出测试数据（图文、子项目「前端」「组件」）");
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
  /**
   * 菜单已经打开：把指针移到「导出」上展开子菜单，点「导出为 …」。before 在点之前做（子菜单已经出来了；外部改文件放在这里，
   * 监听到变化后弹出的冲突对话框不会挡住菜单）
   */
  const pickExport = async (format, before = async () => {}) => {
    const at = await m.ev(`const e = await waitFor(() => menuItem("导出")); if (!e) return null;
      const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }`);
    if (!at) throw new Error("菜单里没有「导出」");
    await m.mouse("mouseMoved", at);
    const item = JSON.stringify(`导出为 ${format}`);
    if (!(await m.ev(`return !!(await waitFor(() => menuItem(${item})))`))) throw new Error(`「导出」的子菜单里没有「导出为 ${format}」`);
    await before();
    await m.ev(`menuItem(${item}).click(); await sleep(300); return 1`);
  };
  const rightClickExport = async (sel, format, before) => {
    await m.click(await m.at(sel), { right: true });
    await t.sleep(300);
    await pickExport(format, before);
  };
  /** 第 i 边（从左 / 上数）编辑区上方的「…」→「导出」→「导出为 …」 */
  const editorExport = async (i, format) => {
    await m.ev(`document.querySelectorAll(".editor-group")[${i}].querySelector(".editor-actions .anticon-more").closest("button").click();
      await sleep(400); return 1`);
    await pickExport(format);
  };
  /** 第 i 边状态栏的保存状态 */
  const saveState = (i) => m.ev(`return document.querySelectorAll(".editor-group")[${i}]?.querySelector(".save-state")?.textContent ?? ""`);
  /** 光标放到第 i 边正文的末尾、焦点放进去，接着打字 */
  const typeAtEnd = async (i, text) => {
    await m.ev(`const v = document.querySelectorAll(".editor-group")[${i}].querySelector(".cm-content").cmTile.root.view;
      v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); await sleep(200); return 1`);
    await m.type(text);
    return t.until(async () => (await saveState(i)).includes("未保存"));
  };
  /** 等导出完的提示（成功、失败），返回提示的文字；等不到时是那时的提示（检查不通过，不中断） */
  const doneToast = async (ms = 30000) => {
    await t.until(async () => /已导出|导出失败|没保存好/.test(await m.toast()), ms);
    return m.toast();
  };
  /** 导出项目、工作区时的确认框：返回里面的文字和标题；uncheck 时取消「包含已完成的待办」；点「导出…」 */
  const confirmExport = async ({ uncheck = false } = {}) => {
    const text = await m.ev(`const c = await waitFor(() => document.querySelector(".export-options")); return c?.textContent ?? ""`);
    const title = await m.ev(`return document.querySelector(".export-confirm .ant-modal-confirm-title")?.textContent ?? ""`);
    const checked = await m.ev(`return document.querySelector(".export-include-done input")?.checked ?? null`);
    if (uncheck) await m.ev(`document.querySelector(".export-include-done input").click(); await sleep(200); return 1`);
    await m.ev(`button("导出", document.querySelector(".export-confirm .ant-modal-confirm-btns")).click(); await sleep(300); return 1`);
    return { text, title, checked };
  };
  /** 导出的文件里各个标题（章的、待办的），按出现的先后：「h几:文字」（深的章前面灰色的上级路径不算） */
  const headings = (html) =>
    [...html.matchAll(/<h([1-6]) class="(?:todo-title[^"]*|chapter-title)">(?:<span class="chapter-path">[^<]*<\/span>)?([^<]*)</g)].map(
      (x) => `h${x[1]}:${x[2]}`,
    );
  const titles = (html) => headings(html).map((h) => h.slice(3));
  const tocOf = (html) => html.split('<nav class="toc">')[1]?.split("</nav>")[0] ?? "";

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

  // ----- 深层项目里的待办：图片在它自己那一级的 .assets 里 -----
  const deepOne = join(out, "按钮.html");
  await stub("pickExportTarget", deepOne);
  await m.clearToasts();
  await rightClickExport(["工作", "需求/前端/组件", "按钮"], "HTML");
  await doneToast();
  const [deepArgs] = await calls();
  html = read(deepOne);
  check(
    "右键深层项目里的待办导出：选位置时带上它的项目路径，所在的位置写完整的路径，图片嵌进去",
    deepArgs?.[2] === "需求/前端/组件" &&
      deepArgs?.[3] === "按钮" &&
      html.includes("工作 / 需求 / 前端 / 组件") &&
      html.includes(`src="data:image/gif;base64,${GIF.toString("base64")}"`) &&
      !html.includes("图片不存在"),
    { deepArgs, size: html.length },
  );

  // ----- 有没保存的修改时从编辑区上方的「…」导出：先存盘，导出的是最新的 -----
  await m.ev(`return await openTodo("工作", "需求", "B")`);
  const dirty = await typeAtEnd(0, "\n还没保存的新内容");
  const fresh = join(out, "B.html");
  await stub("pickExportTarget", fresh);
  await m.clearToasts();
  await editorExport(0, "HTML");
  await doneToast();
  check(
    "导出前有没保存的修改：先存盘，导出的是最新的内容",
    !!dirty && read(fresh).includes("还没保存的新内容") && t.read("工作/需求/B.md").includes("还没保存的新内容"),
    { dirty },
  );
  const [again] = await calls();
  check("再导出时从上次导出到的目录打开", again?.[4] === out, again);

  // ----- 分屏：另一边编辑区上方的「…」导出那一边显示着的待办；导出项目前两边开着的都先存盘 -----
  await m.press("Alt+Shift+=");
  await t.until(() => m.ev(`return document.querySelectorAll(".editor-group").length === 2`));
  // 焦点在新的一边（右边），在侧栏里点 C 开在右边；左边仍是 B
  await m.ev(`row("工作", "需求", "C").click(); await sleep(300);
    return !!(await waitFor(() => document.querySelectorAll(".editor-group")[1]?.querySelector(".editor-title")?.value === "C"))`);
  const rightDirty = await typeAtEnd(1, "\n右边还没保存的");
  const rightFile = join(out, "C.html");
  await stub("pickExportTarget", rightFile);
  await m.clearToasts();
  await editorExport(1, "HTML");
  await doneToast();
  const [rightArgs] = await calls();
  check(
    "分屏时右边编辑区上方的「…」导出右边显示着的待办，先存盘",
    !!rightDirty && rightArgs?.[3] === "C" && read(rightFile).includes("右边还没保存的") && t.read("工作/需求/C.md").includes("右边还没保存的"),
    { rightDirty, rightArgs },
  );
  // 两边都有没保存的修改，从侧栏导出项目：两边开着的都先存盘、导出的是最新的
  const bothDirty = (await typeAtEnd(1, "\n右边又改了")) && (await typeAtEnd(0, "\n左边也改了"));

  // ----- 右键项目：连同各级子项目 -----
  const sidebarOrder = await m.ev(`return [...document.querySelectorAll(".tree-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel))
    .filter(([w, p, id]) => w === "工作" && p === "需求" && id).map(([, , id]) => id)`);
  const whole = join(out, "需求.html");
  await stub("pickExportTarget", whole);
  await m.clearToasts();
  await rightClickExport(["工作", "需求"], "HTML");
  const asked = await confirmExport();
  check(
    "导出项目先确认：一共几条（含各级子项目里的）、已完成几条，默认包含已完成的",
    asked.text.includes("一共 7 条待办（含各级子项目里的），其中已完成 1 条") && asked.checked === true && asked.title === "导出项目「需求」为 HTML",
    asked,
  );
  toast = await doneToast();
  html = read(whole);
  check(
    "导出项目前分屏两边开着的待办都先存盘，导出的是最新的",
    !!bothDirty && html.includes("右边又改了") && html.includes("左边也改了") && t.read("工作/需求/B.md").includes("左边也改了"),
    { bothDirty },
  );
  const order = headings(html);
  check(
    "项目的封面：项目名、路径、各级子项目几个、待办数（连同各级子项目）、导出时间",
    html.includes('cover-title">需求<') &&
      html.includes("工作 / 需求") &&
      html.includes("<dd>2 个（含各级）</dd>") &&
      html.includes("7 条（已完成 1 条，未完成 6 条）") &&
      html.includes("导出时间"),
    order,
  );
  check(
    "项目自己的待办在前，顺序同侧栏（置顶的在最前、已完成的沉底）；子项目「前端」一章在后，它下面的「组件」是下一级的章，标题一级级加深",
    JSON.stringify(order) ===
      JSON.stringify([...sidebarOrder.map((id) => `h2:${id}`), "h1:前端", "h2:页面", "h2:组件", "h3:按钮"]) &&
      sidebarOrder[0] === "C" &&
      sidebarOrder.at(-1) === "A",
    { order, sidebarOrder },
  );
  const toc = tocOf(html);
  const links = [...toc.matchAll(/href="#([^"]+)"/g)].map((x) => x[1]);
  check(
    "目录：每条待办和各级子项目都在，点了能跳到对应的一节；「组件」缩进在「前端」下面",
    links.length === 9 &&
      links.every((id) => html.includes(`id="${id}"`)) &&
      /前端<\/a><ul><li class="toc-todo"><a [^>]*>页面<\/a><\/li><li class="toc-chapter"><a [^>]*>组件<\/a><ul>/.test(toc),
    links,
  );
  check("深层子项目里的图片嵌进去了", html.includes(`data:image/gif;base64,${GIF.toString("base64")}`) && toast.includes("7 条") && toast.includes(whole), toast);

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
    !titles(html).includes("A") && titles(html).includes("B") && html.includes("不含已完成的 1 条待办"),
    titles(html),
  );

  // ----- 右键深层的子项目：只有它自己和它下面的 -----
  const comp = join(out, "组件.html");
  await stub("pickExportTarget", comp);
  await m.clearToasts();
  await rightClickExport(["工作", "需求/前端"], "HTML");
  const compAsked = await confirmExport();
  await doneToast();
  const [compArgs] = await calls();
  html = read(comp);
  check(
    "导出子项目：确认框写明是子项目，选位置时带上它的路径；封面是完整的路径，它下一级的「组件」是一级的章",
    compAsked.title === "导出子项目「需求 / 前端」为 HTML" &&
      compAsked.text.includes("一共 2 条待办（含各级子项目里的）") &&
      compArgs?.[2] === "需求/前端" &&
      compArgs?.[3] === null &&
      html.includes('cover-title">需求 / 前端<') &&
      JSON.stringify(headings(html)) === JSON.stringify(["h2:页面", "h1:组件", "h2:按钮"]),
    { compAsked, compArgs, headings: headings(html) },
  );

  // ----- 右键工作区：每个顶层项目一章，子项目一层层在下面 -----
  const ws = join(out, "工作.html");
  await stub("pickExportTarget", ws);
  await m.clearToasts();
  await rightClickExport(["工作"], "HTML");
  const wsAsked = await confirmExport();
  await doneToast();
  html = read(ws);
  const chapters = [...html.matchAll(/<h([1-6]) class="chapter-title">(?:<span class="chapter-path">([^<]*)<\/span>)?([^<]*)</g)].map(
    (x) => `${x[1]}:${x[2] ?? ""}${x[3]}`,
  );
  check(
    "导出工作区：确认框写明数目，项目按侧栏的顺序各一章，各级子项目一层层在它的父项目下面（深的章前面写着它外面那几章）",
    wsAsked.text.includes("一共 8 条待办，其中已完成 1 条") &&
      JSON.stringify(chapters) === JSON.stringify(["1:日常", "1:需求", "2:需求 / 前端", "3:需求 / 前端 / 组件"]) &&
      html.includes('cover-title">工作<') &&
      html.includes("<dd>2 个（另有各级子项目 2 个）</dd>"),
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
    "导出项目成 PDF：封面和目录一页，长的待办跨页，一级的子项目从新的一页开始，页数大致对",
    pdf.subarray(0, 5).toString() === "%PDF-" && pages(pdf) >= 4 && pages(pdf) <= 20,
    { toast, size: pdf.length, pages: pages(pdf) },
  );
  // 深层的子项目：封面目录一页、自己的「页面」、下一级的「组件」从新的一页开始；「按钮」的图片印出来了
  const subPdf = join(out, "前端.pdf");
  await stub("pickExportTarget", subPdf);
  await m.clearToasts();
  await rightClickExport(["工作", "需求/前端"], "PDF");
  await confirmExport();
  toast = await doneToast(120000);
  pdf = pdfOf(subPdf);
  check(
    "导出深层的子项目成 PDF：封面目录、它自己的待办、下一级的章各从新的一页开始，深层项目里的图片印出来了",
    pdf.subarray(0, 5).toString() === "%PDF-" && pages(pdf) >= 3 && pages(pdf) <= 6 && pdf.toString("latin1").includes("/Subtype /Image"),
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

  // ----- 导出的范围里开着的待办存不上：不导出；和它无关的照常导出 -----
  const CONFLICT = `[...document.querySelectorAll(".ant-modal-title")].find((e) => e.textContent === "文件已在外部被修改" && e.getClientRects().length > 0)`;
  const conflictShown = () => m.ev(`return !!${CONFLICT}`);
  const resolveConflict = (text) =>
    m.ev(`button(${JSON.stringify(text)}, ${CONFLICT}.closest(".ant-modal").querySelector(".ant-modal-footer")).click(); await sleep(600); return 1`);
  const confirmShown = () => m.ev(`return [...document.querySelectorAll(".export-options")].some((e) => e.getClientRects().length > 0)`);
  await typeAtEnd(1, "\n导出前又改的");
  const blocked = join(out, "存不上.html");
  await stub("pickExportTarget", blocked);
  await m.clearToasts();
  await rightClickExport(["工作", "需求"], "HTML", async () => t.write("工作/需求/C.md", "# 待办 C\n\n外部改的\n"));
  check(
    "导出的范围里（分屏右边）开着的待办存不上：弹出冲突对话框，不导出（不弹确认框、不选位置），提示先处理好",
    // 提示只停留几秒，先看它；冲突对话框一直开着
    (await t.until(async () => (await m.toast()).includes("先处理好再导出"))) &&
      (await t.until(conflictShown)) &&
      !(await confirmShown()) &&
      (await calls()).length === 0 &&
      !existsSync(blocked),
    await m.toast(),
  );
  await resolveConflict("放弃我的修改");
  await t.until(async () => !(await conflictShown()));
  await typeAtEnd(1, "\n又改了一次");
  const unrelated = join(out, "D.html");
  await stub("pickExportTarget", unrelated);
  await m.clearToasts();
  await rightClickExport(["工作", "日常", "D"], "HTML", async () => t.write("工作/需求/C.md", "# 待办 C\n\n外部又改了\n"));
  toast = await doneToast();
  check(
    "和它无关的照常导出（冲突对话框照样弹出）",
    toast.includes("已导出") && read(unrelated).includes(">D</h1>") && (await t.until(conflictShown)),
    toast,
  );
  await resolveConflict("放弃我的修改");
  await t.until(async () => !(await conflictShown()));

  // ----- 取消、失败 -----
  await stub("pickExportTarget", null);
  await m.clearToasts();
  await rightClickExport(["工作", "需求", "长文档"], "HTML");
  await t.sleep(1000);
  check("「另存为」里取消了：不导出、不提示", !(await m.toast()).includes("导出"), await m.toast());
  await stub("pickExportTarget", join(out, "没有这个目录", "x.html"));
  await m.clearToasts();
  await rightClickExport(["工作", "需求", "长文档"], "HTML");
  toast = await doneToast();
  check("导出失败时写明原因", /导出失败：.+/.test(toast), toast);
  await stub("pickExportTarget", join(out, "没有这个目录", "x.pdf"));
  await m.clearToasts();
  await rightClickExport(["工作", "需求", "长文档"], "PDF");
  toast = await doneToast(120000);
  check("导出 PDF 失败时也写明原因", /导出失败：.+/.test(toast), toast);
}
