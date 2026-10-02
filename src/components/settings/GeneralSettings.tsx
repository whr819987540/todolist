import { App as AntApp, Radio } from "antd";
import { api, errMsg } from "../../api";
import { useSettings } from "../../settings";
import type { StartupView } from "../../types";

const STARTUP_ITEMS: { value: StartupView; label: string; desc: string }[] = [
  { value: "home", label: "显示首页", desc: "列出全部工作区。" },
  {
    value: "lastPosition",
    label: "回到上次的位置",
    desc: "恢复上次左侧选中的工作区和右侧打开的待办；上次停在首页时仍显示首页。",
  },
];

/** 常规：打开软件时显示的界面，下次启动时生效 */
export default function GeneralSettings() {
  const { message } = AntApp.useApp();
  const { info, setInfo } = useSettings();
  if (!info) return <div className="setting-item" />;

  const change = async (view: StartupView) => {
    try {
      setInfo(await api.setStartupView(view));
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  return (
    <>
      <div className="setting-group">启动</div>
      <div className="setting-item">
        <div className="setting-label">打开软件时</div>
        <div className="setting-desc">下次打开软件时生效；从托盘恢复窗口时总是保持原来的样子。</div>
        <Radio.Group
          className="startup-options"
          vertical
          value={info.settings.startupView}
          onChange={(e) => change(e.target.value)}
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
    </>
  );
}
