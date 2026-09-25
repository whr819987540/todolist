import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import Home from "./components/Home";
import type { Selection } from "./components/Sidebar";
import WorkspaceView from "./components/WorkspaceView";
import { flushAll } from "./hooks";

type View = { name: "home" } | { name: "workspace"; workspace: string; sel: Selection };

export default function App() {
  const [view, setView] = useState<View>({ name: "home" });

  const goHome = useCallback(() => setView({ name: "home" }), []);
  const enter = useCallback(
    (workspace: string, sel: Selection = {}) => setView({ name: "workspace", workspace, sel }),
    [],
  );

  // 关闭窗口前先把编辑中的内容保存下来
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onCloseRequested(() => flushAll())
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (view.name === "home") return <Home onEnter={enter} />;
  return (
    <WorkspaceView
      key={view.workspace}
      workspace={view.workspace}
      initialSel={view.sel}
      onHome={goHome}
      onSwitch={enter}
    />
  );
}
