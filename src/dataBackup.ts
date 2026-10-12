// 待办数据的备份与恢复（docs/requirements.md「数据备份」）：恢复的流程（先存盘、停掉界面状态写盘、恢复后整页重新加载），
// 重新加载后显示的结果，上次恢复中途退出、启动时处理掉之后的提示，以及提示、确认、自动备份状态的文字。
// 界面在 components/settings/DataBackupSettings.tsx

import { emitAppEvent, flushTodos, holdDataRefresh } from "./hooks";
import type { AutoBackupStatus, DataBackupDone, DataBackupInfo, DataRestoreDone, RestoreRecovery } from "./types";
import { fullTime } from "./utils";
import { resumeUiState, suspendUiState } from "./workspaceState";
import type { DataChanged } from "./watch";

/** 恢复失败后先刷新一次时发的 data-changed：什么都可能变了（同监听到一次变了很多处） */
const ALL_CHANGED: DataChanged = { all: true, paths: [], recycle: true };

/** 恢复成功后整页重新加载，结果记在这里（sessionStorage，只在这个窗口里），重新加载后显示 */
const NOTICE_KEY = "dataRestored";

/** 恢复前打开着的待办有存不上的：不恢复，提示先处理好（同改名、移动、删除前的提示） */
export const UNSAVED_BEFORE_RESTORE = "打开着的待办还没保存好，先处理好再恢复";

/**
 * 恢复待办数据：先保存打开着的待办（分屏时两边的都存，不论 auto save 开没开），有存不上的（冲突、保存失败）就不恢复、
 * 抛出 UNSAVED_BEFORE_RESTORE（恢复后整页重新加载，没存上的修改会丢）；再写掉没写盘的界面状态，之后界面状态不再写盘，
 * 监听到的变化、窗口获得焦点、F5 也不刷新（hooks.ts 的 holdDataRefresh：数据目录正被整个换掉，监听会看到一大批变化）。
 * 恢复成功后记下结果、整页重新加载（回到首页，见 App.tsx），失败时界面状态照常写盘、照常刷新（先刷新一次，
 * 期间外部可能改了什么），把错误抛给调用的地方
 */
export async function restoreData(run: () => Promise<DataRestoreDone>, reload = () => location.reload()): Promise<DataRestoreDone> {
  // 比隐藏到托盘时多等一会儿：没存完就开始恢复的话，这次的修改可能既没进恢复前的备份，也存不进恢复后的数据
  if (!(await flushTodos(15_000))) throw new Error(UNSAVED_BEFORE_RESTORE);
  await suspendUiState();
  holdDataRefresh(true);
  let done: DataRestoreDone;
  try {
    done = await run();
  } catch (e) {
    holdDataRefresh(false);
    resumeUiState();
    // 恢复期间没交给回调的监听到的变化、获得焦点不知道是哪里：当成全部变了刷新一次（分屏两边打开着的待办也核对磁盘）
    emitAppEvent("data-changed", ALL_CHANGED);
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

/**
 * 上次恢复待办数据时中途退出（崩溃、断电、被结束），这次启动时 Rust 端处理掉了留下的临时文件夹：提示一次的样子、标题和各段内容。
 * 换回了恢复前的数据、做完了收尾的说清现在是哪份数据；处理不了、原样留着的说明原因，原来的数据在哪里（临时文件夹里的 old、
 * 恢复前的数据备份）。没有时是 null
 */
export function recoveryNotice(
  list: RestoreRecovery[] | null | undefined,
): { type: "success" | "info" | "warning"; title: string; paragraphs: string[] } | null {
  if (!list?.length) return null;
  const paragraphs = list.map((r) => {
    if (r.outcome === "rolledBack")
      return (
        "上次恢复待办数据没有做完（软件在替换到一半时退出了，或者没能全部换回来）。这次启动时已经换回了恢复前的数据；要用备份恢复的话请再恢复一次。" +
        (r.used
          ? `没换回来的这段时间里软件照常能用，备份里换进来的那部分可能在数据目录里待过、在软件里改过，所以没有删，整个留在 ${r.used}，确认不需要了可以删掉。`
          : "")
      );
    if (r.outcome === "finished")
      return `上次恢复待办数据后没能收尾（软件在替换完之后退出了，或者换下来的数据当时删不掉）。这次启动时做完了收尾：恢复已经完成，现在是备份里的数据。${r.before ? `恢复前的数据备份在 ${r.before}。` : ""}`;
    // 恢复前的数据备份没核对过（读不出来、对不上、不知道是哪份）时不说「数据也在备份里」，也不叫用户删：old 可能是仅有的一份
    const before =
      r.backupOk && r.before
        ? `原来的全部数据也在恢复前的数据备份 ${r.before} 里。`
        : r.oldData
          ? `${r.before ? `恢复前的数据备份 ${r.before} 找不到、读不出来或者对不上，` : ""}old 里的可能是原来的数据仅有的一份，请不要删掉。`
          : "";
    const next = r.retry
      ? "关掉占用文件的程序后重新打开软件，会再试着处理。"
      : r.oldData
        ? "需要的话可以自己把 old 里的工作区搬回数据目录。"
        : "";
    return (
      `上次恢复待办数据时软件中途退出了，留下的临时文件夹没能自动处理：${r.reason ?? "原因不明"}。` +
      `临时文件夹原样留着：${r.staging}（old 里是换下来的原来的数据，new 里是备份里的）。${before}${next}`
    );
  });
  if (list.some((r) => r.outcome === "kept")) return { type: "warning", title: "上次恢复待办数据没有完成", paragraphs };
  if (list.every((r) => r.outcome === "finished")) return { type: "success", title: "上次的恢复已经完成", paragraphs };
  return { type: "info", title: "已换回恢复前的数据", paragraphs };
}

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
    `将用${what}替换现在的全部待办数据（各工作区、各级项目、待办和界面状态），打开着的待办先保存。` +
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
