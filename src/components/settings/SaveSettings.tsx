import { Button, InputNumber, Select, Switch } from "antd";
import { useState } from "react";
import { SAVE_DELAY_LIMITS, useSettings } from "../../settings";

type DelayUnit = "sec" | "min";

const unitOf = (secs: number): DelayUnit => (secs % 60 ? "sec" : "min");

/** 保存：auto save 开关和定时保存的间隔，修改后立即生效 */
export default function SaveSettings() {
  const { info, setSaveOptions } = useSettings();
  // 间隔按秒存；单位只是显示方式，不是整分钟时只能按秒显示
  const [unitPref, setUnitPref] = useState<DelayUnit>(() => unitOf(info?.settings.saveDelaySecs ?? 0));
  if (!info) return <div className="setting-item" />;

  const { saveDelaySecs: secs, autoSave } = info.settings;
  const defaultSecs = info.defaults.saveDelaySecs;
  const unit: DelayUnit = unitPref === "min" && secs % 60 === 0 ? "min" : "sec";
  const factor = unit === "min" ? 60 : 1;
  const changeUnit = (u: DelayUnit) => {
    setUnitPref(u);
    if (u === "min" && secs % 60) setSaveOptions({ saveDelaySecs: Math.max(60, Math.round(secs / 60) * 60) });
  };

  return (
    <>
      <div className="setting-group">自动保存</div>
      <div className="setting-item">
        <div className="setting-switch-row">
          <span className="setting-label">auto save</span>
          <Switch
            className="auto-save-switch"
            checked={autoSave}
            onChange={(v) => setSaveOptions({ autoSave: v })}
          />
        </div>
        <div className="setting-desc">
          开启后，编辑器失去焦点、窗口失去焦点（包括隐藏到托盘）时立即保存，有修改时还按下面的间隔定时保存。
          {"关闭时在按 Ctrl+S、切换待办和从托盘退出时保存，失去焦点、隐藏到托盘时不保存；修改后一直没保存的，满 1 小时也会自动保存一次。"}
        </div>
      </div>
      <div className="setting-item">
        <div className="setting-label">定时保存</div>
        <div className="setting-desc">
          待办的标题或正文改动后，隔多久自动保存。从第一处未保存的修改开始计时，继续输入不会推迟保存。只在开启 auto save 时生效，关闭时固定为 1 小时。
        </div>
        <div className={`setting-row${autoSave ? "" : " muted"}`}>
          <span>修改后</span>
          <InputNumber
            className="save-delay-input"
            disabled={!autoSave}
            min={1}
            max={SAVE_DELAY_LIMITS.max / factor}
            precision={0}
            value={secs / factor}
            onChange={(v) => v != null && setSaveOptions({ saveDelaySecs: v * factor })}
          />
          <Select
            className="save-delay-unit"
            disabled={!autoSave}
            value={unit}
            options={[
              { value: "sec", label: "秒" },
              { value: "min", label: "分钟" },
            ]}
            onChange={changeUnit}
          />
          <span>自动保存</span>
          <Button
            className="save-delay-reset"
            disabled={!autoSave || secs === defaultSecs}
            onClick={() => {
              setUnitPref(unitOf(defaultSecs));
              setSaveOptions({ saveDelaySecs: defaultSecs });
            }}
          >
            恢复默认
          </Button>
        </div>
      </div>
      <div className="setting-hint muted">
        按 Ctrl+S 随时立即保存，切换待办、从托盘退出前也总会保存，不受 auto save 开关影响。
      </div>
    </>
  );
}
