// 虚拟桌面：主窗口开在一个桌面上，用户切到另一个桌面后在那里调出它（这里用全局快捷键；托盘图标、再次启动、
// 快速记录里的 Ctrl+Enter 同样经 show_main_window），主窗口挪到当前桌面，不把用户切回原来的桌面。
// 虚拟桌面只能用真的按键（Ctrl+Win+D 新建、Ctrl+Win+← / → 切换、Ctrl+Win+F4 关掉）操作，会动到整个桌面：
// 本来就开着好几个桌面时（在本机上跑）不跑，免得动到用户的桌面；跑完关掉新建的那个
export const title = "虚拟桌面";

const MAXIMIZE = 3;
const RESTORE = 9;
const MINIMIZE = 6;
const NAME = "在别的虚拟桌面上调出主窗口";

export default async function (t) {
  const { check, win } = t;
  const toggleKey = t.TEST_KEYS.toggle.split("+").pop();
  const main = () => win.windows().main;
  const where = () => win.desktopOf();
  const keys = async (...k) => {
    win.pressKeys(k);
    await t.sleep(1500);
  };
  /** 按快捷键调出主窗口，等它到了当前桌面；再多等一会儿：Windows 把用户切回原来的桌面也要时间 */
  const summon = async () => {
    win.hotkey(toggleKey);
    await t.until(() => where().current, 4000);
    await t.sleep(800);
    return { d: where(), w: main() };
  };

  const home = where();
  if (home.error) return t.skip(NAME, `问不出窗口在哪个虚拟桌面（${home.error}）`);
  if (win.desktopCount() > 1) return t.skip(NAME, "已经开着好几个虚拟桌面，免得动到用户的桌面，不跑");
  // 先在原来的桌面上调到前台，看 Windows 让不让测试版拿前台
  win.hotkey(toggleKey);
  await t.sleep(600);
  const fg = !!main()?.fg;

  await keys("LWin", "Ctrl", "D");
  try {
    if (win.desktopCount() < 2 || where().current) return t.skip(NAME, "按 Ctrl+Win+D 没有建出新的虚拟桌面");
    check("切到新建的桌面 2：主窗口还在桌面 1 上", where().id === home.id, where());

    let r = await summon();
    check("开着的主窗口在桌面 1：在桌面 2 上调出时挪到桌面 2，没有把用户切回桌面 1",
      r.d.current && r.d.id !== home.id && r.w.visible && !r.w.min, { home, ...r });
    t.checkForeground(fg, "挪过来后在前台", r.w.fg, r.w);
    const second = r.d.id;

    win.show(MAXIMIZE);
    await t.sleep(600);
    await keys("LWin", "Ctrl", "Left");
    check("回到桌面 1：最大化的主窗口留在桌面 2", !where().current && where().id === second, where());
    r = await summon();
    check("最大化的主窗口：挪到桌面 1，仍是最大化", r.d.current && r.d.id === home.id && r.w.max, { home, ...r });
    win.show(RESTORE);
    await t.sleep(600);

    win.show(MINIMIZE);
    await t.sleep(600);
    await keys("LWin", "Ctrl", "Right");
    check("到桌面 2：最小化的主窗口留在桌面 1", !where().current && where().id === home.id, where());
    r = await summon();
    check("最小化的主窗口：挪到桌面 2 并还原", r.d.current && r.d.id === second && r.w.visible && !r.w.min, { second, ...r });

    win.close();
    await t.sleep(600);
    await keys("LWin", "Ctrl", "Left");
    r = await summon();
    check("藏在托盘里的主窗口：显示在当前桌面（桌面 1）上", r.d.current && r.d.id === home.id && r.w.visible, { home, ...r });

    // 快速记录小窗是工具窗口，不归哪个桌面管：在哪个桌面上按快捷键就弹在哪里，不会把用户切走
    await keys("LWin", "Ctrl", "Right");
    win.hotkey(t.TEST_KEYS.quick.split("+").pop());
    await t.sleep(600);
    const quick = win.windows().quick;
    t.checkForeground(fg, "在桌面 2 上按快速记录的快捷键：小窗弹在桌面 2、在前台，没有切回桌面 1", quick?.visible && quick.fg && !where().current,
      { quick, main: where() });
    win.hotkey(t.TEST_KEYS.quick.split("+").pop());
    await t.sleep(300);
  } finally {
    // 关掉新建的桌面：它在最右边，切过去按 Ctrl+Win+F4，上面的窗口挪到左边的桌面
    if (win.desktopCount() > 1) {
      await keys("LWin", "Ctrl", "Right");
      await keys("LWin", "Ctrl", "F4");
    }
  }
  check("跑完关掉了新建的虚拟桌面", win.desktopCount() === 1);
}
