// 没选中文字时 Ctrl+C 复制光标所在的整行：列表项、任务、标题的行只复制后面的文字（不带 - 、任务框、#），
// 普通的段落、代码块里的行照原样；选中了文字时照常复制选中的。真的按 Ctrl+C，看复制出来的文字，
// 再按 Ctrl+V 粘贴回正文，看进了系统剪贴板的也是这样、粘贴时插在光标处
export const title = "复制一行";

export default async function (t) {
  const { main: m, check } = t;
  await m.viewport(1200, 900);
  const source = [
    "# 本周计划",
    "",
    "- [ ] 买牛奶",
    "- [x] 交报告",
    "  - 嵌套的子项",
    "1. 第一步",
    "",
    "普通的一段",
    "",
    "```",
    "# 代码里的注释",
    "```",
    "",
    "",
  ].join("\n");
  t.write("工作/日常/复制.md", source);
  await m.enter("工作");
  await m.expandAll();
  await m.ev(`return await openTodo("工作", "日常", "复制")`);

  // 记下每次复制放进剪贴板的文字（window 上的监听在编辑器处理完之后才收到）
  await m.ev(`window.__copied = [];
    window.addEventListener("copy", (e) => window.__copied.push(e.clipboardData.getData("text/plain"))); return 1`);
  /** 光标放在以 prefix 开头的那一行（第 at 个字后面，默认行尾），真的按 Ctrl+C，返回这一次复制出来的文字 */
  const copyAt = async (prefix, at = null) => {
    await m.ev(`const v = view(); v.focus(); let n = 1; while (!v.state.doc.line(n).text.startsWith(${JSON.stringify(prefix)})) n++;
      const line = v.state.doc.line(n); v.dispatch({ selection: { anchor: ${at === null ? "line.to" : `line.from + ${at}`} } });
      window.__copied = []; return 1`);
    // 先真的按一下键：只用脚本放光标时 WebView2 里页面还没有焦点（见 marks 套件）
    if (at === null) await m.press("End");
    else await m.press("ArrowRight").then(() => m.press("ArrowLeft"));
    await m.press("Ctrl+C");
    await t.sleep(150);
    return m.ev(`return window.__copied`);
  };
  const doc = () => m.ev(`return view().state.doc.toString()`);

  const task = await copyAt("- [ ] 买牛奶");
  check("任务的行：不带 - 和任务框", JSON.stringify(task) === JSON.stringify(["买牛奶"]), task);
  const done = await copyAt("- [x] 交报告");
  check("勾了的任务也一样", JSON.stringify(done) === JSON.stringify(["交报告"]), done);
  const child = await copyAt("  - 嵌套的子项");
  check("嵌套的子项：不带缩进和 -", JSON.stringify(child) === JSON.stringify(["嵌套的子项"]), child);
  const ordered = await copyAt("1. 第一步");
  check("有序列表项：不带序号", JSON.stringify(ordered) === JSON.stringify(["第一步"]), ordered);
  const heading = await copyAt("# 本周计划", 4);
  check("标题的行：不带 #（光标在行中间也是整行）", JSON.stringify(heading) === JSON.stringify(["本周计划"]), heading);
  const plain = await copyAt("普通的一段");
  check("普通的段落照原样复制整行", JSON.stringify(plain) === JSON.stringify(["普通的一段"]), plain);
  const code = await copyAt("# 代码里的注释");
  check("代码块里的 # 不算标题，照原样复制", JSON.stringify(code) === JSON.stringify(["# 代码里的注释"]), code);
  check("复制不改正文", (await doc()) === source);

  // 选中了文字：照常复制选中的原文
  await m.ev(`const v = view(); const text = "- [ ] 买牛奶"; const from = v.state.doc.toString().indexOf(text);
    v.dispatch({ selection: { anchor: from, head: from + text.length } }); window.__copied = []; return 1`);
  await m.press("Ctrl+C");
  await t.sleep(150);
  const selected = await m.ev(`return window.__copied`);
  check("选中了文字时照常复制选中的原文（连同标记）", JSON.stringify(selected) === JSON.stringify(["- [ ] 买牛奶"]), selected);

  // 复制任务的行，粘贴到最后的空行：进了系统剪贴板的是去掉标记的文字，插在光标处（不在上面另起一行）
  await copyAt("- [ ] 买牛奶");
  await m.ev(`const v = view(); v.dispatch({ selection: { anchor: v.state.doc.length } }); return 1`);
  await m.press("End");
  await m.press("Ctrl+V");
  await t.sleep(300);
  const pasted = await doc();
  check("Ctrl+V 粘贴出来的是去掉标记的文字，插在光标处", pasted === source + "买牛奶", pasted.split("\n").slice(-3));

  // 源码模式也一样
  await m.press("Ctrl+/");
  await t.sleep(300);
  const sourceMode = await copyAt("- [x] 交报告");
  check("源码模式里同样不带标记", JSON.stringify(sourceMode) === JSON.stringify(["交报告"]), sourceMode);
  await m.press("Ctrl+/");
  await m.viewport();
}
