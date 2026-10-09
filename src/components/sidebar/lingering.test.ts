// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLingeringProjects } from "./lingering";
import type { Lingering, Selection } from "./tree";

// docs/requirements.md「隐藏全部完成的项目」：右侧正在显示的全部完成的项目，切到别处后再显示 1 秒（比 Windows 的双击间隔长）
// 才藏起来；这 1 秒里切回它就接着显示；又换了右侧显示的内容（包括又点了一下正显示着的）时重新计时，切走过的在最后一次
// 换了 1 秒后一起藏起来

let lingering: Lingering;
/** 离开的项目要不要留（会不会被藏起来） */
let keep: (workspace: string, project: string) => boolean;

function Probe({ sel }: { sel: Selection }) {
  const value = useLingeringProjects(sel, (ws, p) => keep(ws, p));
  useEffect(() => {
    lingering = value;
  });
  return null;
}

let root: Root;
let mounted: boolean;
/** 右侧改显示 sel（每次点击都是新的对象） */
const show = (workspace: string, project?: string, todoId?: string) =>
  act(() => root.render(createElement(Probe, { sel: { workspace, project, todoId } })));
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const names = () => [...lingering].flatMap(([ws, s]) => [...s].map((p) => `${ws}/${p}`)).sort();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  keep = () => true;
  root = createRoot(document.createElement("div"));
  mounted = true;
});

afterEach(() => {
  if (mounted) act(() => root.unmount());
  vi.useRealTimers();
});

describe("切到别处后再显示一会儿", () => {
  it("切走后再显示 1 秒，然后藏起来", () => {
    show("工作", "P", "x");
    show("工作", "Q", "y");
    expect(names()).toEqual(["工作/P"]);
    wait(999);
    expect(names()).toEqual(["工作/P"]);
    wait(1);
    expect(names()).toEqual([]);
  });

  it("不会被藏起来的项目（没开这一项、没全部完成、在搜索）：不记，不计时", () => {
    keep = () => false;
    show("工作", "P", "x");
    show("工作", "Q", "y");
    expect(names()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("这 1 秒里又点了一下正显示着的：从这一下起重新算 1 秒（接着的双击中间不会藏起来）", () => {
    show("工作", "P", "x");
    show("工作", "Q", "y");
    wait(800);
    show("工作", "Q", "y");
    wait(999);
    expect(names()).toEqual(["工作/P"]);
    wait(1);
    expect(names()).toEqual([]);
  });

  it("这 1 秒里切回它：接着显示，再切走时重新算 1 秒", () => {
    // Q 没全部完成，切走时不会藏起来
    keep = (_ws, p) => p === "P";
    show("工作", "P", "x");
    show("工作", "Q", "y");
    wait(500);
    show("工作", "P");
    expect(names()).toEqual([]);
    wait(2000);
    show("工作", "Q", "y");
    expect(names()).toEqual(["工作/P"]);
    wait(999);
    expect(names()).toEqual(["工作/P"]);
    wait(1);
    expect(names()).toEqual([]);
  });

  it("这 1 秒里又离开另一个全部完成的项目：两个都在最后一次切换 1 秒后一起藏起来", () => {
    keep = (_ws, p) => p.startsWith("P");
    show("工作", "P", "x");
    show("工作", "P2", "z");
    wait(500);
    show("生活", "Q", "y");
    expect(names()).toEqual(["工作/P", "工作/P2"]);
    wait(999);
    expect(names()).toEqual(["工作/P", "工作/P2"]);
    wait(1);
    expect(names()).toEqual([]);
  });

  it("卸载时（回首页等）清掉计时器", () => {
    show("工作", "P", "x");
    show("工作", "Q", "y");
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.unmount());
    mounted = false;
    expect(vi.getTimerCount()).toBe(0);
  });
});
