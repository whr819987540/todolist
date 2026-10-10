import {
  CheckOutlined,
  CloseOutlined,
  ColumnHeightOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FilterFilled,
  FilterOutlined,
  FolderAddOutlined,
  FolderFilled,
  HomeOutlined,
  PlusOutlined,
  SearchOutlined,
  SortAscendingOutlined,
  VerticalAlignMiddleOutlined,
} from "@ant-design/icons";
import { Button, Dropdown, Input, Popover, Tooltip, type InputRef, type MenuProps } from "antd";
import { useState } from "react";
import { clearFilter, describeFilter, isFiltering, useTodoFilter } from "../../filter";
import { parentOf, projectLabel } from "../../projects";
import { ThemeButton } from "../../theme";
import type { SortKey, WorkspaceTree } from "../../types";
import type { ListOptions } from "../../workspaceState";
import type { Actions } from "../menus";
import SettingsButton from "../SettingsButton";
import type { TagActions } from "../workspaceActions";
import FilterPanel from "./FilterPanel";
import { anyVisibleProjectOpen, type Collapsed, type Selection, WS_KEY } from "./tree";
import WorkspacePicker from "./WorkspacePicker";

const SORT_LABELS: Record<SortKey, string> = {
  created: "按创建时间",
  updated: "按修改时间",
  title: "按标题",
  priority: "按优先级",
  manual: "手动排序",
};

/**
 * 侧栏顶部：返回首页、选中要显示的工作区、主题、设置；搜索和「新建」；排序、隐藏已完成（待办、全部完成的项目）、
 * 筛选（按标签、优先级）、全部折叠 / 展开，开着筛选时下面一行写明筛的是什么。
 * 「新建」、排序和隐藏已完成作用于右侧正在显示的工作区；筛选作用于侧栏显示的各工作区
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
  /** 侧栏里这个工作区藏起来、筛掉的项目（和树里一样算），「全部折叠 / 全部展开」不看它们；用到时才算 */
  hiddenOf: (tree: WorkspaceTree) => ReadonlySet<string>;
  /** 重命名、删除标签（筛选的弹出框里） */
  tagActions: TagActions;
}) {
  const { trees, sel, actions: a, searchRef, keyword, collapsedOf, setCollapsed } = props;
  const multi = trees.length > 1;
  const filter = useTodoFilter();
  const filtering = isFiltering(filter);
  // 筛选的弹出框：点按钮、点下面写着筛选的那一行都打开
  const [filterOpen, setFilterOpen] = useState(false);

  // 看得见的项目有展开着的时是「全部折叠」。点了连藏起来的、折叠着的工作区里的一起折叠 / 展开：关掉隐藏、其中的待办
  // 改回未完成、展开工作区后再显示出来时，它们和别的项目一样折叠着 / 展开着。「全部展开」时折叠着的工作区也展开，
  // 不然展开了也看不见；「全部折叠」只折叠项目，工作区那一级不动
  const anyProjectOpen = anyVisibleProjectOpen(trees, collapsedOf, props.hiddenOf);
  const toggleAll = () => {
    for (const t of trees)
      setCollapsed(t.name, (c) => {
        const next = { ...c };
        for (const p of t.projects) next[p.name] = anyProjectOpen;
        if (!anyProjectOpen) next[WS_KEY] = false;
        return next;
      });
  };

  // 「新建」按钮作用于右侧正在显示的工作区
  const selTree = trees.find((t) => t.name === sel.workspace);
  const currentProject = sel.project ?? (selTree?.projects.length === 1 ? selTree.projects[0].name : undefined);
  const where = (project?: string) =>
    [multi ? sel.workspace : "", project ? projectLabel(project) : ""].filter(Boolean).join(" / ");
  // 新建子项目：在右侧显示着的项目里（显示着子项目时是在它的父项目里）
  const subParent = sel.project === undefined ? undefined : (parentOf(sel.project) ?? sel.project);
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
      ...(subParent === undefined
        ? []
        : [{ key: "sub", icon: <FolderAddOutlined />, label: `新建子项目（在「${where(subParent)}」里）` }]),
    ],
    onClick: ({ key }) => {
      if (key === "todo" && currentProject) a.newTodo(currentProject, "", true);
      if (key === "project") a.newProject();
      if (key === "sub" && subParent !== undefined) a.newSubProject(subParent);
    },
  };

  // 排序和隐藏已完成作用于右侧正在显示的工作区，选中了多个工作区时在提示里写明是哪个
  const { sortKey, hideDone, hideDoneProjects } = props.listOptions;
  const ofWs = multi ? `「${sel.workspace}」的` : "";
  const sortItems = (Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({
    key: k,
    label: SORT_LABELS[k],
    extra: k === "manual" ? "拖动待办调整" : undefined,
  }));
  const sortMenu: MenuProps = {
    selectable: true,
    selectedKeys: [sortKey],
    items: multi ? [{ type: "group", label: `${ofWs}排序`, children: sortItems }] : sortItems,
    onClick: ({ key }) => props.setListOptions(sel.workspace, { sortKey: key as SortKey }),
  };

  // 隐藏已完成：已完成的待办、全部完成的项目（待办全都完成了的）各自开关
  const check = (on: boolean) => <CheckOutlined style={{ visibility: on ? "visible" : "hidden" }} />;
  const hideItems = [
    { key: "todos", icon: check(hideDone), label: "隐藏已完成的待办" },
    { key: "projects", icon: check(hideDoneProjects), label: "隐藏全部完成的项目", extra: "待办全都完成了的" },
  ];
  const hideMenu: MenuProps = {
    items: multi ? [{ type: "group", label: `${ofWs}已完成`, children: hideItems }] : hideItems,
    onClick: ({ key }) =>
      props.setListOptions(
        sel.workspace,
        key === "todos" ? { hideDone: !hideDone } : { hideDoneProjects: !hideDoneProjects },
      ),
  };
  const hiding = [hideDone && "已完成的待办", hideDoneProjects && "全部完成的项目"].filter(Boolean);
  const hideTip = hiding.length ? `${ofWs}已隐藏：${hiding.join("、")}` : `隐藏${ofWs}已完成的待办 / 全部完成的项目`;

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
          placeholder="搜索待办（Ctrl+Shift+F）"
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
        <Dropdown menu={hideMenu} trigger={["click"]}>
          <Tooltip title={hideTip}>
            <Button
              type="text"
              size="small"
              className={`hide-done-btn${hiding.length ? " is-active" : ""}`}
              icon={hiding.length ? <EyeInvisibleOutlined /> : <EyeOutlined />}
            />
          </Tooltip>
        </Dropdown>
        <Popover
          open={filterOpen}
          onOpenChange={setFilterOpen}
          trigger={["click"]}
          placement="bottomRight"
          arrow={false}
          // 关着时不渲染：里面要数全部待办的标签
          destroyOnHidden
          content={<FilterPanel trees={trees} tagActions={props.tagActions} />}
        >
          <Tooltip title={filtering ? `筛选：${describeFilter(filter)}` : "按标签、优先级筛选"}>
            <Button
              type="text"
              size="small"
              className={`filter-btn${filtering ? " is-active" : ""}`}
              icon={filtering ? <FilterFilled /> : <FilterOutlined />}
            />
          </Tooltip>
        </Popover>
        <Tooltip title={anyProjectOpen ? "全部折叠" : "全部展开"}>
          <Button
            type="text"
            size="small"
            className="collapse-all-btn"
            icon={anyProjectOpen ? <VerticalAlignMiddleOutlined /> : <ColumnHeightOutlined />}
            onClick={toggleAll}
          />
        </Tooltip>
      </div>

      {filtering && (
        <div className="filter-bar">
          <span
            className="filter-bar-text"
            title={`筛选：${describeFilter(filter)}（点一下修改）`}
            onClick={() => setFilterOpen(true)}
          >
            <FilterFilled /> 筛选：{describeFilter(filter)}
          </span>
          <Tooltip title="清除筛选">
            <span className="filter-bar-clear" role="button" aria-label="清除筛选" onClick={clearFilter}>
              <CloseOutlined />
            </span>
          </Tooltip>
        </div>
      )}
    </>
  );
}
