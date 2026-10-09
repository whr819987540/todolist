import { describe, expect, it } from "vitest";
import { activeAfterClose, closeTabs, mapTabs, moveTab, neighborTab, type OpenTodo, openTab, stepTab, type TodoRef } from "./tabs";

// docs/requirements.md「右侧标签页」：单击打开在预览标签里，再打开别的待办时预览标签被替换（在原处）；修改、双击、新建的是固定标签；
// 已经有标签的切过去、不挪位置；新开的放在正显示着的右边。关掉正显示着的切到右边的（没有时左边的），都关掉了回到项目。
// Ctrl+Tab / Ctrl+Shift+Tab 到头了从另一头接着。改名、移动后跟着走，删除后关掉。
// 「快捷键」的区域切换：焦点在右侧、正显示着一条待办时 Alt+← / Alt+→ 切到左边 / 右边的标签，最左边 / 最右边的标签上不切换
// （Alt+← 回到左侧列表，Alt+→ 把焦点放进正文）

const todo = (id: string, project = "需求", workspace = "工作"): TodoRef => ({ workspace, project, todoId: id });
const fixed = (id: string, project?: string, workspace?: string): OpenTodo => ({ ...todo(id, project, workspace), preview: false });
const preview = (id: string): OpenTodo => ({ ...todo(id), preview: true });
/** 标签列表的简写：a 是固定的，(a) 是预览的 */
const show = (list: readonly OpenTodo[]) => list.map((t) => (t.preview ? `(${t.todoId})` : t.todoId)).join(" ");

describe("打开待办", () => {
  it("单击打开的待办在预览标签里；再单击别的，预览标签在原处被替换", () => {
    let list = openTab([fixed("a"), fixed("b")], todo("c"), false, todo("a"));
    expect(show(list)).toBe("a (c) b");
    list = openTab(list, todo("d"), false, todo("c"));
    expect(show(list)).toBe("a (d) b");
  });

  it("没有预览标签时，新开的放在正显示着的标签右边；正显示着的不在列表里时放在最后", () => {
    expect(show(openTab([fixed("a"), fixed("b")], todo("c"), false, todo("a")))).toBe("a (c) b");
    expect(show(openTab([fixed("a"), fixed("b")], todo("c"), false, null))).toBe("a b (c)");
    expect(show(openTab([fixed("a"), fixed("b")], todo("c"), false, todo("x")))).toBe("a b (c)");
  });

  it("已经有标签的待办再打开：切过去，不挪位置、不新开", () => {
    const list = [fixed("a"), preview("b"), fixed("c")];
    expect(openTab(list, todo("c"), false, todo("b"))).toBe(list);
    expect(openTab(list, todo("b"), false, todo("a"))).toBe(list);
  });

  it("修改、双击过的（keep）：预览标签在原处变成固定的", () => {
    expect(show(openTab([fixed("a"), preview("b"), fixed("c")], todo("b"), true, todo("b")))).toBe("a b c");
  });

  it("新建的待办开在固定的标签里，放在正显示着的右边；原来的预览标签留着", () => {
    expect(show(openTab([fixed("a"), preview("b")], todo("n"), true, todo("a")))).toBe("a n (b)");
  });

  it("不同工作区里 id 相同的待办是不同的标签", () => {
    const list = openTab([fixed("a")], todo("a", "需求", "生活"), true, todo("a"));
    expect(list).toHaveLength(2);
  });
});

describe("关掉标签后显示哪一个", () => {
  const shown = [fixed("a"), fixed("b"), fixed("c"), fixed("d")];

  it("关掉的是正显示着的：切到它右边的标签", () => {
    expect(activeAfterClose(shown, [todo("b")], todo("b"))?.todoId).toBe("c");
  });

  it("右边没有了时切到左边最近的", () => {
    expect(activeAfterClose(shown, [todo("d")], todo("d"))?.todoId).toBe("c");
    // 关掉右侧的标签（连同正显示着的）时，右边的都关掉了
    expect(activeAfterClose(shown, [todo("b"), todo("c"), todo("d")], todo("c"))?.todoId).toBe("a");
  });

  it("关掉的不是正显示着的：不用换", () => {
    expect(activeAfterClose(shown, [todo("a"), todo("d")], todo("b"))).toBeUndefined();
    expect(activeAfterClose(shown, [todo("a")], null)).toBeUndefined();
  });

  it("都关掉了：null（回到项目）", () => {
    expect(activeAfterClose(shown, shown, todo("b"))).toBeNull();
  });

  it("关掉后列表里去掉这些，别的顺序不变", () => {
    expect(show(closeTabs(shown, [todo("b"), todo("d")]))).toBe("a c");
    expect(closeTabs(shown, [todo("x")])).toBe(shown);
  });
});

describe("拖动标签调整顺序", () => {
  const list = [fixed("a"), fixed("b"), fixed("c"), fixed("d")];

  it("拖到另一个标签的前面 / 后面", () => {
    expect(show(moveTab(list, todo("d"), todo("b"), "before"))).toBe("a d b c");
    expect(show(moveTab(list, todo("a"), todo("c"), "after"))).toBe("b c a d");
    expect(show(moveTab(list, todo("a"), todo("d"), "after"))).toBe("b c d a");
    expect(show(moveTab(list, todo("d"), todo("a"), "before"))).toBe("d a b c");
  });

  it("放回原处（自己上、前一个的后面、后一个的前面）：不变", () => {
    expect(moveTab(list, todo("b"), todo("b"), "before")).toBe(list);
    expect(moveTab(list, todo("b"), todo("a"), "after")).toBe(list);
    expect(moveTab(list, todo("b"), todo("c"), "before")).toBe(list);
  });

  it("藏起来的标签（没选中的工作区里的）相对顺序不变", () => {
    const mixed = [fixed("a"), fixed("x", "杂事", "生活"), fixed("b"), fixed("c")];
    expect(show(moveTab(mixed, todo("c"), todo("b"), "before"))).toBe("a x c b");
    expect(show(moveTab(mixed, todo("a"), todo("b"), "after"))).toBe("x b a c");
  });

  it("预览标签拖动后仍是预览的", () => {
    expect(moveTab([fixed("a"), preview("b")], todo("b"), todo("a"), "before")[0].preview).toBe(true);
  });
});

describe("Ctrl+Tab / Ctrl+Shift+Tab", () => {
  const shown = [fixed("a"), fixed("b"), fixed("c")];

  it("下一个 / 上一个，到头了从另一头接着", () => {
    expect(stepTab(shown, todo("a"), 1)?.todoId).toBe("b");
    expect(stepTab(shown, todo("c"), 1)?.todoId).toBe("a");
    expect(stepTab(shown, todo("a"), -1)?.todoId).toBe("c");
  });

  it("正显示着概览（没有正显示着的标签）时：下一个是第一个，上一个是最后一个", () => {
    expect(stepTab(shown, null, 1)?.todoId).toBe("a");
    expect(stepTab(shown, null, -1)?.todoId).toBe("c");
  });

  it("没有标签时什么都不做", () => {
    expect(stepTab([], null, 1)).toBeNull();
  });
});

describe("焦点在右侧时的 Alt+← / Alt+→", () => {
  const shown = [fixed("a"), fixed("b"), fixed("c")];

  it("切到左边 / 右边的标签", () => {
    expect(neighborTab(shown, todo("b"), -1)?.todoId).toBe("a");
    expect(neighborTab(shown, todo("b"), 1)?.todoId).toBe("c");
  });

  it("到头了不从另一头接着（不同于 Ctrl+Tab）：最左边的标签上没有左边的，最右边的标签上没有右边的", () => {
    expect(neighborTab(shown, todo("a"), -1)).toBeNull();
    expect(neighborTab(shown, todo("c"), 1)).toBeNull();
    expect(neighborTab([fixed("a")], todo("a"), -1)).toBeNull();
    expect(neighborTab([fixed("a")], todo("a"), 1)).toBeNull();
  });

  it("没有正显示着的标签（显示概览）时：不切标签", () => {
    expect(neighborTab(shown, null, -1)).toBeNull();
    expect(neighborTab(shown, null, 1)).toBeNull();
    expect(neighborTab(shown, todo("x"), 1)).toBeNull();
    expect(neighborTab([], null, 1)).toBeNull();
  });
});

describe("改名、移动、删除后跟着走", () => {
  it("项目改名：标签跟到新名字下，位置、是否预览不变", () => {
    const list = [fixed("a", "日常"), preview("b"), fixed("c")];
    const out = mapTabs(list, ([w, p, id]) => [w, p === "需求" ? "需求池" : p, id]);
    expect(out.map((t) => [t.project, t.todoId, t.preview])).toEqual([
      ["日常", "a", false],
      ["需求池", "b", true],
      ["需求池", "c", false],
    ]);
  });

  it("删除的关掉", () => {
    const out = mapTabs([fixed("a"), fixed("b")], (k) => (k[2] === "a" ? null : k));
    expect(show(out)).toBe("b");
  });

  it("移过去后和已有的标签重复了：只留前面那个", () => {
    const out = mapTabs([fixed("a"), fixed("b", "日常")], ([w, , id]) => [w, "需求", id === "b" ? "a" : id]);
    expect(show(out)).toBe("a");
  });

  it("没有变化时返回原来的列表", () => {
    const list = [fixed("a")];
    expect(mapTabs(list, (k) => k)).toBe(list);
  });
});
