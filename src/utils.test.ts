import { describe, expect, it } from "vitest";
import type { TodoSummary } from "./types";
import {
  compactTime,
  displayTitle,
  formatDuration,
  matchTodo,
  myVersionTitle,
  relativeTime,
  shortTime,
  reorderedIds,
  sortTodos,
  textStats,
} from "./utils";

const todo = (p: Partial<TodoSummary>): TodoSummary => ({
  id: "20260926-153012",
  title: "",
  preview: "",
  done: false,
  createdAt: 0,
  updatedAt: 0,
  doneAt: null,
  pinned: false,
  order: null,
  tags: [],
  priority: 0,
  ...p,
});

describe("状态栏的字数、行数（textStats）", () => {
  it("空正文是 0 字 0 行", () => {
    expect(textStats("")).toEqual({ chars: 0, lines: 0 });
  });

  it("字数不计空白（空格、制表符、换行、全角空格）", () => {
    expect(textStats("买 牛奶\t和　面包\n")).toEqual({ chars: 6, lines: 2 });
  });

  it("中文、英文、数字、标点每个算一个字", () => {
    expect(textStats("今天 done 3 件，")).toEqual({ chars: 9, lines: 1 });
  });

  it("emoji 等代理对算一个字", () => {
    expect(textStats("好👍🎉")).toEqual({ chars: 3, lines: 1 });
  });

  it("行数按换行算，最后一行没有换行也算一行", () => {
    expect(textStats("甲\n乙\n丙")).toEqual({ chars: 3, lines: 3 });
    expect(textStats("甲\n\n")).toEqual({ chars: 1, lines: 3 });
  });

  it("Markdown 标记也算字（统计的是原文）", () => {
    expect(textStats("# 标题")).toEqual({ chars: 3, lines: 1 });
  });
});

describe("左侧显示的文字（displayTitle）", () => {
  it("有标题用标题", () => {
    expect(displayTitle(todo({ title: " 买牛奶 ", preview: "正文" }))).toEqual({ text: "买牛奶", fromContent: false });
  });

  it("没有标题时用正文开头", () => {
    expect(displayTitle(todo({ title: "  ", preview: "正文开头" }))).toEqual({ text: "正文开头", fromContent: true });
  });

  it("都没有时显示「空白待办」", () => {
    expect(displayTitle(todo({}))).toEqual({ text: "空白待办", fromContent: true });
  });
});

describe("另存为新待办的标题（myVersionTitle）", () => {
  it("原来的标题加上「（我的版本）」", () => {
    expect(myVersionTitle(" 周报 ", "正文")).toBe("周报（我的版本）");
  });

  it("没有标题时取正文第一行，去掉行首的 Markdown 标记", () => {
    expect(myVersionTitle("", "\n\n## 会议纪要\n内容")).toBe("会议纪要（我的版本）");
    expect(myVersionTitle("", "- [ ] 买牛奶\n- 面包")).toBe("买牛奶（我的版本）");
    expect(myVersionTitle("", "> 1. 引用里的列表")).toBe("引用里的列表（我的版本）");
  });

  it("第一行太长时截短", () => {
    const long = "一".repeat(50);
    expect(myVersionTitle("", long)).toBe(`${"一".repeat(30)}…（我的版本）`);
  });

  it("标题和正文都是空的", () => {
    expect(myVersionTitle("", "  \n ")).toBe("我的版本");
  });
});

describe("排序（sortTodos）", () => {
  const a = todo({ id: "a", title: "乙", createdAt: 1, updatedAt: 30 });
  const b = todo({ id: "b", title: "甲", createdAt: 2, updatedAt: 10 });
  const c = todo({ id: "c", title: "丙", createdAt: 3, updatedAt: 20, done: true });
  const ids = (l: TodoSummary[]) => l.map((t) => t.id);

  it("按创建时间、修改时间新的在前，已完成的沉底", () => {
    expect(ids(sortTodos([a, b, c], "created"))).toEqual(["b", "a", "c"]);
    expect(ids(sortTodos([a, b, c], "updated"))).toEqual(["a", "b", "c"]);
  });

  it("按标题（中文按拼音）", () => {
    // 丙 bǐng、甲 jiǎ、乙 yǐ
    expect(ids(sortTodos([a, b, { ...c, done: false }], "title"))).toEqual(["c", "b", "a"]);
  });

  it("置顶的排在最前面，已完成的仍沉底（置顶的已完成排在已完成里的最前面）", () => {
    const d = todo({ id: "d", createdAt: 0, updatedAt: 0, pinned: true });
    const e = todo({ id: "e", createdAt: 0, updatedAt: 0, pinned: true, done: true });
    expect(ids(sortTodos([a, b, c, d, e], "created"))).toEqual(["d", "b", "a", "e", "c"]);
    expect(ids(sortTodos([a, b, c, d, e], "updated"))).toEqual(["d", "a", "b", "e", "c"]);
  });

  it("手动排序：没排过位置的在前（新建的在前），排过的按位置", () => {
    const x = todo({ id: "x", createdAt: 5, order: 1 });
    const y = todo({ id: "y", createdAt: 6, order: 0 });
    const n1 = todo({ id: "n1", createdAt: 7 });
    const n2 = todo({ id: "n2", createdAt: 8 });
    expect(ids(sortTodos([x, n1, y, n2], "manual"))).toEqual(["n2", "n1", "y", "x"]);
    // 置顶、已完成照样分开
    const p = todo({ id: "p", order: 9, pinned: true });
    const d = todo({ id: "d", order: -1, done: true });
    expect(ids(sortTodos([x, y, p, d], "manual"))).toEqual(["p", "y", "x", "d"]);
  });

  it("不改原来的数组", () => {
    const list = [a, b, c];
    sortTodos(list, "title");
    expect(ids(list)).toEqual(["a", "b", "c"]);
  });
});

describe("搜索匹配（matchTodo）", () => {
  it("标题和正文开头，不分大小写", () => {
    const t = todo({ title: "Weekly Report", preview: "整理会议纪要" });
    expect(matchTodo(t, "weekly")).toBe(true);
    expect(matchTodo(t, "纪要")).toBe(true);
    expect(matchTodo(t, "预算")).toBe(false);
    expect(matchTodo(t, "")).toBe(true);
  });
});

describe("时间显示", () => {
  const now = new Date("2026-10-02T15:00:00").getTime();
  const at = (s: string) => new Date(s).getTime();

  it("相对时间：刚刚 / x 分钟前 / x 小时前，超过一天显示日期", () => {
    expect(relativeTime(now - 30_000, now)).toBe("刚刚");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
    expect(relativeTime(at("2026-10-01T09:30:00"), now)).toBe("昨天 09:30");
    expect(relativeTime(at("2026-09-26T14:30:00"), now)).toBe("09-26 14:30");
    expect(relativeTime(at("2025-09-26T14:30:00"), now)).toBe("2025-09-26");
  });

  it("侧栏用的紧凑格式", () => {
    expect(relativeTime(now - 5 * 60_000, now, true)).toBe("5分钟前");
    expect(compactTime(at("2026-10-02T08:05:00"), now)).toBe("08:05");
    expect(compactTime(at("2026-10-01T08:05:00"), now)).toBe("昨天 08:05");
    expect(compactTime(at("2026-09-26T08:05:00"), now)).toBe("09-26");
    expect(compactTime(at("2025-09-26T08:05:00"), now)).toBe("2025-09-26");
  });

  it("昨天的「x 小时前」不跨过零点", () => {
    // 2 小时前是昨天 23:30，显示日期而不是「2 小时前」
    const early = at("2026-10-02T01:30:00");
    expect(relativeTime(at("2026-10-01T23:30:00"), early)).toBe("昨天 23:30");
    expect(shortTime(at("2026-10-02T00:10:00"), early)).toBe("今天 00:10");
  });

  it("时长", () => {
    expect(formatDuration(45)).toBe("45 秒");
    expect(formatDuration(180)).toBe("3 分钟");
    expect(formatDuration(90)).toBe("1 分 30 秒");
  });
});

describe("拖动调整顺序后的顺序（reorderedIds）", () => {
  const list = ["a", "b", "c", "d"].map((id) => todo({ id }));

  it("挪到目标的前面 / 后面", () => {
    expect(reorderedIds(list, "a", "c", "before")).toEqual(["b", "a", "c", "d"]);
    expect(reorderedIds(list, "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
    expect(reorderedIds(list, "d", "a", "before")).toEqual(["d", "a", "b", "c"]);
    expect(reorderedIds(list, "b", "d", "after")).toEqual(["a", "c", "d", "b"]);
  });

  it("放回原处时顺序不变", () => {
    expect(reorderedIds(list, "b", "c", "before")).toEqual(["a", "b", "c", "d"]);
    expect(reorderedIds(list, "b", "a", "after")).toEqual(["a", "b", "c", "d"]);
  });

  it("目标或拖的那条不在了（刚被删掉）时不变", () => {
    expect(reorderedIds(list, "a", "x", "before")).toEqual(["a", "b", "c", "d"]);
    expect(reorderedIds(list, "x", "a", "before")).toEqual(["a", "b", "c", "d"]);
  });
});
