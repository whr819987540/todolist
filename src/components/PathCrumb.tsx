import { Breadcrumb } from "antd";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ancestorsOf, leafName, projectLabel } from "../projects";

interface Props {
  /** 外面那层的类名（editor-crumb、overview-crumb） */
  className: string;
  workspace: string;
  /** 项目路径 */
  project: string;
  onSelectWorkspace: () => void;
  onSelectProject: (project: string) => void;
  /** 最后一级（项目自己）能不能点：编辑区上方能点（回到项目概览），项目概览上方就是它自己，不能点 */
  linkLast: boolean;
}

/**
 * 编辑区上方、项目概览上方的路径：工作区 / 父项目 / … / 项目，每一级都能点。放不下时从工作区后面的第一级起，把中间的几级
 * 折叠成「…」（悬停在它上面列出折叠掉的几级，也都能点）；只剩工作区、「…」和项目自己还放不下时工作区也折叠进去，
 * 再放不下项目名字末尾省略。悬停整条路径显示完整的。路径变了从头量（换一个组件实例）
 */
export default function PathCrumb(p: Props) {
  return <Crumb key={`${p.workspace}\u0000${p.project}`} {...p} />;
}

function Crumb(p: Props) {
  const ancestors = ancestorsOf(p.project);
  // 能折叠的：各级父项目（从上往下），最后是工作区；项目自己不折叠
  const foldable = ancestors.length + 1;
  const ref = useRef<HTMLDivElement>(null);
  // width：量过的宽度；folded：折叠掉了几级（从工作区后面的第一级起）
  const [fit, setFit] = useState({ width: -1, folded: 0 });
  const { folded } = fit;

  // 画好后量一下：放不下、还能折叠就多折叠一级，在浏览器绘制之前接着重画（级数有限，几次就停）
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && fit.folded < foldable && el.scrollWidth > el.clientWidth + 1) setFit((f) => ({ ...f, folded: f.folded + 1 }));
  }, [fit, foldable]);

  // 宽度变了（拖侧栏、改窗口大小）：从不折叠重新量。路径区域的宽度不随内容变（见 styles.css 的 .path-crumb），不会来回折腾
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const width = el.clientWidth;
      setFit((f) => (f.width === width ? f : f.width < 0 ? { ...f, width } : { width, folded: 0 }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const link = (project: string) => <a onClick={() => p.onSelectProject(project)}>{leafName(project)}</a>;
  const wsFolded = folded > ancestors.length;
  const hidden = ancestors.slice(0, folded);
  const shown = [...ancestors.slice(folded), p.project];
  // 折叠起来的几级，悬停「…」时列出来（工作区也折叠了时排在最前面）
  const menuItems = [
    ...(wsFolded ? [{ key: "\u0000ws", label: p.workspace, onClick: p.onSelectWorkspace }] : []),
    ...hidden.map((x) => ({ key: x, label: leafName(x), onClick: () => p.onSelectProject(x) })),
  ];
  const items = [
    ...(wsFolded ? [] : [{ key: "\u0000ws", title: <a onClick={p.onSelectWorkspace}>{p.workspace}</a> }]),
    ...(menuItems.length
      ? [
          {
            key: "\u0000more",
            title: (
              <span className="crumb-more" title={menuItems.map((x) => x.label).join(" / ")}>
                …
              </span>
            ),
            menu: { items: menuItems },
          },
        ]
      : []),
    ...shown.map((x) => ({
      key: x,
      title: x === p.project && !p.linkLast ? leafName(x) : link(x),
    })),
  ];

  return (
    <div
      ref={ref}
      className={`path-crumb ${p.className}${folded >= foldable ? " squeeze" : ""}`}
      title={`${p.workspace} / ${projectLabel(p.project)}`}
    >
      <Breadcrumb items={items} />
    </div>
  );
}
