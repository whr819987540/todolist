// 项目的顺序：在侧栏里把项目拖到另一个项目那一行的上沿 / 下沿，放在它前面 / 后面（插入线、说明），同一层是调整顺序、
// 不在同一层是移过去放在那里（子项目移出来、顶层项目放进父项目、移到别的工作区），有子项目的放不进别的项目（标红）；
// 中间照常是放进去；改成手动排序的提示；记在 .projects.json；新建的排在后面、改名后位置不变、删除后恢复的排在后面；
// 搜索时不能调整；排序按钮里换成按名称、再换回手动排序时恢复，按名称时拖动从按名字的顺序重新排；概览的卡片和「移动到」
// 跟着；重新打开后还在；外部改了 .projects.json 跟着刷新，手改坏了按名字排
import { readFileSync } from "node:fs";

export const title = "项目的顺序";

export default async function (t) {
  const { main: m, check } = t;
  // 项目、待办多，把视口设高一些，要拖到的行都在侧栏的可见区域里
  await m.viewport(1200, 1400);
  await m.enter("工作");

  const refresh = async () => {
    await m.emit("tauri://focus");
    await t.sleep(800);
  };
  /** 侧栏里一个工作区的项目（路径），按显示的先后 */
  const shown = (ws = "工作") =>
    m.ev(`return [...document.querySelectorAll(".sidebar .project-row[data-sel]")].map((r) => JSON.parse(r.dataset.sel))
      .filter((s) => s[0] === ${JSON.stringify(ws)}).map((s) => s[1])`);
  /** 等侧栏里的项目变成 expected 的样子；等不到时返回最后看到的 */
  const shownBecomes = async (expected, ws = "工作") =>
    (await t.until(async () => (await shown(ws)).join() === expected.join())) || (await shown(ws));
  /** 那一层的文件夹里记着的项目顺序（.projects.json），没有时是 null */
  const orderFile = (rel) => {
    try {
      return JSON.parse(readFileSync(t.file(`${rel}/.projects.json`), "utf8"));
    } catch {
      return null;
    }
  };
  /** 拖动中：跟着指针的说明、画了插入线的项目（「路径:前面/后面[:标红]」）、整块高亮的个数、指针是不是「不能放」 */
  const dragInfo = () =>
    m.ev(`return { hint: document.querySelector(".drag-ghost-hint")?.textContent ?? "",
      line: [...document.querySelectorAll(".project-branch.drop-before, .project-branch.drop-after")].map((b) =>
        JSON.parse(b.querySelector(".project-row").dataset.sel)[1] + ":" + (b.classList.contains("drop-before") ? "before" : "after")
        + (b.classList.contains("drop-line-refused") ? ":refused" : "")),
      blocks: document.querySelectorAll(".drop-target, .drop-refused").length,
      nodrop: document.body.classList.contains("drag-nodrop") }`);
  /** 拖动中把指针移到 p，等说明里有 text；返回那时的样子（等不到时是最后看到的） */
  const hover = async (p, text) => {
    await m.mouse("mouseMoved", p, { button: "left", buttons: 1 });
    return (await t.until(async () => (await dragInfo()).hint.includes(text) && (await dragInfo()), 3000)) || (await dragInfo());
  };
  const edge = (sel, place) => m.at(sel, place === "before" ? -0.4 : 0.4);
  const toastHas = (text) => t.until(async () => (await m.toast()).includes(text));
  /** 点排序按钮，在「项目顺序」一组里点 label 开头的那一项 */
  const projectSort = (label) =>
    m.ev(`document.querySelector(".sidebar-bar .anticon-sort-ascending").closest("button").click();
      const groups = await waitFor(() => [...document.querySelectorAll(".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item-group")]
        .find((g) => g.querySelector(".ant-dropdown-menu-item-group-title")?.textContent.includes("项目顺序")));
      const item = [...groups.querySelectorAll(".ant-dropdown-menu-item")].find((e) => e.textContent.startsWith(${JSON.stringify(label)}));
      item.click(); await sleep(600); return 1`);

  // 几个项目和子项目（同在软件里新建）
  for (const name of ["杂项", "备忘"]) await m.invoke("create_project", { workspace: "工作", name });
  for (const name of ["前端", "后端", "测试"]) await m.invoke("create_project", { workspace: "工作", name, parent: "需求" });
  await refresh();
  await m.expandAll();

  // 中文按拼音：备忘、日常、需求（测试、后端、前端）、杂项
  const byName = ["备忘", "日常", "需求", "需求/测试", "需求/后端", "需求/前端", "杂项"];
  check("没调整过时按名字排，子项目跟在父项目后面", (await shown()).join() === byName.join(), await shown());
  check("没调整过时没有 .projects.json", orderFile("工作") === null && orderFile("工作/需求") === null);

  // 顶层项目拖到另一个项目那一行：中间是放进去，上沿 / 下沿是放在前面 / 后面
  await m.drag(await m.at(["工作", "杂项"]), await m.at(["工作", "日常"]), { release: false });
  let d = await hover(await m.at(["工作", "日常"]), "成为子项目");
  check("拖到另一个项目那一行的中间：同原来，放进去成为子项目（整块高亮，没有插入线）", d.hint.includes("放进「日常」，成为子项目") && d.blocks === 1 && !d.line.length, d);
  d = await hover(await edge(["工作", "日常"], "before"), "前面");
  check("拖到上沿：插入线画在它前面，说明「放在「日常」前面」，不整块高亮", d.hint === "放在「日常」前面" && d.line.join() === "日常:before" && !d.blocks && !d.nodrop, d);
  d = await hover(await edge(["工作", "日常"], "after"), "后面");
  check("拖到下沿：插入线画在它后面", d.hint === "放在「日常」后面" && d.line.join() === "日常:after", d);
  await m.clearToasts();
  const beforeDaily = await edge(["工作", "日常"], "before");
  await hover(beforeDaily, "前面");
  await m.drop(beforeDaily);
  const manualOrder = ["备忘", "杂项", "日常", "需求", "需求/测试", "需求/后端", "需求/前端"];
  check("松开后放在了那里", (await shownBecomes(manualOrder)).join() === manualOrder.join(), await shown());
  check("没在手动排序时提示「项目已改为手动排序」", await toastHas("项目已改为手动排序"), await m.toast());
  check(
    "顺序记在工作区文件夹的 .projects.json 里，改成了手动排序",
    JSON.stringify(orderFile("工作")) === JSON.stringify({ version: 1, manual: true, order: ["备忘", "杂项", "日常", "需求"] }),
    orderFile("工作"),
  );

  // 新建的排在后面、彼此按名字；改名后位置不变
  await m.invoke("create_project", { workspace: "工作", name: "零散" });
  await m.invoke("create_project", { workspace: "工作", name: "阿里" });
  await m.invoke("rename_project", { workspace: "工作", name: "日常", newName: "日常事务" });
  await refresh();
  const afterNew = ["备忘", "杂项", "日常事务", "需求", "需求/测试", "需求/后端", "需求/前端", "阿里", "零散"];
  check("新建的排在后面、彼此按名字；改名后位置不变", (await shownBecomes(afterNew)).join() === afterNew.join(), await shown());

  // 子项目之间调整顺序：记在父项目文件夹里，已经在手动排序了，不再提示
  await m.clearToasts();
  await m.drag(await m.at(["工作", "需求/前端"]), await edge(["工作", "需求/测试"], "before"), { release: false });
  d = await hover(await edge(["工作", "需求/测试"], "before"), "前面");
  await m.drop(await edge(["工作", "需求/测试"], "before"));
  const afterSub = ["备忘", "杂项", "日常事务", "需求", "需求/前端", "需求/测试", "需求/后端", "阿里", "零散"];
  check("子项目之间调整顺序", d.hint === "放在「测试」前面" && (await shownBecomes(afterSub)).join() === afterSub.join(), {
    d,
    shown: await shown(),
  });
  check("子项目的顺序记在父项目文件夹的 .projects.json 里", JSON.stringify(orderFile("工作/需求")?.order) === JSON.stringify(["前端", "测试", "后端"]), orderFile("工作/需求"));
  check("已经在手动排序时不再提示", !(await m.toast()).includes("已改为手动排序"), await m.toast());

  // 顶层项目放到两个子项目之间：放进去、放在那里
  await m.drag(await m.at(["工作", "零散"]), await edge(["工作", "需求/前端"], "after"), { release: false });
  d = await hover(await edge(["工作", "需求/前端"], "after"), "后面");
  await m.drop(await edge(["工作", "需求/前端"], "after"));
  const intoParent = ["备忘", "杂项", "日常事务", "需求", "需求/前端", "需求/零散", "需求/测试", "需求/后端", "阿里"];
  check(
    "没有子项目的顶层项目拖到两个子项目之间：说明「放进「需求」，放在「前端」后面」，放进去、放在那里",
    d.hint === "放进「需求」，放在「前端」后面" && (await shownBecomes(intoParent)).join() === intoParent.join() && t.exists("工作/需求/零散"),
    { d, shown: await shown() },
  );

  // 子项目拖到两个顶层项目之间：移出来、放在那里
  await m.drag(await m.at(["工作", "需求/后端"]), await edge(["工作", "备忘"], "after"), { release: false });
  d = await hover(await edge(["工作", "备忘"], "after"), "后面");
  await m.drop(await edge(["工作", "备忘"], "after"));
  const outOfParent = ["备忘", "后端", "杂项", "日常事务", "需求", "需求/前端", "需求/零散", "需求/测试", "阿里"];
  check(
    "子项目拖到两个顶层项目之间：说明「移出来，放在「备忘」后面」，移出来、放在那里",
    d.hint === "移出来，放在「备忘」后面" && (await shownBecomes(outOfParent)).join() === outOfParent.join() && t.exists("工作/后端"),
    { d, shown: await shown() },
  );
  check(
    "原来那一层（父项目里）的顺序去掉它，新的那一层按放下的位置",
    JSON.stringify(orderFile("工作/需求")?.order) === JSON.stringify(["前端", "零散", "测试"]) &&
      JSON.stringify(orderFile("工作")?.order) === JSON.stringify(["备忘", "后端", "杂项", "日常事务", "需求", "阿里"]),
    { sub: orderFile("工作/需求"), top: orderFile("工作") },
  );

  // 有子项目的项目拖到别的父项目的子项目之间：标红、说明原因，放不下
  await m.invoke("create_project", { workspace: "工作", name: "x", parent: "杂项" });
  await refresh();
  await m.expandAll();
  await m.drag(await m.at(["工作", "需求"]), await edge(["工作", "杂项/x"], "before"), { release: false });
  d = await hover(await edge(["工作", "杂项/x"], "before"), "有子项目");
  await m.drop(await edge(["工作", "杂项/x"], "before"));
  check(
    "有子项目的项目放到子项目旁边：插入线标红、说明原因，放不下",
    d.line.join() === "杂项/x:before:refused" && d.nodrop && t.exists("工作/需求") && !t.exists("工作/杂项/需求"),
    d,
  );

  // 搜索时不能调整顺序；拖到中间照常移动（这里不放）
  const manualNow = await shown();
  await m.press("Ctrl+Shift+F");
  await m.type("待办");
  await t.until(async () => !(await shown()).includes("备忘"));
  await m.drag(await m.at(["工作", "日常事务"]), await edge(["工作", "需求"], "before"), { release: false });
  d = await hover(await edge(["工作", "需求"], "before"), "不能调整顺序");
  await m.drop(await edge(["工作", "需求"], "before"));
  check("搜索时拖到上沿 / 下沿：说明「搜索时不能调整顺序」，放不下", d.hint.includes("搜索时不能调整顺序") && d.nodrop && !d.line.length, d);
  await m.ev(`document.querySelector(".sidebar input").focus(); return 1`);
  await m.press("Escape");
  check("搜索时没有调整", (await shownBecomes(manualNow)).join() === manualNow.join(), await shown());

  // 概览的卡片、「移动到」跟着项目的顺序
  await m.ev(`row("工作").click(); await sleep(600); return 1`);
  const cards = await m.ev(`return [...document.querySelectorAll(".overview .project-card .card-name")].map((e) => e.textContent)`);
  const tops = manualNow.filter((p) => !p.includes("/"));
  check("工作区概览的项目卡片按项目的顺序", cards.join() === tops.join(), { cards, tops });
  await m.ev(`row("工作", "需求").click(); await sleep(600); return 1`);
  const subCards = await m.ev(`return [...document.querySelectorAll(".overview .project-card .card-name")].map((e) => e.textContent)`);
  check("父项目概览的子项目卡片按项目的顺序", subCards.join() === "前端,零散,测试", subCards);
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
  check("待办的「移动到」按项目的顺序列出", (moveItems ?? []).join() === expectedMove.join(), { moveItems, expectedMove });

  // 排序按钮：换成按名称（顺序留着），再换回手动排序时恢复
  await projectSort("按名称");
  // 阿里、备忘、后端、日常事务、需求（测试、零散、前端）、杂项（x）
  const byName2 = ["阿里", "备忘", "后端", "日常事务", "需求", "需求/测试", "需求/零散", "需求/前端", "杂项", "杂项/x"];
  check("排序按钮里「项目顺序 → 按名称」：按名字排", (await shownBecomes(byName2)).join() === byName2.join(), await shown());
  check("换成按名称时记下的顺序留着", orderFile("工作").manual === undefined && orderFile("工作").order.length > 0, orderFile("工作"));
  await projectSort("手动排序");
  check("换回手动排序时恢复原来的顺序", (await shownBecomes(manualNow)).join() === manualNow.join(), await shown());

  // 按名称时拖动：从按名字的顺序重新排，留着的旧顺序不再用
  await projectSort("按名称");
  await shownBecomes(byName2);
  await m.clearToasts();
  await m.drag(await m.at(["工作", "杂项"]), await edge(["工作", "阿里"], "before"), { release: false });
  await hover(await edge(["工作", "阿里"], "before"), "前面");
  await m.drop(await edge(["工作", "阿里"], "before"));
  const fresh = ["杂项", "杂项/x", "阿里", "备忘", "后端", "日常事务", "需求", "需求/测试", "需求/零散", "需求/前端"];
  check("按名称时拖动：改成手动排序，别的从按名字的顺序开始（子项目也按名字）", (await shownBecomes(fresh)).join() === fresh.join(), await shown());
  check("又提示「项目已改为手动排序」，父项目里留着的旧顺序去掉", (await toastHas("项目已改为手动排序")) && orderFile("工作/需求") === null, {
    toast: await m.toast(),
    sub: orderFile("工作/需求"),
  });

  // 删除后恢复的排在后面
  const rid = await m.invoke("delete_project", { workspace: "工作", name: "阿里" });
  await m.invoke("restore_recycled", { ids: [rid] });
  await refresh();
  const restored = ["杂项", "杂项/x", "备忘", "后端", "日常事务", "需求", "需求/测试", "需求/零散", "需求/前端", "阿里"];
  check("删除后去掉，恢复的排在后面", (await shownBecomes(restored)).join() === restored.join(), await shown());

  // 重新打开后还在
  await m.reload();
  await m.enter("工作");
  await m.expandAll();
  check("重新打开后顺序不变", (await shownBecomes(restored)).join() === restored.join(), await shown());

  // 同时显示几个工作区：放到别的工作区的项目旁边，移过去放在那里，那个工作区改成手动排序
  await m.selectAllWorkspaces();
  await m.expandAll();
  await m.clearToasts();
  await m.drag(await m.at(["工作", "后端"]), await edge(["生活", "购物"], "before"), { release: false });
  d = await hover(await edge(["生活", "购物"], "before"), "前面");
  await m.drop(await edge(["生活", "购物"], "before"));
  check(
    "拖到别的工作区的项目旁边：说明移到哪个工作区，移过去放在那里",
    d.hint === "移动到工作区「生活」，放在「购物」前面" && (await shownBecomes(["后端", "购物", "杂事"], "生活")).join() === "后端,购物,杂事" && t.exists("生活/后端"),
    { d, shown: await shown("生活") },
  );
  check("提示写明是哪个工作区改成了手动排序", await toastHas("「生活」的项目已改为手动排序"), await m.toast());

  // 外部改了 .projects.json（另一台电脑上调整了、网盘同步过来）：窗口一直在前台也跟着刷新
  t.write("工作/.projects.json", JSON.stringify({ version: 1, manual: true, order: ["需求", "备忘"] }));
  const external = ["需求", "需求/测试", "需求/零散", "需求/前端", "备忘", "阿里", "日常事务", "杂项", "杂项/x"];
  check("外部改了 .projects.json：侧栏跟着刷新", (await shownBecomes(external)).join() === external.join(), await shown());
  await m.clearToasts();
  t.write("工作/.projects.json", "坏了");
  const broken = ["阿里", "备忘", "日常事务", "需求", "需求/测试", "需求/零散", "需求/前端", "杂项", "杂项/x"];
  check("手改坏了的当成没有：按名字排，不报错", (await shownBecomes(broken)).join() === broken.join() && !(await m.toast()), {
    shown: await shown(),
    toast: await m.toast(),
  });
  await m.viewport(0);
}
