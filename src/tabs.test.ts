import { describe, expect, it } from "vitest";
import {
  activeAfterClose,
  closeGroupTabs,
  closeTabs,
  focusGroup,
  keepGroupTab,
  mapGroupTabs,
  mapTabs,
  mergeGroups,
  moveGroupTab,
  moveTab,
  moveTabToGroup,
  neighborTab,
  type OpenTodo,
  openTab,
  pinGroupTabs,
  shownTab,
  showGroupTab,
  SINGLE_GROUP,
  splitGroups,
  stepAcrossGroups,
  stepTab,
  type TabGroups,
  type TodoRef,
} from "./tabs";

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

// docs/requirements.md「右侧分屏」：最多分两边，各有一排标签；打开的待办放进有焦点的那一边；一边的标签都关掉后这一边消失；
// 标签可以拖到另一边；分屏的快捷键按一次分出一边、换方向、同一个方向再按合并回一边；改名、移动后跟着走，删除后关掉

/** 两组的简写：每组按 show 的写法，| 隔开，有焦点的一组后面加 *，正显示着的标签加 ^ */
const groups = (g: TabGroups) =>
  g.groups
    .map((x, i) => {
      const tabs = x.tabs.map((t) => (t.preview ? `(${t.todoId})` : t.todoId) + (x.current && sameId(x.current, t) ? "^" : ""));
      return tabs.join(" ") + (i === g.focused ? " *" : "");
    })
    .join(" | ");
const sameId = (a: TodoRef, b: TodoRef) => a.workspace === b.workspace && a.project === b.project && a.todoId === b.todoId;
/** 按简写造两组："a b^ (c)" 是一组，第二个参数是另一组（没有时不分屏） */
function make(first: string, second?: string, focused = 0): TabGroups {
  const parse = (id: string, spec: string) => {
    const tabs: OpenTodo[] = [];
    let current: TodoRef | null = null;
    for (const w of spec.split(" ").filter(Boolean)) {
      const name = w.replace(/[()^]/g, "");
      const t = { ...todo(name), preview: w.startsWith("(") };
      if (w.endsWith("^")) current = todo(name);
      tabs.push(t);
    }
    return { id, tabs, current };
  };
  return {
    groups: second === undefined ? [parse("a", first)] : [parse("a", first), parse("b", second)],
    direction: "row",
    ratio: 0.5,
    focused,
  };
}

describe("分屏：打开到有焦点的那一边", () => {
  it("显示一条待办时放进有焦点那一边的预览标签，另一边的预览标签不动", () => {
    let g = make("a^ (b)", "(c)^", 0);
    g = showGroupTab(g, todo("d"));
    expect(groups(g)).toBe("a (d)^ * | (c)^");
    g = showGroupTab(focusGroup(g, 1), todo("e"));
    expect(groups(g)).toBe("a (d)^ | (e)^ *");
  });

  it("另一边已经开着的待办，在这一边也开一个标签（同一条待办可以两边都开着）", () => {
    const g = showGroupTab(make("a^", "b^", 1), todo("a"));
    expect(groups(g)).toBe("a^ | b (a)^ *");
  });

  it("新建、双击的固定标签开在有焦点的那一边（也可以指定哪一边）", () => {
    expect(groups(keepGroupTab(make("a^", "b^", 1), todo("n")))).toBe("a^ | b^ n *");
    expect(groups(keepGroupTab(make("a^", "b^", 1), todo("n"), 0))).toBe("a^ n | b^ *");
  });

  it("修改了正文：两边的预览标签都固定下来，不新开标签", () => {
    const g = pinGroupTabs(make("(a)^", "b (a)^"), todo("a"));
    expect(groups(g)).toBe("a^ * | b a^");
    expect(pinGroupTabs(make("b^"), todo("a")).groups[0].tabs).toHaveLength(1);
  });
});

describe("分屏的快捷键", () => {
  it("不分屏时：在另一边分出一组，开着正显示的待办（固定的标签），焦点到新的一边，各占一半", () => {
    const g = splitGroups({ ...make("a (b)^"), ratio: 0.3 }, "column", todo("b"));
    expect(groups(g)).toBe("a (b)^ | b^ *");
    expect(g.direction).toBe("column");
    expect(g.ratio).toBe(0.5);
    expect(g.groups[0].id).not.toBe(g.groups[1].id);
  });

  it("显示概览（没有正显示的待办）时不分屏", () => {
    const g = make("a^");
    expect(splitGroups(g, "row", null)).toBe(g);
  });

  it("已经分屏：按另一个方向改成那个方向，按同一个方向合并回一边", () => {
    const g = make("a^", "b^", 1);
    const turned = splitGroups(g, "column", todo("b"));
    expect(turned.direction).toBe("column");
    expect(groups(turned)).toBe(groups(g));
    expect(groups(splitGroups(turned, "column", todo("b")))).toBe("a b^ *");
  });

  it("分着屏、另一边没显示出来（标签都在没选中的工作区里）：把这条开到那一边", () => {
    const g = splitGroups(make("x^", "b^", 1), "row", todo("b"), false);
    expect(groups(g)).toBe("x b^ * | b^");
  });
});

describe("合并回一边", () => {
  it("左边 / 上面那一边的标签在前，另一边的接在后面，两边都有的只留一个；显示有焦点那一边正显示着的", () => {
    expect(groups(mergeGroups(make("a b^", "c b d^", 1)))).toBe("a b c d^ *");
  });

  it("有焦点那一边的预览标签仍是预览，并过来的预览标签固定下来", () => {
    expect(groups(mergeGroups(make("a (b)^", "(c)^", 0)))).toBe("a (b)^ c *");
    expect(groups(mergeGroups(make("a (b)^", "(c)^", 1)))).toBe("a b (c)^ *");
  });
});

describe("分屏时关掉标签", () => {
  it("关掉的是这一边正显示着的：改成它右边的（没有时左边的）", () => {
    expect(groups(closeGroupTabs(make("a b^ c", "d^"), 0, [todo("b")]))).toBe("a c^ * | d^");
    expect(groups(closeGroupTabs(make("a b c^", "d^"), 0, [todo("c")]))).toBe("a b^ * | d^");
  });

  it("一边的标签都关掉了：这一边消失，回到不分屏，焦点在留下的一边", () => {
    const g = closeGroupTabs(make("a^", "b^ c", 0), 0, [todo("a")]);
    expect(groups(g)).toBe("b^ c *");
    expect(g.groups[0].id).toBe("b");
    expect(groups(closeGroupTabs(make("a^", "b^", 0), 1, [todo("b")]))).toBe("a^ *");
  });

  it("不分屏时标签都关掉了：留着这一组（右侧显示项目）", () => {
    expect(closeGroupTabs(make("a^"), 0, [todo("a")]).groups).toHaveLength(1);
  });

  it("只关这一边的：另一边开着的同一条待办不动", () => {
    expect(groups(closeGroupTabs(make("a^ b", "a^"), 0, [todo("a")]))).toBe("b^ * | a^");
  });

  it("在一边里拖动调整顺序不影响另一边", () => {
    expect(groups(moveGroupTab(make("a^", "b c^"), 1, todo("c"), todo("b"), "before"))).toBe("a^ * | c^ b");
  });
});

describe("把标签拖到另一边", () => {
  it("放在指针下那个标签的前面 / 后面；拖过去的固定下来、显示出来，焦点到那一边", () => {
    expect(groups(moveTabToGroup(make("a (b)^", "c^ d"), 0, todo("b"), 1, todo("d"), "before"))).toBe("a^ | c b^ d *");
    expect(groups(moveTabToGroup(make("a b^", "c^ d"), 0, todo("b"), 1, todo("c"), "after"))).toBe("a^ | c b^ d *");
  });

  it("放在那一边的编辑区上：放在最后", () => {
    expect(groups(moveTabToGroup(make("a^ b", "c^ d"), 0, todo("b"), 1, null, "after"))).toBe("a^ | c d b^ *");
  });

  it("那一边已经开着这条待办：挪到放下的位置（放在编辑区上时不挪），不重复", () => {
    expect(groups(moveTabToGroup(make("a^ b", "b c^"), 0, todo("b"), 1, todo("c"), "after"))).toBe("a^ | c b^ *");
    expect(groups(moveTabToGroup(make("a^ b", "b c^"), 0, todo("b"), 1, null, "after"))).toBe("a^ | b^ c *");
  });

  it("拖走的是原来那一边正显示着的：那一边改显示右边的（没有时左边的）", () => {
    expect(groups(moveTabToGroup(make("a b^ c", "d^"), 0, todo("b"), 1, null, "after"))).toBe("a c^ | d b^ *");
  });

  it("原来那一边没有标签了：消失，回到不分屏", () => {
    const g = moveTabToGroup(make("a^", "c^", 0), 0, todo("a"), 1, null, "after");
    expect(groups(g)).toBe("c a^ *");
  });

  it("拖到同一边：同调整顺序", () => {
    expect(groups(moveTabToGroup(make("a^ b"), 0, todo("b"), 0, todo("a"), "before"))).toBe("b a^ *");
  });
});

describe("分屏时改名、移动、删除后跟着走", () => {
  it("两边的标签和正显示着的都跟过去", () => {
    const g = mapGroupTabs(make("a^", "a^ b"), ([w, p, id]) => [w, p === "需求" ? "需求池" : p, id]);
    expect(g.groups.flatMap((x) => [...x.tabs.map((t) => t.project), x.current?.project])).toEqual(["需求池", "需求池", "需求池", "需求池", "需求池"]);
  });

  it("删除了一边正显示着的：改显示右边的（没有时左边的）", () => {
    expect(groups(mapGroupTabs(make("a b^ c", "d^"), (k) => (k[2] === "b" ? null : k)))).toBe("a c^ * | d^");
  });

  it("一边的标签都删了：这一边消失", () => {
    expect(groups(mapGroupTabs(make("a^", "b^", 1), (k) => (k[2] === "b" ? null : k)))).toBe("a^ *");
  });

  it("没有变化时返回原来的", () => {
    const g = make("a^", "b^");
    expect(mapGroupTabs(g, (k) => k)).toBe(g);
  });
});

describe("一边显示哪个标签", () => {
  it("正显示着的；它没显示出来（在没选中的工作区里、已经关掉）时第一个；没有标签时 null", () => {
    const shown = [fixed("a"), fixed("b")];
    expect(shownTab(shown, todo("b"))?.todoId).toBe("b");
    expect(shownTab(shown, todo("x"))?.todoId).toBe("a");
    expect(shownTab(shown, null)?.todoId).toBe("a");
    expect(shownTab([], todo("a"))).toBeNull();
  });
});

describe("分屏时焦点在右侧的 Alt+← / Alt+→", () => {
  const shown = [
    [fixed("a"), fixed("b")],
    [fixed("c"), fixed("d")],
  ];
  const currents = [todo("b"), todo("d")];

  it("先在这一边里切到左边 / 右边的标签", () => {
    expect(stepAcrossGroups(shown, currents, 0, todo("a"), 1)).toMatchObject({ group: 0, tab: { todoId: "b" } });
    expect(stepAcrossGroups(shown, currents, 1, todo("d"), -1)).toMatchObject({ group: 1, tab: { todoId: "c" } });
  });

  it("左边一边最右边的标签上 Alt+→：进入右边一边正显示着的标签；右边一边最左边的标签上 Alt+←：回到左边一边正显示着的", () => {
    expect(stepAcrossGroups(shown, currents, 0, todo("b"), 1)).toMatchObject({ group: 1, tab: { todoId: "d" } });
    expect(stepAcrossGroups(shown, currents, 1, todo("c"), -1)).toMatchObject({ group: 0, tab: { todoId: "b" } });
  });

  it("两头：左边一边最左边的标签上 Alt+←、右边一边最右边的标签上 Alt+→ 不切换（回到左侧列表 / 焦点放进正文）", () => {
    expect(stepAcrossGroups(shown, currents, 0, todo("a"), -1)).toBeNull();
    expect(stepAcrossGroups(shown, currents, 1, todo("d"), 1)).toBeNull();
  });

  it("另一边没显示出来、这一边显示概览时：不切换", () => {
    expect(stepAcrossGroups([[fixed("a")], []], [todo("a"), null], 0, todo("a"), 1)).toBeNull();
    expect(stepAcrossGroups(shown, currents, 0, null, 1)).toBeNull();
  });

  it("不分屏时同 neighborTab", () => {
    expect(stepAcrossGroups([[fixed("a"), fixed("b")]], [todo("a")], 0, todo("a"), 1)).toMatchObject({ group: 0, tab: { todoId: "b" } });
    expect(stepAcrossGroups([[fixed("a"), fixed("b")]], [todo("b")], 0, todo("b"), 1)).toBeNull();
  });
});

it("一开始不分屏、没有标签", () => {
  expect(SINGLE_GROUP.groups).toHaveLength(1);
  expect(SINGLE_GROUP.groups[0].tabs).toHaveLength(0);
});
