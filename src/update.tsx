// 自动更新的界面：发现新版本时在右下角提示，「立即更新」时下载新版本、保存打开着的待办（同从托盘退出），
// 再运行安装程序（软件随即退出，装好后重新打开）。检查、下载、安装在 Rust 端（lib.rs 的「自动更新」）
import { listen } from "@tauri-apps/api/event";
import { App as AntApp, Button, Progress, Space } from "antd";
import { useEffect, useRef } from "react";
import { api, errMsg } from "./api";
import { flushBeforeQuit, type QuitFlush, QUIT_FLUSH_TIMEOUT } from "./hooks";
import type { UpdateOutcome, UpdateProgress, UpdateStatus } from "./types";
import { fullTime } from "./utils";

const NOTICE_KEY = "update";

/** 这次运行期间点了「以后再说」（或关掉了提示）的版本：不再提示；下次打开软件、检查到更新的版本时再提示 */
const dismissed = new Set<string>();

/** 要不要在右下角提示检查到的新版本 */
export function shouldPrompt(status: UpdateStatus, dismissedVersions: ReadonlySet<string>): boolean {
  return !!status.available && !dismissedVersions.has(status.available.version);
}

/** 下载进度的百分比（0～100）；不知道安装包多大时为 null */
export function progressPercent(p: UpdateProgress | null): number | null {
  if (!p?.total) return null;
  return Math.min(100, Math.floor((p.downloaded / p.total) * 100));
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** 下载进度的文字：已下载 / 一共多少 MB */
export function progressText(p: UpdateProgress | null): string {
  if (!p) return "正在下载…";
  return p.total ? `正在下载 ${mb(p.downloaded)} / ${mb(p.total)} MB` : `正在下载 ${mb(p.downloaded)} MB`;
}

/** 设置里检查更新的结果怎么写 */
export function updateStateText(s: UpdateStatus): string {
  if (s.checking) return "正在检查…";
  if (s.available) return `发现新版本 ${s.available.version}`;
  if (s.error) return `检查失败：${s.error}`;
  if (s.checkedAt) return `已是最新版本（${fullTime(s.checkedAt)} 检查）`;
  return "还没有检查过";
}

/** 刚更新完重新打开时的提示 */
export function outcomeMessage(o: UpdateOutcome): { type: "success" | "warning"; text: string } {
  return o.done
    ? { type: "success", text: `已更新到 ${o.to}` }
    : { type: "warning", text: `没能更新到 ${o.to}（安装没有完成），可以在「设置 → 常规」里再检查更新` };
}

/** 下载好新版本后保存打开着的待办没存好时说明什么 */
export function unsavedWarning(r: Exclude<QuitFlush, "saved">): { title: string; content: string } {
  return r === "failed"
    ? { title: "有修改没能保存", content: "正在编辑的待办里有修改没能保存下来（见上方的提示），现在更新会丢掉这些修改。" }
    : {
        title: "还没保存完",
        content: `正在编辑的内容 ${QUIT_FLUSH_TIMEOUT / 1000} 秒内没有保存完，现在更新可能丢掉还没保存的修改。`,
      };
}

/** 主窗口里的 useUpdatePrompt 注册的「立即更新」，设置里的按钮经 startUpdate 调它 */
let runUpdate: (() => void) | null = null;

/** 下载并安装检查到的新版本（设置里的「立即更新」），进度显示在右下角的提示里 */
export function startUpdate() {
  runUpdate?.();
}

/** 主窗口里：发现新版本时在右下角提示；刚更新完时提示更新好了没有 */
export function useUpdatePrompt() {
  const { notification, modal, message } = AntApp.useApp();
  const apis = useRef({ notification, modal, message });
  useEffect(() => {
    apis.current = { notification, modal, message };
  });

  useEffect(() => {
    let busy = false;
    let cancelled = false;
    const { notification } = apis.current;

    const prompt = (s: UpdateStatus) => {
      if (busy) return;
      if (!shouldPrompt(s, dismissed)) {
        // 再检查时没有新版本了（如发布的版本撤了）：收起提示；点过「以后再说」的已经收起
        if (!s.available) notification.destroy(NOTICE_KEY);
        return;
      }
      const { version, notes } = s.available!;
      const later = () => {
        dismissed.add(version);
        notification.destroy(NOTICE_KEY);
      };
      notification.open({
        key: NOTICE_KEY,
        className: "update-notice",
        placement: "bottomRight",
        duration: false,
        title: `发现新版本 ${version}`,
        description: (
          <>
            <div>现在用的是 {s.current}。</div>
            {notes && <div className="update-notes">{notes}</div>}
          </>
        ),
        actions: (
          <Space>
            <Button size="small" className="update-later" onClick={later}>
              以后再说
            </Button>
            <Button size="small" type="primary" className="update-now" onClick={run}>
              立即更新
            </Button>
          </Space>
        ),
        onClose: () => {
          if (!busy) dismissed.add(version);
        },
      });
    };

    const showStep = (version: string, description: React.ReactNode) =>
      notification.open({
        key: NOTICE_KEY,
        className: "update-notice",
        placement: "bottomRight",
        duration: false,
        closable: false,
        title: `正在更新到 ${version}`,
        description,
      });

    const fail = (reason: string) => {
      busy = false;
      notification.open({
        key: NOTICE_KEY,
        className: "update-notice",
        placement: "bottomRight",
        duration: false,
        title: "更新失败",
        description: <div className="update-error">{reason}</div>,
        actions: (
          <Button size="small" className="update-retry" onClick={run}>
            重试
          </Button>
        ),
      });
    };

    /** 有修改没存好时问还更不更新 */
    const confirmUnsaved = (r: Exclude<QuitFlush, "saved">) =>
      new Promise<boolean>((resolve) => {
        const { title, content } = unsavedWarning(r);
        apis.current.modal.confirm({
          title,
          content,
          okText: "仍然更新",
          okButtonProps: { danger: true },
          cancelText: "先不更新",
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });

    async function run() {
      if (busy) return;
      busy = true;
      let status: UpdateStatus;
      try {
        status = await api.getUpdateStatus();
      } catch (e) {
        return fail(errMsg(e));
      }
      const version = status.available?.version;
      if (!version) {
        busy = false;
        notification.destroy(NOTICE_KEY);
        apis.current.message.info("没有检查到新版本");
        return;
      }
      let progress: UpdateProgress | null = null;
      const showProgress = () =>
        showStep(
          version,
          <div className="update-progress">
            <div>{progressText(progress)}</div>
            <Progress percent={progressPercent(progress) ?? 0} size="small" showInfo={false} />
          </div>,
        );
      showProgress();
      const unlisten = await listen<UpdateProgress>("update-progress", (e) => {
        progress = e.payload;
        showProgress();
      });
      try {
        await api.downloadUpdate();
      } catch (e) {
        return fail(errMsg(e));
      } finally {
        unlisten();
      }
      // 软件马上要退出：先保存打开着的待办，同从托盘退出（存不上的另存为新待办）
      showStep(version, "正在保存打开着的待办…");
      const saved = await flushBeforeQuit();
      if (saved !== "saved" && !(await confirmUnsaved(saved))) {
        busy = false;
        prompt(status);
        return;
      }
      showStep(version, "正在启动安装程序：软件会先退出，装好后自动重新打开。");
      try {
        await api.installUpdate();
      } catch (e) {
        fail(errMsg(e));
      }
    }

    runUpdate = () => void run();
    api.getUpdateStatus().then((s) => cancelled || prompt(s), () => {});
    const unlisten = listen<UpdateStatus>("update-status", (e) => prompt(e.payload));
    // 刚更新完重新打开：提示装好了没有（Rust 端只给一次）
    api.takeUpdateOutcome().then((o) => {
      if (!o) return;
      const { type, text } = outcomeMessage(o);
      apis.current.message[type]({ content: text, className: "update-outcome", duration: 8 });
    }, () => {});
    return () => {
      cancelled = true;
      runUpdate = null;
      unlisten.then((f) => f());
    };
  }, []);
}
