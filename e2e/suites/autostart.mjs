// 开机自启：设置「常规」里的开关和注册表的 Run、StartupApproved（任务管理器的启用 / 禁用）
export const title = "开机自启（注册表）";

export default async function (t) {
  const { main: m, check, win } = t;
  win.removeAutostart();
  const installed = win.runEntryOf("待办清单");

  const ui = () =>
    m.ev(`await waitFor(() => document.querySelector(".autostart-switch:not(.ant-switch-loading)"));
      return { on: document.querySelector(".autostart-switch").classList.contains("ant-switch-checked"),
        hiddenDisabled: document.querySelector(".autostart-hidden input").disabled,
        hidden: document.querySelector(".autostart-hidden input").checked }`);
  const toggle = () => m.ev(`document.querySelector(".autostart-switch").click(); await sleep(800); return 1`);

  await m.openSettings("常规");
  let u = await ui();
  check("没设置过时开关是关着的，「只在托盘里」不能选（默认勾着）", !u.on && u.hiddenDisabled && u.hidden, u);
  await toggle();
  u = await ui();
  const command = `"${t.exe}" --autostart`;
  check("打开后 Run 里有以产品名命名的启动项：带引号的程序路径加 --autostart", u.on && !u.hiddenDisabled && win.runEntry() === command, win.runEntry());
  check("没有动安装版的启动项", win.runEntryOf("待办清单") === installed);
  await m.closeModal();

  // 在任务管理器里禁用（StartupApproved 的第一个字节是奇数）
  win.setApproved([3, 0, 0, 0, 0x8a, 0x1f, 0x3c, 0x52, 0x10, 0x2b, 0xdc, 0x01]);
  await m.openSettings("常规");
  u = await ui();
  check("在任务管理器里禁用了：设置里显示关闭", !u.on, u);
  await toggle();
  check("在设置里重新打开：任务管理器里改回启用", (await ui()).on && win.approvedEntry()?.join() === "2,0,0,0,0,0,0,0,0,0,0,0", win.approvedEntry());
  await m.closeModal();
  win.setApproved([6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  check("任务管理器里启用过（6 开头）也算开着", (await m.invoke("get_autostart")) === true);

  await m.openSettings("常规");
  await m.ev(`document.querySelector(".autostart-hidden input").click(); await sleep(500); return 1`);
  check("取消「开机启动后只在托盘里」，存进设置文件", JSON.parse(t.read(".settings.json")).autostartHidden === false);
  await m.ev(`document.querySelector(".autostart-hidden input").click(); await sleep(500); return 1`);
  check("再勾上", JSON.parse(t.read(".settings.json")).autostartHidden === true);

  await toggle();
  u = await ui();
  check("关闭后 Run 和 StartupApproved 里的那一项都删掉", !u.on && win.runEntry() === "" && win.approvedEntry() === null, u);
  await m.closeModal();
  check("开没开不写进设置文件（是这台电脑上的设置）", !/"autostart"\s*:/.test(t.read(".settings.json")));
}
