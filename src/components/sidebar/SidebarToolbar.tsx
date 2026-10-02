import {
  ColumnHeightOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FolderFilled,
  HomeOutlined,
  PlusOutlined,
  SearchOutlined,
  SortAscendingOutlined,
  VerticalAlignMiddleOutlined,
} from "@ant-design/icons";
import { Button, Dropdown, Input, Tooltip, type InputRef, type MenuProps } from "antd";
import { ThemeButton } from "../../theme";
import type { SortKey, WorkspaceTree } from "../../types";
import type { ListOptions } from "../../workspaceState";
import type { Actions } from "../menus";
import SettingsButton from "../SettingsButton";
import type { Collapsed, Selection } from "./tree";
import WorkspacePicker from "./WorkspacePicker";

const SORT_LABELS: Record<SortKey, string> = {
  created: "按创建时间",
  updated: "按修改时间",
  title: "按标题",
};

/**
 * 侧栏顶部：返回首页、选中要显示的工作区、主题、设置；搜索和「新建」；排序、隐藏已完成、全部折叠 / 展开。
 * 「新建」、排序和隐藏已完成作用于右侧正在显示的工作区
 */
export default function SidebarToolbar(props: {
  trees: WorkspaceTree[];
  sel: Selection;
  workspaces: string[];
  onWorkspacesChange: (list: string[]) => void;
  onHome: () => void;
  /** 右侧正在显示的工作区的操作 */
  actions: Actions;
  searchRef: React.RefObject<InputRef | null>;
  keyword: string;
  setKeyword: (v: string) => void;
  /** 在搜索框里按了 Esc（关键字由这里清空） */
  onSearchEscape: () => void;
  /** 右侧正在显示的工作区的排序和隐藏已完成 */
  listOptions: ListOptions;
  setListOptions: (workspace: string, patch: Partial<ListOptions>) => void;
  collapsedOf: (workspace: string) => Collapsed;
  setCollapsed: (workspace: string, fn: (prev: Collapsed) => Collapsed) => void;
}) {
  const { trees, sel, actions: a, searchRef, keyword, collapsedOf, setCollapsed } = props;
  const multi = trees.length > 1;

  const anyProjectOpen = trees.some((t) => t.projects.some((p) => !collapsedOf(t.name)[p.name]));
  const toggleAll = () => {
    for (const t of trees)
      setCollapsed(t.name, (c) => {
        const next = { ...c };
        for (const p of t.projects) next[p.name] = anyProjectOpen;
        return next;
      });
  };

  // 「新建」按钮作用于右侧正在显示的工作区
  const selTree = trees.find((t) => t.name === sel.workspace);
  const currentProject = sel.project ?? (selTree?.projects.length === 1 ? selTree.projects[0].name : undefined);
  const where = (project?: string) => [multi ? sel.workspace : "", project ?? ""].filter(Boolean).join(" / ");
  const newMenu: MenuProps = {
    items: [
      {
        key: "todo",
        icon: <PlusOutlined />,
        label: currentProject ? `新建待办（${where(currentProject)}）` : "新建待办（请先选择项目）",
        disabled: !currentProject,
        extra: "Ctrl+N",
      },
      { key: "project", icon: <FolderFilled />, label: multi ? `新建项目（${where()}）` : "新建项目" },
    ],
    onClick: ({ key }) => {
      if (key === "todo" && currentProject) a.newTodo(currentProject, "", true);
      if (key === "project") a.newProject();
    },
  };

  // 排序和隐藏已完成作用于右侧正在显示的工作区，选中了多个工作区时在提示里写明是哪个
  const { sortKey, hideDone } = props.listOptions;
  const ofWs = multi ? `「${sel.workspace}」的` : "";
  const sortItems = (Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({ key: k, label: SORT_LABELS[k] }));
  const sortMenu: MenuProps = {
    selectable: true,
    selectedKeys: [sortKey],
    items: multi ? [{ type: "group", label: `${ofWs}排序`, children: sortItems }] : sortItems,
    onClick: ({ key }) => props.setListOptions(sel.workspace, { sortKey: key as SortKey }),
  };

  return (
    <>
      <div className="sidebar-head">
        <Tooltip title="返回首页">
          <Button type="text" icon={<HomeOutlined />} onClick={props.onHome} />
        </Tooltip>
        <WorkspacePicker selected={props.workspaces} onChange={props.onWorkspacesChange} onHome={props.onHome} />
        <ThemeButton type="text" />
        <SettingsButton type="text" />
      </div>

      <div className="sidebar-search">
        <Input
          ref={searchRef}
          allowClear
          prefix={<SearchOutlined className="muted" />}
          placeholder="搜索待办（Ctrl+F）"
          value={keyword}
          onChange={(e) => props.setKeyword(e.target.value)}
          onKeyDown={(e) => {
            // Esc：退出搜索，焦点回到左侧列表
            if (e.key === "Escape") {
              e.preventDefault();
              props.setKeyword("");
              props.onSearchEscape();
            }
          }}
        />
        <Dropdown menu={newMenu} trigger={["click"]} placement="bottomRight">
          <Button type="primary" icon={<PlusOutlined />} />
        </Dropdown>
      </div>

      <div className="sidebar-bar">
        <span className="sidebar-bar-title">{multi ? "工作区、项目与待办" : "项目与待办"}</span>
        <Dropdown menu={sortMenu} trigger={["click"]}>
          <Tooltip title={`${ofWs}排序：${SORT_LABELS[sortKey]}`}>
            <Button type="text" size="small" icon={<SortAscendingOutlined />} />
          </Tooltip>
        </Dropdown>
        <Tooltip title={`${hideDone ? "显示" : "隐藏"}${ofWs}已完成${multi ? "待办" : ""}`}>
          <Button
            type="text"
            size="small"
            className={hideDone ? "is-active" : undefined}
            icon={hideDone ? <EyeInvisibleOutlined /> : <EyeOutlined />}
            onClick={() => props.setListOptions(sel.workspace, { hideDone: !hideDone })}
          />
        </Tooltip>
        <Tooltip title={anyProjectOpen ? "全部折叠" : "全部展开"}>
          <Button
            type="text"
            size="small"
            icon={anyProjectOpen ? <VerticalAlignMiddleOutlined /> : <ColumnHeightOutlined />}
            onClick={toggleAll}
          />
        </Tooltip>
      </div>
    </>
  );
}
