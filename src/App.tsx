import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import Home from "./components/Home";
import type { Selection } from "./components/Sidebar";
import WorkspaceView from "./components/WorkspaceView";
import { flushAll } from "./hooks";
import { useSaveOptions } from "./settings";

/** 从首页进入某个工作区（可直接打开其中的项目 / 待办）；进去后可以在侧栏再选中其他工作区 */
type Entry = Omit<Selection, "workspace">;

type View = { name: "home" } | { name: "workspace"; workspace: string; sel: Entry };

export default function App() {
  const [view, setView] = useState<View>({ name: "home" });
  const { autoSave } = useSaveOptions();
  const autoSaveRef = useRef(autoSave);
  useEffect(() => {
    autoSaveRef.current = autoSave;
  });

  const goHome = useCallback(() => setView({ name: "home" }), []);
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

  if (view.name === "home") return <Home onEnter={enter} />;
  return (
    <WorkspaceView initialWorkspace={view.workspace} initialSel={view.sel} onHome={goHome} />
  );
}
