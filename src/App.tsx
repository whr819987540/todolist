import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import Home from "./components/Home";
import type { Selection } from "./components/Sidebar";
import WorkspaceView from "./components/WorkspaceView";
import { flushAll } from "./hooks";
import { useSaveOptions } from "./settings";
import { compareName } from "./utils";
import { readLastView, readOpenWorkspaces, writeLastView } from "./workspaceState";

/** 从首页进入某个工作区（可直接打开其中的项目 / 待办）；进去后可以在侧栏再选中其他工作区 */
type Entry = Omit<Selection, "workspace">;

type View = { name: "home" } | { name: "workspace"; workspace: string; sel: Entry };

const HOME: View = { name: "home" };

/**
 * 打开软件时显示的界面：默认首页；设置里选了「回到上次的位置」时，回到上次停留的工作区和待办
 * （侧栏选中的工作区由 WorkspaceView 恢复）。右侧显示的工作区已不在时改显示还在的选中工作区中的第一个，
 * 都不在了就回首页；项目、待办不在了由 WorkspaceView 退回上一级
 */
async function startView(): Promise<View> {
  try {
    const { settings } = await api.getSettings();
    const last = readLastView();
    if (settings.startupView !== "lastPosition" || !last) return HOME;
    const names = new Set((await api.listWorkspaces()).map((w) => w.name));
    const { workspace, ...sel } = last;
    if (names.has(workspace)) return { name: "workspace", workspace, sel };
    const other = readOpenWorkspaces()
      .filter((ws) => names.has(ws))
      .sort(compareName)[0];
    return other ? { name: "workspace", workspace: other, sel: {} } : HOME;
  } catch {
    return HOME;
  }
}

export default function App() {
  // 读出设置、决定开屏界面之前是 null
  const [view, setView] = useState<View | null>(null);
  const { autoSave } = useSaveOptions();
  const autoSaveRef = useRef(autoSave);
  useEffect(() => {
    autoSaveRef.current = autoSave;
  });

  useEffect(() => {
    let cancelled = false;
    startView().then((v) => cancelled || setView(v));
    return () => {
      cancelled = true;
    };
  }, []);

  // 记下停在首页（停在工作区里哪个位置由 WorkspaceView 记）
  useEffect(() => {
    if (view?.name === "home") writeLastView(null);
  }, [view]);

  const goHome = useCallback(() => setView(HOME), []);
  const enter = useCallback(
    (workspace: string, sel: Entry = {}) => setView({ name: "workspace", workspace, sel }),
    [],
  );

  // 点关闭按钮时 Rust 端把窗口藏到托盘，这里阻止默认的销毁窗口并把编辑中的内容写盘（auto save 关着时不写待办）；
  // 从托盘「退出」时不论 auto save 开没开都先写盘，再真正退出
  useEffect(() => {
    const pending = [
      getCurrentWindow().onCloseRequested((e) => {
        e.preventDefault();
        return flushAll(autoSaveRef.current);
      }),
      listen("quit-requested", () => flushAll().finally(api.quitApp)),
    ];
    return () => {
      pending.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);

  if (!view) return null;
  if (view.name === "home") return <Home onEnter={enter} />;
  return (
    <WorkspaceView initialWorkspace={view.workspace} initialSel={view.sel} onHome={goHome} />
  );
}
