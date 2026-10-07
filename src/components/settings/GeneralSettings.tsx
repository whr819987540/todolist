import { App as AntApp, Checkbox, Radio, Select, Switch } from "antd";
import { useEffect, useState } from "react";
import { api, errMsg } from "../../api";
import { matchTarget, parseTargetKey, targetKey, targetLabel, targetOptions } from "../../quickCapture";
import { useSettings } from "../../settings";
import { shortcutLabel } from "../../shortcuts";
import type { StartupView, WorkspaceProjects } from "../../types";

const STARTUP_ITEMS: { value: StartupView; label: string; desc: string }[] = [
  { value: "home", label: "显示首页", desc: "列出全部工作区。" },
  {
    value: "lastPosition",
    label: "回到上次的位置",
    desc: "恢复上次左侧选中的工作区和右侧打开的待办；上次停在首页时仍显示首页。",
  },
];

/** 常规：开机自启，打开软件时显示的界面（下次启动时生效），快速记录存到哪里 */
export default function GeneralSettings() {
  const { message } = AntApp.useApp();
  const { info, setInfo } = useSettings();
  // 开机自启记在注册表里（这台电脑上的设置），打开设置时读一次；null 是还没读出来
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  // 快速记录可以存到的项目
  const [projects, setProjects] = useState<WorkspaceProjects[]>([]);
  useEffect(() => {
    api.getAutostart().then(setAutostart, () => setAutostart(false));
    api.listProjects().then(setProjects, () => {});
    // 快速记录存到哪里会在主窗口之外改掉：在小窗里换了项目、项目改名或移到别的工作区后跟着改了（Rust 端），重新读一次
    api.getSettings().then(setInfo, () => {});
  }, [setInfo]);
  if (!info) return <div className="setting-item" />;

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  const toggleAutostart = (on: boolean) => {
    setBusy(true);
    run(async () => {
      const now = await api.setAutostart(on);
      setAutostart(now);
      message.success(now ? "已设置开机时自动启动" : "已关闭开机自动启动");
    }).finally(() => setBusy(false));
  };

  return (
    <>
      <div className="setting-group">启动</div>
      <div className="setting-item">
        <div className="setting-switch-row">
          <span className="setting-label">开机时自动启动</span>
          <Switch
            className="autostart-switch"
            checked={!!autostart}
            loading={autostart === null || busy}
            onChange={toggleAutostart}
          />
        </div>
        <div className="setting-desc">
          登录 Windows 后自动运行。只对这台电脑生效，不随设置备份；在任务管理器的「启动应用」里禁用了的，这里显示为关闭。
        </div>
        <Checkbox
          className="autostart-hidden"
          disabled={!autostart}
          checked={info.settings.autostartHidden}
          onChange={(e) => run(async () => setInfo(await api.setAutostartHidden(e.target.checked)))}
        >
          开机启动后只在托盘里，不显示主窗口
          {info.defaults.autostartHidden && <span className="muted">（默认）</span>}
        </Checkbox>
      </div>
      <div className="setting-item">
        <div className="setting-label">打开软件时</div>
        <div className="setting-desc">下次打开软件时生效；从托盘恢复窗口时总是保持原来的样子。</div>
        <Radio.Group
          className="startup-options"
          vertical
          value={info.settings.startupView}
          onChange={(e) => run(async () => setInfo(await api.setStartupView(e.target.value)))}
        >
          {STARTUP_ITEMS.map((item) => (
            <Radio key={item.value} value={item.value}>
              {item.label}
              {item.value === info.defaults.startupView && <span className="muted">（默认）</span>}
              <div className="setting-desc">{item.desc}</div>
            </Radio>
          ))}
        </Radio.Group>
      </div>
      <div className="setting-hint muted">
        切换待办时，光标（选中的文字）和滚动总是回到这条待办上次编辑的地方；正文在外部被大幅修改、找不到原来的位置时回到开头。
      </div>

      <div className="setting-group">快速记录</div>
      <div className="setting-item">
        <div className="setting-label">存到</div>
        <div className="setting-desc">
          {info.settings.quickCaptureShortcut
            ? `在任何程序里按 ${shortcutLabel(info.settings.quickCaptureShortcut)}（可在「快捷键」里修改）`
            : "从托盘菜单的「快速记录」"}
          弹出小输入框，第一行当标题、其余当正文，Enter 存成这个项目里的一条待办。项目还不在时保存时新建；在小窗里也能改。
        </div>
        <Select
          className="quick-target-setting"
          showSearch={{ filterOption: matchTarget }}
          value={targetKey(info.settings.quickCaptureTarget)}
          options={targetOptions(projects, info.settings.quickCaptureTarget)}
          labelRender={() => targetLabel(info.settings.quickCaptureTarget)}
          onChange={(key) => run(async () => setInfo(await api.setQuickCaptureTarget(parseTargetKey(key))))}
        />
      </div>
    </>
  );
}
