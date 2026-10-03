import { CheckOutlined, FolderFilled } from "@ant-design/icons";
import { Empty, Spin, Tooltip } from "antd";
import { useMemo } from "react";
import { type ContentHits, hitKey, searchSnippet } from "../search";
import type { ProjectNode, TodoSummary, WorkspaceInfo, WorkspaceTree } from "../types";
import { compareName, displayTitle, fullTime, matchTodo, relativeTime, useNow } from "../utils";
import Highlight from "./Highlight";
import type { Selection } from "./sidebar/tree";

interface Props {
  kw: string;
  /** 名称命中关键字的工作区 */
  workspaces: WorkspaceInfo[];
  /** 全部工作区的项目和待办；null 表示还在加载 */
  trees: WorkspaceTree[] | null;
  /** 全文搜索的结果（正文里有关键字的待办）；null 表示还在查 */
  hits: ContentHits | null;
  renderCard: (ws: WorkspaceInfo) => React.ReactNode;
  onEnter: (workspace: string, sel?: Omit<Selection, "workspace">) => void;
}

/** 首页搜索：跨全部工作区查找工作区、项目和待办（标题和正文全文） */
export default function SearchResults({ kw, workspaces, trees, hits, renderCard, onEnter }: Props) {
  const now = useNow();
  const k = kw.toLowerCase();

  const { projects, todos } = useMemo(() => {
    const projects: { workspace: string; project: ProjectNode }[] = [];
    const todos: { workspace: string; project: string; todo: TodoSummary; snippet: string | null }[] = [];
    for (const tree of trees ?? []) {
      const found = hits?.get(tree.name);
      for (const p of [...tree.projects].sort((a, b) => compareName(a.name, b.name))) {
        if (p.name.toLowerCase().includes(k)) projects.push({ workspace: tree.name, project: p });
        for (const t of p.todos) {
          const hit = found?.get(hitKey(p.name, t.id));
          if (matchTodo(t, kw) || hit !== undefined)
            todos.push({ workspace: tree.name, project: p.name, todo: t, snippet: searchSnippet(t, kw, hit) });
        }
      }
    }
    // 未完成在前，最近修改的在前
    todos.sort((a, b) => Number(a.todo.done) - Number(b.todo.done) || b.todo.updatedAt - a.todo.updatedAt);
    return { projects, todos };
  }, [trees, hits, kw, k]);

  const nothing = workspaces.length + projects.length + todos.length === 0;

  return (
    <div className="search-results">
      {trees && !nothing && (
        <div className="search-summary">
          找到 {workspaces.length} 个工作区、{projects.length} 个项目、{todos.length} 条待办
        </div>
      )}

      {workspaces.length > 0 && (
        <>
          <div className="section-title">工作区（{workspaces.length}）</div>
          <div className="card-grid">{workspaces.map(renderCard)}</div>
        </>
      )}

      {!trees || (nothing && !hits) ? (
        <div className="search-loading">
          <Spin />
        </div>
      ) : nothing ? (
        <Empty className="home-empty" description={`没有找到包含“${kw}”的工作区、项目或待办`} />
      ) : (
        <>
          {projects.length > 0 && (
            <>
              <div className="section-title">项目（{projects.length}）</div>
              <div className="list">
                {projects.map(({ workspace, project }) => {
                  const undone = project.todos.filter((t) => !t.done).length;
                  return (
                    <div
                      key={`${workspace}/${project.name}`}
                      className="list-row"
                      onClick={() => onEnter(workspace, { project: project.name })}
                    >
                      <FolderFilled className="project-icon" />
                      <span className="list-title">
                        <Highlight text={project.name} kw={kw} />
                      </span>
                      <span className="list-path" title={workspace}>
                        {workspace}
                      </span>
                      <span className="list-time">
                        {undone} 条未完成 / 共 {project.todos.length} 条
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {todos.length > 0 && (
            <>
              <div className="section-title">待办（{todos.length}）</div>
              <div className="list">
                {todos.map(({ workspace, project, todo: t, snippet: snip }) => {
                  const { text, fromContent } = displayTitle(t);
                  return (
                    <div
                      key={`${workspace}/${project}/${t.id}`}
                      className={`list-row${t.done ? " done" : ""}`}
                      onClick={() => onEnter(workspace, { project, todoId: t.id })}
                    >
                      <span className={`check static${t.done ? " checked" : ""}`}>{t.done && <CheckOutlined />}</span>
                      <div className="list-main">
                        <div className={`list-title${fromContent ? " from-content" : ""}`}>
                          <Highlight text={text} kw={kw} />
                        </div>
                        {snip && (
                          <div className="list-snippet">
                            <Highlight text={snip} kw={kw} />
                          </div>
                        )}
                      </div>
                      <span className="list-path" title={`${workspace} / ${project}`}>
                        {workspace} / {project}
                      </span>
                      <Tooltip title={`修改时间：${fullTime(t.updatedAt)}`}>
                        <span className="list-time">修改 {relativeTime(t.updatedAt, now)}</span>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
