import { priorityText } from "../../priority";
import type { TodoSummary } from "../../types";
import { displayTitle, fullTime } from "../../utils";

/** 待办行的悬停提示 */
export default function TodoTip({ t }: { t: TodoSummary }) {
  return (
    <div className="todo-tip">
      <div className="todo-tip-title">{displayTitle(t).text}</div>
      <div>
        状态：{t.done ? "已完成" : "未完成"}
        {t.pinned && "，已置顶"}
        {t.priority > 0 && `，${priorityText(t.priority)}`}
      </div>
      {t.tags.length > 0 && <div className="todo-tip-tags">标签：{t.tags.join("、")}</div>}
      <div>创建时间：{fullTime(t.createdAt)}</div>
      <div>修改时间：{fullTime(t.updatedAt)}</div>
      {t.done && t.doneAt && <div>完成时间：{fullTime(t.doneAt)}</div>}
      <div className="todo-tip-hint">右键可用默认程序打开，拖到其他项目上可移动过去</div>
    </div>
  );
}
