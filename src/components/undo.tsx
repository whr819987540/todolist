import { App as AntApp } from "antd";
import { useCallback } from "react";
import { api, errMsg } from "../api";
import { projectLabel } from "../projects";
import type { Restored, RestoreResult } from "../types";

/** 撤销删除的提示停留多久（秒） */
const UNDO_SECONDS = 8;

/** 恢复到了哪里，给提示用：「工作 / 需求开发」，改了名的说明一下 */
export function restoredPlace(r: Restored): string {
  const where = r.project ? `${r.workspace} / ${projectLabel(r.project)}` : r.workspace;
  if (!r.renamed) return `「${where}」`;
  return `「${where}」（原来的名字已被占用，改了名）`;
}

/**
 * 删除之后弹出带「撤销」的提示：点撤销时把回收站里的 ids 恢复到原来的位置。
 * 恢复了之后 Rust 端通知主窗口刷新（data-changed），after 在这之外做点别的（如重新打开删掉的那条待办）
 */
export function useUndoDelete() {
  const { message } = AntApp.useApp();
  return useCallback(
    (text: string, ids: string[], after?: (r: RestoreResult) => void) => {
      if (!ids.length) return;
      const key = `undo:${ids.join(",")}`;
      const undo = async () => {
        message.destroy(key);
        try {
          const r = await api.restoreRecycled(ids);
          if (!r.restored.length) {
            message.error(`撤销失败：${r.errors[0] ?? "回收站里已经没有了"}`);
            return;
          }
          const renamed = r.restored.find((x) => x.renamed);
          if (r.errors.length) message.warning(`恢复了 ${r.restored.length} 项，${r.errors.length} 项没恢复：${r.errors[0]}`);
          else if (renamed) message.success(`已撤销删除，恢复到${restoredPlace(renamed)}`);
          else message.success("已撤销删除");
          after?.(r);
        } catch (e) {
          message.error(`撤销失败：${errMsg(e)}`);
        }
      };
      message.open({
        key,
        type: "success",
        duration: UNDO_SECONDS,
        content: (
          <span>
            {text}
            <a className="undo-link" onClick={undo}>
              撤销
            </a>
          </span>
        ),
      });
    },
    [message],
  );
}
