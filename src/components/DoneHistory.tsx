import { CarryOutOutlined, CheckOutlined, FileTextOutlined, SearchOutlined, UndoOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Empty, Input, Modal, Segmented, Spin, Tooltip, type MenuProps } from "antd";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, errMsg } from "../api";
import {
  barLabel,
  countToday,
  dailyCounts,
  dayLabel,
  dayStart,
  DEFAULT_RANGE,
  groupByDay,
  HISTORY_RANGES,
  type HistoryRange,
  inRange,
  isHistoryRange,
  matchHistory,
  placeOf,
  rangeStart,
} from "../doneHistory";
import { useAppEvent, useWindowFocus } from "../hooks";
import { shortPlaceLabel } from "../projects";
import { isRefreshShortcut } from "../shortcuts";
import type { TodoRef } from "../tabs";
import type { DoneTodo, TodoSummary, WorkspaceTree } from "../types";
import { displayTitle, fullTime, useLocalState } from "../utils";
import { type DataChange, dataTouched } from "../watch";
import { useRowPopups } from "./sidebar/RowPopups";

// 完成记录：按完成日期列出完成了的待办（分组、范围、查找、统计的规则在 doneHistory.ts）。
// 首页头部和侧栏底部各有一个入口（同回收站）

interface Props {
  /** 侧栏里选中显示的工作区：在工作区里打开时默认看它们，可以切到全部工作区；首页上不给，看全部工作区 */
  workspaces?: readonly string[];
  /** 变了说明数据刷新过（首页的工作区列表、侧栏加载的工作区），开着时跟着重新读 */
  version: unknown;
  /** 点了一条：完成记录已经关掉，进入它所在的工作区打开它（同搜索结果） */
  onOpen: (t: TodoRef) => void;
  /** 标记为未完成之后：侧栏（连同右侧开着它的编辑区）、首页跟着更新 */
  onUndone: (workspace: string, project: string, s: TodoSummary) => void;
}

/** 看哪些工作区：侧栏里选中的、全部 */
type Scope = "selected" | "all";

/** 右键菜单用侧栏的那一套（共用一个菜单）；完成记录里没有悬停提示，不用工作区的树 */
const NO_TREES: WorkspaceTree[] = [];

const keyOf = (x: DoneTodo) => `${x.workspace}\u0000${x.project}\u0000${x.todo.id}`;

/** 每天完成了几条的柱状图：每天一根，最多的那天标出条数，悬停显示日期和条数，点一下跳到那天的组 */
function DailyBars({ bars, today, onPick }: { bars: { day: number; count: number }[]; today: number; onPick: (day: number) => void }) {
  const max = Math.max(0, ...bars.map((b) => b.count));
  // 最多的那天（一样多时取最近的）标出条数
  const peak = max > 0 ? bars.map((b) => b.count).lastIndexOf(max) : -1;
  // 30 天时每隔 7 天标一个日期（从今天往前数），7 天时每天都标
  const every = bars.length > 7 ? 7 : 1;
  return (
    <div className="history-chart" role="group" aria-label="每天完成的条数">
      {bars.map((b, i) => {
        const label = dayLabel(b.day, today);
        const height = b.count ? `${Math.max(8, (b.count / max) * 100)}%` : 0;
        return (
          <Tooltip
            key={b.day}
            title={
              <span className="history-bar-tip">
                <strong>{b.count} 条</strong>
                <span>{label}</span>
              </span>
            }
            trigger={["hover", "focus"]}
            mouseEnterDelay={0}
          >
            <button
              type="button"
              className={`history-slot${b.count ? "" : " empty"}`}
              aria-label={`${label}：${b.count} 条`}
              data-day={b.day}
              data-count={b.count}
              onClick={() => b.count && onPick(b.day)}
            >
              <span className="history-plot">
                {b.count > 0 && (
                  <span className="history-bar" style={{ height }}>
                    {i === peak && <span className="history-peak">{b.count}</span>}
                  </span>
                )}
              </span>
              <span className="history-tick">{(bars.length - 1 - i) % every === 0 ? barLabel(b.day, today) : ""}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** 完成记录里的一行；标签、优先级以后加在标题后面（跟着 TodoSummary 从 .todos.json 带过来） */
function HistoryRow({
  x,
  busy,
  onOpen,
  onUndone,
  onMenu,
}: {
  x: DoneTodo;
  busy: boolean;
  onOpen: (x: DoneTodo) => void;
  onUndone: (x: DoneTodo) => void;
  onMenu: (e: React.MouseEvent, x: DoneTodo) => void;
}) {
  const { text, fromContent } = displayTitle(x.todo);
  // 项目层级多时中间折叠（同搜索结果），悬停看完整的
  const place = placeOf(x);
  const at = x.todo.doneAt;
  return (
    <div className="list-row history-row" onClick={() => onOpen(x)} onContextMenu={(e) => onMenu(e, x)}>
      <span className="check static checked">
        <CheckOutlined />
      </span>
      <div className="list-main history-main">
        <span className={`list-title${fromContent ? " from-content" : ""}`} title={text}>
          {text}
        </span>
      </div>
      <span className="list-path" title={place}>
        {shortPlaceLabel(x.workspace, x.project)}
      </span>
      <span className="history-time" title={at === null ? "完成时间不详" : `完成时间：${fullTime(at)}`}>
        {at === null ? "" : dayjs(at).format("HH:mm")}
      </span>
      <Button
        size="small"
        type="text"
        className="history-undo"
        icon={<UndoOutlined />}
        loading={busy}
        title="标记为未完成"
        aria-label="标记为未完成"
        onClick={(e) => {
          e.stopPropagation();
          onUndone(x);
        }}
      />
    </div>
  );
}

/** 今天的零点（本地时间）：跨过零点时才变，只在那时重新渲染（「全部」里几千条时不必每隔一会儿整个重新渲染一遍） */
function useToday(): number {
  const [today, setToday] = useState(() => dayStart(Date.now()));
  useEffect(() => {
    const t = window.setInterval(() => setToday(dayStart(Date.now())), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return today;
}

/** 对话框里的内容：每次打开都重新建（看哪些工作区、查找的关键字从头开始），时间范围记在本机 */
function HistoryContent({ workspaces, version, onOpen, onUndone, onClose }: Props & { onClose: () => void }) {
  const { message } = AntApp.useApp();
  const [stored, setRange] = useLocalState<HistoryRange>("doneHistoryRange", DEFAULT_RANGE);
  const range = isHistoryRange(stored) ? stored : DEFAULT_RANGE;
  const [scope, setScope] = useState<Scope>("selected");
  const [keyword, setKeyword] = useState("");
  // 读到的列表，和读的时候看的是哪些工作区、什么范围（key）；还没读回来时是 null
  const [fetched, setFetched] = useState<{ key: string; list: DoneTodo[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popups = useRowPopups(NO_TREES);
  // 跨过零点时「今天」「昨天」、范围的起点跟着换
  const today = useToday();

  // 看的工作区按内容比较，每次渲染新建的数组不会让它重新读
  const wsKey = workspaces && scope === "selected" ? JSON.stringify(workspaces) : null;
  const fetchKey = JSON.stringify([wsKey, range]);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    const key = JSON.stringify([wsKey, range]);
    try {
      const found = await api.listDoneTodos(wsKey ? (JSON.parse(wsKey) as string[]) : null, rangeStart(range, Date.now()));
      if (n === seq.current) setFetched({ key, list: found });
    } catch (e) {
      if (n !== seq.current) return;
      message.error(errMsg(e));
      // 读不出来时留着原来的（下面照样按现在的工作区、范围筛），不再等
      setFetched((f) => ({ key, list: f?.list ?? [] }));
    }
  }, [wsKey, range, message]);
  const list = fetched?.list ?? null;
  // 换了工作区、范围，新的还没读回来：先在原来的里面按现在的工作区、范围筛（只会少几条，不会多出别的工作区、范围外的）
  const stale = fetched !== null && fetched.key !== fetchKey;
  const scopeSet = useMemo(() => (wsKey ? new Set(JSON.parse(wsKey) as string[]) : null), [wsKey]);

  // 打开时、换了范围或工作区时、数据刷新过（侧栏、首页重新加载了）之后读
  useEffect(() => {
    // load 里的 setState 都在 await 之后
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, version]);
  // 在工作区里：看全部工作区时，侧栏没显示的工作区在外部改了也要跟着变，侧栏的数据没变时 version 也不变——窗口获得焦点、
  // 数据目录在外部变了（只是回收站变了的不算，同首页）、快速记录了一条、F5 时都重新读。首页上这几种时候首页自己重新加载，
  // version 跟着变，不必再读一次
  const inWorkspace = workspaces !== undefined;
  useWindowFocus((focused) => focused && inWorkspace && load());
  useAppEvent<DataChange>("data-changed", (c) => inWorkspace && dataTouched(c) && load());
  useEffect(() => {
    if (!inWorkspace) return;
    const onKey = (e: KeyboardEvent) => {
      if (isRefreshShortcut(e)) load();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [load, inWorkspace]);

  const start = rangeStart(range, today);
  const shown = useMemo(
    () =>
      (list ?? []).filter(
        (x) => (!scopeSet || scopeSet.has(x.workspace)) && inRange(x, start) && matchHistory(x, keyword),
      ),
    [list, scopeSet, start, keyword],
  );
  const groups = useMemo(() => groupByDay(shown, today), [shown, today]);
  const bars = useMemo(() => dailyCounts(shown, range, today), [shown, range, today]);
  const todayCount = useMemo(() => countToday(shown, today), [shown, today]);

  const open = (x: DoneTodo) => {
    onClose();
    onOpen({ workspace: x.workspace, project: x.project, todoId: x.todo.id });
  };

  const markUndone = async (x: DoneTodo) => {
    setBusy(keyOf(x));
    try {
      const s = await api.setTodoDone(x.workspace, x.project, x.todo.id, false);
      setFetched((f) => f && { ...f, list: f.list.filter((y) => keyOf(y) !== keyOf(x)) });
      onUndone(x.workspace, x.project, s);
      message.success(`「${displayTitle(x.todo).text}」已标记为未完成`);
    } catch (e) {
      message.error(errMsg(e));
      load();
    } finally {
      setBusy(null);
    }
  };

  const menu = (x: DoneTodo): MenuProps => ({
    items: [
      { key: "open", icon: <FileTextOutlined />, label: "打开" },
      { key: "undone", icon: <UndoOutlined />, label: "标记为未完成" },
    ],
    onClick: ({ key }) => (key === "open" ? open(x) : markUndone(x)),
  });

  /** 点了柱状图的一根：列表滚到那天的组 */
  const scrollToDay = (day: number) => {
    const box = listRef.current;
    const group = box?.querySelector<HTMLElement>(`.history-group[data-day="${day}"]`);
    if (box && group) box.scrollTo({ top: group.offsetTop, behavior: "smooth" });
  };

  const rangeLabel = HISTORY_RANGES.find((r) => r.value === range)!.label;
  const k = keyword.trim();
  const selectedLabel = workspaces?.length === 1 ? workspaces[0] : `选中的 ${workspaces?.length ?? 0} 个工作区`;

  return (
    <>
      <div className="history-filters">
        <Segmented<HistoryRange> className="history-range" value={range} options={HISTORY_RANGES} onChange={setRange} />
        {workspaces && (
          <Segmented<Scope>
            className="history-scope"
            value={scope}
            options={[
              {
                value: "selected",
                label: (
                  <span className="history-scope-name" title={workspaces.join("、")}>
                    {selectedLabel}
                  </span>
                ),
              },
              { value: "all", label: "全部工作区" },
            ]}
            onChange={setScope}
          />
        )}
        <Input
          className="history-search"
          allowClear
          prefix={<SearchOutlined className="muted" />}
          placeholder="按标题、项目查找"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      {list === null ? (
        <div className="history-loading">
          <Spin />
        </div>
      ) : (
        <>
          {/* aria-busy：换了工作区、范围，新的还在读 */}
          <div className="history-stats" aria-busy={stale}>
            <div className="history-stat">
              <div className="stat-value success">{todayCount}</div>
              <div className="stat-label">今天完成</div>
            </div>
            <div className="history-stat">
              <div className="stat-value">{shown.length}</div>
              <div className="stat-label">{range === "all" ? "一共完成" : `${rangeLabel}完成`}</div>
            </div>
            {bars.length > 0 && <DailyBars bars={bars} today={today} onPick={scrollToDay} />}
          </div>
          {groups.length === 0 ? (
            k ? (
              <div className="list-empty history-empty">没有找到包含“{k}”的</div>
            ) : (
              <Empty
                className="history-empty"
                description={range === "all" ? "还没有完成的待办" : `${rangeLabel}还没有完成的待办`}
              />
            )
          ) : (
            <div className="history-list" ref={listRef}>
              {groups.map((g) => (
                <section key={g.day ?? "unknown"} className="history-group" data-day={g.day ?? ""}>
                  <div className="history-day">
                    <span className="history-day-name">{g.label}</span>
                    <span className="muted">{g.items.length} 条</span>
                  </div>
                  {/* 不在可见区域时不排版，按估计的高度（一行约 41px）占位，显示过一次后记住实际的高度 */}
                  <div className="list" style={{ containIntrinsicSize: `auto ${g.items.length * 41}px` }}>
                    {g.items.map((x) => (
                      <HistoryRow
                        key={keyOf(x)}
                        x={x}
                        busy={busy === keyOf(x)}
                        onOpen={open}
                        onUndone={markUndone}
                        onMenu={(e, item) => popups.openMenu(e, menu(item))}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
      {/* 右键菜单的锚点放在页面最外层：对话框弹出时有缩放动画，fixed 定位在它里面会偏 */}
      {createPortal(popups.node, document.body)}
    </>
  );
}

/** 打开完成记录的按钮：首页的头部是普通按钮，侧栏底部是文字链接 */
export default function DoneHistoryButton({ variant = "button", ...props }: Props & { variant?: "button" | "link" }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      {variant === "button" ? (
        <Tooltip title="完成记录：按日期看完成了哪些待办">
          <Button icon={<CarryOutOutlined />} onClick={() => setOpen(true)}>
            完成记录
          </Button>
        </Tooltip>
      ) : (
        <a className="sidebar-history" onClick={() => setOpen(true)} title="按日期看完成了哪些待办">
          <CarryOutOutlined /> 完成记录
        </a>
      )}
      <Modal
        open={open}
        title="完成记录"
        width={760}
        centered
        destroyOnHidden
        onCancel={close}
        footer={<div className="history-foot muted">点一条打开它；右键或行上的按钮可以标记为未完成。</div>}
      >
        <HistoryContent {...props} onClose={close} />
      </Modal>
    </>
  );
}
