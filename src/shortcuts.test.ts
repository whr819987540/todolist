import { describe, expect, it } from "vitest";
import {
  checkShortcut,
  eventShortcut,
  isRefreshShortcut,
  keyName,
  normalizeShortcut,
  reservedShortcut,
  sameShortcut,
  shortcutLabel,
} from "./shortcuts";

const ev = (code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

describe("按键事件 → 快捷键", () => {
  it("修饰键按 Ctrl、Alt、Shift 的顺序，字母和数字去掉 Key / Digit 前缀", () => {
    expect(eventShortcut(ev("KeyT", { ctrl: true, alt: true }))).toBe("Ctrl+Alt+T");
    expect(eventShortcut(ev("Digit5", { alt: true, shift: true }))).toBe("Alt+Shift+5");
    expect(eventShortcut(ev("BracketLeft", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+BracketLeft");
    expect(eventShortcut(ev("F5"))).toBe("F5");
  });

  it("只按了修饰键时不算", () => {
    expect(eventShortcut(ev("ControlLeft", { ctrl: true }))).toBeNull();
    expect(keyName("ShiftRight")).toBeNull();
  });

  it("按物理位置认键，不受输入法、Shift 后的字符影响", () => {
    // 中文输入法下按 Ctrl+Shift+[ 时 key 可能是「【」，code 仍是 BracketLeft
    expect(eventShortcut({ ...ev("BracketLeft", { ctrl: true, shift: true }), key: "【" } as never)).toBe(
      "Ctrl+Shift+BracketLeft",
    );
  });
});

describe("刷新的按键", () => {
  it("F5、Ctrl+R 刷新", () => {
    expect(isRefreshShortcut(ev("F5"))).toBe(true);
    expect(isRefreshShortcut(ev("KeyR", { ctrl: true }))).toBe(true);
  });

  it("带了别的修饰键的不算（这些组合可以设成自定义快捷键，不能一按就同时刷新）", () => {
    expect(isRefreshShortcut(ev("F5", { ctrl: true }))).toBe(false);
    expect(isRefreshShortcut(ev("F5", { alt: true }))).toBe(false);
    expect(isRefreshShortcut(ev("KeyR", { ctrl: true, shift: true }))).toBe(false);
    expect(isRefreshShortcut(ev("KeyR", { ctrl: true, alt: true }))).toBe(false);
    expect(isRefreshShortcut(ev("KeyR"))).toBe(false);
  });

  it("带修饰键的 F5、Ctrl+R 可以录成自定义快捷键", () => {
    expect(checkShortcut("Ctrl+F5")).toBeNull();
    expect(checkShortcut("Ctrl+Alt+R")).toBeNull();
  });
});

describe("比较快捷键", () => {
  it("设置文件里手改的大小写、写法不同也算同一个", () => {
    expect(normalizeShortcut("ctrl+alt+KeyD")).toBe("CTRL+ALT+D");
    expect(sameShortcut("Alt+Ctrl+d", "Ctrl+Alt+D")).toBe(true);
    expect(sameShortcut("Control+Digit1", "Ctrl+1")).toBe(true);
    expect(sameShortcut("Ctrl+D", "Ctrl+Shift+D")).toBe(false);
  });

  it("没设置（不使用）的不和任何快捷键相同", () => {
    expect(sameShortcut(null, "Ctrl+D")).toBe(false);
    expect(sameShortcut(undefined, undefined)).toBe(false);
  });

  it("显示成 Ctrl + Shift + [ 这样", () => {
    expect(shortcutLabel("Ctrl+Shift+BracketLeft")).toBe("Ctrl + Shift + [");
    expect(shortcutLabel("Ctrl+Alt+T")).toBe("Ctrl + Alt + T");
  });
});

describe("录制快捷键时的检查", () => {
  it("要包含 Ctrl 或 Alt", () => {
    expect(checkShortcut("Shift+T")).toMatch(/Ctrl 或 Alt/);
    expect(checkShortcut("Ctrl+Alt+Y")).toBeNull();
    expect(checkShortcut("Alt+Shift+5")).toBeNull();
  });

  it("软件内置的、文本编辑常用的组合不能用", () => {
    for (const s of ["Ctrl+S", "Ctrl+F", "Ctrl+N", "Ctrl+Z", "Ctrl+Y", "Ctrl+C", "Ctrl+V", "Ctrl+Slash", "Alt+ArrowUp"]) {
      expect(checkShortcut(s), s).toMatch(/请换一个/);
    }
  });

  it("Ctrl+Shift+1（显示 / 隐藏大纲）算已占用", () => {
    expect(checkShortcut("Ctrl+Shift+1")).toBe("Ctrl + Shift + 1 是常用的「显示 / 隐藏大纲」快捷键，请换一个");
  });

  it("Ctrl+F、Ctrl+H（正文里的查找、替换）算已占用", () => {
    expect(checkShortcut("Ctrl+F")).toBe("Ctrl + F 是常用的「查找」快捷键，请换一个");
    expect(checkShortcut("Ctrl+H")).toBe("Ctrl + H 是常用的「替换」快捷键，请换一个");
  });

  it("Ctrl+Shift+F（侧栏 / 首页的搜索）算已占用", () => {
    expect(checkShortcut("Ctrl+Shift+F")).toBe("Ctrl + Shift + F 是常用的「搜索」快捷键，请换一个");
    expect(reservedShortcut("shift+ctrl+KeyF")).toBe("搜索");
  });

  it("F5 和 Ctrl+R（刷新）算已占用", () => {
    expect(checkShortcut("F5")).toBe("F5 是常用的「刷新」快捷键，请换一个");
    expect(checkShortcut("Ctrl+R")).toBe("Ctrl + R 是常用的「刷新」快捷键，请换一个");
    expect(reservedShortcut("ctrl+KeyR")).toBe("刷新");
    expect(reservedShortcut("Ctrl+Alt+R")).toBeNull();
  });

  it("Ctrl+W、Ctrl+Tab、Ctrl+Shift+Tab（关闭 / 切换标签）算已占用", () => {
    expect(checkShortcut("Ctrl+W")).toBe("Ctrl + W 是常用的「关闭标签」快捷键，请换一个");
    expect(reservedShortcut("ctrl+Tab")).toBe("下一个标签");
    expect(reservedShortcut("Shift+Ctrl+Tab")).toBe("上一个标签");
    expect(reservedShortcut("Ctrl+Alt+W")).toBeNull();
  });

  it("和其他已经用着的快捷键重复时说明是哪个", () => {
    const taken = [{ key: "Ctrl+Alt+D", label: "「标记完成 / 未完成」" }];
    expect(checkShortcut("Ctrl+Alt+D", taken)).toBe("Ctrl + Alt + D 已用于「标记完成 / 未完成」，请换一个");
    expect(checkShortcut("Ctrl+Alt+E", taken)).toBeNull();
  });
});
