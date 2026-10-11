// 待办数据的备份与恢复（docs/requirements.md「数据备份」）：恢复的流程（先存盘、停掉界面状态写盘、恢复后整页重新加载），
// 重新加载后显示的结果，以及提示、确认、自动备份状态的文字。界面在 components/settings/DataBackupSettings.tsx

import { emitAppEvent, flushAll, holdDataRefresh } from "./hooks";
import type { AutoBackupStatus, DataBackupDone, DataBackupInfo, DataRestoreDone } from "./types";
import { fullTime } from "./utils";
import { resumeUiState, suspendUiState } from "./workspaceState";

/** 恢复成功后整页重新加载，结果记在这里（sessionStorage，只在这个窗口里），重新加载后显示 */
const NOTICE_KEY = "dataRestored";

/**
 * 恢复待办数据：先保存正在编辑的待办（不论 auto save 开没开）、写掉没写盘的界面状态，之后界面状态不再写盘，
 * 监听到的变化、窗口获得焦点、F5 也不刷新（hooks.ts 的 holdDataRefresh：数据目录正被整个换掉，监听会看到一大批变化）；
 * 恢复成功后记下结果、整页重新加载（回到首页，见 App.tsx），失败时界面状态照常写盘、照常刷新（先刷新一次，
 * 期间外部可能改了什么），把错误抛给调用的地方
 */
export async function restoreData(run: () => Promise<DataRestoreDone>, reload = () => location.reload()): Promise<DataRestoreDone> {
  // 比隐藏到托盘时多等一会儿：没存完就开始恢复的话，这次的修改可能既没进恢复前的备份，也存不进恢复后的数据
  await flushAll(true, 15_000);
  await suspendUiState();
  holdDataRefresh(true);
  let done: DataRestoreDone;
  try {
    done = await run();
  } catch (e) {
    holdDataRefresh(false);
    resumeUiState();
    emitAppEvent("data-changed");
    throw e;
  }
  try {
    sessionStorage.setItem(NOTICE_KEY, JSON.stringify(done));
  } catch {
    /* 记不下就不显示结果，照样重新加载 */
  }
  reload();
  return done;
}

/** 刚恢复完、重新加载后：取出恢复的结果（只取一次），没有时是 null */
export function takeRestoreNotice(): DataRestoreDone | null {
  try {
    const raw = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<DataRestoreDone>) : null;
    if (typeof v?.workspaces !== "number" || typeof v.todos !== "number") return null;
    return { workspaces: v.workspaces, todos: v.todos, time: Number(v.time) || 0, before: String(v.before ?? "") };
  } catch {
    return null;
  }
}

const counts = (workspaces: number, todos: number) => `${workspaces} 个工作区、${todos} 条待办`;

/** 备份成功的提示：存到哪里（本地的是完整路径），备份了几个工作区几条待办 */
export function backupDoneText(done: DataBackupDone, where: "local" | "webdav"): string {
  const target = where === "local" ? done.path : `WebDAV：${done.name}`;
  return `已备份 ${counts(done.workspaces, done.todos)}到 ${target}`;
}

/** 恢复成功后显示的结果 */
export function restoreDoneText(done: DataRestoreDone): string {
  const from = done.time ? `${fullTime(done.time)} 的备份` : "备份";
  return `已用${from}恢复了 ${counts(done.workspaces, done.todos)}。恢复前的数据备份在 ${done.before}`;
}

/**
 * 恢复前确认的内容：会用备份替换现在的全部待办数据（备份的时间；本地文件还有几个工作区几条待办），
 * 现在的数据先自动备份一份到备份目录
 */
export function restoreConfirmText(backup: { time: number; info?: DataBackupInfo }, backupDir: string): string {
  const what = backup.info
    ? `${fullTime(backup.time)} 的备份（${counts(backup.info.workspaces, backup.info.todos)}）`
    : `${fullTime(backup.time)} 的备份`;
  return (
    `将用${what}替换现在的全部待办数据（各工作区、项目、待办和界面状态）。` +
    `现在的数据会先自动备份到${backupDir ? ` ${backupDir} 里` : "备份目录里"}的「…-恢复前.zip」；软件回收站和设置不受影响。恢复后界面会重新加载。`
  );
}

/** 设置里显示的自动备份状态：一行说明，出错时另有一行原因 */
export function autoBackupStatusText(status: AutoBackupStatus, enabled: boolean): { text: string; error: string } {
  const run = status.lastRun;
  let text: string;
  if (status.running) text = "正在自动备份…";
  else if (status.latest) text = `上次自动备份：${fullTime(status.latest.time)}，备份目录里共 ${status.count} 份`;
  else text = "还没有自动备份";
  if (!status.running && run?.outcome === "unchanged") text += "；数据之后没有变化，暂不备份";
  if (!enabled) text = `自动备份已关闭。${text}`;
  let error = "";
  if (run?.outcome === "failed") error = `${fullTime(run.time)} 自动备份失败：${run.error ?? "原因不明"}`;
  else if (run?.webdavError) error = `${fullTime(run.time)} 已备份到本地，上传到 WebDAV 失败：${run.webdavError}`;
  return { text, error };
}
