import { describe, expect, it } from "vitest";
import { type DataChanged, dataTouched, recycleTouched, todoTouched, workspacesTouched } from "./watch";

// docs/requirements.md「待办内容 → 感知外部修改 → 监听数据目录」：只刷新有变化的——侧栏里选中的工作区有变化才重新加载，
// 首页在哪个工作区有变化时都重新统计，打开着的待办只在它的正文文件或它所在的项目、工作区文件夹变了时核对磁盘；
// 回收站 `.recycle` 只用来刷新开着的回收站列表

const changed = (paths: string[], more: Partial<DataChanged> = {}): DataChanged => ({ all: false, paths, recycle: false, ...more });

describe("数据目录在外部变了时刷新什么", () => {
  it("快速记录存好后、从回收站恢复后等发的 data-changed 不带内容：首页、工作区视图、回收站都刷新，打开着的待办不用核对", () => {
    for (const c of [null, undefined]) {
      expect(dataTouched(c)).toBe(true);
      expect(workspacesTouched(c, ["工作"])).toBe(true);
      expect(recycleTouched(c)).toBe(true);
      expect(todoTouched(c, "工作", "需求", "A")).toBe(false);
    }
  });

  it("什么都可能变了：都刷新，打开着的待办也核对磁盘", () => {
    const c = changed([], { all: true });
    expect(dataTouched(c)).toBe(true);
    expect(workspacesTouched(c, ["学习"])).toBe(true);
    expect(recycleTouched(c)).toBe(true);
    expect(todoTouched(c, "工作", "需求", "A")).toBe(true);
  });

  it("只是回收站变了：只有开着的回收站刷新", () => {
    const c = changed([], { recycle: true });
    expect(recycleTouched(c)).toBe(true);
    expect(dataTouched(c)).toBe(false);
    expect(workspacesTouched(c, ["工作"])).toBe(false);
    expect(todoTouched(c, "工作", "需求", "A")).toBe(false);
  });

  it("工作区视图只在侧栏里选中的工作区有变化时重新加载；首页哪个工作区变了都重新统计", () => {
    const c = changed(["生活/杂事/E.md"]);
    expect(workspacesTouched(c, ["工作"])).toBe(false);
    expect(workspacesTouched(c, ["工作", "生活"])).toBe(true);
    // 名字只是开头一样的工作区不算
    expect(workspacesTouched(changed(["生活日常/杂事/E.md"]), ["生活"])).toBe(false);
    // 工作区的文件夹本身（在外部新建、改名、删除）
    expect(workspacesTouched(changed(["工作"]), ["工作"])).toBe(true);
    expect(dataTouched(c)).toBe(true);
    expect(recycleTouched(c)).toBe(false);
  });

  it("打开着的待办只在它的正文文件变了时核对磁盘", () => {
    expect(todoTouched(changed(["工作/需求/A.md"]), "工作", "需求", "A")).toBe(true);
    expect(todoTouched(changed(["工作/需求/B.md"]), "工作", "需求", "A")).toBe(false);
    expect(todoTouched(changed(["工作/需求/A.md"]), "工作", "需求池", "A")).toBe(false);
    // 子项目里的待办
    expect(todoTouched(changed(["工作/需求/前端/A.md"]), "工作", "需求/前端", "A")).toBe(true);
    expect(todoTouched(changed(["工作/需求/A.md"]), "工作", "需求/前端", "A")).toBe(false);
    // 只是标题、完成状态这些元数据变了：随工作区视图的刷新过来，不用核对正文
    expect(todoTouched(changed(["工作/需求/.todos.json"]), "工作", "需求", "A")).toBe(false);
  });

  it("打开着的待办所在的项目、父项目、工作区的文件夹在外部改名、删掉了：核对磁盘", () => {
    expect(todoTouched(changed(["工作/需求"]), "工作", "需求", "A")).toBe(true);
    expect(todoTouched(changed(["工作"]), "工作", "需求", "A")).toBe(true);
    expect(todoTouched(changed(["工作/需求"]), "工作", "需求/前端", "A")).toBe(true);
    expect(todoTouched(changed(["工作/需求/前端"]), "工作", "需求/前端", "A")).toBe(true);
    // 名字只是开头一样的项目、同一项目里的子项目不算
    expect(todoTouched(changed(["工作/需"]), "工作", "需求", "A")).toBe(false);
    expect(todoTouched(changed(["工作/需求/前端"]), "工作", "需求", "A")).toBe(false);
  });
});
