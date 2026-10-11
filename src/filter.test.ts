import { describe, expect, it, vi } from "vitest";
import {
  clearFilter,
  countPriorities,
  describeFilter,
  dropTagFromFilter,
  filterByTag,
  isFiltering,
  matchFilter,
  NO_FILTER,
  onlyTag,
  readFilter,
  renameTagInFilter,
  setFilter,
  subscribeFilter,
  type TodoFilter,
  togglePriority,
  toggleTag,
} from "./filter";
import type { Priority } from "./types";

// docs/requirements.md「筛选（按标签和优先级）」：标签之间「任一」（默认）或「全部」，几个优先级之间「任一」，
// 标签和优先级之间「并且」；侧栏顶部写明筛的是什么；点了某个标签就只按它筛（优先级不变）；标签改名、删除后
// 筛选里跟着改；只记在这次运行期间

const t = (tags: string[], priority: Priority = 0) => ({ tags, priority });
const f = (o: Partial<TodoFilter>): TodoFilter => ({ ...NO_FILTER, ...o });

describe("符不符合筛选", () => {
  it("没开筛选时都符合", () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(matchFilter(t([]), NO_FILTER)).toBe(true);
  });

  it("标签「任一」：有其中一个就算，不区分大小写", () => {
    const any = f({ tags: ["工作", "work"] });
    expect(matchFilter(t(["WORK"]), any)).toBe(true);
    expect(matchFilter(t(["工作", "急"]), any)).toBe(true);
    expect(matchFilter(t(["急"]), any)).toBe(false);
    expect(matchFilter(t([]), any)).toBe(false);
  });

  it("标签「全部」：选中的都有才算", () => {
    const all = f({ tags: ["工作", "急"], tagMode: "all" });
    expect(matchFilter(t(["急", "工作", "别的"]), all)).toBe(true);
    expect(matchFilter(t(["工作"]), all)).toBe(false);
  });

  it("几个优先级之间是「任一」，「无」也能选", () => {
    const p = f({ priorities: [3, 0] });
    expect(matchFilter(t([], 3), p)).toBe(true);
    expect(matchFilter(t([], 0), p)).toBe(true);
    expect(matchFilter(t([], 2), p)).toBe(false);
  });

  it("标签和优先级之间是「并且」", () => {
    const both = f({ tags: ["工作"], priorities: [3] });
    expect(matchFilter(t(["工作"], 3), both)).toBe(true);
    expect(matchFilter(t(["工作"], 1), both)).toBe(false);
    expect(matchFilter(t([], 3), both)).toBe(false);
  });
});

describe("侧栏顶部写的", () => {
  it("标签「任一」用「或」，「全部」用「和」，优先级从高到低", () => {
    expect(describeFilter(f({ tags: ["工作", "等回复"], priorities: [1, 3] }))).toBe("标签 工作 或 等回复，优先级 高、低");
    expect(describeFilter(f({ tags: ["工作", "急"], tagMode: "all" }))).toBe("标签 工作 和 急");
    expect(describeFilter(f({ priorities: [0] }))).toBe("优先级 无");
  });
});

describe("改筛选", () => {
  it("选上 / 取消标签、优先级", () => {
    const a = toggleTag(NO_FILTER, "工作");
    expect(a.tags).toEqual(["工作"]);
    expect(toggleTag(a, "WORK").tags).toEqual(["工作", "WORK"]);
    expect(toggleTag(f({ tags: ["Work"] }), "work").tags).toEqual([]);
    expect(togglePriority(togglePriority(NO_FILTER, 3), 1).priorities).toEqual([3, 1]);
    expect(togglePriority(f({ priorities: [3] }), 3).priorities).toEqual([]);
  });

  it("点了某个标签：标签只选它一个，优先级不变", () => {
    const before = f({ tags: ["工作", "急"], priorities: [3] });
    expect(onlyTag(before, "等回复")).toEqual(f({ tags: ["等回复"], priorities: [3] }));
    const same = f({ tags: ["等回复"] });
    expect(onlyTag(same, "等回复")).toBe(same);
  });

  it("标签改名后跟着改，改成已经选着的就合并", () => {
    expect(renameTagInFilter(f({ tags: ["工作", "急"] }), "工作", "办公").tags).toEqual(["办公", "急"]);
    expect(renameTagInFilter(f({ tags: ["工作", "急"] }), "WORK", "x").tags).toEqual(["工作", "急"]);
    expect(renameTagInFilter(f({ tags: ["工作", "急"] }), "工作", "急").tags).toEqual(["急"]);
    const none = f({ tags: ["急"] });
    expect(renameTagInFilter(none, "工作", "办公")).toBe(none);
  });

  it("标签删掉后不再选着它", () => {
    expect(dropTagFromFilter(f({ tags: ["工作", "急"] }), "急").tags).toEqual(["工作"]);
    const none = f({ tags: ["急"] });
    expect(dropTagFromFilter(none, "工作")).toBe(none);
  });

  it("各档优先级的条数", () => {
    expect(countPriorities([t([], 3), t([], 3), t([], 0)])).toEqual({ 0: 1, 1: 0, 2: 0, 3: 2 });
  });
});

describe("现在的筛选", () => {
  it("改了通知订阅的，没变时不通知；可以清除", () => {
    const fn = vi.fn();
    const off = subscribeFilter(fn);
    filterByTag("工作");
    expect(readFilter().tags).toEqual(["工作"]);
    filterByTag("工作");
    expect(fn).toHaveBeenCalledTimes(1);
    setFilter((x) => togglePriority(x, 2));
    clearFilter();
    expect(readFilter()).toBe(NO_FILTER);
    expect(fn).toHaveBeenCalledTimes(3);
    off();
  });
});
