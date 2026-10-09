import { describe, expect, it, vi } from "vitest";
import { type CreateTodo, leaveProblem, rescueAsNew, rescueNotice, rescuePlaces, type RescueResult } from "./rescue";
import type { TodoSummary } from "./types";

// docs/requirements.md「待办内容 → 感知外部修改」：离开一条待办（切换待办、关标签、返回首页等）或从托盘退出时
// 存不上（正文在外部被改过、正显示着冲突对话框，待办或项目在外部被删了等），自动另存为新待办，两份都保留：
// 存成同一项目里的一条新待办；原来的项目也不在了时存到快速记录存到的项目（不在时新建）；提示新待办的标题，
// 另存也失败时明确提示

const summary = (title: string, id = "20261009-120000"): TodoSummary => ({
  id,
  title,
  preview: "",
  done: false,
  createdAt: 0,
  updatedAt: 0,
  doneAt: null,
  pinned: false,
  order: null,
});

const here = { workspace: "工作", project: "需求" };
const quick = { workspace: "收件箱", project: "快速记录" };

/** 只有 ok 里列出的地方建得成（「工作区/项目」），其他的报「项目不存在」 */
function fakeCreate(...ok: string[]) {
  return vi.fn<CreateTodo>(async (workspace, project, title) => {
    if (!ok.includes(`${workspace}/${project}`)) throw `项目「${project}」不存在`;
    return summary(title);
  });
}

describe("离开时要不要另存（leaveProblem）", () => {
  it("都存好了不另存", () => {
    expect(leaveProblem({ unsaved: false, detached: false, conflict: false, error: "" })).toBeNull();
    // 正显示着冲突对话框，但已经没有没存的修改（例如刚选了「放弃我的修改」）
    expect(leaveProblem({ unsaved: false, detached: false, conflict: true, error: "" })).toBeNull();
  });

  it("改名、移动、删除之后（不再往这一条存，内容在操作前存好了）不另存", () => {
    expect(leaveProblem({ unsaved: true, detached: true, conflict: true, error: "" })).toBeNull();
  });

  it("正文在外部被改过：按冲突另存", () => {
    expect(leaveProblem({ unsaved: true, detached: false, conflict: true, error: "" })).toEqual({ conflict: true });
  });

  it("保存失败（待办、项目在外部被删了等）：带着原因另存", () => {
    expect(leaveProblem({ unsaved: true, detached: false, conflict: false, error: "待办不存在，可能已被删除或移动" })).toEqual({
      conflict: false,
      error: "待办不存在，可能已被删除或移动",
    });
  });
});

describe("另存到哪里（rescuePlaces / rescueAsNew）", () => {
  it("先存进原来的项目（不重新建），再是快速记录存到的项目（不在时新建）", () => {
    expect(rescuePlaces(here, quick)).toEqual([
      { at: here, createProject: false },
      { at: quick, createProject: true },
    ]);
    // 还没读出设置时只试原来的项目
    expect(rescuePlaces(here, undefined)).toEqual([{ at: here, createProject: false }]);
  });

  it("原来的项目还在：存成其中的一条新待办，标题、正文原样", async () => {
    const create = fakeCreate("工作/需求");
    const r = await rescueAsNew(create, here, quick, "周报（我的版本）", "# 我改的\n");
    expect(r).toEqual({ ok: true, todo: summary("周报（我的版本）"), at: here });
    expect(create.mock.calls).toEqual([["工作", "需求", "周报（我的版本）", "# 我改的\n", false]]);
  });

  it("原来的项目也不在了：存到快速记录存到的项目，不在时新建", async () => {
    const create = fakeCreate("收件箱/快速记录");
    const r = await rescueAsNew(create, here, quick, "周报（我的版本）", "正文");
    expect(r).toEqual({ ok: true, todo: summary("周报（我的版本）"), at: quick });
    expect(create.mock.calls.map((c) => [c[0], c[1], c[4]])).toEqual([
      ["工作", "需求", false],
      ["收件箱", "快速记录", true],
    ]);
  });

  it("快速记录存到的就是原来那个项目、它被删了：照快速记录的做法重新建", async () => {
    const create = vi.fn<CreateTodo>(async (_w, _p, title, _c, createProject) => {
      if (!createProject) throw "项目「快速记录」不存在";
      return summary(title);
    });
    const r = await rescueAsNew(create, quick, quick, "灵感（我的版本）", "x");
    expect(r.ok && r.at).toEqual(quick);
  });

  it("都存不进去：失败，带着原因", async () => {
    const create = vi.fn<CreateTodo>(async () => {
      throw "创建待办文件失败：拒绝访问";
    });
    expect(await rescueAsNew(create, here, quick, "周报（我的版本）", "正文")).toEqual({
      ok: false,
      error: "创建待办文件失败：拒绝访问",
    });
  });
});

describe("另存后的提示（rescueNotice）", () => {
  const saved = (at = here): RescueResult => ({ ok: true, todo: summary("周报（我的版本）"), at });

  it("外部改过：说明原来那条在外部被改过、新待办的标题，两份都保留", () => {
    const text = rescueNotice({ conflict: true }, "周报", here, saved());
    expect(text).toBe("「周报」在外部被改过，你没保存的修改已另存为新待办「周报（我的版本）」，两份都保留");
  });

  it("保存失败：带上原因；存到了别的项目时写明在哪里（子项目写成「父项目 / 子项目」）", () => {
    const text = rescueNotice({ conflict: false, error: "项目「需求」不存在" }, "周报", here, saved(quick));
    expect(text).toBe("「周报」没能保存（项目「需求」不存在），你没保存的修改已另存为「收件箱 / 快速记录」里的新待办「周报（我的版本）」");
    const sub = rescueNotice({ conflict: true }, "周报", here, saved({ workspace: "收件箱", project: "灵感/产品" }));
    expect(sub).toContain("「收件箱 / 灵感 / 产品」里的新待办「周报（我的版本）」");
  });

  it("另存也失败：明确说明，以及修改在哪里", () => {
    const failed: RescueResult = { ok: false, error: "拒绝访问" };
    const problem = { conflict: false as const, error: "待办不存在，可能已被删除或移动" };
    const lost = rescueNotice(problem, "周报", here, failed);
    expect(lost).toContain("「周报」没能保存（待办不存在，可能已被删除或移动），另存为新待办也失败了（拒绝访问）");
    expect(lost).toContain("没能留下来");
    expect(rescueNotice(problem, "周报", here, failed, "clipboard")).toContain("已复制到剪贴板");
    // 从托盘退出时：还在编辑区里（不退出）
    expect(rescueNotice({ conflict: true }, "周报", here, failed, "editor")).toContain("还在编辑区里");
  });
});
