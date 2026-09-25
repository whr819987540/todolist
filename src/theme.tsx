import { DesktopOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button, Dropdown, Tooltip, theme } from "antd";
import { createContext, useContext, useEffect, useLayoutEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";

export const ThemeContext = createContext<{ mode: ThemeMode; setMode: (m: ThemeMode) => void }>({
  mode: "system",
  setMode: () => {},
});

const query = window.matchMedia("(prefers-color-scheme: dark)");

export function useSystemDark(): boolean {
  const [dark, setDark] = useState(query.matches);
  useEffect(() => {
    const onChange = () => setDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return dark;
}

/** 让标题栏（系统原生）跟着切换深浅色 */
export function useWindowTheme(mode: ThemeMode) {
  useEffect(() => {
    getCurrentWindow()
      .setTheme(mode === "system" ? null : mode)
      .catch(() => {});
  }, [mode]);
}

/** 把 antd 的设计变量同步成 CSS 变量，自定义样式据此适配深浅色 */
export function CssVars({ dark }: { dark: boolean }) {
  const { token } = theme.useToken();
  useLayoutEffect(() => {
    const vars: Record<string, string> = {
      "--c-primary": token.colorPrimary,
      "--c-primary-bg": token.colorPrimaryBg,
      "--c-primary-bg-hover": token.colorPrimaryBgHover,
      "--c-success": token.colorSuccess,
      "--c-warning": token.colorWarning,
      "--c-error": token.colorError,
      "--c-text": token.colorText,
      "--c-text-2": token.colorTextSecondary,
      "--c-text-3": token.colorTextTertiary,
      "--c-text-4": token.colorTextQuaternary,
      "--c-bg": token.colorBgContainer,
      "--c-bg-layout": dark ? "#0f0f0f" : "#f5f6f8",
      "--c-bg-sidebar": dark ? "#1b1b1b" : "#f7f8fa",
      "--c-bg-elevated": token.colorBgElevated,
      "--c-border": token.colorBorderSecondary,
      "--c-border-strong": token.colorBorder,
      "--c-hover": token.colorFillTertiary,
      "--c-fill": token.colorFillQuaternary,
      "--c-highlight": dark ? "rgba(250, 173, 20, 0.35)" : "#ffe58f",
      "--font": token.fontFamily,
    };
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.dataset.theme = dark ? "dark" : "light";
  }, [token, dark]);
  return null;
}

const ICONS: Record<ThemeMode, React.ReactNode> = {
  system: <DesktopOutlined />,
  light: <SunOutlined />,
  dark: <MoonOutlined />,
};

export function ThemeButton({ type = "default" }: { type?: "default" | "text" }) {
  const { mode, setMode } = useContext(ThemeContext);
  return (
    <Dropdown
      trigger={["click"]}
      menu={{
        selectable: true,
        selectedKeys: [mode],
        items: [
          { key: "system", icon: ICONS.system, label: "跟随系统" },
          { key: "light", icon: ICONS.light, label: "浅色模式" },
          { key: "dark", icon: ICONS.dark, label: "深色模式" },
        ],
        onClick: ({ key }) => setMode(key as ThemeMode),
      }}
    >
      <Tooltip title="外观">
        <Button type={type} icon={ICONS[mode]} />
      </Tooltip>
    </Dropdown>
  );
}
