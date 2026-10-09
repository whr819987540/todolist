import { App as AntApp } from "antd";
import { useCallback } from "react";
import { api, errMsg } from "../../api";
import { restoreConfirmText, restoreData } from "../../dataBackup";
import type { DataBackupInfo, DataRestoreDone } from "../../types";

/**
 * 恢复待办数据（本地文件、WebDAV 上的都用它）：先确认（写明备份的时间、会替换现在的全部待办数据、
 * 现在的数据先备份到哪里），确认后经 dataBackup.ts 的 restoreData 恢复，成功后整页重新加载；失败时说明原因
 */
export function useDataRestore() {
  const { modal } = AntApp.useApp();
  return useCallback(
    async (backup: { time: number; info?: DataBackupInfo }, run: () => Promise<DataRestoreDone>) => {
      const status = await api.getAutoBackupStatus().catch(() => null);
      modal.confirm({
        title: "恢复待办数据？",
        content: restoreConfirmText(backup, status?.dir ?? ""),
        okText: "恢复",
        okButtonProps: { danger: true },
        cancelText: "取消",
        width: 480,
        onOk: async () => {
          try {
            await restoreData(run);
          } catch (e) {
            modal.error({ title: "恢复失败", content: errMsg(e), width: 480 });
          }
        },
      });
    },
    [modal],
  );
}
