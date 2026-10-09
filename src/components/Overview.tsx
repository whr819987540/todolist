import {
  CheckOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderFilled,
  FolderOpenOutlined,
  MoreOutlined,
  PlusOutlined,
  PushpinFilled,
} from "@ant-design/icons";
import { Breadcrumb, Button, Dropdown, Empty, Input, Progress, Tooltip } from "antd";
import { useState } from "react";
import { deepTodos, isSubProject, leafName, parentOf, subProjectsOf } from "../projects";
import type { ProjectNode, SortKey, TodoSummary, WorkspaceTree } from "../types";
import { avatarColor, displayTitle, firstChar, fullTime, relativeTime, shortTime, sortTodos, useNow } from "../utils";
import { type DragMove, isDraggingProject, isDraggingTodo, reorderMark } from "./DragMove";
import { selKey } from "./sidebar/tree";
import { type MoveTarget, projectMenu, todoMenu, workspaceMenu, type Actions } from "./menus";

const percent = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);

function latest(todos: TodoSummary[]): number {
  return todos.reduce((m, t) => Math.max(m, t.updatedAt), 0);
}

/**
 * 项目卡片（工作区概览里的顶层项目、父项目概览里的子项目）：点击进入，右键是项目的菜单，可以拖到左侧。
 * 完成进度和数目包括子项目里的待办
 */
function ProjectCard({ workspace, projects, name, actions: a, drag }: {
  workspace: string;
  /** 这个工作区的全部项目 */
  projects: readonly ProjectNode[];
  /** 项目路径 */
  name: string;
  actions: Actions;
  drag: DragMove;
}) {
  const now = useNow();
  const todos = deepTodos(projects, name);
  const d = todos.filter((t) => t.done).length;
  const last = latest(todos);
  const subs = isSubProject(name) ? 0 : subProjectsOf(projects, name).length;
  return (
    <Dropdown menu={projectMenu(a, name)} trigger={["contextMenu"]}>
      <div
        className={`card project-card${isDraggingProject(drag.state, workspace, name) ? " drag-source" : ""}`}
        onMouseDown={(e) => drag.start(e, { kind: "project", workspace, project: name })}
        onClick={() => a.selectProject(name)}
      >
        <div className="card-head">
          <FolderFilled className="project-icon big" />
          <span className="card-name" title={leafName(name)}>
            {leafName(name)}
          </span>
          {subs > 0 && <span className="card-subs muted">{subs} 个子项目</span>}
        </div>
        <Progress percent={percent(d, todos.length)} size="small" />
        <div className="card-foot">
          <span>
            {todos.length - d} 条未完成 / 共 {todos.length} 条
          </span>
          <span>{last ? `更新于 ${relativeTime(last, now)}` : "暂无待办"}</span>
        </div>
      </div>
    </Dropdown>
  );
}

/** 未选中项目时右侧显示的工作区概览：顶层项目的卡片（数目包括子项目里的），可以拖到左侧的其他工作区上 */
export function WorkspaceOverview({ tree, actions: a, drag }: { tree: WorkspaceTree; actions: Actions; drag: DragMove }) {
  const all = tree.projects.flatMap((p) => p.todos);
  const done = all.filter((t) => t.done).length;
  const tops = tree.projects.filter((p) => !isSubProject(p.name));

  return (
    <section className="overview">
      <div className="overview-head">
        <span className="ws-avatar big" style={{ background: avatarColor(tree.name) }}>
          {firstChar(tree.name)}
        </span>
        <div className="overview-title">
          <h2>{tree.name}</h2>
          <div className="muted">工作区 · 点击项目卡片进入项目</div>
        </div>
        <div className="overview-actions">
          <Button icon={<FolderOpenOutlined />} onClick={a.openWorkspaceFolder}>
            打开文件夹
          </Button>
          <Dropdown menu={workspaceMenu(a)} trigger={["click"]} placement="bottomRight">
            <Button icon={<MoreOutlined />} />
          </Dropdown>
          <Button type="primary" icon={<PlusOutlined />} onClick={a.newProject}>
            新建项目
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <Stat label="项目" value={tops.length} />
        <Stat label="待办总数" value={all.length} />
        <Stat label="未完成" value={all.length - done} accent="primary" />
        <Stat label="已完成" value={done} accent="success" />
        <Stat label="完成率" value={`${percent(done, all.length)}%`} />
      </div>

      <div className="section-title">全部项目</div>
      {tree.projects.length === 0 ? (
        <Empty className="overview-empty" description="这个工作区还没有项目">
          <Button type="primary" icon={<PlusOutlined />} onClick={a.newProject}>
            新建项目
          </Button>
        </Empty>
      ) : (
        <div className="card-grid">
          {tops.map((p) => (
            <ProjectCard
              key={p.name}
              workspace={tree.name}
              projects={tree.projects}
              name={p.name}
              actions={a}
              drag={drag}
            />
          ))}
          <div className="card card-add" onClick={a.newProject}>
            <PlusOutlined /> 新建项目
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 选中项目（未选中具体待办）时右侧显示的项目概览。父项目的完成进度和数目包括子项目里的待办，上面列出子项目的卡片，
 * 下面是它自己的待办（快速添加的也加在它自己里）
 */
export function ProjectOverview(p: {
  workspace: string;
  project: ProjectNode;
  /** 这个工作区的全部项目（找子项目） */
  projects: readonly ProjectNode[];
  /** 右键「移动到」列出的项目（第一组是这个工作区的） */
  moveTargets: MoveTarget[];
  sortKey: SortKey;
  actions: Actions;
  /** 打开时聚焦快速添加框（用键盘在左侧列表里移过来时不聚焦） */
  autoFocus: boolean;
  /** 待办可以拖到左侧的其他项目上 */
  drag: DragMove;
}) {
  const { project, actions: a } = p;
  const now = useNow();
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const sorted = sortTodos(project.todos, p.sortKey);
  const undone = sorted.filter((t) => !t.done);
  const done = sorted.filter((t) => t.done);
  const isSub = isSubProject(project.name);
  const subs = isSub ? [] : subProjectsOf(p.projects, project.name);
  const all = deepTodos(p.projects, project.name);
  const allDone = all.filter((t) => t.done).length;
  const parent = parentOf(project.name);
  // 有子项目时，下面的待办列表是它自己的，标题里说清楚
  const own = subs.length ? "自己的" : "";

  const quickAdd = async () => {
    const title = draft.trim();
    if (!title || adding) return;
    setAdding(true);
    try {
      // 创建失败（例如项目文件夹在外部被删）时保留输入，方便重试
      if (await a.newTodo(project.name, title, false)) setDraft("");
    } finally {
      setAdding(false);
    }
  };

  const mark = reorderMark(p.drag.state, p.workspace, project.name);
  const row = (t: TodoSummary) => {
    const { text, fromContent } = displayTitle(t);
    const dropMark = mark?.id === t.id ? ` drop-${mark.place}` : "";
    return (
      <Dropdown key={t.id} menu={todoMenu(a, project.name, t, p.moveTargets)} trigger={["contextMenu"]}>
        <div
          className={`list-row${t.done ? " done" : ""}${isDraggingTodo(p.drag.state, p.workspace, project.name, t.id) ? " drag-source" : ""}${dropMark}`}
          data-sel={selKey({ workspace: p.workspace, project: project.name, todoId: t.id })}
          onMouseDown={(e) => p.drag.start(e, { kind: "todo", workspace: p.workspace, project: project.name, todo: t })}
          onClick={() => a.selectTodo(project.name, t.id)}
        >
          <span
            className={`check${t.done ? " checked" : ""}`}
            role="checkbox"
            aria-checked={t.done}
            onClick={(e) => {
              e.stopPropagation();
              a.toggleDone(project.name, t);
            }}
          >
            {t.done && <CheckOutlined />}
          </span>
          <span className={`list-title${fromContent ? " from-content" : ""}`}>
            {t.pinned && <PushpinFilled className="pin-mark" />}
            {text}
          </span>
          <Tooltip title={`创建时间：${fullTime(t.createdAt)}`}>
            <span className="list-time">创建 {shortTime(t.createdAt, now)}</span>
          </Tooltip>
          <Tooltip title={`修改时间：${fullTime(t.updatedAt)}`}>
            <span className="list-time">修改 {relativeTime(t.updatedAt, now)}</span>
          </Tooltip>
        </div>
      </Dropdown>
    );
  };

  return (
    <section className="overview">
      <Breadcrumb
        className="overview-crumb"
        items={[
          { title: <a onClick={a.selectWorkspace}>{p.workspace}</a> },
          ...(parent !== undefined ? [{ title: <a onClick={() => a.selectProject(parent)}>{parent}</a> }] : []),
          { title: leafName(project.name) },
        ]}
      />
      <div className="overview-head">
        <FolderFilled className="project-icon huge" />
        <div className="overview-title">
          <h2>{leafName(project.name)}</h2>
          <div className="muted">
            共 {all.length} 条{subs.length ? "（含子项目）" : ""} · 未完成 {all.length - allDone} 条 · 已完成 {allDone} 条
          </div>
        </div>
        <div className="overview-actions">
          {!isSub && (
            <Button icon={<FolderAddOutlined />} onClick={() => a.newSubProject(project.name)}>
              新建子项目
            </Button>
          )}
          <Button icon={<EditOutlined />} onClick={() => a.renameProject(project.name)}>
            重命名
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => a.openProjectFolder(project.name)}>
            打开文件夹
          </Button>
          <Dropdown menu={projectMenu(a, project.name)} trigger={["click"]} placement="bottomRight">
            <Button icon={<MoreOutlined />} />
          </Dropdown>
        </div>
      </div>

      <Progress percent={percent(allDone, all.length)} className="overview-progress" />

      <div className="quick-add">
        <Input
          autoFocus={p.autoFocus}
          size="large"
          prefix={<PlusOutlined className="muted" />}
          placeholder="添加待办：输入标题后按 Enter 创建"
          value={draft}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
          onPressEnter={quickAdd}
          disabled={adding}
        />
        <Button size="large" type="primary" onClick={() => a.newTodo(project.name, draft.trim(), true)}>
          新建并编辑
        </Button>
      </div>

      {subs.length > 0 && (
        <>
          <div className="section-title">子项目（{subs.length}）</div>
          <div className="card-grid">
            {subs.map((s) => (
              <ProjectCard
                key={s.name}
                workspace={p.workspace}
                projects={p.projects}
                name={s.name}
                actions={a}
                drag={p.drag}
              />
            ))}
            <div className="card card-add" onClick={() => a.newSubProject(project.name)}>
              <PlusOutlined /> 新建子项目
            </div>
          </div>
        </>
      )}

      {project.todos.length === 0 ? (
        subs.length ? (
          <div className="list-empty">这个项目自己还没有待办，在上方输入标题快速添加</div>
        ) : (
          <Empty className="overview-empty" description="还没有待办，在上方输入标题快速添加" />
        )
      ) : (
        <>
          <div className="section-title">
            {own}未完成（{undone.length}）
          </div>
          <div className="list">{undone.length ? undone.map(row) : <div className="list-empty">全部完成了，真棒！</div>}</div>
          {done.length > 0 && (
            <>
              <div className="section-title">
                {own}已完成（{done.length}）
              </div>
              <div className="list">{done.map(row)}</div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: "primary" | "success" }) {
  return (
    <div className="stat">
      <div className={`stat-value${accent ? ` ${accent}` : ""}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
