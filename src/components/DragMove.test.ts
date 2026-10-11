import { describe, expect, it } from "vitest";
import type { WorkspaceTree } from "../types";
import { type DragItem, type DragState, type DropTarget, dragConcerns, dropClass, edgePlace, judge, projectMark } from "./DragMove";

// docs/requirements.md「拖动移动项目」：拖到另一个项目（哪一级的都行）那一行的上沿 / 下沿（各占行高的四分之一）时放在它的
// 前面 / 后面，中间时同原来（放进它）。放到的是它所在的那一层：同一层是调整顺序，不在同一层是移过去放在那里（跨几级也行，
// 有子项目的也行），能不能放同移动的规则（同名的不能放，标红说明原因；放到它自己的子项目旁边不算能放的地方）；
// 搜索、筛选时不能这样调整顺序，说明原因

const tree = (name: string, ...projects: string[]): WorkspaceTree => ({
  name,
  projects: projects.map((p) => ({ name: p, todos: [], order: null })),
  manualOrder: false,
});
const trees = [
  tree("工作", "需求", "需求/前端", "需求/前端/组件", "需求/前端/页面", "需求/后端", "日常", "零散"),
  tree("生活", "购物", "购物/零散", "旅行"),
];
const project = (p: string, workspace = "工作"): DragItem => ({ kind: "project", workspace, project: p });
/** 放在 sibling 旁边：放到的是它所在的那一层（它的父项目，顶层时没有） */
const beside = (sibling: string, place: "before" | "after", workspace = "工作"): DropTarget => ({
  workspace,
  project: sibling.includes("/") ? sibling.slice(0, sibling.lastIndexOf("/")) : undefined,
  sibling,
  place,
});
const SEARCHING = "搜索时不能调整顺序，先清空搜索";
const FILTERING = "筛选时不能调整顺序，先清除筛选";

describe("指针在行的哪一截", () => {
  it("上下各四分之一是放在前面 / 后面，中间是放进去", () => {
    expect(edgePlace(3, 32)).toBe("before");
    expect(edgePlace(7.9, 32)).toBe("before");
    expect(edgePlace(8, 32)).toBeNull();
    expect(edgePlace(16, 32)).toBeNull();
    expect(edgePlace(24, 32)).toBeNull();
    expect(edgePlace(24.1, 32)).toBe("after");
    expect(edgePlace(31, 32)).toBe("after");
  });
});

describe("项目放在另一个项目旁边", () => {
  const at = (item: DragItem, target: DropTarget, blocked: string | null = null) => judge(item, target, trees, blocked);

  it("同一层是调整顺序：顶层、子项目里、深处的一层都行", () => {
    expect(at(project("日常"), beside("需求", "before"))).toEqual({ status: "ok", hint: "放在「需求」前面" });
    expect(at(project("需求/前端"), beside("需求/后端", "after"))).toEqual({ status: "ok", hint: "放在「后端」后面" });
    expect(at(project("需求/前端/页面"), beside("需求/前端/组件", "before"))).toEqual({ status: "ok", hint: "放在「组件」前面" });
  });

  it("放下后顺序不变的（它前一个的后面、后一个的前面）不算能放的地方", () => {
    // 「工作」的顶层按现在的顺序是 需求、日常、零散；「需求/前端」里是 组件、页面
    expect(at(project("日常"), beside("需求", "after"))).toEqual({ status: "none", hint: "已在这个位置" });
    expect(at(project("日常"), beside("零散", "before"))).toEqual({ status: "none", hint: "已在这个位置" });
    expect(at(project("需求/前端/页面"), beside("需求/前端/组件", "after"))).toEqual({ status: "none", hint: "已在这个位置" });
    expect(at(project("零散"), beside("需求", "before")).status).toBe("ok");
    expect(at(project("日常"), beside("零散", "after")).status).toBe("ok");
  });

  it("不在同一层是移过去放在那里，说明移到哪里", () => {
    expect(at(project("需求/前端"), beside("日常", "before"))).toEqual({ status: "ok", hint: "移出来，放在「日常」前面" });
    expect(at(project("零散"), beside("需求/前端", "after"))).toEqual({ status: "ok", hint: "放进「需求」，放在「前端」后面" });
    expect(at(project("日常"), beside("购物", "before", "生活"))).toEqual({
      status: "ok",
      hint: "移动到工作区「生活」，放在「购物」前面",
    });
    expect(at(project("日常"), beside("购物/零散", "after", "生活"))).toEqual({
      status: "ok",
      hint: "放进「生活 / 购物」，放在「零散」后面",
    });
  });

  it("跨几级也是移过去放在那里：放进深处的一层、从深处移出来，说明里深处的路径写全（不到 4 级不折叠）", () => {
    expect(at(project("零散"), beside("需求/前端/组件", "after"))).toEqual({
      status: "ok",
      hint: "放进「需求 / 前端」，放在「组件」后面",
    });
    expect(at(project("需求/前端/页面"), beside("日常", "before"))).toEqual({ status: "ok", hint: "移出来，放在「日常」前面" });
    expect(at(project("需求/前端/页面"), beside("需求/后端", "after"))).toEqual({ status: "ok", hint: "放进「需求」，放在「后端」后面" });
  });

  it("有子项目的也能放到别的层（下面各级跟着）", () => {
    expect(at(project("需求"), beside("购物/零散", "before", "生活"))).toEqual({
      status: "ok",
      hint: "放进「生活 / 购物」，放在「零散」前面",
    });
    expect(at(project("需求/前端"), beside("日常", "after"))).toEqual({ status: "ok", hint: "移出来，放在「日常」后面" });
  });

  it("那里有同名的不能放：标红，说明原因", () => {
    const taken = at(project("零散"), beside("购物/零散", "before", "生活"));
    expect(taken.status).toBe("refused");
    expect(taken.hint).toContain("已有同名");
    expect(at(project("购物/零散", "生活"), beside("日常", "after"))).toEqual({
      status: "refused",
      hint: "「工作」里已有同名项目",
    });
  });

  it("放在它自己的子项目（哪一级的）旁边不算能放的地方，说明原因", () => {
    expect(at(project("需求"), beside("需求/前端", "before"))).toEqual({ status: "none", hint: "不能放进它自己里面" });
    expect(at(project("需求"), beside("需求/前端/组件", "after"))).toEqual({ status: "none", hint: "不能放进它自己的子项目里" });
  });

  it("搜索、筛选时不能调整顺序：说明原因、放不下；拖到中间照常移动", () => {
    expect(at(project("日常"), beside("需求", "before"), SEARCHING)).toEqual({ status: "none", hint: SEARCHING });
    expect(at(project("需求/前端"), beside("日常", "before"), SEARCHING).status).toBe("none");
    expect(at(project("需求/前端/页面"), beside("需求/前端/组件", "before"), FILTERING)).toEqual({ status: "none", hint: FILTERING });
    expect(at(project("日常"), { workspace: "工作", project: "需求" }, SEARCHING)).toEqual({
      status: "ok",
      hint: "放进「需求」，成为子项目",
    });
  });
});

describe("拖项目放在别的项目旁边时画在哪里", () => {
  const state = (target: DropTarget, status: DragState["status"] = "ok"): DragState => ({
    item: project("日常"),
    target,
    status,
    hint: "",
  });

  it("插入线画在那个项目上（哪一级的都行），放不下时标红；放不下的地方（none）不画", () => {
    expect(projectMark(state(beside("需求/前端/组件", "before")), "工作", "需求/前端/组件")).toEqual({ place: "before", refused: false });
    expect(projectMark(state(beside("需求/前端/组件", "before")), "工作", "需求/前端")).toBeUndefined();
    expect(projectMark(state(beside("需求/后端", "after")), "工作", "需求/后端")).toEqual({ place: "after", refused: false });
    expect(projectMark(state(beside("需求", "before"), "refused"), "工作", "需求")).toEqual({ place: "before", refused: true });
    expect(projectMark(state(beside("需求", "before"), "none"), "工作", "需求")).toBeUndefined();
    expect(projectMark(state(beside("需求", "before")), "工作", "零散")).toBeUndefined();
    expect(projectMark(state(beside("需求", "before")), "生活", "需求")).toBeUndefined();
  });

  it("不把那一层（工作区、父项目）整块高亮", () => {
    expect(dropClass(state(beside("需求", "before")), "工作")).toBeUndefined();
    expect(dropClass(state(beside("需求/前端", "before")), "工作", "需求")).toBeUndefined();
    expect(dropClass(state({ workspace: "工作", project: "需求" }), "工作", "需求")).toBe("drop-target");
  });

  it("深处的项目：它和它的各级父项目跟着重新渲染（侧栏一级级往下传），旁边的不用", () => {
    const s = state(beside("需求/前端/组件", "before"));
    expect(["需求", "需求/前端", "需求/前端/组件"].every((p) => dragConcerns(s, "工作", p))).toBe(true);
    expect(dragConcerns(s, "工作", "需求/前端/页面")).toBe(false);
    expect(dragConcerns(s, "工作", "需求/后端")).toBe(false);
  });

  it("那个项目（和它的父项目）跟着重新渲染，别的项目不用", () => {
    const s = state(beside("需求/后端", "after"));
    expect(dragConcerns(s, "工作", "需求")).toBe(true);
    expect(dragConcerns(s, "工作", "需求/后端")).toBe(true);
    expect(dragConcerns(s, "工作", "需求/前端")).toBe(false);
    expect(dragConcerns(s, "工作", "零散")).toBe(false);
    // 拖的是它自己
    expect(dragConcerns(s, "工作", "日常")).toBe(true);
  });
});
