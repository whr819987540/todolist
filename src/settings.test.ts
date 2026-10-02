// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, SettingsInfo } from "./types";

// CLAUDE.md：编辑区背景色在设置的「外观」里修改，立即生效；背景色存在设置文件里。
// 改了立即生效、停顿片刻再存盘；存盘期间又改了的，下一次接着存，不能丢。

const DEFAULTS: AppSettings = {
  toggleShortcut: "Ctrl+Alt+T",
  toggleDoneShortcut: "Ctrl+Alt+D",
  openExternalShortcut: "Ctrl+Alt+O",
  sidebarFontSize: 14,
  editorFontSize: 15,
  editorBackground: "beige",
  editorCustomColor: "#c7edcc",
  saveDelaySecs: 180,
  autoSave: false,
  startupView: "home",
  theme: "system",
  editShortcuts: {},
};
const info = (settings: Partial<AppSettings> = {}): SettingsInfo => ({
  settings: { ...DEFAULTS, ...settings },
  defaults: DEFAULTS,
  toggleShortcutRegistered: true,
});

/** 后端的 set_editor_background：先挂起，由测试决定什么时候完成，模拟存盘还没完成时又改了 */
const pending: (() => void)[] = [];
vi.mock("./api", () => ({
  errMsg: (e: unknown) => String(e),
  api: {
    getSettings: vi.fn(async () => info()),
    setTheme: vi.fn(async () => info()),
    setFontSize: vi.fn(async () => info()),
    setSaveOptions: vi.fn(async () => info()),
    setEditorBackground: vi.fn(
      (background: AppSettings["editorBackground"], customColor: string) =>
        new Promise<SettingsInfo>((resolve) => pending.push(() => resolve(info({ editorBackground: background, editorCustomColor: customColor })))),
    ),
  },
}));

const { api } = await import("./api");
const { SettingsProvider, useSettings } = await import("./settings");

let ctx: ReturnType<typeof useSettings>;
function Grab() {
  const value = useSettings();
  useEffect(() => {
    ctx = value;
  });
  return null;
}

let unmount: () => void;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.setItem("themeInSettings", "1");
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(createElement(SettingsProvider, { theme: "system", onTheme: () => {}, children: createElement(Grab) }));
  });
  unmount = () => act(() => root.unmount());
});

afterEach(() => {
  unmount();
  vi.useRealTimers();
  pending.length = 0;
  vi.mocked(api.setEditorBackground).mockClear();
});

const settle = () => act(async () => {
  await vi.advanceTimersByTimeAsync(400);
});

describe("编辑区背景色存盘", () => {
  it("改了立即生效，停顿片刻后连同自定义颜色一起存盘", async () => {
    act(() => ctx.setEditorBackground("custom", "#112233"));
    expect(ctx.info?.settings.editorBackground).toBe("custom");
    await settle();
    pending.shift()?.();
    await settle();
    expect(vi.mocked(api.setEditorBackground).mock.calls).toEqual([["custom", "#112233"]]);
  });

  it("存盘还没完成时又换了背景色（颜色没变）：换的这一次也存盘，不丢", async () => {
    act(() => ctx.setEditorBackground("custom"));
    await settle(); // 开始存「自定义」，还没完成
    act(() => ctx.setEditorBackground("beige"));
    pending.shift()?.(); // 「自定义」存完
    await settle(); // 接着存「护眼米色」
    pending.shift()?.();
    await settle();
    const calls = vi.mocked(api.setEditorBackground).mock.calls;
    expect(calls[calls.length - 1]).toEqual(["beige", "#c7edcc"]);
    expect(ctx.info?.settings.editorBackground).toBe("beige");
  });
});
