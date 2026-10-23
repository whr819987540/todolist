// @vitest-environment happy-dom
import { App as AntApp } from "antd";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "./types";
import {
  outcomeMessage,
  progressPercent,
  progressText,
  shouldPrompt,
  startUpdate,
  unsavedWarning,
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
const mocked = vi.hoisted(() => ({
  api: {
    getUpdateStatus: vi.fn(),
    takeUpdateOutcome: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => {}),
    installUpdate: vi.fn(async () => {}),
  },
  flushBeforeQuit: vi.fn(),
}));
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

describe("下载进度", () => {
  it("知道安装包多大时显示百分比和 MB", () => {
    const p = { downloaded: 1.5 * 1024 * 1024, total: 3 * 1024 * 1024 };
    expect(progressPercent(p)).toBe(50);
    expect(progressText(p)).toBe("正在下载 1.5 / 3.0 MB");
    expect(progressPercent({ downloaded: 10, total: 10 })).toBe(100);
  });

  it("不知道大小、还没开始时", () => {
    expect(progressPercent({ downloaded: 1024 * 1024, total: null })).toBeNull();
    expect(progressText({ downloaded: 1024 * 1024, total: null })).toBe("正在下载 1.0 MB");
    expect(progressPercent(null)).toBeNull();
    expect(progressText(null)).toBe("正在下载…");
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

describe("更新前有修改没存好", () => {
  it("存不下来、没存完时说明现在更新会丢掉修改", () => {
    expect(unsavedWarning("failed")).toEqual({
      title: "有修改没能保存",
      content: "正在编辑的待办里有修改没能保存下来（见上方的提示），现在更新会丢掉这些修改。",
    });
    expect(unsavedWarning("timeout").content).toBe("正在编辑的内容 10 秒内没有保存完，现在更新可能丢掉还没保存的修改。");
  });
});

// docs/requirements.md「自动更新 → 立即更新」：下载好后保存打开着的待办，另存也失败、10 秒内没存完时问是否仍要更新，
// 不更新时回到发现新版本的提示（之前点过「以后再说」的也是）
describe("「立即更新」时打开着的待办没存好", () => {
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
  /** 检查到了新版本 version：同 Rust 端检查完发的 update-status */
  const found = async (version: string) => {
    const s = status({ available: { version, notes: "" } });
    mocked.api.getUpdateStatus.mockResolvedValue(s);
    await act(async () => tauri.events.get("update-status")?.({ payload: s }));
    return s;
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
});
