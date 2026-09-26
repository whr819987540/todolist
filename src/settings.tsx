import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { SettingsInfo } from "./types";

const SettingsContext = createContext<{
  info: SettingsInfo | null;
  setInfo: (info: SettingsInfo) => void;
}>({ info: null, setInfo: () => {} });

/** 应用设置（保存在数据目录的 .settings.json）：启动时读一次，设置界面修改后更新 */
export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  useEffect(() => {
    api.getSettings().then(setInfo).catch(() => {});
  }, []);
  const value = useMemo(() => ({ info, setInfo }), [info]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);
