import { App as AntApp } from "antd";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errMsg } from "./api";
import { registerFlusher } from "./hooks";
import type { AppSettings, EditorBackground, FontArea, SettingsInfo, ThemeMode } from "./types";

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

/** 定时保存间隔的可调范围（秒），与 settings.rs 的 SAVE_DELAY_RANGE 一致 */
export const SAVE_DELAY_LIMITS = { min: 1, max: 3600 };

type SaveOptions = Pick<AppSettings, "autoSave" | "saveDelaySecs">;

/** 设置还没读出来时用的保存方式，与 settings.rs 的默认值一致 */
const DEFAULT_SAVE_OPTIONS: SaveOptions = { autoSave: false, saveDelaySecs: 180 };

/** 改了立即生效、稍后存盘的设置：外观、保存方式 */
type Pending = Pick<
  AppSettings,
  "theme" | "sidebarFontSize" | "editorFontSize" | "editorBackground" | "editorCustomColor"
> &
  SaveOptions;

/** 拖动滑块、滚动滚轮、输入数字时设置会连续变化，停下来片刻再存盘 */
const SAVE_DELAY = 300;

/** 以前主题只记在本机（localStorage）；搬进设置文件后记下这个标记，只搬一次 */
const THEME_MIGRATED_KEY = "themeInSettings";

const SettingsContext = createContext<{
  info: SettingsInfo | null;
  setInfo: (info: SettingsInfo) => void;
  /** 立即生效，稍后存盘 */
  setTheme: (theme: ThemeMode) => void;
  /** 立即生效，稍后存盘；超出范围时取边界值。返回调整后的字号 */
  setFontSize: (area: FontArea, size: number | ((cur: number) => number)) => number;
  /** 立即生效，稍后存盘；不传 customColor（#rrggbb）时保留原来的自定义颜色 */
  setEditorBackground: (background: EditorBackground, customColor?: string) => void;
  /** 立即生效，稍后存盘；间隔超出范围时取边界值 */
  setSaveOptions: (patch: Partial<SaveOptions>) => void;
}>({
  info: null,
  setInfo: () => {},
  setTheme: () => {},
  setFontSize: () => 0,
  setEditorBackground: () => {},
  setSaveOptions: () => {},
});

/**
 * 应用设置（保存在数据目录的 .settings.json）：启动时读一次，设置界面修改后更新。
 * 主题由外层（main.tsx 的 Root，在 antd 的主题配置外面）应用：theme 是正在用的主题，设置读出来、改了之后交给 onTheme
 */
export function SettingsProvider({
  theme,
  onTheme,
  children,
}: {
  theme: ThemeMode;
  onTheme: (theme: ThemeMode) => void;
  children: React.ReactNode;
}) {
  const { message } = AntApp.useApp();
  const [info, setRawInfo] = useState<SettingsInfo | null>(null);
  const infoRef = useRef(info);
  useEffect(() => {
    infoRef.current = info;
  }, [info]);
  // 已经生效、还没存盘的设置
  const pending = useRef<Partial<Pending>>({});
  const timer = useRef(0);

  // 后端返回的设置里可能还是存盘前的旧值，用待存的值盖上
  const setInfo = useCallback((next: SettingsInfo) => {
    setRawInfo({ ...next, settings: { ...next.settings, ...pending.current } });
  }, []);

  const flushPending = useCallback(async () => {
    window.clearTimeout(timer.current);
    const saving = { ...pending.current };
    const fields = Object.keys(saving) as (keyof Pending)[];
    if (!fields.length) return;
    try {
      if (saving.theme) await api.setTheme(saving.theme);
      for (const area of FONT_AREAS) {
        const size = saving[FONT_FIELDS[area]];
        if (size != null) await api.setFontSize(area, size);
      }
      // 背景色和自定义颜色总是一起改
      if (saving.editorBackground && saving.editorCustomColor) {
        await api.setEditorBackground(saving.editorBackground, saving.editorCustomColor);
      }
      if (saving.autoSave != null || saving.saveDelaySecs != null) {
        const cur = infoRef.current?.settings ?? DEFAULT_SAVE_OPTIONS;
        await api.setSaveOptions(saving.autoSave ?? cur.autoSave, saving.saveDelaySecs ?? cur.saveDelaySecs);
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

  useEffect(() => registerFlusher(flushPending), [flushPending]);

  const apply = useCallback(
    (patch: Partial<Pending>) => {
      Object.assign(pending.current, patch);
      setRawInfo((i) => i && { ...i, settings: { ...i.settings, ...patch } });
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flushPending, SAVE_DELAY);
    },
    [flushPending],
  );

  const setTheme = useCallback((next: ThemeMode) => apply({ theme: next }), [apply]);

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

  const setSaveOptions = useCallback(
    (patch: Partial<SaveOptions>) => {
      const { min, max } = SAVE_DELAY_LIMITS;
      const next = { ...patch };
      if (next.saveDelaySecs != null) next.saveDelaySecs = Math.round(Math.min(max, Math.max(min, next.saveDelaySecs)));
      apply(next);
    },
    [apply],
  );

  // 启动时本机缓存着的主题：以前主题只记在本机，设置文件里的还是默认值时搬过去
  const cachedTheme = useRef(theme);
  useEffect(() => {
    api
      .getSettings()
      .then((loaded) => {
        setInfo(loaded);
        try {
          if (localStorage.getItem(THEME_MIGRATED_KEY)) return;
          localStorage.setItem(THEME_MIGRATED_KEY, "1");
        } catch {
          return;
        }
        const { defaults } = loaded;
        if (loaded.settings.theme === defaults.theme && cachedTheme.current !== defaults.theme)
          setTheme(cachedTheme.current);
      })
      .catch(() => {});
  }, [setInfo, setTheme]);

  // 主题交给外层应用（设置读出来之前外层用本机缓存的）
  const themeSetting = info?.settings.theme;
  useLayoutEffect(() => {
    if (themeSetting) onTheme(themeSetting);
  }, [themeSetting, onTheme]);

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
    () => ({ info, setInfo, setTheme, setFontSize, setEditorBackground, setSaveOptions }),
    [info, setInfo, setTheme, setFontSize, setEditorBackground, setSaveOptions],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);

/** 当前的保存方式：定时保存的间隔和 auto save 开关 */
export function useSaveOptions(): SaveOptions {
  const s = useContext(SettingsContext).info?.settings ?? DEFAULT_SAVE_OPTIONS;
  return { autoSave: s.autoSave, saveDelaySecs: s.saveDelaySecs };
}
