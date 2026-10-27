import { listen } from "@tauri-apps/api/event";
import { App as AntApp, Button, Switch } from "antd";
import { useEffect, useState } from "react";
import { api, errMsg } from "../../api";
import { useSettings } from "../../settings";
import type { UpdateStatus } from "../../types";
import { startUpdate, updateStateText } from "../../update";

/** 常规里的「更新」：当前版本、自动检查更新的开关、检查更新、发现了新版本时立即更新 */
export default function UpdateSettings() {
  const { message } = AntApp.useApp();
  const { info, setInfo } = useSettings();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    api.getUpdateStatus().then(setStatus, () => {});
    const unlisten = listen<UpdateStatus>("update-status", (e) => setStatus(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  if (!info || !status) return null;

  const check = () => {
    setStatus({ ...status, checking: true });
    // 检查完的状态同定时检查的，经 update-status 收：几次检查排着队时，这一次检查完后面还有没检查完的，返回值可能比
    // 之后收到的事件晚到，不拿它盖掉
    api.checkUpdate().catch((e) => message.error(errMsg(e)));
  };
  const toggle = (on: boolean) =>
    api.setAutoUpdate(on).then(setInfo, (e) => message.error(errMsg(e)));

  return (
    <>
      <div className="setting-group">更新</div>
      <div className="setting-item">
        <div className="setting-switch-row">
          <span className="setting-label">自动检查更新</span>
          <Switch className="auto-update-switch" checked={info.settings.autoUpdate} onChange={toggle} />
        </div>
        <div className="setting-desc">
          打开软件后和每隔 6 小时检查一次 GitHub 上有没有新版本，有了在右下角提示，由你决定什么时候更新，不会自己安装。
          更新时先保存打开着的待办，软件退出、装好后自动重新打开；待办数据和设置都不动。
        </div>
        <div className="update-row">
          <span className="update-current">当前版本 {status.current}</span>
          <Button size="small" className="check-update" loading={status.checking} onClick={check}>
            检查更新
          </Button>
        </div>
        <div className={`update-state${status.error && !status.available ? " error-text" : ""}`}>
          <span>{updateStateText(status)}</span>
          {status.available && !status.checking && (
            <Button size="small" type="primary" className="settings-update-now" onClick={startUpdate}>
              立即更新
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
