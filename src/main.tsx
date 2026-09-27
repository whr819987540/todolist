import { App as AntApp, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { SettingsProvider } from "./settings";
import { CssVars, ThemeContext, useSystemDark, useWindowTheme, type ThemeMode } from "./theme";
import { useLocalState } from "./utils";
import "./styles.css";

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif';

// 只在输入框和正文编辑器里保留系统右键菜单（复制/粘贴），其他地方用应用自己的菜单
document.addEventListener("contextmenu", (e) => {
  if (!(e.target as HTMLElement).closest("input, textarea, [contenteditable='true']")) e.preventDefault();
});

// 屏蔽网页相关的浏览器快捷键：刷新、打印、查找、缩放重置等
document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (
    e.key === "F5" ||
    e.key === "F3" ||
    e.key === "F7" ||
    (ctrl && ["r", "p", "g", "j", "u", "h", "f", "n", "s", "o"].includes(key)) ||
    (ctrl && e.shiftKey && key === "r")
  ) {
    e.preventDefault();
  }
});

function Root() {
  const [mode, setMode] = useLocalState<ThemeMode>("theme", "system");
  const systemDark = useSystemDark();
  const dark = mode === "dark" || (mode === "system" && systemDark);
  useWindowTheme(mode);

  return (
    <ThemeContext.Provider value={{ mode, setMode }}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
          token: {
            colorPrimary: "#1677ff",
            borderRadius: 6,
            fontFamily: FONT,
          },
        }}
      >
        <AntApp className="app-root" message={{ top: 56, maxCount: 3 }}>
          <CssVars dark={dark} />
          <ErrorBoundary>
            <SettingsProvider>
              <App />
            </SettingsProvider>
          </ErrorBoundary>
        </AntApp>
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
