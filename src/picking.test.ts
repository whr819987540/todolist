import { describe, expect, it } from "vitest";
import { rangePick, togglePick } from "./picking";

// CLAUDE.md「批量操作」：Ctrl+单击加选 / 取消，Shift+单击选中一段

describe("Ctrl+单击", () => {
  it("还没多选时，从正打开着的那条开始", () => {
    expect(togglePick([], "b", "a")).toEqual(["a", "b"]);
  });

  it("没有打开着的、或点的就是打开着的那条：只选这一条", () => {
    expect(togglePick([], "b", null)).toEqual(["b"]);
    expect(togglePick([], "a", "a")).toEqual(["a"]);
  });

  it("已经选中的取消，没选中的加上；多选中不再管打开着的那条", () => {
    expect(togglePick(["a", "b"], "c", "a")).toEqual(["a", "b", "c"]);
    expect(togglePick(["a", "b", "c"], "b", "a")).toEqual(["a", "c"]);
    expect(togglePick(["b", "c"], "a", "a")).toEqual(["b", "c", "a"]);
  });
});

describe("Shift+单击", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("按显示顺序选中两端之间的一段，往上往下都行", () => {
    expect(rangePick(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangePick(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangePick(order, "c", "c")).toEqual(["c"]);
  });

  it("有一头不在列表里时不选", () => {
    expect(rangePick(order, "x", "b")).toBeNull();
    expect(rangePick(order, "b", "x")).toBeNull();
  });
});
