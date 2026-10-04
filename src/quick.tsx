import { App as AntApp, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import ErrorBoundary from "./components/ErrorBoundary";
import QuickCapture from "./components/QuickCapture";
import { CssVars, FONT, readThemeCache, useSystemDark } from "./theme";
import { blockBrowserDefaults } from "./webview";
import "./styles.css";

// 快速记录小窗的入口（quick.html），和主窗口是两个页面

blockBrowserDefaults();

function Root() {
  // 主题跟主窗口一样：先用本机缓存的，读到设置后换成设置里的
  const [mode, setMode] = useState(readThemeCache);
  const systemDark = useSystemDark();
  const dark = mode === "dark" || (mode === "system" && systemDark);
  useEffect(() => {
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: "#1677ff", borderRadius: 6, fontFamily: FONT },
      }}
    >
      <AntApp className="app-root" message={{ top: 8, maxCount: 1 }}>
        <CssVars dark={dark} />
        <ErrorBoundary>
          <QuickCapture onTheme={setMode} />
        </ErrorBoundary>
      </AntApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
