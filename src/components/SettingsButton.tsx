import { CheckCircleFilled, ExclamationCircleFilled, SettingOutlined } from "@ant-design/icons";
import { App as AntApp, Button, InputNumber, Modal, Slider, Tabs, Tooltip } from "antd";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { FONT_FIELDS, FONT_LIMITS, useSettings } from "../settings";
import { checkShortcut, eventShortcut, keyLabel, keyName, modifiers, shortcutLabel } from "../shortcuts";
import type { EditorBackground, FontArea, ShortcutAction } from "../types";
import BackupSettings from "./BackupSettings";

/** 设置按钮，点击打开设置对话框 */
export default function SettingsButton({ type = "default" }: { type?: "default" | "text" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip title="设置">
        <Button type={type} icon={<SettingOutlined />} onClick={() => setOpen(true)} />
      </Tooltip>
      <Modal open={open} title="设置" footer={null} width={560} centered destroyOnHidden onCancel={() => setOpen(false)}>
        <Tabs
          className="settings-tabs"
          items={[
            { key: "shortcuts", label: "快捷键", children: <ShortcutSettings /> },
            { key: "appearance", label: "外观", children: <AppearanceSettings /> },
            { key: "backup", label: "备份与恢复", children: <BackupSettings /> },
          ]}
        />
      </Modal>
    </>
  );
}

type ShortcutField = "toggleShortcut" | "toggleDoneShortcut" | "openExternalShortcut";

const ITEMS: { action: ShortcutAction; field: ShortcutField; label: string; desc: string }[] = [
  {
    action: "toggleWindow",
    field: "toggleShortcut",
    label: "显示 / 隐藏主窗口",
    desc: "全局快捷键，在任何程序里都能用：主窗口在前台时隐藏到系统托盘，否则调到前台。",
  },
  {
    action: "toggleDone",
    field: "toggleDoneShortcut",
    label: "标记完成 / 未完成",
    desc: "软件在前台且选中了某条待办时生效。",
  },
  {
    action: "openExternal",
    field: "openExternalShortcut",
    label: "用默认程序打开",
    desc: "软件在前台且选中了某条待办时，用系统默认的 Markdown 程序打开它。",
  },
];

function ShortcutSettings() {
  const { message } = AntApp.useApp();
  const { info, setInfo } = useSettings();
  const [recording, setRecording] = useState<ShortcutAction | null>(null);

  // 打开时刷新一次：全局快捷键的注册状态可能变了
  useEffect(() => {
    api
      .getSettings()
      .then(setInfo)
      .catch((e) => message.error(errMsg(e)));
  }, [setInfo, message]);

  // 录制任何快捷键期间都暂停全局快捷键，否则按下它会直接把窗口藏起来、录不到；结束录制或关闭对话框时恢复，
  // 并用恢复后的注册状态刷新提示
  useEffect(() => {
    if (!recording) return;
    api.pauseToggleShortcut(true).catch(() => {});
    return () => {
      api.pauseToggleShortcut(false).then(setInfo, () => {});
    };
  }, [recording, setInfo]);

  if (!info) return <div className="setting-item" />;

  const row = ({ action, field, label, desc }: (typeof ITEMS)[number]) => {
    const value = info.settings[field];
    return (
      <ShortcutRow
        key={action}
        label={label}
        desc={desc}
        value={value}
        defaultValue={info.defaults[field]}
        warning={
          action === "toggleWindow" && value && !info.toggleShortcutRegistered
            ? `快捷键 ${shortcutLabel(value)} 未生效，可能已被其他程序占用，请换一个`
            : undefined
        }
        recording={recording === action}
        onRecording={(on) => setRecording((cur) => (on ? action : cur === action ? null : cur))}
        onSave={async (shortcut) => {
          try {
            setInfo(await api.setShortcut(action, shortcut));
            message.success(shortcut ? `「${label}」已设置为 ${shortcutLabel(shortcut)}` : `「${label}」已设为不使用`);
          } catch (e) {
            message.error(errMsg(e));
          }
        }}
      />
    );
  };

  return (
    <>
      <div className="setting-group">全局快捷键</div>
      {ITEMS.slice(0, 1).map(row)}
      <div className="setting-group">应用内快捷键</div>
      {ITEMS.slice(1).map(row)}
    </>
  );
}

/** 外观：编辑区背景色和字号，修改后立即生效，不用点保存 */
function AppearanceSettings() {
  const { info } = useSettings();
  if (!info) return <div className="setting-item" />;
  return (
    <>
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

function Keys({ parts }: { parts: string[] }) {
  return (
    <span className="keys">
      {parts.map((k, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="keys-plus">+</span>}
          <kbd>{keyLabel(k)}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

/** 一个快捷键的设置行：点击输入框后按下新的组合键录制 */
function ShortcutRow(p: {
  label: string;
  desc: string;
  value: string | null;
  defaultValue: string | null;
  warning?: string;
  recording: boolean;
  onRecording: (on: boolean) => void;
  onSave: (shortcut: string | null) => Promise<void>;
}) {
  const { recording } = p;
  const [held, setHeld] = useState<string[]>([]);
  const [hint, setHint] = useState("");
  const [saving, setSaving] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!recording) return;
    setHeld([]);
    setHint("");
    boxRef.current?.focus();
  }, [recording]);

  const save = async (shortcut: string | null) => {
    setSaving(true);
    try {
      await p.onSave(shortcut);
    } finally {
      setSaving(false);
      p.onRecording(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    // 不让按键触发页面上的其他快捷键（Ctrl+N 新建等）或关闭对话框
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || saving) return;
    const mods = modifiers(e);
    if (e.key === "Escape" && mods.length === 0) {
      p.onRecording(false);
      return;
    }
    const shortcut = eventShortcut(e);
    setHeld(shortcut ? shortcut.split("+") : mods);
    if (!shortcut) return;
    const problem = e.metaKey ? "暂不支持 Win 键组合" : checkShortcut(shortcut);
    if (problem) setHint(problem);
    else save(shortcut);
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (recording && !keyName(e.code)) setHeld(modifiers(e));
  };

  return (
    <div className="setting-item">
      <div className="setting-label">{p.label}</div>
      <div className="setting-desc">{p.desc}</div>
      <div className="setting-row">
        <div
          ref={boxRef}
          tabIndex={0}
          className={`shortcut-box${recording ? " recording" : ""}`}
          onClick={() => p.onRecording(true)}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => p.onRecording(false)}
        >
          {recording ? (
            held.length ? (
              <Keys parts={held} />
            ) : (
              <span className="muted">请按下新的快捷键，Esc 取消</span>
            )
          ) : p.value ? (
            <Keys parts={p.value.split("+")} />
          ) : (
            <span className="muted">未设置</span>
          )}
        </div>
        <Button loading={saving} onMouseDown={(e) => e.preventDefault()} onClick={() => p.onRecording(!recording)}>
          {recording ? "取消" : "修改"}
        </Button>
        <Button disabled={recording || p.value === p.defaultValue} onClick={() => save(p.defaultValue)}>
          恢复默认
        </Button>
        <Button disabled={recording || !p.value} onClick={() => save(null)}>
          不使用
        </Button>
      </div>
      {recording && hint && <div className="setting-hint error-text">{hint}</div>}
      {!recording && p.warning && (
        <div className="setting-hint warning-text">
          <ExclamationCircleFilled /> {p.warning}
        </div>
      )}
    </div>
  );
}
