import { App as AntApp, Checkbox } from "antd";
import { useCallback, useRef } from "react";
import { api, errMsg } from "../api";
import {
  exportCounts,
  exportedText,
  exportGroups,
  exportTitle,
  printDialogText,
  readExportDir,
  rememberExportDir,
} from "../exporting";
import type { ExportFormat, ExportGroup, ExportScope, SortKey } from "../types";

/** 一次导出：导出什么、按哪种排序（这个工作区侧栏现在的），以及先存盘 */
export interface ExportPlan {
  format: ExportFormat;
  scope: ExportScope;
  workspace: string;
  /** 导出项目时是这个项目；导出一条待办时是它所在的项目 */
  project?: string;
  /** 导出一条待办时是它的 id */
  todo?: string;
  sortKey: SortKey;
  /** 右侧正在编辑的待办在导出的范围里时先存盘；返回是否存好了（没有要存的也算），存不上就不导出 */
  flush: () => Promise<boolean>;
}

/** 导出完的提示停留多久（秒） */
const DONE_SECONDS = 10;

/**
 * 导出成 HTML / PDF 的流程：先存盘（存不上不导出）→ 导出项目、工作区时重新读一遍数据，按侧栏的排序和项目的顺序排好，确认
 * 「包含已完成的待办」→「另存为」对话框（Rust 端，从上次导出到的目录打开）→ 在后台导出，期间显示「正在导出…」→
 * 提示存到了哪里，带「打开」「在文件夹中显示」；失败时写明原因
 */
export function useExport() {
  const { message, modal } = AntApp.useApp();
  // 同时导出几份时各自的提示不互相顶掉
  const seq = useRef(0);

  /** 确认框：一共几条、已完成几条，「包含已完成的待办」（默认包含）；返回选了什么，取消时为 null */
  const askIncludeDone = useCallback(
    (title: string, scope: ExportScope, total: number, done: number) =>
      new Promise<boolean | null>((resolve) => {
        let include = true;
        modal.confirm({
          title,
          icon: null,
          className: "export-confirm",
          content: (
            <div className="export-options">
              <div>
                一共 {total} 条待办{scope === "project" ? "（含子项目里的）" : ""}，其中已完成 {done} 条。
              </div>
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
        if (!(await plan.flush())) return;
        let groups: ExportGroup[];
        let includeDone = true;
        if (plan.scope === "todo") {
          if (!plan.project || !plan.todo) return;
          groups = [{ project: plan.project, ids: [plan.todo] }];
        } else {
          // 按现在磁盘上的数据：刚存的标题、外部的修改、项目的顺序（.projects.json）都算上
          const tree = await api.loadWorkspace(plan.workspace);
          groups = exportGroups(tree.projects, plan.project, plan.sortKey, tree.manualOrder);
          const { total, done } = exportCounts(tree.projects, groups);
          const choice = await askIncludeDone(exportTitle(plan.format, plan.workspace, plan.project), plan.scope, total, done);
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
          project: plan.scope === "project" ? (plan.project ?? null) : null,
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
