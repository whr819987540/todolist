import { CheckCircleFilled, ExclamationCircleFilled } from "@ant-design/icons";
import { Button, InputNumber, Segmented, Slider } from "antd";
import { FONT_FIELDS, FONT_LIMITS, useSettings } from "../../settings";
import { THEME_ITEMS } from "../../theme";
import type { EditorBackground, FontArea, ThemeMode } from "../../types";

/** 外观：主题、编辑区背景色和字号，修改后立即生效，不用点保存 */
export default function AppearanceSettings() {
  const { info, setTheme } = useSettings();
  if (!info) return <div className="setting-item" />;
  return (
    <>
      <div className="setting-group">主题</div>
      <div className="setting-item">
        <div className="setting-desc">窗口标题栏跟着切换；首页和侧栏顶部的主题按钮改的也是这里。</div>
        <Segmented<ThemeMode>
          className="theme-options"
          value={info.settings.theme}
          options={THEME_ITEMS.map((t) => ({
            value: t.value,
            icon: t.icon,
            label: t.value === info.defaults.theme ? `${t.label}（默认）` : t.label,
          }))}
          onChange={setTheme}
        />
      </div>
      <div className="setting-group">编辑区背景色</div>
      <EditorBackgroundSetting defaultValue={info.defaults.editorBackground} />
      <div className="setting-group">字号</div>
      <FontSettings />
    </>
  );
}

const BG_ITEMS: { value: EditorBackground; label: string }[] = [
  { value: "beige", label: "护眼米色" },
  { value: "white", label: "白色" },
  { value: "custom", label: "自定义" },
];

const RGB = ["R", "G", "B"] as const;
const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbToHex = (rgb: number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** WCAG 相对亮度，0 是黑、1 是白 */
function luminance(rgb: number[]) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 编辑区里的文字是深色的，背景亮度低于这个值时次要文字就不太看得清了 */
const DARK_BG = 0.4;

function EditorBackgroundSetting({ defaultValue }: { defaultValue: EditorBackground }) {
  const { info, setEditorBackground } = useSettings();
  if (!info) return null;
  const { editorBackground: value, editorCustomColor: color } = info.settings;
  const rgb = hexToRgb(color);
  const setChannel = (i: number, v: number | null) => {
    if (v == null) return;
    const next = [...rgb];
    next[i] = v;
    setEditorBackground("custom", rgbToHex(next));
  };
  return (
    <div className="setting-item">
      <div className="setting-desc">
        右侧待办编辑区的背景，选「自定义」可以输入 RGB 数值。深色模式下编辑区始终是深色背景，这里的选择在浅色模式下生效。
      </div>
      <div className="bg-options" role="radiogroup" aria-label="编辑区背景色">
        {BG_ITEMS.map((item) => {
          const selected = item.value === value;
          return (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`bg-option${selected ? " selected" : ""}`}
              onClick={() => selected || setEditorBackground(item.value)}
            >
              <span
                className={`bg-swatch ${item.value}`}
                style={item.value === "custom" ? { background: color } : undefined}
              >
                整理本周会议纪要
                <span className="bg-swatch-text">在这里记录详细内容…</span>
              </span>
              <span className="bg-option-label">
                {selected && <CheckCircleFilled />}
                <span>
                  {item.label}
                  {item.value === defaultValue && <span className="muted">（默认）</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {value === "custom" && (
        <>
          <div className="setting-row bg-rgb">
            {RGB.map((ch, i) => (
              <InputNumber
                key={ch}
                className="bg-rgb-input"
                prefix={ch}
                min={0}
                max={255}
                precision={0}
                value={rgb[i]}
                onChange={(v) => setChannel(i, v)}
              />
            ))}
            <span className="bg-rgb-hex">{color.toUpperCase()}</span>
          </div>
          {luminance(rgb) < DARK_BG && (
            <div className="setting-hint warning-text">
              <ExclamationCircleFilled /> 颜色偏深，编辑区里的文字可能看不清
            </div>
          )}
        </>
      )}
    </div>
  );
}

const FONT_ITEMS: { area: FontArea; label: string; desc: string; sample: string }[] = [
  {
    area: "sidebar",
    label: "左侧列表",
    desc: "进入工作区后，左侧的工作区、项目与待办列表。",
    sample: "整理本周会议纪要",
  },
  {
    area: "editor",
    label: "待办编辑区",
    desc: "右侧的待办正文。编辑时按住 Ctrl 滚动鼠标滚轮也能快速调整。",
    sample: "在这里记录详细内容，Markdown 纯文本 123",
  },
];

function FontSettings() {
  const { info, setFontSize } = useSettings();
  if (!info) return null;
  return (
    <>
      {FONT_ITEMS.map(({ area, label, desc, sample }) => {
        const value = info.settings[FONT_FIELDS[area]];
        const defaultValue = info.defaults[FONT_FIELDS[area]];
        const { min, max } = FONT_LIMITS[area];
        return (
          <div className="setting-item" key={area}>
            <div className="setting-label">{label}</div>
            <div className="setting-desc">{desc}</div>
            <div className="setting-row">
              <Slider
                className="font-slider"
                min={min}
                max={max}
                value={value}
                marks={{ [min]: `${min}`, [defaultValue]: "默认", [max]: `${max}` }}
                tooltip={{ formatter: (v) => `${v}px` }}
                onChange={(v) => setFontSize(area, v)}
              />
              <InputNumber
                className="font-input"
                min={min}
                max={max}
                precision={0}
                value={value}
                suffix="px"
                onChange={(v) => v != null && setFontSize(area, v)}
              />
              <Button disabled={value === defaultValue} onClick={() => setFontSize(area, defaultValue)}>
                恢复默认
              </Button>
            </div>
            <div className="font-sample" style={{ fontSize: value }}>
              {sample}
            </div>
          </div>
        );
      })}
    </>
  );
}
