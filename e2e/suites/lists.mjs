// 正文里列表的缩进和折行对齐（实时渲染）
export const title = "列表的缩进和折行对齐";

const LONG = "，这一项写得很长很长，长到一行放不下需要自动折行，第二行要和第一行的正文开头对齐".repeat(3);
const EN = " mixed English words that should wrap around nicely".repeat(5);
const DOC = [
  "段落",
  "",
  `- 第一级${LONG}`,
  `  - 第二级${LONG}`,
  `    续行：缩进到正文${LONG}`,
  `    - 第三级${EN}`,
  "- 第一级第二项",
  "",
  ...Array.from({ length: 9 }, (_, i) => `${i + 1}. 第${i + 1}项`),
  `10. 两位数${LONG}`,
  "",
  `- [ ] 任务${LONG}`,
  "- 普通项",
  `  - [x] 嵌套的任务${LONG}`,
  "  - 嵌套的普通项",
  "",
  `1. [ ] 有序的任务${LONG}`,
  "",
  `> - 引用里${LONG}`,
  `>   - 引用里第二级${LONG}`,
  "",
  "- 第二段：",
  "",
  `  列表项里的第二段${LONG}`,
  "",
  `- > 项里的引用${LONG}`,
  `  > 引用第二行${LONG}`,
  "",
  "98. 九十八",
  "99. 九十九",
  `100. 三位数${LONG}`,
  "",
  `- - 同一行套着子项${LONG}`,
  "    子项的续行",
  "",
  "9. 第九",
  "10. # 标题项",
  "11. 第十一",
].join("\n");

/**
 * 页面里：每一行文字开头（列表符号、任务框后面）的 x，和折下来的各行开头的 x。实时渲染只给看得见的行加装饰，
 * 不在可见范围里的行先滚过去
 */
const MEASURE = `const v = view();
  const PREFIX = /^[ \\t>]*(?:(?:[-*+]|\\d+[.)])(?:[ \\t]+\\[[ xX]\\])?[ \\t]*(?:[-*+] )?(?:> ?)?(?:#{1,6} )?)?/;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const out = {};
  for (let n = 1; n <= v.state.doc.lines; n++) {
    const line = v.state.doc.line(n);
    const start = line.from + PREFIX.exec(line.text)[0].length;
    if (start >= line.to) continue;
    const block = v.lineBlockAt(line.from);
    const scrolled = v.scrollDOM.scrollTop;
    const shown = v.coordsAtPos(line.to, -1) && block.top >= scrolled && Math.min(block.bottom, block.top + 100) <= scrolled + v.scrollDOM.clientHeight;
    if (!shown) {
      v.scrollDOM.scrollTop = block.top - 20;
      await frame();
    }
    const c = v.coordsAtPos(start, 1);
    const rows = [];
    let top = c.top;
    for (let p = start + 1; p < line.to; p++) {
      const q = v.coordsAtPos(p, 1);
      if (q.top > top + 2) { rows.push(q.left); top = q.top; }
    }
    // 引用竖线的位置：画在行首（左边框），或"- > 引用"第一行画在列表符号那一格后面（背景）
    const at = v.domAtPos(line.from).node;
    const el = (at.nodeType === 3 ? at.parentElement : at).closest(".cm-line");
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect().left;
    const bar = cs.borderLeftStyle !== "none" && parseFloat(cs.borderLeftWidth) ? box : cs.backgroundImage !== "none" ? box + parseFloat(cs.backgroundPositionX) : null;
    out[n] = { left: c.left, rows, bar, lineLeft: v.coordsAtPos(line.from, 1).left, text: line.text.slice(0, 12) };
  }
  return { lines: out, fs: parseFloat(getComputedStyle(v.contentDOM).fontSize) };`;

/**
 * 页面里：第 n 行是不是显示着原文（rendered 这些换成了符号 / 序号 / 复选框的都不在）；编辑器没拿到焦点时全都渲染，量了也不算数。
 * 有序任务光标碰到任务框时只有任务框显示原文，序号照样是一块
 */
const SHOWS_RAW = (n, rendered = ".cm-md-li-bullet, .cm-md-li-num, .cm-md-task") => `const v = view(); const line = v.state.doc.line(${n});
  const at = v.domAtPos(line.from).node;
  const el = (at.nodeType === 3 ? at.parentElement : at).closest(".cm-line");
  return !!el && !el.querySelector(${JSON.stringify(rendered)})`;

/** 页面里：光标所在的行，行首的列表符号 / 引用标记那一块在哪里、里面是什么字，光标在哪里，拼音（zhong…）从哪里开始 */
const CARET_LINE = `const v = view(); const line = v.state.doc.lineAt(v.state.selection.main.head);
  const at = v.domAtPos(line.from).node;
  const el = (at.nodeType === 3 ? at.parentElement : at).closest(".cm-line");
  const mark = el.querySelector(".cm-md-li-num, .cm-md-li-mark, .cm-md-li-bullet, .cm-md-quote-mark, .cm-md-li-qgap");
  let pinyin = null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.textContent.indexOf("zhong");
    if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); pinyin = r.getBoundingClientRect().left; break; }
  }
  return { text: line.text, mark: mark && mark.getBoundingClientRect().left, markText: mark ? mark.textContent : "",
    caret: v.coordsAtPos(v.state.selection.main.head, 1).left, pinyin };`;

/** 在光标处用输入法打 zhongwen（还没上屏）再上屏成「中文」，记下前、中、后三次的 CARET_LINE */
async function composeAtCursor(m, t) {
  const before = await m.ev(CARET_LINE);
  await m.send("Input.imeSetComposition", { text: "zhongwen", selectionStart: 8, selectionEnd: 8 });
  await t.sleep(150);
  const during = await m.ev(CARET_LINE);
  await m.send("Input.insertText", { text: "中文" });
  await t.sleep(200);
  return { before, during, after: await m.ev(CARET_LINE) };
}

export default async function (t) {
  const { main: m, check } = t;
  await m.viewport(1000, 760);
  await m.enter("工作");
  await m.ev(`return await openTodo("工作", "需求", "A")`);
  await m.ev(`const v = view(); v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(DOC)} } });
    v.contentDOM.blur(); await sleep(300); return 1`);
  const lineNo = (prefix) => DOC.split("\n").findIndex((l) => l.startsWith(prefix)) + 1;
  const L = {
    para: lineNo("段落"),
    one: lineNo("- 第一级，"),
    two: lineNo("  - 第二级"),
    cont: lineNo("    续行"),
    three: lineNo("    - 第三级"),
    n1: lineNo("1. 第1项"),
    n9: lineNo("9. "),
    n10: lineNo("10. "),
    task: lineNo("- [ ] 任务"),
    bullet: lineNo("- 普通项"),
    subTask: lineNo("  - [x]"),
    subBullet: lineNo("  - 嵌套的普通项"),
    oTask: lineNo("1. [ ]"),
    q1: lineNo("> - 引用里，"),
    q2: lineNo(">   - 引用里第二级"),
    para2: lineNo("  列表项里的第二段"),
    qItem: lineNo("- > 项里的引用"),
    qItem2: lineNo("  > 引用第二行"),
    n98: lineNo("98. "),
    n100: lineNo("100. "),
    nested: lineNo("- - 同一行"),
    nestedCont: lineNo("    子项的续行"),
    h9: lineNo("9. 第九"),
    h10: lineNo("10. # 标题项"),
  };
  const WRAPPED = ["one", "two", "cont", "three", "n10", "task", "subTask", "oTask", "q1", "q2", "para2", "qItem", "qItem2", "n100", "nested"];
  const near = (a, b) => Math.abs(a - b) <= 1;
  const misaligned = (r) =>
    WRAPPED.map((k) => ({ k, ...r.lines[L[k]] })).filter((x) => !x.rows.length || x.rows.some((y) => !near(y, x.left)));

  // 实时渲染
  let r = await m.ev(MEASURE);
  const x = (k) => r.lines[L[k]].left;
  check(
    "每一级列表缩进约两个字宽（同 Typora），第一级的正文离段落开头也是这么宽",
    near(x("one") - x("para"), 2 * r.fs) && near(x("two") - x("one"), 2 * r.fs) && near(x("three") - x("two"), 2 * r.fs),
    { fs: r.fs, para: x("para"), one: x("one"), two: x("two"), three: x("three") },
  );
  let bad = misaligned(r);
  check("一项太长折行后，折下来的行和第一行的正文开头对齐（中文、英文、几级嵌套、两位数序号、任务、有序任务、引用里、续行、第二段）", !bad.length, bad);
  check("缩进到正文的续行、列表项里的第二段对齐到这一项的正文", near(x("cont"), x("two")) && near(x("para2"), x("one")));
  check("两位数的序号和一位数的正文对齐", near(x("n1"), x("n10")) && near(x("n9"), x("n10")) && near(x("n1"), x("one")));
  check("任务框占列表符号那一格：任务和普通项的正文对齐", near(x("task"), x("bullet")) && near(x("subTask"), x("subBullet")));
  check("有序列表里的任务：正文在序号、任务框后面", x("oTask") > x("n1") + r.fs);
  check("引用里的列表照样一级一级缩进", near(x("q2") - x("q1"), 2 * r.fs) && x("q1") > x("one"));
  const bar = (k) => r.lines[L[k]].bar;
  check(
    "内容从引用开始的列表项（- > 引用）：第一行的引用竖线在列表符号后面，和下一行的竖线接上，两行的文字对齐",
    bar("qItem") !== null && near(bar("qItem"), bar("qItem2")) && bar("qItem") > r.lines[L.qItem].lineLeft + r.fs && near(x("qItem"), x("qItem2")),
    { line1: r.lines[L.qItem], line2: r.lines[L.qItem2] },
  );
  check("有三位数的序号时整个列表的那一格一起加宽：正文对齐", near(x("n98"), x("n100")) && x("n100") > x("one"), { n98: x("n98"), n100: x("n100") });
  check("同一行里套着子项（- - 甲）：正文和子项的续行对齐", near(x("nested"), x("nestedCont")) && near(x("nested") - x("one"), 2 * r.fs));
  check("列表项本身是标题（10. # 标题）时，正文和同一列表的别的项对齐", near(x("h10"), x("h9")));

  // 光标碰到列表符号时显示原文，正文不动
  const before = r;
  const moved = [];
  for (const k of ["one", "two", "three", "n10", "task", "subTask", "oTask", "n100", "qItem"]) {
    // 光标放在正文开头，再真的按一下 ← 进到列表符号（有序列表里的任务是进到任务框）里：
    // 只在页面里设光标时，WebView2 上编辑器不一定算拿到了焦点，就不显示原文
    await m.ev(`const v = view(); v.focus(); const line = v.state.doc.line(${L[k]});
      const at = /^[ \\t>]*(?:(?:[-*+]|\\d+[.)])(?:[ \\t]+\\[[ xX]\\])?[ \\t]*)?/.exec(line.text)[0].length;
      v.dispatch({ selection: { anchor: line.from + at } }); return 1`);
    await m.press("ArrowLeft");
    await t.sleep(80);
    // 先看显示原文没有：MEASURE 会把别的行滚进来，这一行滚出可见范围后就不加装饰了
    const raw = await m.ev(SHOWS_RAW(L[k], k === "oTask" ? ".cm-md-task" : undefined));
    const now = (await m.ev(MEASURE)).lines[L[k]];
    if (!raw || !near(now.left, before.lines[L[k]].left)) moved.push({ k, raw, before: before.lines[L[k]].left, now: now.left });
  }
  check("光标放到列表符号、任务框上（显示原文）时，这一行的正文不左右跳", !moved.length, moved);
  await m.ev(`view().focus(); return 1`);
  await m.press("Ctrl+A");
  await t.sleep(200);
  check(
    "全选时列表符号、序号、任务框都显示原文",
    !(await m.ev(`return document.querySelectorAll(".cm-content .cm-md-li-bullet, .cm-content .cm-md-li-num, .cm-content .cm-md-task").length`)),
  );
  r = await m.ev(MEASURE);
  // 引用的 > 显示原文时还占着文字的位置；标题显示出 # 本来就会挪
  bad = Object.keys(before.lines)
    .filter((n) => !/^\s*>|# /.test(before.lines[n].text) && !near(r.lines[n].left, before.lines[n].left))
    .map((n) => ({ n, before: before.lines[n], now: r.lines[n] }));
  check("全选（全部显示原文）时引用以外的正文都不动", !bad.length, bad);

  // ← 经过列表符号，跳过藏起来的缩进，到上一行
  const head = () => m.ev(`const v = view(); const h = v.state.selection.main.head; const line = v.state.doc.lineAt(h); return [line.number, h - line.from]`);
  await m.ev(`const v = view(); v.focus(); const line = v.state.doc.line(${L.three}); v.dispatch({ selection: { anchor: line.from + 6 } }); return 1`);
  const steps = [];
  for (let i = 0; i < 3; i++) {
    await m.press("ArrowLeft");
    steps.push(await head());
  }
  const prevEnd = DOC.split("\n")[L.three - 2].length;
  check(
    "在下一级列表项的正文开头按 ←：经过列表符号，再按就到上一行末尾，不停在藏起来的缩进前面",
    JSON.stringify(steps) === JSON.stringify([[L.three, 5], [L.three, 4], [L.three - 1, prevEnd]]),
    steps,
  );
  await m.press("ArrowRight");
  const right = await head();
  await m.press("End");
  await m.press("Home");
  await m.press("Home");
  const home = await head();
  check("→ 从上一行末尾进来、Home 按两下，都停在列表符号前面（不停在缩进前面）", right[1] === 4 && home[1] === 4, { right, home });
  const typed = await m.ev(`const v = view(); return v.state.doc.toString() === ${JSON.stringify(DOC)}`);

  // 大字号
  await m.ev(`document.documentElement.style.setProperty("--fs-editor", "32px"); view().contentDOM.blur(); await sleep(400); return 1`);
  r = await m.ev(MEASURE);
  bad = misaligned(r);
  check(
    "编辑区字号 32px 时同样对齐，每级缩进跟着字号变宽",
    r.fs === 32 && !bad.length && near(x("two") - x("one"), 64),
    { fs: r.fs, bad, one: x("one"), two: x("two") },
  );
  await m.ev(`document.documentElement.style.removeProperty("--fs-editor"); await sleep(300); return 1`);

  // 只改显示
  await m.ev(`view().focus(); return 1`);
  await m.press("Ctrl+S");
  await t.until(() => t.read("工作/需求/A.md") === DOC);
  check("只改显示：正文按原样保存，行首的空格一个不少", typed && t.read("工作/需求/A.md") === DOC);

  // 输入法：在有序列表项的正文开头打拼音（这里是回车续出来的空项），序号不动、拼音不跑进序号那一格
  await m.ev(`const v = view(); v.focus(); v.dispatch({ selection: { anchor: v.state.doc.line(${L.h9}).to } }); return 1`);
  await m.press("End");
  await m.press("Enter");
  await t.sleep(150);
  const ime = await composeAtCursor(m, t);
  check(
    "在有序列表项的正文开头用输入法打字：序号不动，拼音从正文开头开始，上屏后正文是打的字",
    ime.before.mark && near(ime.during.mark, ime.before.mark) && near(ime.during.pinyin, ime.before.caret) && !/zhong/.test(ime.during.markText) && /^10\. 中文$/.test(ime.after.text),
    ime,
  );
  await m.viewport();
}
