// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  matchTarget,
  parseTargetKey,
  readDraft,
  submitKey,
  targetExists,
  targetKey,
  targetOptions,
  writeDraft,
} from "./quickCapture";
import type { WorkspaceProjects } from "./types";

// docs/requirements.md「快速记录」：选择存到哪个项目（默认收件箱 / 快速记录，不在时保存时新建），
// Enter 保存，Shift+Enter 换行，Ctrl+Enter 保存并打开；没存的草稿留着。「项目的顺序」：列表里的项目按项目的顺序

const ws = (name: string, projects: string[], order: Record<string, number> = {}, manualOrder = false): WorkspaceProjects => ({
  name,
  projects,
  manualOrder,
  order,
});

const list = [ws("生活", ["购物", "旅行"]), ws("工作", ["需求开发", "日常事务"]), ws("空的", [])];

describe("存到哪个项目", () => {
  it("按工作区分组，名称排序，没有项目的工作区不列", () => {
    const groups = targetOptions(list, { workspace: "工作", project: "日常事务" });
    expect(groups.map((g) => g.label)).toEqual(["工作", "生活"]);
    expect(groups[0].options.map((o) => o.label)).toEqual(["日常事务", "需求开发"]);
    expect(parseTargetKey(groups[1].options[0].value)).toEqual({ workspace: "生活", project: "购物" });
  });

  it("还不在的项目放在最前面，注明保存时新建", () => {
    const inbox = { workspace: "收件箱", project: "快速记录" };
    expect(targetExists(list, inbox)).toBe(false);
    const groups = targetOptions(list, inbox);
    expect(groups[0].label).toBe("保存时新建");
    expect(groups[0].options).toEqual([{ value: targetKey(inbox), label: "收件箱 / 快速记录", title: "收件箱 / 快速记录" }]);
    expect(groups).toHaveLength(3);
  });

  it("搜索工作区名、项目名都行", () => {
    const opt = targetOptions(list, null)[0].options[1];
    expect(matchTarget("需求", opt)).toBe(true);
    expect(matchTarget(" 工作 ", opt)).toBe(true);
    expect(matchTarget("购物", opt)).toBe(false);
  });

  it("子项目跟在父项目后面，写成「父项目 / 子项目」；可以存到子项目里", () => {
    const withSubs = [ws("工作", ["需求开发/后端", "日常事务", "需求开发", "需求开发/前端"])];
    const sub = { workspace: "工作", project: "需求开发/前端" };
    const [group] = targetOptions(withSubs, sub);
    expect(group.options.map((o) => o.label)).toEqual(["日常事务", "需求开发", "需求开发 / 后端", "需求开发 / 前端"]);
    expect(group.options[3].title).toBe("工作 / 需求开发 / 前端");
    expect(parseTargetKey(group.options[3].value)).toEqual(sub);
    expect(targetExists(withSubs, sub)).toBe(true);
  });

  it("项目手动排序时按记下的顺序，没排过的排在后面（同侧栏）", () => {
    const manual = [
      ws("工作", ["需求开发", "日常事务", "需求开发/后端", "需求开发/前端", "杂项"], { 需求开发: 0, 日常事务: 1, "需求开发/前端": 0 }, true),
    ];
    expect(targetOptions(manual, null)[0].options.map((o) => o.label)).toEqual([
      "需求开发",
      "需求开发 / 前端",
      "需求开发 / 后端",
      "日常事务",
      "杂项",
    ]);
    // 换成按名称时记下的顺序不管
    const byName = [{ ...manual[0], manualOrder: false }];
    expect(targetOptions(byName, null)[0].options.map((o) => o.label)).toEqual([
      "日常事务",
      "需求开发",
      "需求开发 / 后端",
      "需求开发 / 前端",
      "杂项",
    ]);
  });

  it("名字里有斜杠、引号也能对回去", () => {
    const t = { workspace: 'A "B"', project: "C / D" };
    expect(parseTargetKey(targetKey(t))).toEqual(t);
  });
});

describe("按键", () => {
  const key = (k: Partial<KeyboardEvent>) =>
    submitKey({ key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...k });

  it("Enter 保存，Ctrl+Enter 保存并打开", () => {
    expect(key({})).toBe("save");
    expect(key({ ctrlKey: true })).toBe("open");
  });

  it("Shift+Enter 换行、输入法组合中的 Enter 上屏，都不保存", () => {
    expect(key({ shiftKey: true })).toBeNull();
    expect(key({ isComposing: true })).toBeNull();
    expect(key({ key: "a" })).toBeNull();
  });
});

describe("草稿", () => {
  it("没存的留着，存好（清空）后去掉", () => {
    writeDraft("买牛奶");
    expect(readDraft()).toBe("买牛奶");
    writeDraft("");
    expect(readDraft()).toBe("");
  });
});
