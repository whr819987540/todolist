// 正文里的图片：粘贴（截图、和文字一起时粘贴文字）、从资源管理器拖进来（经 Tauri 的拖放事件），存进项目文件夹的
// .assets/{待办 id}/；实时渲染时显示成图片（相对路径、别处的、数据目录以外的绝对路径经 asset 协议显示，宽的缩小，
// 显示不了的写明原因，光标所在的行显示原文，源码模式不显示）；只读的不能插入；太大的提示；冲突时另存为新待办复制图片、
// 撤销记录接着用；删除、恢复时图片跟着进出回收站
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

export const title = "图片";

/** w×h 的纯色 PNG */
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 每个通道 8 位
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let i = 0; i < w * 3; i++) row[1 + i] = [0x16, 0x77, 0xff][i % 3];
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export default async function (t) {
  const { main: m, check } = t;
  await m.viewport(1200, 900);
  await m.enter("工作");
  await m.expandAll();

  const small = png(40, 30);
  const doc = () => m.ev(`return view()?.state.doc.toString() ?? null`);
  const assets = (rel) => (t.exists(rel) ? readdirSync(t.file(rel)) : []);
  const toastHas = (text) => t.until(async () => (await m.toast()).includes(text));
  /** 在正文里粘贴：files 是 [{ b64, name, type, pad }]（pad：补到这么多字节），text 是同时放进剪贴板的文字 */
  const paste = (files, text = "") =>
    m.ev(`const dt = new DataTransfer();
      if (${JSON.stringify(text)}) dt.setData("text/plain", ${JSON.stringify(text)});
      for (const f of ${JSON.stringify(files)}) {
        let bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
        if (f.pad) { const big = new Uint8Array(f.pad); big.set(bytes); bytes = big; }
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      const v = view(); v.focus();
      v.contentDOM.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      return 1`);
  const shot = { b64: small.toString("base64"), name: "image.png", type: "image/png" };
  /** 正文失去焦点（实时渲染时全部显示成渲染后的样子） */
  const blur = () => m.ev(`view().contentDOM.blur(); await sleep(300); return 1`);
  /** 显示出来的图片：加载好了没有、原来的宽度、显示的宽度 */
  const images = () =>
    m.ev(`return [...document.querySelectorAll(".cm-md-image img")].map((i) => ({
      ok: i.complete && i.naturalWidth > 0, natural: i.naturalWidth, width: Math.round(i.getBoundingClientRect().width), alt: i.alt }))`);
  const placeholders = () => m.ev(`return [...document.querySelectorAll(".cm-md-image-error")].map((e) => e.textContent)`);
  /** 正文第 line 行行尾在窗口里的位置（Tauri 的拖放事件给的是物理像素） */
  const lineEnd = (line) =>
    m.ev(`const v = view(); const pos = v.state.doc.line(${line}).to; const c = v.coordsAtPos(pos);
      return { pos, x: (c.left + 1) * devicePixelRatio, y: ((c.top + c.bottom) / 2) * devicePixelRatio }`);
  /** 模拟从资源管理器拖文件：Tauri 接管了系统的拖放，页面收到的是它发的事件 */
  const drag = (type, paths, p) =>
    m.ev(`await invoke("plugin:event|emit", { event: "tauri://drag-${type}", payload: ${
      type === "leave" ? "null" : JSON.stringify({ paths, position: { x: p.x, y: p.y } })
    } }); await sleep(200); return 1`);
  const dropFiles = async (paths, p) => {
    await drag("enter", paths, p);
    await drag("over", paths, p);
    const caret = await m.ev(`return !!document.querySelector(".cm-drop-caret")`);
    await drag("drop", paths, p);
    return caret;
  };

  // ----- 粘贴 -----
  await m.ev(`return await openTodo("工作", "日常", "D")`);
  await m.ev(`const v = view(); v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length } }); return 1`);
  await paste([shot]);
  await t.until(async () => (await doc())?.includes("](.assets/D/"));
  const pasted = assets("工作/日常/.assets/D");
  check(
    "粘贴截图：存成 工作/日常/.assets/D/图片-年月日-时分秒.png，内容就是剪贴板里的图片",
    pasted.length === 1 && /^图片-\d{8}-\d{6}\.png$/.test(pasted[0]) && readFileSync(t.file(`工作/日常/.assets/D/${pasted[0]}`)).equals(small),
    pasted,
  );
  const link = `![${pasted[0]?.replace(/\.png$/, "")}](.assets/D/${pasted[0]})`;
  check("在光标处插入 ![文件名](.assets/D/文件名)，算修改（未保存）", (await doc())?.endsWith(link) && (await m.ev(`return document.querySelector(".save-state")?.textContent`)) === "未保存", await doc());
  await m.press("Ctrl+S");
  check("保存后 .md 里是相对地址", await t.until(() => t.read("工作/日常/D.md").endsWith(link)));
  check("附件目录不是子项目，侧栏里没有它", !(await m.ev(`return !!row("工作", "日常/.assets")`)));

  await paste([shot], "一起复制的文字");
  await t.sleep(500);
  check("剪贴板里同时有文字：照常粘贴文字，不存图片", (await doc())?.endsWith("一起复制的文字") && assets("工作/日常/.assets/D").length === 1, await doc());
  await m.press("Ctrl+Z");

  await m.clearToasts();
  await paste([{ ...shot, pad: 21 * 1024 * 1024 }]);
  check("超过 20 MB 的图片照常插入，提示它比较大", (await toastHas("比较大")) && assets("工作/日常/.assets/D").length === 2, await m.toast());
  const big = assets("工作/日常/.assets/D").find((n) => n !== pasted[0]);
  check("大图片完整存下来了", !!big && statSync(t.file(`工作/日常/.assets/D/${big}`)).size === 21 * 1024 * 1024);
  await m.press("Ctrl+Z");
  check("撤销后图片文件还在（还可能撤销回来）", assets("工作/日常/.assets/D").length === 2);

  // ----- 显示 -----
  await blur();
  const one = await t.until(async () => {
    const list = await images();
    return list.length === 1 && list[0].ok && list;
  });
  check("实时渲染：光标不在那一行时显示成图片（经 asset 协议读到了文件）", !!one && one[0].natural === 40, await images());

  // 各种地址：.assets 以外的相对路径、数据目录以外的绝对路径（file:///）、找不到的、不是图片的、宽的
  const outside = join(t.data, "..", "外面的图片.png");
  writeFileSync(outside, small);
  mkdirSync(t.file(".图库"), { recursive: true });
  writeFileSync(t.file(".图库/b.png"), small);
  writeFileSync(t.file(".图库/说明.txt"), "不是图片");
  mkdirSync(t.file("工作/日常/.assets/图片"), { recursive: true });
  writeFileSync(t.file("工作/日常/.assets/图片/wide.png"), png(3000, 20));
  const fileUrl = `file:///${outside.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:")}`;
  t.write(
    "工作/日常/图片.md",
    [
      "# 图片",
      "",
      "![别处](../../.图库/b.png)",
      "",
      `![外面](${fileUrl})`,
      "",
      "![宽](.assets/图片/wide.png)",
      "",
      "![没有](.assets/图片/没有.png)",
      "",
      "![文本](../../.图库/说明.txt)",
      "",
    ].join("\n"),
  );
  await m.press("F5");
  await m.ev(`return await openTodo("工作", "日常", "图片")`);
  await blur();
  const all = await t.until(async () => {
    const list = await images();
    return list.length === 3 && list.every((i) => i.ok) && list;
  });
  check("相对于 .md 的别处的图片、数据目录以外的绝对路径（file:///）都显示出来", !!all, await images());
  const width = await m.ev(`return Math.round(view().contentDOM.getBoundingClientRect().width)`);
  const wide = (await images()).find((i) => i.alt === "宽");
  check("比编辑区宽的按比例缩小到编辑区的宽度", !!wide && wide.natural === 3000 && wide.width <= width, { wide, width });
  const holders = await t.until(async () => {
    const list = await placeholders();
    return list.length === 2 && list;
  });
  check(
    "显示不了的是占位框，写明原因：找不到图片、不是图片文件",
    !!holders && holders.some((x) => x.includes("找不到图片")) && holders.some((x) => x.includes("不是图片文件")),
    await placeholders(),
  );
  // 光标放在第一张图片那一行：这一行显示原文
  const line3 = await m.ev(`const v = view(); v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(3).from + 2 } }); await sleep(300);
    const d = v.domAtPos(v.state.doc.line(3).from).node; const ln = (d.nodeType === 3 ? d.parentElement : d).closest(".cm-line");
    return { text: ln?.textContent, image: !!ln?.querySelector(".cm-md-image") }`);
  check("光标在图片那一行时显示原文，别的行照样显示图片", !line3.image && line3.text?.startsWith("![别处]") && (await images()).length === 2, line3);
  await m.press("Ctrl+/");
  await blur();
  check("源码模式只显示原文", (await images()).length === 0 && (await placeholders()).length === 0);
  await m.press("Ctrl+/");

  // ----- 拖进来 -----
  await m.ev(`return await openTodo("工作", "日常", "D")`);
  const dropped = join(t.data, "..", "拖进来的 截图#1.png");
  writeFileSync(dropped, png(50, 20));
  const at = await lineEnd(1);
  const caret = await dropFiles([dropped], at);
  check("拖着图片停在正文上时画出放下的位置", caret);
  await t.until(async () => (await doc())?.includes("拖进来的 截图_1"));
  check(
    "拖进来的图片复制一份到附件目录（保留原名，# 换成 _），原文件不动",
    assets("工作/日常/.assets/D").includes("拖进来的 截图_1.png") && statSync(dropped).isFile(),
    assets("工作/日常/.assets/D"),
  );
  const text = await doc();
  check(
    "插在放下的位置；地址里有空格时写成 <…>",
    text?.slice(at.pos).startsWith("![拖进来的 截图_1](<.assets/D/拖进来的 截图_1.png>)"),
    text?.slice(0, 120),
  );
  check("放下后不再画放下的位置", !(await m.ev(`return !!document.querySelector(".cm-drop-caret")`)));

  const txt = join(t.data, "..", "说明.txt");
  writeFileSync(txt, "x");
  await m.clearToasts();
  const before = await doc();
  await dropFiles([txt], await lineEnd(1));
  check("拖进来的不是图片：提示，不插入", (await toastHas("不是图片")) && (await doc()) === before, await m.toast());
  const sidebar = await m.at(["工作", "日常", "D"]);
  const dpr = await m.ev(`return devicePixelRatio`);
  await dropFiles([dropped], { x: sidebar.x * dpr, y: sidebar.y * dpr });
  await t.sleep(500);
  check("拖到正文以外的地方（侧栏）什么都不做", (await doc()) === before);
  await m.press("Ctrl+S");
  await t.until(() => t.read("工作/日常/D.md") === before);

  // ----- 只读的正文不能插入 -----
  t.write("工作/日常/乱码.md", Buffer.from("abc \xff\xfe\xff def", "latin1"));
  await m.press("F5");
  await m.ev(`return await openTodo("工作", "日常", "乱码")`).catch(() => "");
  await m.clearToasts();
  await paste([shot]);
  check("只读的正文（编码认不出）不能插入，提示原因", (await toastHas("只读")) && !t.exists("工作/日常/.assets/乱码"), await m.toast());

  // ----- 外部修改冲突时另存为新待办：复制图片，链接改成新的，撤销记录接着用 -----
  await m.ev(`return await openTodo("工作", "日常", "D")`);
  const mine = await m.ev(`const v = view(); v.focus(); v.dispatch({ changes: { from: v.state.doc.length, insert: "\\n没保存的修改" } });
    await sleep(200); return v.state.doc.toString()`);
  t.write("工作/日常/D.md", "# 待办 D\n\n外部改的\n");
  await m.emit("tauri://focus");
  const CONFLICT = `[...document.querySelectorAll(".ant-modal-title")].find((e) => e.textContent === "文件已在外部被修改" && e.getClientRects().length > 0)`;
  if (await t.until(() => m.ev(`return !!${CONFLICT}`))) {
    await m.ev(`button("另存为新待办", ${CONFLICT}.closest(".ant-modal").querySelector(".ant-modal-footer")).click(); await sleep(800); return 1`);
    const copy = await t.until(() => t.meta("工作", "日常").find((x) => x.title.includes("（我的版本）")));
    const copied = copy ? assets(`工作/日常/.assets/${copy.id}`) : [];
    check("另存为新待办：复制一份原来那条的图片给新的那条", copied.length >= 3 && copied.includes(pasted[0]), copied);
    const saved = copy ? t.read(`工作/日常/${copy.id}.md`) : "";
    check(
      "新的那条的正文里，图片的链接改成了它自己的 id",
      saved === mine.split(".assets/D/").join(`.assets/${copy?.id}/`) && !saved.includes(".assets/D/"),
      saved,
    );
    await t.until(async () => (await doc()) === saved);
    await m.ev(`view().focus(); return 1`);
    await m.press("Ctrl+Z");
    check(
      "打开着新的那条，还能撤销刚才的修改，链接仍是新的",
      (await doc()) === saved.replace("\n没保存的修改", ""),
      await doc(),
    );
  } else {
    check("有没保存的修改时外部改了正文：弹出冲突对话框", false);
  }

  // ----- 删除、恢复 -----
  const rid = await m.invoke("delete_todo", { workspace: "工作", project: "日常", id: "D" });
  check(
    "删除待办：图片连同 .md 放进回收站的同一项里",
    !t.exists("工作/日常/.assets/D") && assets(`.recycle/${rid}/.assets/D`).includes(pasted[0]) && t.exists(`.recycle/${rid}/D.md`),
  );
  await m.invoke("restore_recycled", { ids: [rid] });
  check("恢复：图片一起回来", assets("工作/日常/.assets/D").includes(pasted[0]));
}
