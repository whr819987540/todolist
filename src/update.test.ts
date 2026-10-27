// @vitest-environment happy-dom
import { App as AntApp } from "antd";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "./types";
import {
  compareVersions,
  outcomeMessage,
  progressPercent,
  progressText,
  replacesFailure,
  shouldPrompt,
  startUpdate,
  updateStateText,
  useUpdatePrompt,
} from "./update";

// 「立即更新」的流程（useUpdatePrompt）用的 Rust 端命令、事件和退出前写盘换成假的：事件记下回调，用例里直接调
const tauri = vi.hoisted(() => ({ events: new Map<string, (e: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    tauri.events.set(name, cb);
    return () => tauri.events.delete(name);
  },
}));
// useAppEvent（设置里的「立即更新」经它发给 useUpdatePrompt）也收 Rust 端发给这个窗口的同名事件：换成什么都不收的
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: async () => () => {} }),
}));
const mocked = vi.hoisted(() => {
  const api = {
    getUpdateStatus: vi.fn(),
    takeUpdateOutcome: vi.fn(async () => null),
    // 同 Rust 端：下载前重新检查一次，默认服务器上还是检查到的那个版本，下载好后返回它
    downloadUpdate: vi.fn(async (): Promise<string | null> => (await api.getUpdateStatus())?.available?.version ?? null),
    installUpdate: vi.fn(async () => {}),
    showMain: vi.fn(async () => {}),
  };
  return { api, flushBeforeQuit: vi.fn() };
});
vi.mock("./api", () => ({ api: mocked.api, errMsg: (e: unknown) => String(e) }));
vi.mock("./hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hooks")>()),
  flushBeforeQuit: mocked.flushBeforeQuit,
}));

const status = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({
  current: "0.1.2",
  checking: false,
  checkedAt: null,
  error: null,
  available: null,
  ...patch,
});

describe("新版本的提示", () => {
  it("检查到新版本时提示，点过「以后再说」的版本这次运行期间不再提示", () => {
    const found = status({ available: { version: "0.1.3", notes: "" } });
    expect(shouldPrompt(status(), new Set())).toBe(false);
    expect(shouldPrompt(found, new Set())).toBe(true);
    expect(shouldPrompt(found, new Set(["0.1.3"]))).toBe(false);
    // 又发布了更新的版本：再提示
    expect(shouldPrompt(status({ available: { version: "0.1.4", notes: "" } }), new Set(["0.1.3"]))).toBe(true);
  });
});

describe("版本号的大小", () => {
  it("逐段按数字比，预发布版比正式版小，+ 后面的不算", () => {
    expect(compareVersions("0.1.4", "0.1.3")).toBeGreaterThan(0);
    expect(compareVersions("0.1.3", "0.1.4")).toBeLessThan(0);
    expect(compareVersions("0.1.3", "0.1.3")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3+build.5", "1.2.3")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0-beta")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
  });
});

// docs/requirements.md「自动更新 → 立即更新」：出错的提示留着，直到关掉或点「重试」；再检查到同一个版本时不换掉，
// 检查到版本号更大的新版本时换成新版本的提示，没有新版本了时收起
describe("更新失败的提示换不换掉", () => {
  it("检查到版本号更大的新版本、没有新版本了时换掉；同一个版本（检查开始时、检查失败时也是）不换", () => {
    const at = (version: string | null, patch: Partial<UpdateStatus> = {}) =>
      status({ available: version ? { version, notes: "" } : null, ...patch });
    expect(replacesFailure(at("0.1.3"), "0.1.3")).toBe(false);
    expect(replacesFailure(at("0.1.3", { checking: true }), "0.1.3")).toBe(false);
    expect(replacesFailure(at("0.1.3", { error: "连不上更新服务器" }), "0.1.3")).toBe(false);
    expect(replacesFailure(at("0.1.4"), "0.1.3")).toBe(true);
    expect(replacesFailure(at("0.1.10"), "0.1.9")).toBe(true);
    expect(replacesFailure(at(null), "0.1.3")).toBe(true);
  });
});

describe("下载进度", () => {
  it("知道安装包多大时显示百分比和 MB", () => {
    const p = { version: "0.1.3", downloaded: 1.5 * 1024 * 1024, total: 3 * 1024 * 1024 };
    expect(progressPercent(p)).toBe(50);
    expect(progressText(p)).toBe("正在下载 1.5 / 3.0 MB");
    expect(progressPercent({ version: "0.1.3", downloaded: 10, total: 10 })).toBe(100);
  });

  it("不知道大小、还没开始时", () => {
    expect(progressPercent({ version: "0.1.3", downloaded: 1024 * 1024, total: null })).toBeNull();
    expect(progressText({ version: "0.1.3", downloaded: 1024 * 1024, total: null })).toBe("正在下载 1.0 MB");
    expect(progressPercent(null)).toBeNull();
    expect(progressText(null)).toBe("正在下载…");
    // 下载前先告诉要下载哪个版本，还没收到数据
    expect(progressText({ version: "0.1.3", downloaded: 0, total: null })).toBe("正在下载…");
  });
});

describe("设置里检查更新的结果", () => {
  it("正在检查、有新版本、检查失败、已是最新、没检查过", () => {
    expect(updateStateText(status({ checking: true, available: { version: "0.1.3", notes: "" } }))).toBe("正在检查…");
    expect(updateStateText(status({ available: { version: "0.1.3", notes: "" }, error: "连不上" }))).toBe("发现新版本 0.1.3");
    expect(updateStateText(status({ error: "连不上更新服务器", checkedAt: 1 }))).toBe("检查失败：连不上更新服务器");
    expect(updateStateText(status({ checkedAt: new Date(2026, 9, 13, 15, 2, 0).getTime() }))).toBe(
      "已是最新版本（2026-10-13 15:02:00 检查）",
    );
    expect(updateStateText(status())).toBe("还没有检查过");
  });
});

describe("更新完重新打开时", () => {
  it("装好了提示新版本，没装好提示可以再检查", () => {
    expect(outcomeMessage({ from: "0.1.2", to: "0.1.3", done: true })).toEqual({ type: "success", text: "已更新到 0.1.3" });
    const failed = outcomeMessage({ from: "0.1.2", to: "0.1.3", done: false });
    expect(failed.type).toBe("warning");
    expect(failed.text).toContain("没能更新到 0.1.3");
  });
});

// docs/requirements.md「自动更新 → 立即更新」：下载前重新检查一次，按服务器上现在的版本下载（提示里的版本号跟着变，
// 没有新版本了时不更新）；下载好后保存打开着的待办，另存也失败、10 秒内没存完时问是否仍要更新（主窗口藏在托盘里时
// 先调出来），不更新时回到发现新版本的提示（之前点过「以后再说」的也是）
describe("「立即更新」", () => {
  let unmount = () => {};
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // 打开时还没检查到新版本
    mocked.api.getUpdateStatus.mockResolvedValue(status());
    function Probe() {
      useUpdatePrompt();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(AntApp, null, createElement(Probe))));
    unmount = () => act(() => root.unmount());
  });
  afterEach(() => {
    unmount();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  /** 等到 fn() 为真（让 React、antd 的提示渲染完），最多 ms 毫秒；返回最后一次的结果 */
  async function until(fn: () => boolean, ms = 2000) {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await act(() => new Promise((r) => setTimeout(r, 20)));
    return fn();
  }
  /** 右下角的提示（关掉了的还在淡出，不算） */
  const notice = () => [...document.querySelectorAll(".update-notice:not(.ant-notification-fade-leave)")];
  /** 右下角是发现新版本 version 的提示，有「立即更新」「以后再说」 */
  const prompting = (version: string) =>
    notice().length === 1 &&
    !!notice()[0].textContent?.includes(`发现新版本 ${version}`) &&
    !!notice()[0].querySelector(".update-now") &&
    !!notice()[0].querySelector(".update-later");
  const confirmTitle = () => document.querySelector(".ant-modal-confirm-title")?.textContent ?? "";
  const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
  const confirmButton = (text: string) =>
    [...document.querySelectorAll(".ant-modal-confirm-btns button")].find((b) => b.textContent?.replace(/\s/g, "") === text);
  /** 同 Rust 端检查开始、检查完时发的 update-status */
  const emitStatus = async (s: UpdateStatus) => {
    mocked.api.getUpdateStatus.mockResolvedValue(s);
    await act(async () => tauri.events.get("update-status")?.({ payload: s }));
  };
  /** 检查到了新版本 version */
  const found = async (version: string) => {
    const s = status({ available: { version, notes: "" } });
    await emitStatus(s);
    return s;
  };
  /** 右下角是更新失败的提示：写着原因 reason，有「重试」 */
  const failing = (reason: string) =>
    notice().length === 1 &&
    !!notice()[0].textContent?.includes("更新失败") &&
    !!notice()[0].textContent?.includes(reason) &&
    !!notice()[0].querySelector(".update-retry");
  /** 点右下角的「立即更新」，下载时出错（reason） */
  const failDownload = async (reason: string) => {
    mocked.api.downloadUpdate.mockRejectedValueOnce(reason);
    await click(notice()[0].querySelector(".update-now"));
    expect(await until(() => failing(reason))).toBe(true);
  };

  it("另存也失败：问是否仍要更新，选「先不更新」时不安装，回到发现新版本的提示", async () => {
    await found("0.1.3");
    expect(await until(() => prompting("0.1.3"))).toBe(true);
    mocked.flushBeforeQuit.mockResolvedValue("failed");
    await click(notice()[0].querySelector(".update-now"));
    expect(await until(() => !!confirmButton("先不更新"))).toBe(true);
    expect(confirmTitle()).toBe("有修改没能保存");
    await click(confirmButton("先不更新"));
    expect(await until(() => prompting("0.1.3"))).toBe(true);
    expect(mocked.api.installUpdate).not.toHaveBeenCalled();
  });

  it("点过「以后再说」、再从设置里点「立即更新」，10 秒内没存完时选「先不更新」：也回到发现新版本的提示", async () => {
    await found("0.1.4");
    expect(await until(() => prompting("0.1.4"))).toBe(true);
    await click(notice()[0].querySelector(".update-later"));
    // 点了「以后再说」的版本再检查到时不提示
    await found("0.1.4");
    expect(await until(() => notice().length === 0)).toBe(true);
    mocked.flushBeforeQuit.mockResolvedValue("timeout");
    await act(async () => startUpdate());
    expect(await until(() => !!confirmButton("先不更新"))).toBe(true);
    expect(confirmTitle()).toBe("还没保存完");
    await click(confirmButton("先不更新"));
    expect(await until(() => prompting("0.1.4"))).toBe(true);
    expect(mocked.api.installUpdate).not.toHaveBeenCalled();
  });

  it("问之前先调出主窗口（可能藏在托盘里），同从托盘退出时存不上", async () => {
    await found("0.1.5");
    let askedBeforeShown = true;
    mocked.api.showMain.mockImplementationOnce(async () => {
      askedBeforeShown = !!confirmButton("先不更新");
    });
    mocked.flushBeforeQuit.mockResolvedValue("failed");
    await act(async () => startUpdate());
    expect(await until(() => !!confirmButton("先不更新"))).toBe(true);
    expect(mocked.api.showMain).toHaveBeenCalledTimes(1);
    expect(askedBeforeShown).toBe(false);
    await click(confirmButton("先不更新"));
    expect(await until(() => prompting("0.1.5"))).toBe(true);
  });

  it("下载前重新检查到了又发布的更新的版本：下载它，提示里的版本号跟着变；「先不更新」后提示这个版本", async () => {
    await found("0.1.3");
    expect(await until(() => prompting("0.1.3"))).toBe(true);
    let finishDownload: (v: string | null) => void = () => {};
    mocked.api.downloadUpdate.mockImplementationOnce(() => new Promise((r) => (finishDownload = r)));
    mocked.flushBeforeQuit.mockResolvedValue("failed");
    await click(notice()[0].querySelector(".update-now"));
    const updating = (version: string) => !!notice()[0]?.textContent?.includes(`正在更新到 ${version}`);
    expect(await until(() => updating("0.1.3"))).toBe(true);
    // 同 Rust 端：重新检查到了 0.1.4（检查完发 update-status），下载前先发一个带着版本号的进度
    const newer = status({ available: { version: "0.1.4", notes: "又一版" } });
    mocked.api.getUpdateStatus.mockResolvedValue(newer);
    await act(async () => tauri.events.get("update-status")?.({ payload: newer }));
    await act(async () => tauri.events.get("update-progress")?.({ payload: { version: "0.1.4", downloaded: 0, total: null } }));
    expect(await until(() => updating("0.1.4"))).toBe(true);
    await act(async () => finishDownload("0.1.4"));
    expect(await until(() => !!confirmButton("先不更新"))).toBe(true);
    await click(confirmButton("先不更新"));
    expect(await until(() => prompting("0.1.4"))).toBe(true);
    expect(mocked.api.installUpdate).not.toHaveBeenCalled();
  });

  it("更新失败的提示留着：再检查到同一个版本（检查开始、检查完、检查失败时）不换成发现新版本的提示", async () => {
    const s = await found("0.1.3");
    expect(await until(() => prompting("0.1.3"))).toBe(true);
    await failDownload("下载的安装包和签名对不上");
    await emitStatus({ ...s, checking: true });
    await emitStatus({ ...s, checkedAt: 1 });
    await emitStatus({ ...s, error: "连不上更新服务器", checkedAt: 2 });
    expect(await until(() => prompting("0.1.3"), 300)).toBe(false);
    expect(failing("下载的安装包和签名对不上")).toBe(true);
  });

  it("更新失败的提示在时检查到版本号更大的新版本：换成它的提示；检查到没有新版本了：收起", async () => {
    await found("0.1.3");
    expect(await until(() => prompting("0.1.3"))).toBe(true);
    await failDownload("连不上更新服务器");
    await found("0.1.4");
    expect(await until(() => prompting("0.1.4"))).toBe(true);
    await failDownload("连不上更新服务器");
    await emitStatus(status({ checkedAt: 3 }));
    expect(await until(() => notice().length === 0)).toBe(true);
  });

  it("关掉更新失败的提示后照常：再检查到这个版本时提示发现新版本；点「重试」重新下载", async () => {
    await found("0.1.3");
    expect(await until(() => prompting("0.1.3"))).toBe(true);
    await failDownload("连不上更新服务器");
    await click(notice()[0].querySelector(".ant-notification-notice-close"));
    expect(await until(() => notice().length === 0)).toBe(true);
    await found("0.1.3");
    expect(await until(() => prompting("0.1.3"))).toBe(true);
    await failDownload("连不上更新服务器");
    mocked.flushBeforeQuit.mockResolvedValue("failed");
    await click(notice()[0].querySelector(".update-retry"));
    expect(await until(() => !!confirmButton("先不更新"))).toBe(true);
    expect(mocked.api.downloadUpdate).toHaveBeenCalledTimes(3);
  });

  it("下载前重新检查时服务器上已经没有新版本了：不下载、不安装，收起提示，说已是最新版本", async () => {
    await found("0.1.3");
    expect(await until(() => prompting("0.1.3"))).toBe(true);
    mocked.api.downloadUpdate.mockResolvedValueOnce(null);
    await click(notice()[0].querySelector(".update-now"));
    expect(await until(() => notice().length === 0)).toBe(true);
    const toast = () => document.querySelector(".ant-message-notice")?.textContent ?? "";
    expect(await until(() => toast().includes("已是最新版本"))).toBe(true);
    expect(mocked.flushBeforeQuit).not.toHaveBeenCalled();
    expect(mocked.api.installUpdate).not.toHaveBeenCalled();
  });
});
