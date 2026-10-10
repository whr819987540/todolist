import { CheckCircleOutlined, CloseOutlined, DeleteOutlined, PushpinOutlined, SwapOutlined, UndoOutlined } from "@ant-design/icons";
import { Button, Dropdown } from "antd";
import { projectLabel, shortPlaceLabel, shortProjectLabel } from "../projects";
import { displayTitle } from "../utils";
import type { TodoAt } from "./DragMove";
import { batchMoveMenu, type MoveTarget } from "./menus";
import type { BatchActions } from "./workspaceActions";

/** 一条待办在列表里显示的位置：同时显示了几个工作区时带上工作区；层级多时中间折叠，悬停看完整的 */
const placeOf = (x: TodoAt, multi: boolean) =>
  multi ? shortPlaceLabel(x.workspace, x.project) : shortProjectLabel(x.project);

/** 左侧列表里多选了待办时，右侧显示的批量操作 */
export default function BatchPanel({
  items,
  targets,
  actions: a,
  onClear,
}: {
  items: TodoAt[];
  /** 可以移到的项目：侧栏里显示的各工作区的项目 */
  targets: readonly MoveTarget[];
  actions: BatchActions;
  onClear: () => void;
}) {
  const multi = new Set(items.map((x) => x.workspace)).size > 1 || targets.length > 1;
  const done = items.filter((x) => x.todo.done).length;
  const pinned = items.filter((x) => x.todo.pinned).length;
  return (
    <section className="overview batch">
      <div className="overview-head">
        <div className="overview-title">
          <h2>已选择 {items.length} 条待办</h2>
          <div className="muted">
            {items.length - done} 条未完成、{done} 条已完成
            {pinned > 0 && `，${pinned} 条置顶`}
          </div>
        </div>
        <div className="overview-actions">
          <Button icon={<CloseOutlined />} onClick={onClear}>
            取消选择
          </Button>
        </div>
      </div>

      <div className="batch-actions">
        <Button type="primary" icon={<CheckCircleOutlined />} onClick={() => a.setDone(items, true)}>
          标记为已完成
        </Button>
        <Button icon={<UndoOutlined />} onClick={() => a.setDone(items, false)}>
          标记为未完成
        </Button>
        <Button icon={<PushpinOutlined />} onClick={() => a.setPinned(items, pinned < items.length)}>
          {pinned < items.length ? "置顶" : "取消置顶"}
        </Button>
        <Dropdown menu={batchMoveMenu(targets, (ws, p) => a.move(items, p, ws))} trigger={["click"]}>
          <Button icon={<SwapOutlined />}>移动到</Button>
        </Dropdown>
        <Button danger icon={<DeleteOutlined />} onClick={() => a.remove(items)}>
          删除
        </Button>
      </div>

      <div className="section-title">选中的待办</div>
      <div className="list">
        {items.map((x) => {
          const { text, fromContent } = displayTitle(x.todo);
          return (
            <div key={`${x.workspace}/${x.project}/${x.todo.id}`} className={`list-row${x.todo.done ? " done" : ""}`}>
              <span className={`list-title${fromContent ? " from-content" : ""}`}>{text}</span>
              <span className="list-path" title={`${x.workspace} / ${projectLabel(x.project)}`}>
                {placeOf(x, multi)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="setting-hint muted">
        在左侧列表里 Ctrl+单击加选或取消一条，Shift+单击选中一段；把选中的拖到左侧的项目上可以一起移过去；按 Esc 取消选择
      </div>
    </section>
  );
}
