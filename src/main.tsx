import { App as AntApp, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { SettingsProvider } from "./settings";
import { CssVars, FONT, readThemeCache, ThemeContext, useSystemDark, useWindowTheme, writeThemeCache } from "./theme";
import { blockBrowserDefaults } from "./webview";
import "./styles.css";


blockBrowserDefaults();

function Root() {
  // 主题存在设置文件里，由 SettingsProvider 读出来交给这里；读出来之前先用本机缓存的
  const [mode, setMode] = useState(readThemeCache);
  const systemDark = useSystemDark();
  const dark = mode === "dark" || (mode === "system" && systemDark);
  useWindowTheme(mode);
  useEffect(() => writeThemeCache(mode), [mode]);

  return (
    <ThemeContext.Provider value={mode}>
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
            <SettingsProvider theme={mode} onTheme={setMode}>
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
