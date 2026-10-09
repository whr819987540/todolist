import { useEffect, useState } from "react";
import { LINGER_MS, type Lingering, lingeringAfter, NO_LINGERING, type Selection } from "./tree";

/**
 * 「隐藏全部完成的项目」开着时，右侧显示的内容离开一个全部完成的项目后，它在侧栏里再显示一会儿（ms）才藏起来：
 * 立即藏起来的话，它下面的行在点击的那一下整体上移，双击的第二下落到别的行上。
 *
 * sel 是右侧显示的内容，每换一次（包括又点了一下正显示着的，sel 是新的对象）都重新计时，最后一次换了 ms 之后
 * 切走过的一起藏起来，免得在接着的双击中间藏起来。keep(workspace, project) 在离开的那一下判断这个项目要不要留
 * （会被藏起来的才留），没开这一项时什么都不记、不计时。卸载时清掉计时器
 */
export function useLingeringProjects(
  sel: Selection,
  keep: (workspace: string, project: string) => boolean,
  ms = LINGER_MS,
): Lingering {
  const [state, setState] = useState({ sel, lingering: NO_LINGERING });
  let current = state;
  if (state.sel !== sel) {
    // 在渲染时按上一次的选中项算出来（React 文档「存储前一次渲染的信息」）：切走的这一次渲染里它就还显示着，
    // 不会先藏起来再出现
    current = { sel, lingering: lingeringAfter(state.lingering, state.sel, sel, keep) };
    setState(current);
  }

  useEffect(() => {
    if (!state.lingering.size) return;
    const timer = setTimeout(() => setState((s) => ({ sel: s.sel, lingering: NO_LINGERING })), ms);
    return () => clearTimeout(timer);
  }, [state, ms]);

  return current.lingering;
}
