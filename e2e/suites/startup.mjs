// 开机自启时的主窗口：只在托盘里 / 显示主窗口；上次最大化的窗口不会弹出来、也不会丢掉最大化
export const title = "开机自启时的主窗口";

const MAXIMIZE = 3;
const RESTORE = 9;

export default async function (t) {
  const { check, win } = t;
  const main = () => win.windows().main;

  let w = main();
  check("正常启动（不带 --autostart）显示主窗口，图标不是系统默认的", w?.visible && win.icons().every((h) => h > 0), { w, icons: win.icons() });

  // 最大化后退出，开机自启（只在托盘里）
  win.show(MAXIMIZE);
  await t.sleep(800);
  check("最大化", main().max);
  await t.restart({ args: ["--autostart"] });
  await t.sleep(1000);
  w = main();
  check("开机自启默认只在托盘里：主窗口不显示（上次最大化的也不弹出来）", !w.visible && !w.max, w);

  // 一直没打开就退出，下次正常打开仍是最大化的
  await t.restart();
  await t.sleep(800);
  w = main();
  check("开机自启后没打开过主窗口就退出：下次正常打开仍是最大化", w.visible && w.max, w);

  // 开机自启后从托盘打开（这里用「显示 / 隐藏主窗口」的快捷键，和托盘图标一样调 show_main_window）
  await t.restart({ args: ["--autostart"] });
  await t.sleep(800);
  win.hotkey(t.TEST_KEYS.toggle.split("+").pop());
  await t.sleep(1000);
  w = main();
  check("开机自启后第一次显示主窗口时恢复最大化", w.visible && w.max, w);
  win.show(RESTORE);
  await t.sleep(500);

  // 设置成开机时显示主窗口
  await t.main.invoke("set_autostart_hidden", { hidden: false });
  await t.restart({ args: ["--autostart"] });
  await t.sleep(800);
  check("取消「只在托盘里」后，开机自启时显示主窗口", main().visible);
  await t.main.invoke("set_autostart_hidden", { hidden: true });
}
