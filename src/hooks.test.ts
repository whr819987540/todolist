// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAppEvent, flushBeforeQuit, holdDataRefresh, registerFlusher, useAppEvent, useWindowFocus } from "./hooks";

// Tauri 的窗口事件换成假的：记下注册的回调，用例里直接调
const tauri = vi.hoisted(() => ({
  focus: [] as ((e: { payload: boolean }) => void)[],
  events: [] as { name: string; cb: (e: { payload: unknown }) => void }[],
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async (cb: (e: { payload: boolean }) => void) => {
      tauri.focus.push(cb);
      return () => {};
    },
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
      tauri.events.push({ name, cb });
      return () => {};
    },
  }),
}));

// docs/requirements.md「窗口与系统集成」：只有从托盘菜单「退出」才真正结束程序，退出前要保存正在编辑的内容；
// 「感知外部修改」：存不上的另存为新待办，等这些做完再退出；另存也失败、一直没存完时不退出（问用户）

const unregister: (() => void)[] = [];
afterEach(() => {
  unregister.splice(0).forEach((u) => u());
  vi.useRealTimers();
});
const add = (flush: (quitting: boolean) => Promise<unknown>, todo = false) => unregister.push(registerFlusher(flush, todo));

describe("从托盘退出前写盘（flushBeforeQuit）", () => {
  it("都存好了（另存为新待办也算）：可以退出；正在编辑的待办按退出的方式存", async () => {
    const editor = vi.fn(async () => true);
    add(editor, true);
    add(async () => undefined);
    expect(await flushBeforeQuit()).toBe("saved");
    expect(editor).toHaveBeenCalledWith(true);
  });

  it("正在编辑的待办有存不下来的：不退出", async () => {
    add(async () => false, true);
    add(async () => undefined);
    expect(await flushBeforeQuit()).toBe("failed");
  });

  it("出错了也不退出", async () => {
    add(async () => {
      throw new Error("x");
    });
    expect(await flushBeforeQuit()).toBe("failed");
  });

  it("先存完正在编辑的待办，再写别的（另存时记下的新待办的编辑位置要一起写进界面状态）", async () => {
    const order: string[] = [];
    add(async () => {
      order.push("界面状态");
    });
    add(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("待办");
      return true;
    }, true);
    expect(await flushBeforeQuit()).toBe("saved");
    expect(order).toEqual(["待办", "界面状态"]);
  });

  it("等得够久，另存不会被截断；一直没存完时不退出", async () => {
    vi.useFakeTimers();
    let finish: (v: boolean) => void = () => {};
    add(() => new Promise<boolean>((r) => (finish = r)), true);
    let result = "";
    const done = flushBeforeQuit(10_000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result).toBe("");
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(result).toBe("timeout");
    finish(true);
  });
});

// docs/requirements.md「数据备份 → 恢复数据」「监听数据目录」：恢复期间数据目录被整个换掉，这期间不刷新
describe("恢复待办数据期间不刷新（holdDataRefresh）", () => {
  it("Rust 端、前端自己发的 data-changed，快速记录的 open-todo，窗口获得焦点都不交给回调；失去焦点、别的事件照常；放开后照常", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const got: string[] = [];
    function Probe() {
      useWindowFocus((focused) => got.push(focused ? "获得焦点" : "失去焦点"));
      useAppEvent("data-changed", () => got.push("data-changed"));
      useAppEvent("open-todo", () => got.push("open-todo"));
      useAppEvent("auto-backup", () => got.push("auto-backup"));
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    const fireAll = () => {
      for (const cb of tauri.focus) {
        cb({ payload: true });
        cb({ payload: false });
      }
      for (const { cb } of tauri.events) cb({ payload: null });
      emitAppEvent("data-changed");
    };
    holdDataRefresh(true);
    fireAll();
    expect(got).toEqual(["失去焦点", "auto-backup"]);
    got.length = 0;
    holdDataRefresh(false);
    fireAll();
    expect(got.sort()).toEqual(["auto-backup", "data-changed", "data-changed", "open-todo", "失去焦点", "获得焦点"].sort());
    act(() => root.unmount());
  });
});
