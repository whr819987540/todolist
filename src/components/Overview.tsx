import {
  CheckOutlined,
  EditOutlined,
  FolderFilled,
  FolderOpenOutlined,
  MoreOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { Breadcrumb, Button, Dropdown, Empty, Input, Progress, Tooltip } from "antd";
import { useState } from "react";
import type { ProjectNode, SortKey, TodoSummary, WorkspaceTree } from "../types";
import { avatarColor, displayTitle, firstChar, fullTime, relativeTime, shortTime, sortTodos, useNow } from "../utils";
import { projectMenu, todoMenu, workspaceMenu, type Actions } from "./menus";

const percent = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);

function latest(todos: TodoSummary[]): number {
  return todos.reduce((m, t) => Math.max(m, t.updatedAt), 0);
}

/** 未选中项目时右侧显示的工作区概览 */
export function WorkspaceOverview({ tree, actions: a }: { tree: WorkspaceTree; actions: Actions }) {
  const now = useNow();
  const all = tree.projects.flatMap((p) => p.todos);
  const done = all.filter((t) => t.done).length;

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
        <Stat label="项目" value={tree.projects.length} />
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
          {tree.projects.map((p) => {
            const d = p.todos.filter((t) => t.done).length;
            const last = latest(p.todos);
            return (
              <Dropdown key={p.name} menu={projectMenu(a, p.name)} trigger={["contextMenu"]}>
                <div className="card project-card" onClick={() => a.selectProject(p.name)}>
                  <div className="card-head">
                    <FolderFilled className="project-icon big" />
                    <span className="card-name" title={p.name}>
                      {p.name}
                    </span>
                  </div>
                  <Progress percent={percent(d, p.todos.length)} size="small" />
                  <div className="card-foot">
                    <span>
                      {p.todos.length - d} 条未完成 / 共 {p.todos.length} 条
                    </span>
                    <span>{last ? `更新于 ${relativeTime(last, now)}` : "暂无待办"}</span>
                  </div>
                </div>
              </Dropdown>
            );
          })}
          <div className="card card-add" onClick={a.newProject}>
            <PlusOutlined /> 新建项目
          </div>
        </div>
      )}
    </section>
  );
}

/** 选中项目（未选中具体待办）时右侧显示的项目概览 */
export function ProjectOverview(p: {
  workspace: string;
  project: ProjectNode;
  projectNames: string[];
  sortKey: SortKey;
  actions: Actions;
}) {
  const { project, actions: a } = p;
  const now = useNow();
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const sorted = sortTodos(project.todos, p.sortKey);
  const undone = sorted.filter((t) => !t.done);
  const done = sorted.filter((t) => t.done);

  const quickAdd = async () => {
    const title = draft.trim();
    if (!title || adding) return;
    setAdding(true);
    try {
      await a.newTodo(project.name, title, false);
      setDraft("");
    } finally {
      setAdding(false);
    }
  };

  const row = (t: TodoSummary) => {
    const { text, fromContent } = displayTitle(t);
    return (
      <Dropdown key={t.id} menu={todoMenu(a, project.name, t, p.projectNames)} trigger={["contextMenu"]}>
        <div className={`list-row${t.done ? " done" : ""}`} onClick={() => a.selectTodo(project.name, t.id)}>
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
          <span className={`list-title${fromContent ? " from-content" : ""}`}>{text}</span>
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
        items={[{ title: <a onClick={a.selectWorkspace}>{p.workspace}</a> }, { title: project.name }]}
      />
      <div className="overview-head">
        <FolderFilled className="project-icon huge" />
        <div className="overview-title">
          <h2>{project.name}</h2>
          <div className="muted">
            共 {project.todos.length} 条 · 未完成 {undone.length} 条 · 已完成 {done.length} 条
          </div>
        </div>
        <div className="overview-actions">
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

      <Progress percent={percent(done.length, project.todos.length)} className="overview-progress" />

      <div className="quick-add">
        <Input
          autoFocus
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

      {project.todos.length === 0 ? (
        <Empty className="overview-empty" description="还没有待办，在上方输入标题快速添加" />
      ) : (
        <>
          <div className="section-title">未完成（{undone.length}）</div>
          <div className="list">{undone.length ? undone.map(row) : <div className="list-empty">全部完成了，真棒！</div>}</div>
          {done.length > 0 && (
            <>
              <div className="section-title">已完成（{done.length}）</div>
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
