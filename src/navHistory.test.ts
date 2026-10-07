import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Place } from "./navHistory";

// docs/requirements.md「鼠标侧键后退 / 前进」：在这次运行期间看过的地方之间来回，和浏览器一样——首页、工作区概览、项目概览、
// 待办各算一处，在中间某处又去了新的地方时前进的记录清掉；用键盘在左侧列表里连着移动、停不到 1 秒就移走的不算看过。
// 工作区 / 项目改名、待办移动后跟着走，删除的不再回去；最多记 100 处。

type Nav = typeof import("./navHistory");
let nav: Nav;

beforeEach(async () => {
  // 记录在模块里，每个用例用一份新的
  vi.resetModules();
  nav = await import("./navHistory");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T10:00:00"));
});

afterEach(() => {
  vi.useRealTimers();
});

const ws = (workspace: string): Place => ({ workspace });
const project = (workspace: string, p: string): Place => ({ workspace, project: p });
const todo = (workspace: string, p: string, todoId: string): Place => ({ workspace, project: p, todoId });

/** 一路后退，返回经过的地方（不含当前这处） */
function backAll(): Place[] {
  const out: Place[] = [];
  for (let p = nav.go(-1); p !== undefined; p = nav.go(-1)) out.push(p);
  return out;
}

describe("后退、前进", () => {
  it("和浏览器一样按顺序来回；到头时不动", () => {
    nav.visit(null);
    nav.visit(ws("工作"));
    nav.visit(project("工作", "需求"));
    expect(nav.go(1)).toBeUndefined();
    expect(nav.go(-1)).toEqual(ws("工作"));
    expect(nav.go(-1)).toBeNull(); // 首页
    expect(nav.go(-1)).toBeUndefined();
    expect(nav.go(1)).toEqual(ws("工作"));
    expect(nav.go(1)).toEqual(project("工作", "需求"));
  });

  it("首页、工作区概览、项目概览、待办各算一处", () => {
    nav.visit(null);
    nav.visit(ws("工作"));
    nav.visit(project("工作", "需求"));
    nav.visit(todo("工作", "需求", "20260926-153012"));
    expect(backAll()).toEqual([project("工作", "需求"), ws("工作"), null]);
  });

  it("和当前这处一样时不重复记", () => {
    nav.visit(ws("工作"));
    nav.visit(ws("工作"));
    nav.visit(project("工作", "需求"));
    expect(backAll()).toEqual([ws("工作")]);
  });

  it("在中间某处又去了新的地方：前进的记录清掉", () => {
    nav.visit(ws("A"));
    nav.visit(ws("B"));
    nav.visit(ws("C"));
    nav.go(-1); // B
    nav.visit(ws("D"));
    expect(nav.go(1)).toBeUndefined();
    expect(nav.go(-1)).toEqual(ws("B"));
    expect(nav.go(-1)).toEqual(ws("A"));
  });

  it("后退、前进到的地方再记一次（右侧跟着显示）不算新去的地方", () => {
    nav.visit(ws("A"));
    nav.visit(ws("B"));
    const back = nav.go(-1)!;
    nav.visit(back);
    expect(nav.go(1)).toEqual(ws("B"));
  });

  it("最多记 100 处，超出时忘掉最早的", () => {
    for (let i = 1; i <= 105; i++) nav.visit(ws(`工作区${i}`));
    const back = backAll();
    expect(back).toHaveLength(99);
    expect(back[back.length - 1]).toEqual(ws("工作区6"));
  });

  it("右侧自动改了显示（replace）：替换当前这处，不多记一处", () => {
    nav.visit(ws("工作"));
    nav.visit(todo("工作", "需求", "a"));
    nav.visit(project("工作", "需求"), "replace");
    expect(nav.go(-1)).toEqual(ws("工作"));
    expect(nav.go(1)).toEqual(project("工作", "需求"));
  });
});

describe("用键盘在左侧列表里连着移动", () => {
  it("停不到 1 秒就移走的不算看过", () => {
    nav.visit(ws("工作"));
    nav.visit(project("工作", "甲"), "keyboard");
    vi.advanceTimersByTime(300);
    nav.visit(project("工作", "乙"), "keyboard");
    vi.advanceTimersByTime(300);
    nav.visit(project("工作", "丙"), "keyboard");
    expect(backAll()).toEqual([ws("工作")]);
  });

  it("停了 1 秒以上的算看过", () => {
    nav.visit(ws("工作"));
    nav.visit(project("工作", "甲"), "keyboard");
    vi.advanceTimersByTime(1500);
    nav.visit(project("工作", "乙"), "keyboard");
    expect(backAll()).toEqual([project("工作", "甲"), ws("工作")]);
  });

  it("用鼠标点过去的不受影响", () => {
    nav.visit(ws("工作"));
    nav.visit(project("工作", "甲"));
    nav.visit(project("工作", "乙"), "keyboard");
    expect(backAll()).toEqual([project("工作", "甲"), ws("工作")]);
  });
});

describe("改名、移动、删除之后跟着走", () => {
  beforeEach(() => {
    nav.visit(null);
    nav.visit(ws("工作"));
    nav.visit(project("工作", "需求"));
    nav.visit(todo("工作", "需求", "a"));
    nav.visit(ws("生活"));
  });

  it("项目改名", () => {
    nav.mapPlaces(([w, p, id]) => [w, w === "工作" && p === "需求" ? "需求池" : p, id]);
    expect(backAll()).toEqual([todo("工作", "需求池", "a"), project("工作", "需求池"), ws("工作"), null]);
  });

  it("待办移到别的工作区（id 可能变）", () => {
    nav.mapPlaces((k) => (k[0] === "工作" && k[1] === "需求" && k[2] === "a" ? ["生活", "杂事", "a-2"] : k));
    expect(backAll()).toEqual([todo("生活", "杂事", "a-2"), project("工作", "需求"), ws("工作"), null]);
  });

  it("删除的不再回去，前后相同的两处并成一处，当前位置不变", () => {
    nav.mapPlaces((k) => (k[0] === "工作" && k[1] === "需求" ? null : k));
    expect(backAll()).toEqual([ws("工作"), null]);
    expect(nav.go(1)).toEqual(ws("工作"));
    expect(nav.go(1)).toEqual(ws("生活"));
  });

  it("当前这处被删了：退到它前面最近的一处", () => {
    nav.mapPlaces((k) => (k[0] === "生活" ? null : k));
    expect(nav.go(1)).toBeUndefined();
    expect(nav.go(-1)).toEqual(project("工作", "需求"));
  });
});
