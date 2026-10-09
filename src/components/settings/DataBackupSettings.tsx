import { DownloadOutlined, FolderOpenOutlined, UploadOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Checkbox, Input, InputNumber, Switch } from "antd";
import { useCallback, useEffect, useState } from "react";
import { api, errMsg } from "../../api";
import { autoBackupStatusText, backupDoneText } from "../../dataBackup";
import { useAppEvent } from "../../hooks";
import { AUTO_BACKUP_KEEP_LIMITS, useSettings } from "../../settings";
import type { AutoBackupStatus } from "../../types";
import { useDataRestore } from "./dataRestore";

type AutoBackupOptions = Parameters<typeof api.setAutoBackup>[0];

/** 「备份与恢复」里待办数据的两节：手动备份到本地 / 从本地恢复，自动备份（WebDAV 上的在 BackupSettings 里） */
export default function DataBackupSettings({ webdavConfigured }: { webdavConfigured: boolean }) {
  const { message } = AntApp.useApp();
  const { info, setInfo } = useSettings();
  const confirmRestore = useDataRestore();
  const [status, setStatus] = useState<AutoBackupStatus | null>(null);
  const [busy, setBusy] = useState<"pickSave" | "saving" | "pickOpen" | "dir" | null>(null);

  const refresh = useCallback(() => {
    api.getAutoBackupStatus().then(setStatus, () => {});
  }, []);
  // 打开时、换了备份目录（包括恢复了设置）时读一次；自动备份开始、结束时 Rust 端通知
  const dir = info?.settings.autoBackupDir;
  useEffect(() => {
    api.getAutoBackupStatus().then(setStatus, () => {});
  }, [dir]);
  useAppEvent("auto-backup", refresh);

  if (!info) return null;
  const s = info.settings;

  const run = async (kind: NonNullable<typeof busy> | null, fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const setAuto = (patch: Partial<AutoBackupOptions>) =>
    run(null, async () => {
      const current = { enabled: s.autoBackup, dir: s.autoBackupDir, keep: s.autoBackupKeep, webdav: s.autoBackupWebdav };
      setInfo(await api.setAutoBackup({ ...current, ...patch }));
      refresh();
    });

  const onBackupFile = () =>
    run("pickSave", async () => {
      const path = await api.pickDataBackupTarget();
      if (!path) return;
      setBusy("saving");
      message.success(backupDoneText(await api.backupDataToFile(path), "local"));
      refresh();
    });

  const onRestoreFile = () =>
    run("pickOpen", async () => {
      const path = await api.pickDataBackupFile();
      if (!path) return;
      const backup = await api.inspectDataBackup(path);
      await confirmRestore({ time: backup.time, info: backup }, () => api.restoreDataFromFile(path));
    });

  const onPickDir = () =>
    run("dir", async () => {
      const picked = await api.pickBackupDir();
      if (picked) await setAuto({ dir: picked });
    });

  const shown = status && autoBackupStatusText(status, s.autoBackup);

  return (
    <>
      <div className="setting-group">待办数据</div>
      <div className="setting-desc">
        把全部工作区、项目、待办（含附件和界面状态）打包成 zip，不含回收站、设置和密码。恢复时用备份替换现在的全部待办数据，替换前先自动备份一份现在的。
      </div>
      <div className="backup-bar">
        <Button
          className="data-backup-file"
          icon={<DownloadOutlined />}
          loading={busy === "pickSave" || busy === "saving"}
          onClick={onBackupFile}
        >
          {busy === "saving" ? "正在备份…" : "备份数据到本地…"}
        </Button>
        <Button
          className="data-restore-file"
          icon={<UploadOutlined />}
          loading={busy === "pickOpen"}
          onClick={onRestoreFile}
        >
          从本地文件恢复数据…
        </Button>
      </div>

      <div className="setting-group">自动备份</div>
      <div className="setting-item">
        <div className="setting-switch-row">
          <span className="setting-label">每天自动备份待办数据</span>
          <Switch className="auto-backup-switch" checked={s.autoBackup} onChange={(on) => setAuto({ enabled: on })} />
        </div>
        <div className="setting-desc">
          启动时和运行期间（藏在托盘里也照常）检查，距上次自动备份满 24 小时、数据有变化时备份一份；失败时不弹窗，在下面显示原因。
        </div>
        <div className={`auto-backup-status${shown?.error ? " failed" : ""}`}>
          <div className="muted">{shown?.text ?? "…"}</div>
          {shown?.error && <div className="error-text">{shown.error}</div>}
        </div>
      </div>
      <div className="setting-item">
        <div className="setting-label">备份目录</div>
        <div className="setting-row backup-dir-row">
          <Input className="backup-dir" readOnly value={status?.dir ?? ""} title={status?.dir} />
          <Button loading={busy === "dir"} onClick={onPickDir}>
            更改…
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => run(null, api.openBackupDir)}>
            打开
          </Button>
        </div>
        <div className="setting-desc">
          {s.autoBackupDir ? (
            <>
              默认是数据目录旁边的 {status?.defaultDir}
              <Button type="link" size="small" className="backup-dir-reset" onClick={() => setAuto({ dir: "" })}>
                恢复默认
              </Button>
            </>
          ) : (
            "默认是数据目录旁边的这个文件夹；不能选在数据目录里面。"
          )}
        </div>
      </div>
      <div className="setting-item">
        <div className="setting-row">
          <span>保留最近</span>
          <InputNumber
            className="auto-backup-keep"
            size="small"
            min={AUTO_BACKUP_KEEP_LIMITS.min}
            max={AUTO_BACKUP_KEEP_LIMITS.max}
            precision={0}
            value={s.autoBackupKeep}
            onChange={(v) => v != null && v !== s.autoBackupKeep && setAuto({ keep: v })}
          />
          <span>份</span>
          {s.autoBackupKeep !== info.defaults.autoBackupKeep && (
            <Button type="link" size="small" onClick={() => setAuto({ keep: info.defaults.autoBackupKeep })}>
              恢复默认（{info.defaults.autoBackupKeep}）
            </Button>
          )}
        </div>
        <div className="setting-desc">
          每次自动备份后删掉多出来的最旧的（{AUTO_BACKUP_KEEP_LIMITS.min}–{AUTO_BACKUP_KEEP_LIMITS.max} 份）；恢复前的那份（…-恢复前.zip）不算、不删。
        </div>
        <Checkbox
          className="auto-backup-webdav"
          checked={s.autoBackupWebdav}
          disabled={!webdavConfigured && !s.autoBackupWebdav}
          onChange={(e) => setAuto({ webdav: e.target.checked })}
        >
          同时上传到 WebDAV
          <span className="muted">
            {webdavConfigured ? "（远程目录里同样只留最近这么多份）" : "（需先在下面配置 WebDAV 服务器）"}
          </span>
        </Checkbox>
      </div>
    </>
  );
}
