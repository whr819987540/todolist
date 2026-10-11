// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoBackupStatus, DataRestoreDone } from "./types";

// docs/requirements.md「数据备份」：恢复前先保存正在编辑的待办，之后界面状态不再写盘，免得内存里的标签、编辑位置等
// 稍后写盘时把恢复出来的 .state.json 覆盖掉；恢复成功后整个界面重新加载、提示恢复了什么；失败时界面不重新加载，
// 界面状态照常写盘。备份、恢复的提示写明文件名 / 几个工作区几条待办，自动备份失败时在设置里写明原因

vi.mock("./api", () => ({
  api: {
    readUiState: vi.fn(async () => null),
    writeUiState: vi.fn(async () => {}),
  },
}));

let api: (typeof import("./api"))["api"];
let state: typeof import("./workspaceState");
let hooks: typeof import("./hooks");
let backup: typeof import("./dataBackup");

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  ({ api } = await import("./api"));
  state = await import("./workspaceState");
  hooks = await import("./hooks");
  backup = await import("./dataBackup");
  await state.loadUiState();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const DONE: DataRestoreDone = {
  workspaces: 2,
  todos: 5,
  time: new Date(2026, 9, 9, 15, 30, 12).getTime(),
  before: "C:\\Users\\me\\TodoList-backups\\TodoList-data-20261009-160000-恢复前.zip",
};

describe("恢复待办数据", () => {
  it("先保存正在编辑的待办、写掉没写盘的界面状态，之后不再写盘，恢复完整页重新加载", async () => {
    const order: string[] = [];
    hooks.registerFlusher(async () => {
      order.push("保存正在编辑的待办");
    }, true);
    vi.mocked(api.writeUiState).mockImplementation(async () => {
      order.push("写界面状态");
    });
    // 还没写盘的改动（5 秒内才写）
    state.writeOpenWorkspaces(["工作"]);
    const reload = vi.fn();
    const result = await backup.restoreData(async () => {
      order.push("恢复");
      // 恢复期间内存里的界面状态又变了（如刷新后关掉了不在了的待办的标签）
      state.writeOpenWorkspaces(["生活"]);
      return DONE;
    }, reload);
    expect(result).toBe(DONE);
    expect(order).toEqual(["保存正在编辑的待办", "写界面状态", "恢复"]);
    expect(vi.mocked(api.writeUiState).mock.calls[0][0]).toContain("工作");
    expect(reload).toHaveBeenCalledTimes(1);

    // 重新加载之前，过了写盘的时间、又隐藏到托盘（立即写盘）：都不写，恢复出来的 .state.json 不会被覆盖
    await vi.advanceTimersByTimeAsync(10_000);
    await hooks.flushAll();
    expect(api.writeUiState).toHaveBeenCalledTimes(1);

    // 重新加载后取出恢复的结果，只取一次
    expect(backup.takeRestoreNotice()).toEqual(DONE);
    expect(backup.takeRestoreNotice()).toBeNull();
  });

  it("恢复失败：不重新加载，界面状态照常写盘", async () => {
    const reload = vi.fn();
    await expect(
      backup.restoreData(async () => {
        state.writeOpenWorkspaces(["生活"]);
        throw "备份里有不安全的路径";
      }, reload),
    ).rejects.toBe("备份里有不安全的路径");
    expect(reload).not.toHaveBeenCalled();
    expect(api.writeUiState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.writeUiState).toHaveBeenLastCalledWith(expect.stringContaining("生活"));
    expect(backup.takeRestoreNotice()).toBeNull();
  });

  // 「监听数据目录」「恢复数据」：恢复时数据目录里的工作区被整个换掉，监听会看到一大批变化；这期间不刷新，
  // 免得读到换掉之后、整页重新加载之前的数据，报「工作区不存在」
  it("恢复期间不刷新（监听到的变化、窗口获得焦点、F5），成功后一直到整页重新加载都不刷新", async () => {
    const changed = vi.fn();
    window.addEventListener("app-event:data-changed", changed);
    let during: boolean | null = null;
    expect(hooks.dataRefreshHeld()).toBe(false);
    await backup.restoreData(async () => {
      during = hooks.dataRefreshHeld();
      return DONE;
    }, vi.fn());
    expect(during).toBe(true);
    expect(hooks.dataRefreshHeld()).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    window.removeEventListener("app-event:data-changed", changed);
  });

  it("恢复失败（数据没换）：照常刷新，先刷新一次", async () => {
    const changed = vi.fn();
    window.addEventListener("app-event:data-changed", changed);
    await expect(
      backup.restoreData(async () => {
        expect(hooks.dataRefreshHeld()).toBe(true);
        throw "恢复失败，「工作」可能有文件正被其他程序占用";
      }, vi.fn()),
    ).rejects.toContain("恢复失败");
    expect(hooks.dataRefreshHeld()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener("app-event:data-changed", changed);
  });

  it("记下的结果坏了时不显示", () => {
    sessionStorage.setItem("dataRestored", "{坏了");
    expect(backup.takeRestoreNotice()).toBeNull();
    sessionStorage.setItem("dataRestored", JSON.stringify({ before: "x" }));
    expect(backup.takeRestoreNotice()).toBeNull();
  });
});

describe("提示的文字", () => {
  it("备份成功：写明存到哪里（本地的是完整路径）、几个工作区几条待办", () => {
    const done = {
      path: "D:\\备份\\TodoList-data-20261009-153012.zip",
      name: "TodoList-data-20261009-153012.zip",
      workspaces: 3,
      todos: 7,
    };
    const local = backup.backupDoneText(done, "local");
    expect(local).toContain("D:\\备份\\TodoList-data-20261009-153012.zip");
    expect(local).toContain("3 个工作区、7 条待办");
    expect(backup.backupDoneText({ ...done, path: done.name }, "webdav")).toContain("WebDAV：TodoList-data-20261009-153012.zip");
  });

  it("恢复成功：写明用哪个时间的备份恢复了几个工作区几条待办，恢复前的数据备份在哪里", () => {
    const text = backup.restoreDoneText(DONE);
    expect(text).toContain("2026-10-09 15:30:12");
    expect(text).toContain("2 个工作区、5 条待办");
    expect(text).toContain(DONE.before);
  });

  it("恢复前确认：写明备份的时间、会替换现在的全部待办数据、现在的先备份到哪里", () => {
    const info = { name: "x.zip", time: DONE.time, workspaces: 4, todos: 9, appVersion: "0.1.0" };
    const local = backup.restoreConfirmText({ time: DONE.time, info }, "C:\\Users\\me\\TodoList-backups");
    expect(local).toContain("2026-10-09 15:30:12");
    expect(local).toContain("4 个工作区、9 条待办");
    expect(local).toContain("替换现在的全部待办数据");
    expect(local).toContain("C:\\Users\\me\\TodoList-backups");
    expect(local).toContain("恢复前");
    // WebDAV 上的只知道时间
    const remote = backup.restoreConfirmText({ time: DONE.time }, "");
    expect(remote).toContain("2026-10-09 15:30:12");
    expect(remote).not.toContain("条待办");
  });

  const status = (patch: Partial<AutoBackupStatus> = {}): AutoBackupStatus => ({
    dir: "C:\\Users\\me\\TodoList-backups",
    defaultDir: "C:\\Users\\me\\TodoList-backups",
    running: false,
    latest: { name: "TodoList-data-20261009-153012.zip", time: DONE.time },
    count: 3,
    lastRun: null,
    ...patch,
  });
  const run = (patch: Partial<NonNullable<AutoBackupStatus["lastRun"]>>) => ({
    time: new Date(2026, 9, 10, 9, 0, 0).getTime(),
    outcome: "done" as const,
    name: null,
    error: null,
    webdavError: null,
    ...patch,
  });

  it("自动备份：上次的时间和份数；没有过时说明；正在备份；关掉了", () => {
    expect(backup.autoBackupStatusText(status(), true)).toEqual({
      text: "上次自动备份：2026-10-09 15:30:12，备份目录里共 3 份",
      error: "",
    });
    expect(backup.autoBackupStatusText(status({ latest: null, count: 0 }), true).text).toBe("还没有自动备份");
    expect(backup.autoBackupStatusText(status({ running: true }), true).text).toBe("正在自动备份…");
    expect(backup.autoBackupStatusText(status(), false).text).toMatch(/^自动备份已关闭。上次自动备份/);
  });

  it("自动备份失败时写明原因；本地好了、上传 WebDAV 失败另外说明；数据没变化时说明跳过", () => {
    const failed = backup.autoBackupStatusText(status({ lastRun: run({ outcome: "failed", error: "无法创建备份目录 X：拒绝访问" }) }), true);
    expect(failed.error).toBe("2026-10-10 09:00:00 自动备份失败：无法创建备份目录 X：拒绝访问");
    const upload = backup.autoBackupStatusText(status({ lastRun: run({ webdavError: "用户名或密码错误（HTTP 401）" }) }), true);
    expect(upload.error).toContain("已备份到本地，上传到 WebDAV 失败：用户名或密码错误（HTTP 401）");
    const unchanged = backup.autoBackupStatusText(status({ lastRun: run({ outcome: "unchanged" }) }), true);
    expect(unchanged.text).toContain("没有变化");
    expect(unchanged.error).toBe("");
  });
});
