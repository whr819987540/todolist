import { DeleteOutlined, EditOutlined, MoreOutlined } from "@ant-design/icons";
import { Button, Checkbox, Dropdown, Segmented } from "antd";
import {
  clearFilter,
  countPriorities,
  isFiltering,
  setFilter,
  type TodoFilter,
  togglePriority,
  toggleTag,
  useTodoFilter,
} from "../../filter";
import { PRIORITIES } from "../../priority";
import { allTodos, countTags, hasTag, sameTag, tagClass } from "../../tags";
import type { WorkspaceTree } from "../../types";
import { PriorityLabel } from "../TodoMarks";
import type { TagActions } from "../workspaceActions";

/**
 * 侧栏顶部「筛选」的弹出框：侧栏里显示的各工作区的待办用到的标签（带条数，多的在前）和各档优先级（带条数），都可以多选；
 * 标签之间「任一」还是「全部」可以切换。选着的标签没有待办用了时也列出来（0 条），可以取消。
 * 每个标签后面的「…」可以重命名、删除这个标签（作用于侧栏显示的各工作区）
 */
export default function FilterPanel({ trees, tagActions }: { trees: readonly WorkspaceTree[]; tagActions: TagActions }) {
  const filter = useTodoFilter();
  const todos = allTodos(trees);
  const used = countTags(todos);
  const tags = [
    ...used,
    ...filter.tags.filter((t) => !used.some((u) => sameTag(u.name, t))).map((name) => ({ name, count: 0 })),
  ];
  const priorities = countPriorities(todos);

  return (
    <div className="filter-panel">
      <div className="filter-head">
        <span className="filter-section">标签</span>
        <Segmented
          size="small"
          value={filter.tagMode}
          onChange={(v) => setFilter((f) => ({ ...f, tagMode: v as TodoFilter["tagMode"] }))}
          options={[
            { value: "any", label: "任一", title: "有选中的其中一个标签就算" },
            { value: "all", label: "全部", title: "选中的标签都有才算" },
          ]}
        />
      </div>
      {tags.length ? (
        <div className="filter-tags">
          {tags.map((t) => (
            <div key={t.name} className="filter-item">
              <Checkbox checked={hasTag(filter.tags, t.name)} onChange={() => setFilter((f) => toggleTag(f, t.name))}>
                <span className={tagClass(t.name)}>{t.name}</span>
              </Checkbox>
              <span className="filter-count">{t.count}</span>
              <Dropdown
                trigger={["click"]}
                placement="bottomRight"
                menu={{
                  items: [
                    { key: "rename", icon: <EditOutlined />, label: "重命名" },
                    { key: "delete", icon: <DeleteOutlined />, label: "删除", danger: true },
                  ],
                  onClick: ({ key }) => (key === "rename" ? tagActions.rename(t.name) : tagActions.remove(t.name)),
                }}
              >
                <span className="filter-more" role="button" aria-label={`标签「${t.name}」的操作`} title="重命名、删除这个标签">
                  <MoreOutlined />
                </span>
              </Dropdown>
            </div>
          ))}
        </div>
      ) : (
        <div className="filter-empty">侧栏里的待办还没有标签：在编辑区上方点「+ 标签」，或右键待办选「标签…」加上</div>
      )}
      <div className="filter-head">
        <span className="filter-section">优先级</span>
      </div>
      <div className="filter-priorities">
        {PRIORITIES.map((p) => (
          <div key={p} className="filter-item">
            <Checkbox checked={filter.priorities.includes(p)} onChange={() => setFilter((f) => togglePriority(f, p))}>
              <PriorityLabel priority={p} />
            </Checkbox>
            <span className="filter-count">{priorities[p]}</span>
          </div>
        ))}
      </div>
      <div className="filter-foot">
        <span>标签和优先级都要符合</span>
        <Button size="small" type="link" disabled={!isFiltering(filter)} onClick={clearFilter}>
          清除
        </Button>
      </div>
    </div>
  );
}
