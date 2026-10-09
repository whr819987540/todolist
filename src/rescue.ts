import { errMsg } from "./api";
import { projectLabel } from "./projects";
import type { QuickTarget, TodoSummary } from "./types";

// docs/requirements.md「待办内容 → 感知外部修改」：离开一条待办（切换待办、关标签、返回首页等）、从托盘退出时
// 存盘存不上（正文在外部被改过，或者待办、项目在外部被删了等），这时没法再弹对话框让用户选，自动另存为新待办，
// 两份都保留；原来的项目也不在了时存到快速记录存到的项目里

/** 工作区里的一个项目（路径：顶层项目是名字，子项目是「父项目/子项目」） */
export interface ProjectAt {
  workspace: string;
  project: string;
}

/** 为什么存不上：正文在外部被改过（存盘时发现，或者正显示着冲突对话框），或者保存失败了（error 是原因） */
export type LeaveProblem = { conflict: true } | { conflict: false; error: string };

/**
 * 离开时存完盘，还有没存上的修改就要另存，返回为什么存不上；都存好了、或者这条待办已经改名 / 移走 / 删除
 * （detached，之后不再往它存，内容在操作前存好了）时是 null
 */
export function leaveProblem(o: {
  /** 标题或正文还有没存上的修改 */
  unsaved: boolean;
  detached: boolean;
  /** 正文在外部被改过 */
  conflict: boolean;
  /** 这次存盘失败的原因 */
  error: string;
}): LeaveProblem | null {
  if (!o.unsaved || o.detached) return null;
  return o.conflict ? { conflict: true } : { conflict: false, error: o.error || "原因不明" };
}

/** 新建待办，同 api.createTodo：createProject 为 true 时工作区、项目不在就先建 */
export type CreateTodo = (
  workspace: string,
  project: string,
  title: string,
  content: string,
  createProject: boolean,
) => Promise<TodoSummary>;

/**
 * 另存到哪里，按顺序试：原来的项目（不在了不重新建，免得把在外部删掉的项目又建回来），
 * 再是快速记录存到的项目（不在时新建，同快速记录）
 */
export function rescuePlaces(here: ProjectAt, quick: QuickTarget | undefined): { at: ProjectAt; createProject: boolean }[] {
  const places = [{ at: here, createProject: false }];
  if (quick) places.push({ at: { workspace: quick.workspace, project: quick.project }, createProject: true });
  return places;
}

export type RescueResult = { ok: true; todo: TodoSummary; at: ProjectAt } | { ok: false; error: string };

/** 存成一条新待办（标题已经加上了「（我的版本）」），按 rescuePlaces 的顺序试，存好了就不再往下试 */
export async function rescueAsNew(
  create: CreateTodo,
  here: ProjectAt,
  quick: QuickTarget | undefined,
  title: string,
  content: string,
): Promise<RescueResult> {
  let error = "";
  for (const { at, createProject } of rescuePlaces(here, quick)) {
    try {
      return { ok: true, todo: await create(at.workspace, at.project, title, content, createProject), at };
    } catch (e) {
      error = errMsg(e);
    }
  }
  return { ok: false, error };
}

/**
 * 另存也失败时，没存上的修改在哪里：编辑区里（从托盘退出时，没有退出）、复制到了剪贴板，或者没留下来
 */
export type Leftover = "editor" | "clipboard" | "lost";

/**
 * 另存后的提示：original 是原来那条显示的标题。另存到了别的项目时写明在哪里；另存也失败时说明修改在哪里
 */
export function rescueNotice(
  problem: LeaveProblem,
  original: string,
  here: ProjectAt,
  result: RescueResult,
  leftover: Leftover = "lost",
): string {
  const why = problem.conflict ? `「${original}」在外部被改过` : `「${original}」没能保存（${problem.error}）`;
  if (!result.ok) {
    const tail = {
      editor: "修改还在编辑区里",
      clipboard: "你没保存的修改已复制到剪贴板，请粘贴到别处保存",
      lost: "你没保存的修改没能留下来",
    }[leftover];
    return `${why}，另存为新待办也失败了（${result.error}）。${tail}`;
  }
  const { at, todo } = result;
  const where =
    at.workspace === here.workspace && at.project === here.project ? "" : `「${at.workspace} / ${projectLabel(at.project)}」里的`;
  return `${why}，你没保存的修改已另存为${where}新待办「${todo.title}」${problem.conflict ? "，两份都保留" : ""}`;
}
