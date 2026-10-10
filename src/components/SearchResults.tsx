import { CheckOutlined, FolderFilled } from "@ant-design/icons";
import { Empty, Spin, Tooltip } from "antd";
import { useMemo } from "react";
import { deepTodos, leafName, parentOf, projectLabel, sortProjects } from "../projects";
import { type ContentHits, hitKey, matchTodo, searchSnippet, tagQuery, textKeyword } from "../search";
import type { ProjectNode, TodoSummary, WorkspaceInfo, WorkspaceTree } from "../types";
import { displayTitle, fullTime, relativeTime, useNow } from "../utils";
import Highlight from "./Highlight";
import type { Selection } from "./sidebar/tree";
import { PriorityFlag, TagChips } from "./TodoMarks";

/** 搜索结果里待办的标题后面最多显示几个标签 */
const RESULT_TAGS = 3;

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

/** 首页搜索：跨全部工作区查找工作区、项目和待办（标题、正文全文和标签）；#标签名 只按标签找 */
export default function SearchResults({ kw, workspaces, trees, hits, renderCard, onEnter }: Props) {
  const now = useNow();
  // 只按标签找时项目名不算命中，标题不高亮
  const textKw = textKeyword(kw);
  const k = textKw.toLowerCase();
  const tag = tagQuery(kw);

  const { projects, todos } = useMemo(() => {
    // 项目按自己的名字匹配（子项目不看父项目的名字），数目包括子项目里的待办
    const projects: { workspace: string; project: ProjectNode; todos: TodoSummary[] }[] = [];
    const todos: { workspace: string; project: string; todo: TodoSummary; snippet: string | null }[] = [];
    for (const tree of trees ?? []) {
      const found = hits?.get(tree.name);
      for (const p of sortProjects(tree.projects)) {
        if (k && leafName(p.name).toLowerCase().includes(k))
          projects.push({ workspace: tree.name, project: p, todos: deepTodos(tree.projects, p.name) });
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
        <Empty
          className="home-empty"
          description={
            tag === null
              ? `没有找到包含“${kw}”的工作区、项目或待办`
              : tag
                ? `没有找到带标签「${tag}」的待办`
                : "没有带标签的待办"
          }
        />
      ) : (
        <>
          {projects.length > 0 && (
            <>
              <div className="section-title">项目（{projects.length}）</div>
              <div className="list">
                {projects.map(({ workspace, project, todos: all }) => {
                  const undone = all.filter((t) => !t.done).length;
                  const parent = parentOf(project.name);
                  const where = parent === undefined ? workspace : `${workspace} / ${parent}`;
                  return (
                    <div
                      key={`${workspace}/${project.name}`}
                      className="list-row"
                      onClick={() => onEnter(workspace, { project: project.name })}
                    >
                      <FolderFilled className="project-icon" />
                      <span className="list-title">
                        <Highlight text={leafName(project.name)} kw={textKw} />
                      </span>
                      <span className="list-path" title={where}>
                        {where}
                      </span>
                      <span className="list-time">
                        {undone} 条未完成 / 共 {all.length} 条
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
                        <div className={`list-title with-marks${fromContent ? " from-content" : ""}`}>
                          <PriorityFlag priority={t.priority} />
                          <span className="list-title-text">
                            <Highlight text={text} kw={textKw} />
                          </span>
                          <TagChips tags={t.tags} max={RESULT_TAGS} keyword={kw} />
                        </div>
                        {snip && (
                          <div className="list-snippet">
                            <Highlight text={snip} kw={textKw} />
                          </div>
                        )}
                      </div>
                      <span className="list-path" title={`${workspace} / ${projectLabel(project)}`}>
                        {workspace} / {projectLabel(project)}
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
