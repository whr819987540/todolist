import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
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

  // 点关闭按钮时 Rust 端把窗口藏到托盘，这里阻止默认的销毁窗口并把编辑中的内容写盘；
  // 从托盘「退出」时同样先写盘，再真正退出
  useEffect(() => {
    const pending = [
      getCurrentWindow().onCloseRequested((e) => {
        e.preventDefault();
        return flushAll();
      }),
      listen("quit-requested", () => flushAll().finally(api.quitApp)),
    ];
    return () => {
      pending.forEach((p) => p.then((unlisten) => unlisten()));
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
