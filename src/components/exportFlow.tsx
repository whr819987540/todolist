import { App as AntApp, Checkbox } from "antd";
import { useCallback, useRef } from "react";
import { api, errMsg } from "../api";
import {
  countsText,
  exportedText,
  exportGroups,
  exportTitle,
  printDialogText,
  readExportDir,
  rememberExportDir,
} from "../exporting";
import type { ExportFormat, ExportGroup, ExportScope, SortKey } from "../types";

/** 一次导出：导出什么、待办按哪种排序（这个工作区侧栏现在的），以及先存盘 */
export interface ExportPlan {
  format: ExportFormat;
  scope: ExportScope;
  workspace: string;
  /** 导出项目时是这个项目（哪一级的都行）；导出一条待办时是它所在的项目 */
  project?: string;
  /** 导出一条待办时是它的 id */
  todo?: string;
  sortKey: SortKey;
  /**
   * 先把打开着的待办存盘（分屏时两边的都存）：导出的范围里开着的存不上（弹出了冲突对话框、保存失败）时抛出，
   * 不导出（WorkspaceView 的 saveFirst）
   */
  saveFirst: () => Promise<void>;
}

/** 导出完的提示停留多久（秒） */
const DONE_SECONDS = 10;

/**
 * 导出成 HTML / PDF 的流程：先存盘（存不上不导出）→ 导出项目、工作区时重新读一遍数据，按侧栏的排序和项目的顺序排成项目树，
 * 确认「包含已完成的待办」→「另存为」对话框（Rust 端，从上次导出到的目录打开）→ 在后台导出，期间显示「正在导出…」→
 * 提示存到了哪里，带「打开」「在文件夹中显示」；失败时写明原因
 */
export function useExport() {
  const { message, modal } = AntApp.useApp();
  // 同时导出几份时各自的提示不互相顶掉
  const seq = useRef(0);

  /** 确认框：一共几条、已完成几条，「包含已完成的待办」（默认包含）；返回选了什么，取消时为 null */
  const askIncludeDone = useCallback(
    (title: string, counts: string) =>
      new Promise<boolean | null>((resolve) => {
        let include = true;
        modal.confirm({
          title,
          icon: null,
          className: "export-confirm",
          content: (
            <div className="export-options">
              <div>{counts}</div>
              <Checkbox className="export-include-done" defaultChecked onChange={(e) => (include = e.target.checked)}>
                包含已完成的待办
              </Checkbox>
            </div>
          ),
          okText: "导出…",
          cancelText: "取消",
          onOk: () => resolve(include),
          onCancel: () => resolve(null),
        });
      }),
    [modal],
  );

  return useCallback(
    async (plan: ExportPlan) => {
      const key = `export:${++seq.current}`;
      try {
        await plan.saveFirst();
      } catch (e) {
        message.error(errMsg(e));
        return;
      }
      try {
        let groups: ExportGroup[];
        let includeDone = true;
        if (plan.scope === "todo") {
          if (!plan.project || !plan.todo) return;
          groups = [{ project: plan.project, ids: [plan.todo], children: [] }];
        } else {
          // 按现在磁盘上的数据：刚存的标题、外部的修改、各层项目的顺序（.projects.json）都算上
          const tree = await api.loadWorkspace(plan.workspace);
          // 点了菜单之后这个项目已经不在了（刚被删掉、改名、移走）：不弹确认框
          if (plan.project !== undefined && !tree.projects.some((p) => p.name === plan.project))
            throw new Error("项目不存在，可能已被删除或移动");
          groups = exportGroups(tree.projects, plan.project, plan.sortKey, tree.manualOrder);
          const title = exportTitle(plan.format, plan.workspace, plan.project);
          const choice = await askIncludeDone(title, countsText(tree.projects, plan.project));
          if (choice === null) return;
          includeDone = choice;
        }
        const path = await api.pickExportTarget(plan.format, plan.workspace, plan.project ?? null, plan.todo ?? null, readExportDir());
        if (!path) return;
        message.open({ key, type: "loading", content: "正在导出…", duration: 0 });
        const r = await api.exportTodos({
          format: plan.format,
          path,
          scope: plan.scope,
          workspace: plan.workspace,
          includeDone,
          groups,
        });
        if (r.printDialog !== null) {
          // 没导出成文件：不记目录，没有「打开」「在文件夹中显示」
          message.open({ key, type: "warning", duration: DONE_SECONDS, content: printDialogText(r.printDialog) });
          return;
        }
        rememberExportDir(r.path);
        const act = (fn: (path: string) => Promise<void>) => () => {
          message.destroy(key);
          fn(r.path).catch((e) => message.error(errMsg(e)));
        };
        message.open({
          key,
          type: "success",
          duration: DONE_SECONDS,
          content: (
            <span className="export-done">
              {exportedText(r)}
              <a className="undo-link" onClick={act(api.openExported)}>
                打开
              </a>
              <a className="undo-link" onClick={act(api.revealExported)}>
                在文件夹中显示
              </a>
            </span>
          ),
        });
      } catch (e) {
        message.open({ key, type: "error", content: `导出失败：${errMsg(e)}` });
      }
    },
    [message, askIncludeDone],
  );
}
