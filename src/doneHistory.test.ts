import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  countToday,
  dailyCounts,
  dayLabel,
  groupByDay,
  inRange,
  matchHistory,
  rangeStart,
  UNKNOWN_DAY,
} from "./doneHistory";
import type { DoneTodo, TodoSummary } from "./types";

// 完成记录按本地时间的自然日分组：用东八区跑（和 UTC 差 8 小时，按 UTC 分组的话凌晨完成的会算到前一天）。
// 时间都写成不带时区的本地时间，在用例里（设好时区之后）再换成毫秒
beforeAll(() => {
  vi.stubEnv("TZ", "Asia/Shanghai");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const at = (s: string) => new Date(s).getTime();

let seq = 0;
const done = (doneAt: string | null, p: Partial<TodoSummary> = {}, place: Partial<DoneTodo> = {}): DoneTodo => ({
  workspace: "工作",
  project: "需求",
  ...place,
  todo: {
    id: `t${++seq}`,
    title: `完成于 ${doneAt ?? "不详"}`,
    preview: "",
    done: true,
    createdAt: 0,
    updatedAt: 0,
    doneAt: doneAt === null ? null : at(doneAt),
    pinned: false,
    order: null,
    ...p,
  },
});

const titles = (items: DoneTodo[]) => items.map((x) => x.todo.title);

describe("时间范围（rangeStart、inRange）", () => {
  it("最近 7 天是今天和之前的 6 天，从 6 天前的零点算起", () => {
    const now = at("2026-10-09T15:00:00");
    const start = rangeStart("7d", now);
    expect(start).toBe(at("2026-10-03T00:00:00"));
    expect(inRange(done("2026-10-03T00:00:00"), start)).toBe(true);
    expect(inRange(done("2026-10-02T23:59:59"), start)).toBe(false);
    expect(inRange(done("2026-10-09T14:59:00"), start)).toBe(true);
  });

  it("最近 30 天同理：今天和之前的 29 天", () => {
    expect(rangeStart("30d", at("2026-10-09T00:10:00"))).toBe(at("2026-09-10T00:00:00"));
  });

  it("「全部」没有下限，没有完成时间的也算；最近几天里不算没有完成时间的", () => {
    expect(rangeStart("all", at("2026-10-09T15:00:00"))).toBeNull();
    expect(inRange(done("2001-01-01T08:00:00"), null)).toBe(true);
    expect(inRange(done(null), null)).toBe(true);
    expect(inRange(done(null), rangeStart("7d", at("2026-10-09T15:00:00")))).toBe(false);
  });

  it("按日历往前数天，夏令时切换（一天 25 小时）时也是从那天的零点起", () => {
    vi.stubEnv("TZ", "America/New_York");
    try {
      // 2026-11-01 夏令时结束，那天有 25 小时
      const start = rangeStart("7d", at("2026-11-03T12:00:00"));
      expect(start).toBe(at("2026-10-28T00:00:00"));
      expect(inRange(done("2026-10-28T00:30:00"), start)).toBe(true);
      expect(inRange(done("2026-10-27T23:30:00"), start)).toBe(false);
    } finally {
      vi.stubEnv("TZ", "Asia/Shanghai");
    }
  });
});

describe("组名（dayLabel）", () => {
  const now = () => at("2026-10-09T15:00:00");

  it("今天、昨天", () => {
    expect(dayLabel(at("2026-10-09T00:00:00"), now())).toBe("今天");
    expect(dayLabel(at("2026-10-08T00:00:00"), now())).toBe("昨天");
  });

  it("再往前写日期和星期", () => {
    expect(dayLabel(at("2026-10-07T00:00:00"), now())).toBe("10月7日 星期三");
    expect(dayLabel(at("2026-01-02T00:00:00"), now())).toBe("1月2日 星期五");
  });

  it("不是今年的写上年份", () => {
    expect(dayLabel(at("2025-12-31T00:00:00"), at("2026-01-02T09:00:00"))).toBe("2025年12月31日 星期三");
    // 刚过元旦：去年最后一天是「昨天」
    expect(dayLabel(at("2025-12-31T00:00:00"), at("2026-01-01T00:05:00"))).toBe("昨天");
  });
});

describe("按完成日期分组（groupByDay）", () => {
  it("最近的那天在前，组里按完成时间倒序", () => {
    const now = at("2026-10-09T15:00:00");
    const groups = groupByDay(
      [
        done("2026-10-07T09:00:00"),
        done("2026-10-09T08:00:00"),
        done("2026-10-08T20:00:00"),
        done("2026-10-09T14:30:00"),
        done("2026-10-07T18:00:00"),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(["今天", "昨天", "10月7日 星期三"]);
    expect(groups.map((g) => titles(g.items))).toEqual([
      ["完成于 2026-10-09T14:30:00", "完成于 2026-10-09T08:00:00"],
      ["完成于 2026-10-08T20:00:00"],
      ["完成于 2026-10-07T18:00:00", "完成于 2026-10-07T09:00:00"],
    ]);
    expect(groups[0].day).toBe(at("2026-10-09T00:00:00"));
  });

  it("按本地时间的自然日：凌晨完成的算当天，深夜的算前一天（不按 UTC）", () => {
    const groups = groupByDay([done("2026-10-09T00:30:00"), done("2026-10-08T23:30:00")], at("2026-10-09T10:00:00"));
    expect(groups.map((g) => [g.label, titles(g.items)])).toEqual([
      ["今天", ["完成于 2026-10-09T00:30:00"]],
      ["昨天", ["完成于 2026-10-08T23:30:00"]],
    ]);
  });

  it("没有完成时间的放在最后的「完成时间不详」一组，按修改时间倒序", () => {
    const groups = groupByDay(
      [
        done(null, { title: "旧的", updatedAt: at("2025-03-01T10:00:00") }),
        done("2026-10-01T10:00:00"),
        done(null, { title: "较新的", updatedAt: at("2025-05-01T10:00:00") }),
      ],
      at("2026-10-09T15:00:00"),
    );
    expect(groups.map((g) => g.label)).toEqual(["10月1日 星期四", UNKNOWN_DAY]);
    expect(groups[1].day).toBeNull();
    expect(titles(groups[1].items)).toEqual(["较新的", "旧的"]);
  });

  it("都有完成时间时没有「完成时间不详」；没有完成的待办时没有组", () => {
    expect(groupByDay([done("2026-10-09T08:00:00")], at("2026-10-09T15:00:00")).map((g) => g.label)).toEqual(["今天"]);
    expect(groupByDay([], at("2026-10-09T15:00:00"))).toEqual([]);
  });

  it("跨过零点后，原来的「今天」变成「昨天」", () => {
    const items = [done("2026-10-09T08:00:00")];
    expect(groupByDay(items, at("2026-10-09T23:59:00"))[0].label).toBe("今天");
    expect(groupByDay(items, at("2026-10-10T00:01:00"))[0].label).toBe("昨天");
  });
});

describe("查找（matchHistory）", () => {
  const sub = done("2026-10-09T08:00:00", { title: "联调 Payment 接口" }, { workspace: "工作", project: "后端/支付" });
  const untitled = done("2026-10-09T08:00:00", { title: " ", preview: "给张三回邮件" }, { workspace: "生活", project: "杂事" });

  it("按标题查找，不区分大小写", () => {
    expect(matchHistory(sub, "payment")).toBe(true);
    expect(matchHistory(sub, "  PAYMENT ")).toBe(true);
    expect(matchHistory(sub, "订单")).toBe(false);
  });

  it("没有标题时按正文开头查找；有标题时不看正文开头", () => {
    expect(matchHistory(untitled, "张三")).toBe(true);
    const titled = done("2026-10-09T08:00:00", { title: "写周报", preview: "给张三回邮件" });
    expect(matchHistory(titled, "张三")).toBe(false);
  });

  it("按所在的工作区、父项目、子项目查找", () => {
    expect(matchHistory(sub, "工作")).toBe(true);
    expect(matchHistory(sub, "后端")).toBe(true);
    expect(matchHistory(sub, "支付")).toBe(true);
    expect(matchHistory(sub, "后端 / 支付")).toBe(true);
    expect(matchHistory(untitled, "工作")).toBe(false);
  });

  it("没有关键字时都算", () => {
    expect(matchHistory(sub, "")).toBe(true);
    expect(matchHistory(untitled, "   ")).toBe(true);
  });
});

describe("统计（countToday、dailyCounts）", () => {
  const now = () => at("2026-10-09T15:00:00");
  const items = () => [
    done("2026-10-09T08:00:00"),
    done("2026-10-09T00:10:00"),
    done("2026-10-08T23:50:00"),
    done("2026-10-03T09:00:00"),
    done("2026-09-20T09:00:00"),
    done(null),
  ];

  it("今天完成了几条（按本地时间的自然日）", () => {
    expect(countToday(items(), now())).toBe(2);
    expect(countToday(items(), at("2026-10-10T08:00:00"))).toBe(0);
  });

  it("最近 7 天：每天一根，从早到晚，最后一根是今天，没完成的那天是 0", () => {
    const bars = dailyCounts(items(), "7d", now());
    expect(bars.map((b) => b.count)).toEqual([1, 0, 0, 0, 0, 1, 2]);
    expect(bars[0].day).toBe(at("2026-10-03T00:00:00"));
    expect(bars[6].day).toBe(at("2026-10-09T00:00:00"));
  });

  it("最近 30 天有 30 根；「全部」不画", () => {
    const bars = dailyCounts(items(), "30d", now());
    expect(bars).toHaveLength(30);
    expect(bars[0].day).toBe(at("2026-09-10T00:00:00"));
    expect(bars.reduce((n, b) => n + b.count, 0)).toBe(5);
    expect(dailyCounts(items(), "all", now())).toEqual([]);
  });
});
