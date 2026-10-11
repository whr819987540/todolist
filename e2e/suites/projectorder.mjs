// 项目的顺序：在侧栏里把项目拖到另一个项目（哪一级的都行）那一行的上沿 / 下沿，放在它前面 / 后面（插入线、说明），
// 同一层是调整顺序、不在同一层是移过去放在那里（放进父项目、放进深处的子项目、从深处移出来、移到别的工作区）；
// 中间照常是放进去；有子项目的也能放到别的层，它里面各级子项目的顺序跟着它；那里有同名的放不下（标红）、放到它自己的
// 子项目旁边不算能放的地方；改成手动排序的提示；每一层记在那一层文件夹的 .projects.json；新建的排在后面、改名后位置不变、
// 删除后恢复的排在后面；搜索时不能调整；隐藏全部完成的项目时藏起来的也算在那一层里；排序按钮里换成按名称、再换回手动排序
// 时恢复，按名称时拖动从按名字的顺序重新排（别的各层留着的旧顺序去掉）；概览的卡片和「移动到」跟着；重新打开后还在；
// 外部改了 .projects.json（多深的都算）跟着刷新，手改坏了按名字排
import { readFileSync } from "node:fs";

export const title = "项目的顺序";

export default async function (t) {
  const { main: m, check } = t;
  // 项目、待办多，把视口设高一些，要拖到的行都在侧栏的可见区域里
  await m.viewport(1200, 1600);
  await m.enter("工作");

  const refresh = async () => {
    await m.emit("tauri://focus");
    await t.sleep(800);
  };
  /** 展开侧栏里折叠着的工作区、各级项目（展开一级后下一级的箭头才出来，展开几遍） */
  const expandDeep = async () => {
    for (let i = 0; i < 4; i++) await m.expandAll();
  };
  /** 侧栏里一个工作区的项目（路径），按显示的先后 */
  const shown = (ws = "工作") =>
    m.ev(`return [...document.querySelectorAll(".sidebar .project-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel))
      .filter((s) => s[0] === ${JSON.stringify(ws)}).map((s) => s[1])`);
  /** 等侧栏里的项目变成 expected 的样子；等不到时返回最后看到的 */
  const shownBecomes = async (expected, ws = "工作") =>
    // t.until 返回回调的值：对上时要返回列出的顺序本身，不是 true
    (await t.until(async () => {
      const now = await shown(ws);
      return now.join() === expected.join() && now;
    })) || (await shown(ws));
  /** 那一层的文件夹里记着的项目顺序（.projects.json），没有时是 null */
  const orderFile = (rel) => {
    try {
      return JSON.parse(readFileSync(t.file(`${rel}/.projects.json`), "utf8"));
    } catch {
      return null;
    }
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  /**
   * 拖动中：跟着指针的说明、画了插入线的项目（「路径:前面/后面[:标红]」）和插入线离左边多远、整块高亮的个数、
   * 指针是不是「不能放」
   */
  const dragInfo = () =>
    m.ev(`const lines = [...document.querySelectorAll(".project-branch.drop-before, .project-branch.drop-after")];
      return { hint: document.querySelector(".drag-ghost-hint")?.textContent ?? "",
      line: lines.map((b) =>
        JSON.parse(b.querySelector(".project-row").dataset.sel)[1] + ":" + (b.classList.contains("drop-before") ? "before" : "after")
        + (b.classList.contains("drop-line-refused") ? ":refused" : "")),
      left: lines.map((b) => parseFloat(getComputedStyle(b, b.classList.contains("drop-before") ? "::before" : "::after").left))[0] ?? -1,
      blocks: document.querySelectorAll(".drop-target, .drop-refused").length,
      nodrop: document.body.classList.contains("drag-nodrop") }`);
  /** 拖动中把指针移到 p，等说明里有 text；返回那时的样子（等不到时是最后看到的） */
  const hover = async (p, text) => {
    await m.mouse("mouseMoved", p, { button: "left", buttons: 1 });
    return (await t.until(async () => (await dragInfo()).hint.includes(text) && (await dragInfo()), 3000)) || (await dragInfo());
  };
  const edge = (sel, place) => m.at(sel, place === "before" ? -0.4 : 0.4);
  /** 把项目 from 拖到项目 to 那一行的上沿 / 下沿，等说明里有 text 时看一眼，松开；返回松开前的样子 */
  const dragBeside = async (from, to, place, text) => {
    const p = await edge(to, place);
    await m.drag(await m.at(from), p, { release: false });
    const d = await hover(p, text);
    await m.drop(p);
    return d;
  };
  const toastHas = (text) => t.until(async () => (await m.toast()).includes(text));
  /** 点排序按钮，在「项目顺序」一组里点 label 开头的那一项 */
  const projectSort = (label) =>
    m.ev(`document.querySelector(".sidebar-bar .anticon-sort-ascending").closest("button").click();
      const groups = await waitFor(() => [...document.querySelectorAll(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item-group")]
        .find((g) => g.querySelector(".ant-dropdown-menu-item-group-title")?.textContent.includes("项目顺序")));
      const item = [...groups.querySelectorAll(".ant-dropdown-menu-item")].find((e) => e.textContent.startsWith(${JSON.stringify(label)}));
      item.click(); await sleep(600); return 1`);
  const cards = () => m.ev(`return [...document.querySelectorAll(".overview .project-card .card-name")].map((e) => e.textContent)`);

  // 几个项目和各级子项目（同在软件里新建）
  for (const name of ["杂项", "备忘"]) await m.invoke("create_project", { workspace: "工作", name });
  for (const name of ["前端", "后端", "测试"]) await m.invoke("create_project", { workspace: "工作", name, parent: "需求" });
  for (const name of ["组件", "页面", "样式"]) await m.invoke("create_project", { workspace: "工作", name, parent: "需求/前端" });
  await refresh();
  await expandDeep();

  // 中文按拼音：备忘、日常、需求（测试、后端、前端（样式、页面、组件））、杂项
  const byName = ["备忘", "日常", "需求", "需求/测试", "需求/后端", "需求/前端", "需求/前端/样式", "需求/前端/页面", "需求/前端/组件", "杂项"];
  check("没调整过时按名字排，各级子项目跟在父项目后面", (await shownBecomes(byName)).join() === byName.join(), await shown());
  check("没调整过时没有 .projects.json", orderFile("工作") === null && orderFile("工作/需求") === null && orderFile("工作/需求/前端") === null);

  // 顶层项目拖到另一个项目那一行：中间是放进去，上沿 / 下沿是放在前面 / 后面
  await m.drag(await m.at(["工作", "杂项"]), await m.at(["工作", "日常"]), { release: false });
  let d = await hover(await m.at(["工作", "日常"]), "成为子项目");
  check("拖到另一个项目那一行的中间：同原来，放进去成为子项目（整块高亮，没有插入线）", d.hint.includes("放进「日常」，成为子项目") && d.blocks === 1 && !d.line.length, d);
  d = await hover(await edge(["工作", "日常"], "before"), "前面");
  check("拖到上沿：插入线画在它前面，说明「放在「日常」前面」，不整块高亮", d.hint === "放在「日常」前面" && d.line.join() === "日常:before" && !d.blocks && !d.nodrop, d);
  const topLeft = d.left;
  d = await hover(await edge(["工作", "日常"], "after"), "后面");
  check("拖到下沿：插入线画在它后面", d.hint === "放在「日常」后面" && d.line.join() === "日常:after", d);
  d = await hover(await edge(["工作", "需求"], "after"), "已在这个位置");
  check("放下后顺序不变的位置（它前一个的后面）：说明「已在这个位置」，不画插入线、放不下", d.hint === "已在这个位置" && !d.line.length && d.nodrop, d);
  await m.clearToasts();
  const beforeDaily = await edge(["工作", "日常"], "before");
  await hover(beforeDaily, "前面");
  await m.drop(beforeDaily);
  const manualOrder = ["备忘", "杂项", "日常", "需求", "需求/测试", "需求/后端", "需求/前端", "需求/前端/样式", "需求/前端/页面", "需求/前端/组件"];
  check("松开后放在了那里", (await shownBecomes(manualOrder)).join() === manualOrder.join(), await shown());
  check("没在手动排序时提示「项目已改为手动排序」", await toastHas("项目已改为手动排序"), await m.toast());
  check(
    "顺序记在工作区文件夹的 .projects.json 里，改成了手动排序",
    same(orderFile("工作"), { version: 1, manual: true, order: ["备忘", "杂项", "日常", "需求"] }),
    orderFile("工作"),
  );

  // 新建的排在后面、彼此按名字；改名后位置不变
  await m.invoke("create_project", { workspace: "工作", name: "零散" });
  await m.invoke("create_project", { workspace: "工作", name: "阿里" });
  await m.invoke("rename_project", { workspace: "工作", name: "日常", newName: "日常事务" });
  await refresh();
  const afterNew = ["备忘", "杂项", "日常事务", "需求", "需求/测试", "需求/后端", "需求/前端", "需求/前端/样式", "需求/前端/页面", "需求/前端/组件", "阿里", "零散"];
  check("新建的排在后面、彼此按名字；改名后位置不变", (await shownBecomes(afterNew)).join() === afterNew.join(), await shown());

  // 子项目之间调整顺序：记在父项目文件夹里，下面各级跟着它；已经在手动排序了，不再提示
  await m.clearToasts();
  d = await dragBeside(["工作", "需求/前端"], ["工作", "需求/测试"], "before", "前面");
  const afterSub = ["备忘", "杂项", "日常事务", "需求", "需求/前端", "需求/前端/样式", "需求/前端/页面", "需求/前端/组件", "需求/测试", "需求/后端", "阿里", "零散"];
  check("子项目之间调整顺序，它下面的子项目跟着它", d.hint === "放在「测试」前面" && (await shownBecomes(afterSub)).join() === afterSub.join(), {
    d,
    shown: await shown(),
  });
  check("子项目的顺序记在父项目文件夹的 .projects.json 里", same(orderFile("工作/需求")?.order, ["前端", "测试", "后端"]), orderFile("工作/需求"));
  check("已经在手动排序时不再提示", !(await m.toast()).includes("已改为手动排序"), await m.toast());

  // 深处一层（第 3 级）里调整顺序：插入线从那一级的缩进处画起
  d = await dragBeside(["工作", "需求/前端/组件"], ["工作", "需求/前端/样式"], "before", "前面");
  const afterDeep = ["备忘", "杂项", "日常事务", "需求", "需求/前端", "需求/前端/组件", "需求/前端/样式", "需求/前端/页面", "需求/测试", "需求/后端", "阿里", "零散"];
  check(
    "深处的子项目之间调整顺序：插入线比顶层的往右缩进",
    d.hint === "放在「样式」前面" && d.line.join() === "需求/前端/样式:before" && d.left > topLeft && (await shownBecomes(afterDeep)).join() === afterDeep.join(),
    { d, topLeft, shown: await shown() },
  );
  check("深处一层的顺序记在它的父项目文件夹里", same(orderFile("工作/需求/前端")?.order, ["组件", "样式", "页面"]), orderFile("工作/需求/前端"));

  // 顶层项目放到两个子项目之间：放进去、放在那里（插入线画在展开着的「前端」整块的下面）
  d = await dragBeside(["工作", "零散"], ["工作", "需求/前端"], "after", "后面");
  const intoParent = ["备忘", "杂项", "日常事务", "需求", "需求/前端", "需求/前端/组件", "需求/前端/样式", "需求/前端/页面", "需求/零散", "需求/测试", "需求/后端", "阿里"];
  check(
    "顶层项目拖到两个子项目之间：说明「放进「需求」，放在「前端」后面」，放进去、放在那里",
    d.hint === "放进「需求」，放在「前端」后面" && (await shownBecomes(intoParent)).join() === intoParent.join() && t.exists("工作/需求/零散"),
    { d, shown: await shown() },
  );
  check("新的那一层按放下的位置", same(orderFile("工作/需求")?.order, ["前端", "零散", "测试", "后端"]), orderFile("工作/需求"));

  // 顶层项目放进深处的一层（跨两级）
  d = await dragBeside(["工作", "阿里"], ["工作", "需求/前端/样式"], "before", "前面");
  const deepInto = ["备忘", "杂项", "日常事务", "需求", "需求/前端", "需求/前端/组件", "需求/前端/阿里", "需求/前端/样式", "需求/前端/页面", "需求/零散", "需求/测试", "需求/后端"];
  check(
    "顶层项目拖到深处两个子项目之间：说明「放进「需求 / 前端」，放在「样式」前面」，放进去、放在那里",
    d.hint === "放进「需求 / 前端」，放在「样式」前面" && (await shownBecomes(deepInto)).join() === deepInto.join() && t.exists("工作/需求/前端/阿里"),
    { d, shown: await shown() },
  );

  // 深处的子项目拖到两个顶层项目之间：移出来、放在那里
  d = await dragBeside(["工作", "需求/前端/组件"], ["工作", "备忘"], "after", "后面");
  const outOfDeep = ["备忘", "组件", "杂项", "日常事务", "需求", "需求/前端", "需求/前端/阿里", "需求/前端/样式", "需求/前端/页面", "需求/零散", "需求/测试", "需求/后端"];
  check(
    "深处的子项目拖到两个顶层项目之间：说明「移出来，放在「备忘」后面」，移出来、放在那里",
    d.hint === "移出来，放在「备忘」后面" && (await shownBecomes(outOfDeep)).join() === outOfDeep.join() && t.exists("工作/组件"),
    { d, shown: await shown() },
  );
  check(
    "原来那一层（深处的父项目里）的顺序去掉它，新的那一层按放下的位置",
    same(orderFile("工作/需求/前端")?.order, ["阿里", "样式", "页面"]) && same(orderFile("工作")?.order, ["备忘", "组件", "杂项", "日常事务", "需求"]),
    { sub: orderFile("工作/需求/前端"), top: orderFile("工作") },
  );

  // 有子项目的项目也能放到别的层：它里面子项目的顺序跟着它
  for (const name of ["x", "y"]) await m.invoke("create_project", { workspace: "工作", name, parent: "杂项" });
  await refresh();
  await expandDeep();
  await dragBeside(["工作", "杂项/y"], ["工作", "杂项/x"], "before", "前面");
  await t.until(async () => same(orderFile("工作/杂项")?.order, ["y", "x"]));
  d = await dragBeside(["工作", "杂项"], ["工作", "需求/前端/页面"], "after", "后面");
  const withSubs = [
    "备忘",
    "组件",
    "日常事务",
    "需求",
    "需求/前端",
    "需求/前端/阿里",
    "需求/前端/样式",
    "需求/前端/页面",
    "需求/前端/杂项",
    "需求/前端/杂项/y",
    "需求/前端/杂项/x",
    "需求/零散",
    "需求/测试",
    "需求/后端",
  ];
  check(
    "有子项目的项目拖到深处两个子项目之间：说明「放进「需求 / 前端」，放在「页面」后面」，连同子项目放进去",
    d.hint === "放进「需求 / 前端」，放在「页面」后面" &&
      (await shownBecomes(withSubs)).join() === withSubs.join() &&
      t.exists("工作/需求/前端/杂项/x") &&
      !t.exists("工作/杂项"),
    { d, shown: await shown() },
  );
  check("它里面子项目的顺序跟着它（.projects.json 跟着移过去）", same(orderFile("工作/需求/前端/杂项")?.order, ["y", "x"]), orderFile("工作/需求/前端/杂项"));

  // 放不下的：那一层有同名的（插入线标红、说明原因），放到它自己的子项目旁边（不算能放的地方，不画插入线）
  await m.invoke("create_project", { workspace: "工作", name: "备忘", parent: "日常事务" });
  await refresh();
  await expandDeep();
  const beforeRefused = await shown();
  d = await dragBeside(["工作", "备忘"], ["工作", "日常事务/备忘"], "before", "已有同名");
  check(
    "放到有同名项目的一层：插入线标红、说明原因，放不下",
    d.line.join() === "日常事务/备忘:before:refused" && d.hint.includes("已有同名") && d.nodrop && t.exists("工作/备忘"),
    d,
  );
  d = await dragBeside(["工作", "需求"], ["工作", "需求/前端/样式"], "before", "子项目");
  check(
    "放到它自己的子项目旁边：说明不能放进它自己的子项目里，不画插入线，放不下",
    d.hint.includes("不能放进它自己的子项目里") && !d.line.length && d.nodrop && t.exists("工作/需求"),
    d,
  );
  check("都没有动", (await shownBecomes(beforeRefused)).join() === beforeRefused.join(), await shown());

  // 删除后去掉，恢复的排在后面（顶层、深处都是）
  const rid1 = await m.invoke("delete_project", { workspace: "工作", name: "组件" });
  const rid2 = await m.invoke("delete_project", { workspace: "工作", name: "需求/前端/阿里" });
  check(
    "删除后那一层的顺序里去掉它",
    same(orderFile("工作")?.order, ["备忘", "日常事务", "需求"]) && same(orderFile("工作/需求/前端")?.order, ["样式", "页面", "杂项"]),
    { top: orderFile("工作"), deep: orderFile("工作/需求/前端") },
  );
  await m.invoke("restore_recycled", { ids: [rid1, rid2] });
  await refresh();
  await expandDeep();
  const manualNow = [
    "备忘",
    "日常事务",
    "日常事务/备忘",
    "需求",
    "需求/前端",
    "需求/前端/样式",
    "需求/前端/页面",
    "需求/前端/杂项",
    "需求/前端/杂项/y",
    "需求/前端/杂项/x",
    "需求/前端/阿里",
    "需求/零散",
    "需求/测试",
    "需求/后端",
    "组件",
  ];
  check("恢复的排在它那一层的后面", (await shownBecomes(manualNow)).join() === manualNow.join(), await shown());

  // 搜索时不能调整顺序；拖到中间照常移动（这里不放）
  await m.press("Ctrl+Shift+F");
  await m.type("待办");
  await t.until(async () => !(await shown()).includes("备忘"));
  d = await dragBeside(["工作", "日常事务"], ["工作", "需求"], "before", "不能调整顺序");
  check("搜索时拖到上沿 / 下沿：说明「搜索时不能调整顺序」，放不下", d.hint.includes("搜索时不能调整顺序") && d.nodrop && !d.line.length, d);
  await m.ev(`document.querySelector(".sidebar input").focus(); return 1`);
  await m.press("Escape");
  check("搜索时没有调整", (await shownBecomes(manualNow)).join() === manualNow.join(), await shown());

  // 概览的卡片、「移动到」跟着项目的顺序（哪一级都是）
  await m.ev(`row("工作").click(); await sleep(600); return 1`);
  const tops = manualNow.filter((p) => !p.includes("/"));
  check("工作区概览的项目卡片按项目的顺序", (await cards()).join() === tops.join(), { cards: await cards(), tops });
  await m.ev(`row("工作", "需求").click(); await sleep(600); return 1`);
  check("子项目卡片按项目的顺序", (await cards()).join() === "前端,零散,测试,后端", await cards());
  await m.ev(`row("工作", "需求/前端").click(); await sleep(600); return 1`);
  check("深处的子项目卡片也按项目的顺序", (await cards()).join() === "样式,页面,杂项,阿里", await cards());
  await m.click(await m.at(["工作", "需求", "A"]), { right: true });
  await t.sleep(300);
  const moveTitle = await m.ev(`const e = [...document.querySelectorAll(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-submenu-title")]
      .find((x) => x.textContent.includes("移动到"));
    const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }`);
  await m.mouse("mouseMoved", moveTitle);
  const moveItems = await t.until(() =>
    m.ev(`const items = [...document.querySelectorAll(".ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden) .ant-dropdown-menu-item")]
      .map((e) => e.textContent.trim()); return items.length ? items : null`),
  );
  await m.press("Escape");
  await m.press("Escape");
  const expectedMove = manualNow.filter((p) => p !== "需求").map((p) => p.split("/").join(" / "));
  check("待办的「移动到」按项目的顺序列出（各级子项目在各自那一层里）", (moveItems ?? []).join() === expectedMove.join(), { moveItems, expectedMove });

  // 重新打开后还在
  await m.reload();
  await m.enter("工作");
  await expandDeep();
  check("重新打开后顺序不变", (await shownBecomes(manualNow)).join() === manualNow.join(), await shown());

  // 排序按钮：换成按名称（顺序留着），再换回手动排序时恢复
  await projectSort("按名称");
  // 备忘、日常事务（备忘）、需求（测试、后端、零散、前端（阿里、样式、页面、杂项（x、y）））、组件
  const byName2 = [
    "备忘",
    "日常事务",
    "日常事务/备忘",
    "需求",
    "需求/测试",
    "需求/后端",
    "需求/零散",
    "需求/前端",
    "需求/前端/阿里",
    "需求/前端/样式",
    "需求/前端/页面",
    "需求/前端/杂项",
    "需求/前端/杂项/x",
    "需求/前端/杂项/y",
    "组件",
  ];
  check("排序按钮里「项目顺序 → 按名称」：各级都按名字排", (await shownBecomes(byName2)).join() === byName2.join(), await shown());
  check("换成按名称时记下的顺序留着", orderFile("工作")?.manual === undefined && orderFile("工作")?.order.length > 0, orderFile("工作"));
  await projectSort("手动排序");
  check("换回手动排序时恢复原来的顺序", (await shownBecomes(manualNow)).join() === manualNow.join(), await shown());

  // 按名称时拖动：从按名字的顺序重新排，别的各层（多深的都算）留着的旧顺序不再用
  await projectSort("按名称");
  await shownBecomes(byName2);
  await m.clearToasts();
  await dragBeside(["工作", "组件"], ["工作", "备忘"], "before", "前面");
  const fresh = [
    "组件",
    "备忘",
    "日常事务",
    "日常事务/备忘",
    "需求",
    "需求/测试",
    "需求/后端",
    "需求/零散",
    "需求/前端",
    "需求/前端/阿里",
    "需求/前端/样式",
    "需求/前端/页面",
    "需求/前端/杂项",
    "需求/前端/杂项/x",
    "需求/前端/杂项/y",
  ];
  check("按名称时拖动：改成手动排序，别的从按名字的顺序开始（各级子项目也按名字）", (await shownBecomes(fresh)).join() === fresh.join(), await shown());
  check(
    "又提示「项目已改为手动排序」，各级父项目里留着的旧顺序去掉",
    (await toastHas("项目已改为手动排序")) && orderFile("工作/需求") === null && orderFile("工作/需求/前端") === null && orderFile("工作/需求/前端/杂项") === null,
    { toast: await m.toast(), sub: orderFile("工作/需求"), deep: orderFile("工作/需求/前端"), deeper: orderFile("工作/需求/前端/杂项") },
  );

  // 同时显示几个工作区：深处的、有子项目的项目放到别的（按名称排的）工作区的项目旁边，移过去放在那里，那个工作区改成
  // 手动排序；它里面子项目的顺序（手动排序时看得到的）跟着它
  await dragBeside(["工作", "需求/前端/杂项/y"], ["工作", "需求/前端/杂项/x"], "before", "前面");
  await t.until(async () => same(orderFile("工作/需求/前端/杂项")?.order, ["y", "x"]));
  await m.selectAllWorkspaces();
  await expandDeep();
  await m.clearToasts();
  d = await dragBeside(["工作", "需求/前端/杂项"], ["生活", "购物"], "before", "前面");
  const life = ["杂项", "杂项/y", "杂项/x", "购物", "杂事"];
  check(
    "拖到别的工作区的项目旁边：说明移到哪个工作区，移过去放在那里，它里面子项目的顺序跟着",
    d.hint === "移动到工作区「生活」，放在「购物」前面" &&
      (await shownBecomes(life, "生活")).join() === life.join() &&
      t.exists("生活/杂项/x") &&
      same(orderFile("生活/杂项")?.order, ["y", "x"]),
    { d, shown: await shown("生活"), sub: orderFile("生活/杂项") },
  );
  check("提示写明是哪个工作区改成了手动排序", await toastHas("「生活」的项目已改为手动排序"), await m.toast());

  // 隐藏全部完成的项目时：藏起来的也算在那一层里，调整顺序后它和别的项目的相对位置不变
  const toggleHideDoneProjects = async () => {
    await m.click(await m.at(".hide-done-btn"));
    await m.ev(`const item = await waitFor(() => [...document.querySelectorAll(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item")]
        .find((e) => e.textContent.includes("隐藏全部完成的项目")));
      item.click(); await sleep(400); return 1`);
  };
  await m.invoke("set_todo_done", { workspace: "生活", project: "购物", id: "GBK笔记", done: true });
  await refresh();
  await m.ev(`row("生活").click(); await sleep(600); return 1`);
  await toggleHideDoneProjects();
  const lifeHiding = ["杂项", "杂项/y", "杂项/x", "杂事"];
  check("全部完成的「购物」藏起来了", (await shownBecomes(lifeHiding, "生活")).join() === lifeHiding.join(), await shown("生活"));
  d = await dragBeside(["生活", "杂项"], ["生活", "杂事"], "after", "后面");
  check(
    "藏起来的项目也算在那一层里：调整后它和别的项目的相对位置不变",
    d.hint === "放在「杂事」后面" && same(orderFile("生活")?.order, ["购物", "杂事", "杂项"]),
    { d, file: orderFile("生活") },
  );
  await toggleHideDoneProjects();
  const lifeAfter = ["购物", "杂事", "杂项", "杂项/y", "杂项/x"];
  check("关掉隐藏后照这个顺序显示", (await shownBecomes(lifeAfter, "生活")).join() === lifeAfter.join(), await shown("生活"));

  // 外部改了 .projects.json（另一台电脑上调整了、网盘同步过来）：窗口一直在前台也跟着刷新，深处的也算
  t.write("工作/.projects.json", JSON.stringify({ version: 1, manual: true, order: ["需求", "备忘"] }));
  const external = [
    "需求",
    "需求/测试",
    "需求/后端",
    "需求/零散",
    "需求/前端",
    "需求/前端/阿里",
    "需求/前端/样式",
    "需求/前端/页面",
    "备忘",
    "日常事务",
    "日常事务/备忘",
    "组件",
  ];
  check("外部改了工作区的 .projects.json：侧栏跟着刷新", (await shownBecomes(external)).join() === external.join(), await shown());
  t.write("工作/需求/前端/.projects.json", JSON.stringify({ version: 1, order: ["页面", "阿里"] }));
  const externalDeep = [
    "需求",
    "需求/测试",
    "需求/后端",
    "需求/零散",
    "需求/前端",
    "需求/前端/页面",
    "需求/前端/阿里",
    "需求/前端/样式",
    "备忘",
    "日常事务",
    "日常事务/备忘",
    "组件",
  ];
  check("外部改了深处父项目里的 .projects.json：也跟着刷新", (await shownBecomes(externalDeep)).join() === externalDeep.join(), await shown());
  await m.clearToasts();
  t.write("工作/.projects.json", "坏了");
  const broken = [
    "备忘",
    "日常事务",
    "日常事务/备忘",
    "需求",
    "需求/测试",
    "需求/后端",
    "需求/零散",
    "需求/前端",
    "需求/前端/阿里",
    "需求/前端/样式",
    "需求/前端/页面",
    "组件",
  ];
  check("手改坏了的当成没有：按名字排，不报错", (await shownBecomes(broken)).join() === broken.join() && !(await m.toast()), {
    shown: await shown(),
    toast: await m.toast(),
  });
  await m.viewport(0);
}
