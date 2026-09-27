import { App as AntApp } from "antd";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errMsg } from "./api";
import { registerFlusher } from "./hooks";
import type { AppSettings, EditorBackground, FontArea, SettingsInfo } from "./types";

/** 字号的可调范围（px），与 settings.rs 的 FontArea::range 一致 */
export const FONT_LIMITS: Record<FontArea, { min: number; max: number }> = {
  sidebar: { min: 12, max: 20 },
  editor: { min: 12, max: 32 },
};

export const FONT_FIELDS = {
  sidebar: "sidebarFontSize",
  editor: "editorFontSize",
} as const satisfies Record<FontArea, keyof AppSettings>;

const FONT_AREAS = Object.keys(FONT_FIELDS) as FontArea[];

/** 改了立即生效、稍后存盘的外观设置 */
type Appearance = Pick<AppSettings, "sidebarFontSize" | "editorFontSize" | "editorBackground" | "editorCustomColor">;

/** 拖动滑块、滚动滚轮、输入 RGB 时外观设置会连续变化，停下来片刻再存盘 */
const SAVE_DELAY = 300;

const SettingsContext = createContext<{
  info: SettingsInfo | null;
  setInfo: (info: SettingsInfo) => void;
  /** 立即生效，稍后存盘；超出范围时取边界值。返回调整后的字号 */
  setFontSize: (area: FontArea, size: number | ((cur: number) => number)) => number;
  /** 立即生效，稍后存盘；不传 customColor（#rrggbb）时保留原来的自定义颜色 */
  setEditorBackground: (background: EditorBackground, customColor?: string) => void;
}>({ info: null, setInfo: () => {}, setFontSize: () => 0, setEditorBackground: () => {} });

/** 应用设置（保存在数据目录的 .settings.json）：启动时读一次，设置界面修改后更新 */
export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { message } = AntApp.useApp();
  const [info, setRawInfo] = useState<SettingsInfo | null>(null);
  const infoRef = useRef(info);
  useEffect(() => {
    infoRef.current = info;
  }, [info]);
  // 已经生效、还没存盘的外观设置
  const pending = useRef<Partial<Appearance>>({});
  const timer = useRef(0);

  // 后端返回的设置里可能还是存盘前的旧值，用待存的值盖上
  const setInfo = useCallback((next: SettingsInfo) => {
    setRawInfo({ ...next, settings: { ...next.settings, ...pending.current } });
  }, []);

  const flushAppearance = useCallback(async () => {
    window.clearTimeout(timer.current);
    const saving = { ...pending.current };
    const fields = Object.keys(saving) as (keyof Appearance)[];
    if (!fields.length) return;
    try {
      for (const area of FONT_AREAS) {
        const size = saving[FONT_FIELDS[area]];
        if (size != null) await api.setFontSize(area, size);
      }
      // 背景色和自定义颜色总是一起改
      if (saving.editorBackground && saving.editorCustomColor) {
        await api.setEditorBackground(saving.editorBackground, saving.editorCustomColor);
      }
    } catch (e) {
      message.error(`保存设置失败：${errMsg(e)}`);
      // 界面上恢复成实际保存着的设置
      api.getSettings().then(setInfo, () => {});
    } finally {
      // 存盘期间又改过的留给下一次
      for (const f of fields) if (pending.current[f] === saving[f]) delete pending.current[f];
    }
  }, [message, setInfo]);

  useEffect(() => registerFlusher(flushAppearance), [flushAppearance]);

  const apply = useCallback(
    (patch: Partial<Appearance>) => {
      Object.assign(pending.current, patch);
      setRawInfo((i) => i && { ...i, settings: { ...i.settings, ...patch } });
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flushAppearance, SAVE_DELAY);
    },
    [flushAppearance],
  );

  const setFontSize = useCallback(
    (area: FontArea, size: number | ((cur: number) => number)) => {
      const field = FONT_FIELDS[area];
      const { min, max } = FONT_LIMITS[area];
      const cur = pending.current[field] ?? infoRef.current?.settings[field] ?? min;
      const next = Math.round(Math.min(max, Math.max(min, typeof size === "number" ? size : size(cur))));
      if (next !== cur) apply({ [field]: next });
      return next;
    },
    [apply],
  );

  const setEditorBackground = useCallback(
    (background: EditorBackground, customColor?: string) => {
      const color = customColor ?? pending.current.editorCustomColor ?? infoRef.current?.settings.editorCustomColor;
      if (color) apply({ editorBackground: background, editorCustomColor: color });
    },
    [apply],
  );

  useEffect(() => {
    api.getSettings().then(setInfo).catch(() => {});
  }, [setInfo]);

  // 字号通过 CSS 变量作用到侧栏列表和编辑区，styles.css 里有加载前的默认值；编辑区背景色标在
  // 根元素的 data-editor-bg 上（index.html 里是加载前的默认值），自定义颜色写进 CSS 变量 --c-editor-custom
  const sidebarFontSize = info?.settings.sidebarFontSize;
  const editorFontSize = info?.settings.editorFontSize;
  const editorBackground = info?.settings.editorBackground;
  const editorCustomColor = info?.settings.editorCustomColor;
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (sidebarFontSize) root.style.setProperty("--fs-sidebar", `${sidebarFontSize}px`);
    if (editorFontSize) root.style.setProperty("--fs-editor", `${editorFontSize}px`);
    if (editorBackground) root.dataset.editorBg = editorBackground;
    if (editorCustomColor) root.style.setProperty("--c-editor-custom", editorCustomColor);
  }, [sidebarFontSize, editorFontSize, editorBackground, editorCustomColor]);

  const value = useMemo(
    () => ({ info, setInfo, setFontSize, setEditorBackground }),
    [info, setInfo, setFontSize, setEditorBackground],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);
