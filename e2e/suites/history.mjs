// 完成记录：首页头部和侧栏底部的入口，按完成日期（本地时间）分组、组里按完成时间倒序，时间范围（记在本机）、
// 没有完成时间的放在「完成时间不详」，优先级的小旗子和标签（同侧栏），查找（含标签、#标签名）、统计和按天的柱状图，
// 点一条进入工作区打开它，标记为未完成，在工作区里默认看选中的工作区、可以切到全部，开着时数据变了跟着更新，回收站里的不算。
// 多级子项目：五级深的项目里的也列出来，位置中间折叠、悬停看完整的，按折叠掉的那一级也查得到，点它时各级父项目都展开，
// 标记为未完成后各级项目的未完成数跟着变；分屏：两边开着的都变成未完成，点一条开在有焦点的那一边（另一边开着它时也是）

export const title = "完成记录";

const WEEK = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
/** 本地时间 daysAgo 天前的 h:mi（测试版和这里在同一台机器上，时区一样） */
const localTime = (daysAgo, h, mi = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, mi, 0, 0);
  return d.getTime();
};
/** 组名：今天、昨天以前的写「10月7日 星期三」，不是今年的带年份 */
const dayName = (ms) => {
  const d = new Date(ms);
  const year = d.getFullYear() === new Date().getFullYear() ? "" : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
};
/** 五级深的项目（连同工作区六级）：行上的位置中间折叠成「工作 / 深 / … / 四 / 五」 */
const DEEP = "深/二/三/四/五";

/** 离半夜 12 点不到这么久时先等过了半夜再跑：「今天」「昨天」、最近 7 天的范围在跑的中途换了的话，分组和条数都对不上 */
const MIDNIGHT_MARGIN = 5 * 60_000;

export default async function (t) {
  const { main: m, check } = t;
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  const toMidnight = midnight.getTime() - Date.now();
  if (toMidnight < MIDNIGHT_MARGIN) {
    console.log(`  … 离半夜 12 点不到 ${Math.ceil(toMidnight / 1000)} 秒，等过了半夜再跑`);
    await t.sleep(toMidnight + 15_000);
  }
  await m.viewport(1200, 900);

  // 测试数据：A 刚完成，接口里没有标题的一条刚完成，B 昨天 21:30，五级深的项目里的「深处的」2 天前 10:00，D 3 天前 9:15，
  // E 10 天前（不在最近 7 天里），GBK笔记是以前的版本留下的、没有完成时间的；C 没完成
  const setDoneAt = (ws, p, id, doneAt) => {
    const rel = `${ws}/${p}/.todos.json`;
    const meta = JSON.parse(t.read(rel));
    const x = meta.todos.find((y) => y.id === id);
    if (doneAt === null) delete x.doneAt;
    else x.doneAt = doneAt;
    t.write(rel, JSON.stringify(meta, null, 2));
  };
  for (const [ws, p, id] of [["工作", "需求", "B"], ["工作", "日常", "D"], ["生活", "杂事", "E"], ["生活", "购物", "GBK笔记"], ["工作", "需求", "A"]])
    await m.invoke("set_todo_done", { workspace: ws, project: p, id, done: true });
  await m.invoke("create_project", { workspace: "工作", name: "接口", parent: "需求" });
  const sub = await m.invoke("create_todo", { workspace: "工作", project: "需求/接口", title: "", content: "联调支付接口的细节" });
  await m.invoke("set_todo_done", { workspace: "工作", project: "需求/接口", id: sub.id, done: true });
  let parent = null;
  for (const name of DEEP.split("/")) {
    await m.invoke("create_project", { workspace: "工作", name, parent });
    parent = parent ? `${parent}/${name}` : name;
  }
  const deep = await m.invoke("create_todo", { workspace: "工作", project: DEEP, title: "深处的", content: "" });
  await m.invoke("set_todo_done", { workspace: "工作", project: DEEP, id: deep.id, done: true });
  const bAt = localTime(1, 21, 30);
  const deepAt = localTime(2, 10, 0);
  const dAt = localTime(3, 9, 15);
  const eAt = localTime(10, 8, 0);
  setDoneAt("工作", "需求", "B", bAt);
  setDoneAt("工作", DEEP, deep.id, deepAt);
  setDoneAt("工作", "日常", "D", dAt);
  setDoneAt("生活", "杂事", "E", eAt);
  setDoneAt("生活", "购物", "GBK笔记", null);
  // B 有标签和优先级（改它们不算修改，完成时间也不动）
  await m.invoke("set_todo_tags", { workspace: "工作", project: "需求", id: "B", tags: ["工作", "等回复"] });
  await m.invoke("set_todo_priority", { workspace: "工作", project: "需求", id: "B", priority: 3 });
  await m.emit("tauri://focus");
  await t.sleep(500);

  /** 打开完成记录，等列表读出来、对话框弹出来的动画做完（位置不再变，右键时按行的位置点） */
  const openHistory = (where) =>
    m.ev(`${where === "home" ? `button("完成记录").click()` : `document.querySelector(".sidebar-history").click()`};
      if (!(await waitFor(() => document.querySelector(".history-stats")))) return false;
      let last = "";
      await waitFor(() => {
        const r = JSON.stringify(document.querySelector(".ant-modal")?.getBoundingClientRect());
        const same = r === last;
        last = r;
        return same;
      });
      return true;`);
  const groups = () =>
    m.ev(`return [...document.querySelectorAll(".history-group")].map((g) => ({
      day: g.querySelector(".history-day-name").textContent,
      count: g.querySelector(".history-day .muted").textContent,
      rows: [...g.querySelectorAll(".history-row")].map((r) => ({
        title: r.querySelector(".list-title-text").textContent,
        fromContent: r.querySelector(".list-title").classList.contains("from-content"),
        flag: r.querySelector(".list-title > .prio-flag")?.getAttribute("class") ?? "",
        tags: [...r.querySelectorAll(".list-title .tag-chip")].map((c) => ({ name: c.textContent, cls: c.className })),
        place: r.querySelector(".list-path").textContent,
        placeTitle: r.querySelector(".list-path").title,
        time: r.querySelector(".history-time").textContent,
      })),
    }))`);
  const titles = async () => (await groups()).flatMap((g) => g.rows.map((r) => r.title));
  /** 换时间范围、看哪些工作区，等新的读回来（读回来之前统计上标着 aria-busy） */
  const pick = (box, text) =>
    m.ev(`[...document.querySelectorAll(".${box} .ant-segmented-item")].find((e) => e.textContent.includes(${JSON.stringify(text)})).click();
      await sleep(100);
      if (!(await waitFor(() => document.querySelector(".history-stats[aria-busy='false']"), 10000))) throw new Error("换了以后没有读回来");
      await sleep(200); return 1`);
  const picked = (box) => m.ev(`return document.querySelector(".${box} .ant-segmented-item-selected")?.textContent`);
  const stats = () =>
    m.ev(`return Object.fromEntries([...document.querySelectorAll(".history-stat")].map((s) =>
      [s.querySelector(".stat-label").textContent, Number(s.querySelector(".stat-value").textContent)]))`);
  const bars = () => m.ev(`return [...document.querySelectorAll(".history-slot")].map((b) => Number(b.dataset.count))`);
  const search = (kw) => m.ev(`setInput(document.querySelector(".history-search input"), ${JSON.stringify(kw)}); await sleep(300); return 1`);
  const rowOf = (title) => `[...document.querySelectorAll(".history-row")].find((r) => r.querySelector(".list-title-text").textContent === ${JSON.stringify(title)})`;
  /**
   * 点完成记录里的一条（等它列出来）：完成记录关掉，进入它所在的工作区打开它。等对话框关掉的动画做完（还在淡出的遮罩
   * 会挡住接下来的鼠标点击）
   */
  const clickRow = (title) =>
    m.ev(`const r = await waitFor(() => ${rowOf(title)}); if (!r) throw new Error("完成记录里没有「" + ${JSON.stringify(title)} + "」");
      r.click();
      await waitFor(() => ![...document.querySelectorAll(".ant-modal-wrap")].some((w) => w.getClientRects().length > 0));
      await sleep(300); return 1`);
  /** 行上的按钮「标记为未完成」，等它从列表里去掉 */
  const undoRow = (title) =>
    m.ev(`const r = await waitFor(() => ${rowOf(title)}); if (!r) throw new Error("完成记录里没有「" + ${JSON.stringify(title)} + "」");
      r.querySelector(".history-undo").click(); await waitFor(() => !(${rowOf(title)})); await sleep(300); return 1`);
  /** 右侧各边正显示着的标签（[id, 是不是预览]）、标题是不是已完成的样子（没有编辑区的是 null），有焦点的是第几边 */
  const sides = () =>
    m.ev(`const gs = [...document.querySelectorAll(".editor-group")];
      return {
        tabs: gs.map((g) => { const e = g.querySelector(".editor-tab.active"); return e ? [JSON.parse(e.dataset.tab)[2], e.classList.contains("preview")] : null; }),
        done: gs.map((g) => { const e = g.querySelector(".editor-title"); return e ? e.classList.contains("done") : null; }),
        focused: gs.findIndex((g) => g.classList.contains("focused")),
      }`);

  // 首页的「完成记录」：默认最近 7 天
  check("首页头部有「完成记录」，打开后默认是最近 7 天", (await openHistory("home")) && (await picked("history-range")) === "最近 7 天");
  let g = await groups();
  check(
    "按完成日期分组，最近的在前：今天、昨天、再往前写日期和星期，组名后面写几条",
    g.map((x) => `${x.day} ${x.count}`).join("，") === `今天 2 条，昨天 1 条，${dayName(deepAt)} 1 条，${dayName(dAt)} 1 条`,
    g.map((x) => `${x.day} ${x.count}`),
  );
  check("组里按完成时间倒序（后完成的在前）", g[0]?.rows.map((r) => r.title).join() === "联调支付接口的细节,A", g[0]?.rows);
  const b = g[1]?.rows[0];
  check("每条显示标题、「工作区 / 项目」和完成的几点几分", b?.title === "B" && b.place === "工作 / 需求" && b.time === "21:30", b);
  // 标签的颜色和侧栏、项目概览用同一个规则（tags.ts 的 tagClass）
  const tagClasses = await m.ev(`const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/tags.ts")) ?? "/src/tags.ts";
    const { tagClass } = await import(url); return ["工作", "等回复"].map((x) => tagClass(x))`);
  check(
    "有优先级的标题前面是小旗子（高是红的），后面是标签，颜色同侧栏",
    (b?.flag ?? "").split(" ").includes("prio-3") && JSON.stringify(b?.tags.map((x) => x.name)) === JSON.stringify(["工作", "等回复"]) &&
      b.tags.every((x, i) => x.cls.split(" ").filter((c) => c.startsWith("tag-")).join(" ") === tagClasses[i]),
    { b, tagClasses },
  );
  check("没有优先级、标签的没有小旗子和标签", g[0]?.rows.every((r) => !r.flag && r.tags.length === 0), g[0]?.rows);
  const s0 = g[0]?.rows[0];
  check("没有标题的显示正文开头，子项目写成「工作区 / 父项目 / 子项目」", s0?.fromContent && s0.place === "工作 / 需求 / 接口", s0);
  const d0 = g[2]?.rows[0];
  check(
    "五级深的项目里完成的也列出来：位置中间折叠成「…」，悬停看完整的路径",
    d0?.title === "深处的" && d0.place === "工作 / 深 / … / 四 / 五" && d0.placeTitle === "工作 / 深 / 二 / 三 / 四 / 五" && d0.time === "10:00",
    d0,
  );
  check("10 天前完成的、没有完成时间的不在最近 7 天里", !(await titles()).includes("E") && !(await titles()).includes("GBK笔记"), await titles());
  let st = await stats();
  check("统计：今天完成几条、最近 7 天一共几条", st["今天完成"] === 2 && st["最近 7 天完成"] === 5, st);
  check("柱状图：每天一根，最后一根是今天", (await bars()).join() === "0,0,0,1,1,1,2", await bars());
  await m.mouse("mouseMoved", await m.at(".history-slot:last-child"));
  const tip = await t.until(() => m.ev(`return document.querySelector(".ant-tooltip:not(.ant-tooltip-hidden) .history-bar-tip")?.textContent`));
  check("悬停柱子显示条数和日期", tip === "2 条今天", tip);

  await pick("history-range", "最近 30 天");
  g = await groups();
  check("最近 30 天：10 天前完成的也列出来，30 根柱子", g.some((x) => x.day === dayName(eAt) && x.rows[0]?.title === "E") && (await bars()).length === 30, g.map((x) => x.day));
  await pick("history-range", "全部");
  g = await groups();
  check("「全部」：没有完成时间的在最后的「完成时间不详」一组", g.at(-1)?.day === "完成时间不详" && g.at(-1).rows.map((r) => r.title).join() === "GBK笔记", g.map((x) => x.day));
  st = await stats();
  check("「全部」时不画柱状图，统计是一共几条", !(await m.ev(`return !!document.querySelector(".history-chart")`)) && st["一共完成"] === 7, st);

  // 查找：按标题、所在的工作区 / 各级项目，不区分大小写；统计跟着
  await search("日常");
  check("按项目查找", (await titles()).join() === "D", await titles());
  await search("三");
  check("按项目路径里折叠掉的那一级也查得到", (await titles()).join() === "深处的", await titles());
  await search("gbk");
  check("按标题查找，不区分大小写；统计按查找后的算", (await titles()).join() === "GBK笔记" && (await stats())["一共完成"] === 1, await titles());
  await search("没有这个");
  check("找不到时说明", (await m.ev(`return document.querySelector(".history-empty")?.textContent`)) === "没有找到包含“没有这个”的");
  // 标签：名字里有关键字的也算（命中的标签高亮）；#标签名 只按标签找，同侧栏的搜索
  await search("等回");
  const hit = await m.ev(`return [...document.querySelectorAll(".history-row .tag-chip.hit")].map((c) => c.textContent)`);
  check("按标签名查找，命中的标签高亮", (await titles()).join() === "B" && hit.join() === "等回复", { titles: await titles(), hit });
  await search("#工作");
  check("#标签名 只按标签找：不看标题、项目名（「工作」工作区里别的没有这个标签）", (await titles()).join() === "B", await titles());
  await search("#");
  check("只输入 # 时列出有标签的", (await titles()).join() === "B", await titles());
  await search("#没有");
  check("按标签找不到时说明", (await m.ev(`return document.querySelector(".history-empty")?.textContent`)) === "没有找到带标签「没有」的");
  await search("");

  // 时间范围记在本机：关掉再开、重新加载页面后还是「全部」
  await m.closeModal();
  await openHistory("home");
  const kept = await picked("history-range");
  await m.closeModal();
  await m.reload();
  await openHistory("home");
  check("时间范围记在本机（关掉再开、重新加载后还在）", kept === "全部" && (await picked("history-range")) === "全部", kept);

  // 右键「标记为未完成」：从列表里去掉，首页的卡片跟着更新
  await m.clearToasts();
  await m.click(await m.ev(`const r = ${rowOf("D")}; r.scrollIntoView({ block: "nearest" }); const x = r.getBoundingClientRect();
    return { x: Math.round(x.left + 60), y: Math.round(x.top + x.height / 2) }`), { right: true });
  // 右键菜单弹出来要一会儿，CI 上忙的时候 300ms 不一定够
  await m.ev(`const it = await waitFor(() => menuItem("标记为未完成")); if (!it) throw new Error("右键菜单里没有「标记为未完成」");
    it.click(); await waitFor(() => !(${rowOf("D")}) && document.querySelector(".ant-message-notice")); await sleep(200); return 1`);
  const dMeta = t.meta("工作", "日常").find((x) => x.id === "D");
  check("右键「标记为未完成」：从列表里去掉，.todos.json 里改成未完成",
    !(await titles()).includes("D") && dMeta.done === false && !dMeta.doneAt && /「D」已标记为未完成/.test(await m.toast()), dMeta);
  await m.closeModal();
  // 工作区「工作」里一共 7 条（各级子项目里的都算），完成了 A、B、接口里的、深处的
  const card = await t.until(() =>
    m.ev(`const c = [...document.querySelectorAll(".ws-card")].find((x) => x.textContent.includes("工作"))?.querySelector(".card-foot").textContent;
      return c?.includes("已完成 4 / 7") ? c : null`),
  );
  check("首页的卡片跟着更新", !!card, await m.ev(`return [...document.querySelectorAll(".ws-card .card-foot")].map((c) => c.textContent)`));

  // 点一条：关掉完成记录，进入它所在的工作区打开它
  await openHistory("home");
  await clickRow("E");
  const opened = await t.until(() => m.ev(`return document.querySelector(".editor-title")?.value === "E" && !!row("生活", "杂事", "E")?.classList.contains("selected")`));
  check("点一条：关掉完成记录，进入它所在的工作区打开这条待办，左侧选中它",
    opened && !(await m.ev(`return !!document.querySelector(".history-stats")`)));
  const tab = await m.ev(`const e = document.querySelector(".editor-tab.active"); return e && { id: JSON.parse(e.dataset.tab)[2], preview: e.classList.contains("preview") }`);
  check("打开在预览标签里（同首页的搜索结果）", tab?.id === "E" && tab.preview, tab);

  // 侧栏底部的「完成记录」：默认看侧栏里选中显示的工作区，可以切到全部工作区
  await openHistory("sidebar");
  check("侧栏底部有「完成记录」，默认看选中的工作区", (await picked("history-scope")) === "生活" && (await titles()).join() === "E,GBK笔记", await titles());
  // 对话框开着时应用内快捷键不响应：Ctrl+N 不在后面的项目里新建待办，Ctrl+W 不关标签，「标记完成 / 未完成」不改后面打开着的 E，
  // 分屏的快捷键不把后面的编辑区分成两边
  const todosBefore = t.meta("生活", "杂事").length;
  for (const key of ["Ctrl+N", "Ctrl+W", "Ctrl+Alt+D", "Alt+Shift+="]) await m.press(key);
  await t.sleep(800);
  const behind = await m.ev(`const e = document.querySelector(".editor-tab.active");
    return { tab: e && JSON.parse(e.dataset.tab)[2], title: document.querySelector(".editor-title")?.value, open: !!document.querySelector(".history-stats"),
      groups: document.querySelectorAll(".editor-group").length }`);
  check(
    "完成记录开着时 Ctrl+N、Ctrl+W、「标记完成 / 未完成」、分屏（Alt+Shift+=）的快捷键不响应",
    t.meta("生活", "杂事").length === todosBefore &&
      t.meta("生活", "杂事").find((x) => x.id === "E")?.done &&
      behind.tab === "E" &&
      behind.title === "E" &&
      behind.open &&
      behind.groups === 1,
    { behind, todos: t.meta("生活", "杂事").map((x) => [x.id, x.done]) },
  );
  await pick("history-scope", "全部工作区");
  check("切到「全部工作区」", (await titles()).includes("A") && (await titles()).includes("B"), await titles());

  // 开着时数据变了跟着更新：外部标记完成后窗口重新获得焦点、删除进回收站的不算
  await m.invoke("set_todo_done", { workspace: "工作", project: "需求", id: "C", done: true });
  await m.invoke("delete_todo", { workspace: "工作", project: "需求", id: "A" });
  await m.emit("tauri://focus");
  const updated = await t.until(async () => {
    const list = await titles();
    return list.includes("C") && !list.includes("A") ? list : null;
  });
  check("开着时数据变了跟着更新（刚完成的出现，删除进回收站的去掉）", !!updated, await titles());

  // 点别的工作区的一条：选中那个工作区、展开分支，打开它
  await clickRow("B");
  const inWork = await t.until(() => m.ev(`return document.querySelector(".editor-title")?.value === "B" && !!row("工作", "需求", "B")?.classList.contains("selected")`));
  check("点没选中的工作区里的一条：选中那个工作区，展开它所在的分支，打开它", inWork && (await m.ev(`return !!row("生活")`)));

  // 行上的按钮「标记为未完成」：侧栏跟着更新
  await openHistory("sidebar");
  await undoRow("B");
  const sideB = await m.ev(`const r = row("工作", "需求", "B"); return { done: r?.classList.contains("done"), checked: !!r?.querySelector(".check.checked") }`);
  check("行上的按钮「标记为未完成」：从列表里去掉，侧栏的勾选框跟着取消", !(await titles()).includes("B") && !sideB.done && !sideB.checked, sideB);
  check("编辑区里打开着的这条也变成未完成",
    !t.meta("工作", "需求").find((x) => x.id === "B").done && !(await m.ev(`return document.querySelector(".editor-title").classList.contains("done")`)));
  await m.closeModal();

  // 五级深的项目：先把中间的两级折叠起来，点完成记录里的一条时各级父项目都展开，打开它、左侧选中它
  await m.ev(`for (const p of ["深/二/三", "深"]) row("工作", p)?.querySelector(".chevron.open")?.click(); await sleep(300); return 1`);
  const folded = await m.ev(`return !row("工作", ${JSON.stringify(DEEP)}) && !row("工作", "深/二/三")`);
  await openHistory("sidebar");
  await clickRow("深处的");
  const deepOpened = await t.until(() =>
    m.ev(`return document.querySelector(".editor-title")?.value === "深处的" &&
      !!row("工作", ${JSON.stringify(DEEP)}, ${JSON.stringify(deep.id)})?.classList.contains("selected")`),
  );
  const chevrons = await m.ev(`const ps = ["深", "深/二", "深/二/三", "深/二/三/四", ${JSON.stringify(DEEP)}];
    return ps.map((p) => !!row("工作", p)?.querySelector(".chevron.open"))`);
  check("点五级深的项目里的一条：各级父项目都展开，打开它、左侧选中它", folded && deepOpened && chevrons.every(Boolean), { folded, chevrons });

  // 标记为未完成后各级项目的未完成数跟着变（顶层的「深」算上各级子项目里的）
  const countOf = (p) => m.ev(`const c = row("工作", ${JSON.stringify(p)})?.querySelector(".row-count"); return c && [c.textContent, c.title]`);
  const before = await countOf("深");
  await openHistory("sidebar");
  await undoRow("深处的");
  const after = await t.until(async () => {
    const c = await countOf("深");
    return c?.[0] === "1" ? c : null;
  });
  check(
    "标记为未完成后侧栏各级项目的未完成数跟着变",
    before?.[0] === "" && after?.[1] === "未完成 1 / 共 1（含子项目）" && (await countOf(DEEP))?.[0] === "1",
    { before, after },
  );
  await m.closeModal();

  // 分屏：两边都开着 C（已完成），在完成记录里标记为未完成，两边都变成未完成的样子
  await m.ev(`return await openTodo("工作", "需求", "C")`);
  await m.press("Alt+Shift+=");
  const split = await t.until(async () => {
    const s = await sides();
    return s.tabs.length === 2 && s.tabs.every((x) => x?.[0] === "C") && s.done.every((d) => d === true) ? s : null;
  });
  check("分屏：两边都开着 C，都是已完成的样子", !!split, await sides());
  await openHistory("sidebar");
  await undoRow("C");
  const both = await t.until(async () => {
    const s = await sides();
    return s.done.length === 2 && s.done.every((d) => d === false) ? s : null;
  });
  check("分屏时标记为未完成：两边的编辑区都变成未完成的样子", !!both && !t.meta("工作", "需求").find((x) => x.id === "C").done, await sides());

  // 点一条：开在有焦点的那一边（分屏后焦点在新的右边），打开在预览标签里，另一边不动
  await clickRow("联调支付接口的细节");
  const right = await t.until(async () => {
    const s = await sides();
    return s.tabs[1]?.[0] === sub.id ? s : null;
  });
  check(
    "分屏时点一条：开在有焦点的那一边的预览标签里，另一边不动",
    right?.focused === 1 && right.tabs[1][1] === true && right.tabs[0]?.[0] === "C",
    await sides(),
  );

  // 另一边已经开着它时也开在有焦点的这一边：焦点移到左边，再点同一条
  await m.click(
    await m.ev(`const r = document.querySelectorAll(".editor-group")[0].querySelector(".cm-scroller").getBoundingClientRect();
      return { x: Math.round(r.left + 40), y: Math.round(r.top + 20) }`),
  );
  const leftFocused = await t.until(async () => (await sides()).focused === 0);
  await openHistory("sidebar");
  await clickRow("联调支付接口的细节");
  const left = await t.until(async () => {
    const s = await sides();
    return s.tabs[0]?.[0] === sub.id ? s : null;
  });
  check(
    "另一边已经开着这条时也开在有焦点的这一边（两边都开着它）",
    leftFocused && left?.focused === 0 && left.tabs[1]?.[0] === sub.id,
    await sides(),
  );
  await m.ev(`if (document.querySelector(".history-stats")) document.querySelector(".ant-modal-close")?.click(); await sleep(300); return 1`);
}
