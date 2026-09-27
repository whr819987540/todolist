import { App as AntApp } from "antd";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errMsg } from "./api";
import { registerFlusher } from "./hooks";
import type { AppSettings, FontArea, SettingsInfo } from "./types";

/** 字号的可调范围（px），与 settings.rs 的 FontArea::range 一致 */
export const FONT_LIMITS: Record<FontArea, { min: number; max: number }> = {
  sidebar: { min: 12, max: 20 },
  editor: { min: 12, max: 32 },
};

export const FONT_FIELDS = {
  sidebar: "sidebarFontSize",
  editor: "editorFontSize",
} as const satisfies Record<FontArea, keyof AppSettings>;

/** 拖动滑块、滚动滚轮时字号会连续变化，停下来片刻再存盘 */
const FONT_SAVE_DELAY = 300;

const SettingsContext = createContext<{
  info: SettingsInfo | null;
  setInfo: (info: SettingsInfo) => void;
  /** 立即生效，稍后存盘；超出范围时取边界值。返回调整后的字号 */
  setFontSize: (area: FontArea, size: number | ((cur: number) => number)) => number;
}>({ info: null, setInfo: () => {}, setFontSize: () => 0 });

/** 应用设置（保存在数据目录的 .settings.json）：启动时读一次，设置界面修改后更新 */
export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { message } = AntApp.useApp();
  const [info, setRawInfo] = useState<SettingsInfo | null>(null);
  const infoRef = useRef(info);
  useEffect(() => {
    infoRef.current = info;
  }, [info]);
  // 已经生效、还没存盘的字号
  const pending = useRef<Partial<Record<FontArea, number>>>({});
  const timer = useRef(0);

  // 后端返回的设置里字号可能还是存盘前的旧值，用待存的值盖上
  const setInfo = useCallback((next: SettingsInfo) => {
    const settings = { ...next.settings };
    for (const [area, size] of Object.entries(pending.current) as [FontArea, number][]) {
      settings[FONT_FIELDS[area]] = size;
    }
    setRawInfo({ ...next, settings });
  }, []);

  const flushFontSizes = useCallback(async () => {
    window.clearTimeout(timer.current);
    for (const [area, size] of Object.entries(pending.current) as [FontArea, number][]) {
      try {
        await api.setFontSize(area, size);
      } catch (e) {
        message.error(`保存字号失败：${errMsg(e)}`);
        // 界面上恢复成实际保存着的字号
        api.getSettings().then(setInfo, () => {});
      } finally {
        // 存盘期间又调过的话留给下一次
        if (pending.current[area] === size) delete pending.current[area];
      }
    }
  }, [message, setInfo]);

  useEffect(() => registerFlusher(flushFontSizes), [flushFontSizes]);

  const setFontSize = useCallback(
    (area: FontArea, size: number | ((cur: number) => number)) => {
      const field = FONT_FIELDS[area];
      const { min, max } = FONT_LIMITS[area];
      const cur = pending.current[area] ?? infoRef.current?.settings[field] ?? min;
      const next = Math.round(Math.min(max, Math.max(min, typeof size === "number" ? size : size(cur))));
      if (next !== cur) {
        pending.current[area] = next;
        setRawInfo((i) => i && { ...i, settings: { ...i.settings, [field]: next } });
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flushFontSizes, FONT_SAVE_DELAY);
      }
      return next;
    },
    [flushFontSizes],
  );

  useEffect(() => {
    api.getSettings().then(setInfo).catch(() => {});
  }, [setInfo]);

  // 字号通过 CSS 变量作用到侧栏列表和编辑区，styles.css 里有加载前的默认值
  const sidebarFontSize = info?.settings.sidebarFontSize;
  const editorFontSize = info?.settings.editorFontSize;
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    if (sidebarFontSize) style.setProperty("--fs-sidebar", `${sidebarFontSize}px`);
    if (editorFontSize) style.setProperty("--fs-editor", `${editorFontSize}px`);
  }, [sidebarFontSize, editorFontSize]);

  const value = useMemo(() => ({ info, setInfo, setFontSize }), [info, setInfo, setFontSize]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);
