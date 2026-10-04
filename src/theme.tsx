import { DesktopOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button, Dropdown, Tooltip, theme } from "antd";
import { createContext, useContext, useEffect, useLayoutEffect, useState } from "react";
import { useSettings } from "./settings";
import type { ThemeMode } from "./types";

export type { ThemeMode };

/** 界面字体：中文用微软雅黑 */
export const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif';

/** 正在用的主题：设置读出来之前是本机缓存的 */
export const ThemeContext = createContext<ThemeMode>("system");

/**
 * 主题存在设置文件里；本机（localStorage）另记一份，启动时设置还没读出来就先用它，免得界面闪一下。
 * 以前主题只记在这里，第一次读到设置时由 SettingsProvider 搬进设置文件
 */
const CACHE_KEY = "theme";

const isThemeMode = (v: unknown): v is ThemeMode => v === "system" || v === "light" || v === "dark";

export function readThemeCache(): ThemeMode {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    return isThemeMode(v) ? v : "system";
  } catch {
    return "system";
  }
}

export function writeThemeCache(mode: ThemeMode) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(mode));
  } catch {
    /* 忽略 */
  }
}

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

export const THEME_ITEMS: { value: ThemeMode; icon: React.ReactNode; label: string }[] = [
  { value: "system", icon: <DesktopOutlined />, label: "跟随系统" },
  { value: "light", icon: <SunOutlined />, label: "浅色模式" },
  { value: "dark", icon: <MoonOutlined />, label: "深色模式" },
];

const ICONS = Object.fromEntries(THEME_ITEMS.map((t) => [t.value, t.icon])) as Record<ThemeMode, React.ReactNode>;

/** 切换主题的按钮，改的是设置文件里的主题（和设置的「外观」里是同一个） */
export function ThemeButton({ type = "default" }: { type?: "default" | "text" }) {
  const mode = useContext(ThemeContext);
  const { setTheme } = useSettings();
  return (
    <Dropdown
      trigger={["click"]}
      menu={{
        selectable: true,
        selectedKeys: [mode],
        items: THEME_ITEMS.map((t) => ({ key: t.value, icon: t.icon, label: t.label })),
        onClick: ({ key }) => setTheme(key as ThemeMode),
      }}
    >
      <Tooltip title="外观">
        <Button type={type} icon={ICONS[mode]} />
      </Tooltip>
    </Dropdown>
  );
}
