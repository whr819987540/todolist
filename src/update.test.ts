import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "./types";
import { outcomeMessage, progressPercent, progressText, shouldPrompt, unsavedWarning, updateStateText } from "./update";

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
