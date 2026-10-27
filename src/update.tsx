// 自动更新的界面：发现新版本时在右下角提示，「立即更新」时下载新版本、保存打开着的待办（同从托盘退出），
// 再运行安装程序（软件随即退出，装好后重新打开）。检查、下载、安装在 Rust 端（lib.rs 的「自动更新」）
import { listen } from "@tauri-apps/api/event";
import { App as AntApp, Button, Progress, Space } from "antd";
import { useEffect, useRef } from "react";
import { api, errMsg } from "./api";
import { emitAppEvent, flushBeforeQuit, type QuitFlush, unsavedWarning, useAppEvent } from "./hooks";
import type { UpdateOutcome, UpdateProgress, UpdateStatus } from "./types";
import { fullTime } from "./utils";

const NOTICE_KEY = "update";

/** 这次运行期间点了「以后再说」（或关掉了提示）的版本：不再提示；下次打开软件、检查到更新的版本时再提示 */
const dismissed = new Set<string>();

/** 要不要在右下角提示检查到的新版本 */
export function shouldPrompt(status: UpdateStatus, dismissedVersions: ReadonlySet<string>): boolean {
  return !!status.available && !dismissedVersions.has(status.available.version);
}

/**
 * 比较两个版本号，a 大时为正数、一样时为 0（语义化版本：x.y.z 逐段按数字比；1.0.0-beta 这样的预发布版比 1.0.0 小，
 * 预发布标识逐段比，数字的按数字比、比字母的小；+ 后面的不算）
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const s = v.trim().replace(/^v/i, "").split("+")[0];
    const dash = s.indexOf("-");
    const core = (dash < 0 ? s : s.slice(0, dash)).split(".").map((n) => Number.parseInt(n, 10) || 0);
    return { core, pre: dash < 0 ? null : s.slice(dash + 1).split(".") };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return Math.sign(d);
  }
  // 正式版比同号的预发布版大
  if (!x.pre || !y.pre) return (x.pre ? -1 : 0) + (y.pre ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    // 前面都一样时，段多的大
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * 更新失败的提示（更新到 failed 这个版本时失败的，写着原因、有「重试」）显示着时，检查的结果 s 换不换掉它：
 * 检查到版本号更大的新版本（换成它的提示）、已经没有新版本了（收起）时换；再检查到同一个版本（检查开始时、检查失败时
 * 之前检查到的也留着）时不换，免得原因还没看到就没了
 */
export function replacesFailure(s: UpdateStatus, failed: string): boolean {
  return !s.available || compareVersions(s.available.version, failed) > 0;
}

/** 下载进度的百分比（0～100）；不知道安装包多大时为 null */
export function progressPercent(p: UpdateProgress | null): number | null {
  if (!p?.total) return null;
  return Math.min(100, Math.floor((p.downloaded / p.total) * 100));
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** 下载进度的文字：已下载 / 一共多少 MB；还没开始（下载前先告诉要下载哪个版本，还没收到数据）时只说正在下载 */
export function progressText(p: UpdateProgress | null): string {
  if (!p || (!p.downloaded && !p.total)) return "正在下载…";
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

/** 设置里的「立即更新」（startUpdate）发给主窗口里 useUpdatePrompt 的事件，走同一个流程 */
const START_UPDATE = "start-update";

/** 下载并安装检查到的新版本（设置里的「立即更新」），进度显示在右下角的提示里 */
export function startUpdate() {
  emitAppEvent(START_UPDATE);
}

/** 主窗口里：发现新版本时在右下角提示；刚更新完时提示更新好了没有 */
export function useUpdatePrompt() {
  const { notification, modal, message } = AntApp.useApp();
  const apis = useRef({ notification, modal, message });
  useEffect(() => {
    apis.current = { notification, modal, message };
  });
  // 「立即更新」的流程在下面的 effect 里，挂上后经它收设置里的「立即更新」
  const runUpdate = useRef<() => void>(() => {});
  useAppEvent(START_UPDATE, () => runUpdate.current());

  useEffect(() => {
    let busy = false;
    let cancelled = false;
    /** 右下角显示着更新失败的提示时，是更新到哪个版本时失败的（不知道时为空串，检查到哪个新版本都换掉它）；没有时为 null */
    let failed: string | null = null;
    const { notification } = apis.current;

    const prompt = (s: UpdateStatus) => {
      if (busy) return;
      if (failed !== null) {
        // 失败的提示留着，直到用户关掉或点「重试」；检查到版本号更大的新版本、没有新版本了时才换掉
        if (!replacesFailure(s, failed)) return;
        failed = null;
        if (!shouldPrompt(s, dismissed)) {
          notification.destroy(NOTICE_KEY);
          return;
        }
      }
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

    /** 更新到 version 时失败了：提示原因，可以重试 */
    const fail = (reason: string, version: string) => {
      busy = false;
      failed = version;
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
        // 用户关掉了：之后照常，再检查到这个版本时提示发现新版本（没点过「以后再说」的）
        onClose: () => {
          failed = null;
        },
      });
    };

    /**
     * 有修改没存好时问还更不更新。主窗口可能藏在托盘里（点了「立即更新」后，下载时关到了托盘）：先调出来再问，
     * 同从托盘退出时存不上（App.tsx 的 quit），不然确认框弹在看不见的窗口里，更新停在那里
     */
    const confirmUnsaved = async (r: Exclude<QuitFlush, "saved">) => {
      await api.showMain().catch(() => {});
      return new Promise<boolean>((resolve) => {
        apis.current.modal.confirm({
          ...unsavedWarning(r, "更新"),
          okText: "仍然更新",
          okButtonProps: { danger: true },
          cancelText: "先不更新",
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
    };

    async function run() {
      if (busy) return;
      busy = true;
      // 失败的提示（点了「重试」）接下来换成进度、收起，或者再失败时换成新的
      failed = null;
      let status: UpdateStatus;
      try {
        status = await api.getUpdateStatus();
      } catch (e) {
        return fail(errMsg(e), "");
      }
      const found = status.available?.version;
      if (!found) {
        busy = false;
        notification.destroy(NOTICE_KEY);
        apis.current.message.info("没有检查到新版本");
        return;
      }
      // 提示里写的版本：下载前 Rust 端重新检查一次，可能又发布了更新的版本，跟着进度里的走
      let version = found;
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
        version = e.payload.version;
        showProgress();
      });
      let downloaded: string | null;
      try {
        downloaded = await api.downloadUpdate();
      } catch (e) {
        return fail(errMsg(e), version);
      } finally {
        unlisten();
      }
      if (!downloaded) {
        // 重新检查时服务器上已经没有新版本了（发布的版本撤了）：不更新，收起提示
        busy = false;
        notification.destroy(NOTICE_KEY);
        apis.current.message.info(`已是最新版本（更新服务器上已经没有 ${version} 了）`);
        return;
      }
      version = downloaded;
      // 软件马上要退出：先保存打开着的待办，同从托盘退出（存不上的另存为新待办）
      showStep(version, "正在保存打开着的待办…");
      const saved = await flushBeforeQuit();
      if (saved !== "saved" && !(await confirmUnsaved(saved))) {
        // 先不更新：回到发现新版本的提示。用户刚刚自己点了更新，之前点过「以后再说」的这个版本也提示，
        // 不然「正在保存打开着的待办…」（关不掉）一直留在右下角
        dismissed.delete(version);
        busy = false;
        // 按现在检查到的：下载前重新检查过，版本可能换了
        prompt(await api.getUpdateStatus().catch(() => status));
        return;
      }
      showStep(version, "正在启动安装程序：软件会先退出，装好后自动重新打开。");
      try {
        await api.installUpdate();
      } catch (e) {
        fail(errMsg(e), version);
      }
    }

    runUpdate.current = () => void run();
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
      runUpdate.current = () => {};
      unlisten.then((f) => f());
    };
  }, []);
}
