// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushBeforeQuit, registerFlusher } from "./hooks";

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
