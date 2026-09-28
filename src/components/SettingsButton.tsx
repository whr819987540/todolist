import { CheckCircleFilled, ExclamationCircleFilled, SettingOutlined } from "@ant-design/icons";
import {
  App as AntApp,
  Button,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Segmented,
  Select,
  Slider,
  Switch,
  Tabs,
  Tooltip,
} from "antd";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import {
  CONFIGURABLE_EDIT_SHORTCUTS,
  type EditCommandId,
  EDIT_SHORTCUT_GROUPS,
  EDIT_SHORTCUTS,
} from "../editShortcuts";
import { FONT_FIELDS, FONT_LIMITS, SAVE_DELAY_LIMITS, useEditShortcuts, useSettings } from "../settings";
import {
  checkShortcut,
  eventShortcut,
  keyLabel,
  keyName,
  modifiers,
  sameShortcut,
  shortcutLabel,
  type TakenShortcut,
} from "../shortcuts";
import { THEME_ITEMS } from "../theme";
import type { EditorBackground, FontArea, ShortcutAction, StartupView, ThemeMode } from "../types";
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
            { key: "general", label: "常规", children: <GeneralSettings /> },
            { key: "shortcuts", label: "快捷键", children: <ShortcutSettings /> },
            { key: "appearance", label: "外观", children: <AppearanceSettings /> },
            { key: "save", label: "保存", children: <SaveSettings /> },
            { key: "backup", label: "备份与恢复", children: <BackupSettings /> },
          ]}
        />
      </Modal>
    </>
  );
}

const STARTUP_ITEMS: { value: StartupView; label: string; desc: string }[] = [
  { value: "home", label: "显示首页", desc: "列出全部工作区。" },
  {
    value: "lastPosition",
    label: "回到上次的位置",
    desc: "恢复上次左侧选中的工作区和右侧打开的待办；上次停在首页时仍显示首页。",
  },
];

/** 常规：打开软件时显示的界面，下次启动时生效 */
function GeneralSettings() {
  const { message } = AntApp.useApp();
  const { info, setInfo } = useSettings();
  if (!info) return <div className="setting-item" />;

  const change = async (view: StartupView) => {
    try {
      setInfo(await api.setStartupView(view));
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  return (
    <>
      <div className="setting-group">启动</div>
      <div className="setting-item">
        <div className="setting-label">打开软件时</div>
        <div className="setting-desc">下次打开软件时生效；从托盘恢复窗口时总是保持原来的样子。</div>
        <Radio.Group
          className="startup-options"
          vertical
          value={info.settings.startupView}
          onChange={(e) => change(e.target.value)}
        >
          {STARTUP_ITEMS.map((item) => (
            <Radio key={item.value} value={item.value}>
              {item.label}
              {item.value === info.defaults.startupView && <span className="muted">（默认）</span>}
              <div className="setting-desc">{item.desc}</div>
            </Radio>
          ))}
        </Radio.Group>
      </div>
      <div className="setting-hint muted">
        切换待办时，光标（选中的文字）和滚动总是回到这条待办上次编辑的地方；正文在外部被大幅修改、找不到原来的位置时回到开头。
      </div>
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

/** 录制中的是哪一个：应用快捷键 app:动作、编辑快捷键 edit:命令 */
type RecordingSlot = `app:${ShortcutAction}` | `edit:${EditCommandId}`;

function ShortcutSettings() {
  const { message } = AntApp.useApp();
  const { info, setInfo } = useSettings();
  const edit = useEditShortcuts();
  const [recording, setRecording] = useState<RecordingSlot | null>(null);

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

  /** 除了 self 以外正用着的快捷键：应用快捷键、编辑快捷键和编辑区的固定按键，互相不能重复 */
  const takenExcept = (self: RecordingSlot): TakenShortcut[] => [
    ...ITEMS.filter((i) => `app:${i.action}` !== self).map((i) => ({
      key: info.settings[i.field],
      label: `「${i.label}」`,
    })),
    ...CONFIGURABLE_EDIT_SHORTCUTS.filter((e) => `edit:${e.id}` !== self).map((e) => ({
      key: edit[e.id],
      label: `编辑快捷键「${e.label}」`,
    })),
    ...EDIT_SHORTCUTS.flatMap((e) => (e.fixed ?? []).map((key) => ({ key, label: `编辑快捷键「${e.label}」` }))),
  ];
  const recorder = (slot: RecordingSlot) => ({
    recording: recording === slot,
    onRecording: (on: boolean) => setRecording((cur) => (on ? slot : cur === slot ? null : cur)),
    check: (shortcut: string) => checkShortcut(shortcut, takenExcept(slot)),
  });

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
        {...recorder(`app:${action}`)}
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
      <EditShortcutSettings recorder={recorder} />
    </>
  );
}

/** 编辑快捷键：正文里的 Markdown 编辑操作，默认同 Typora；每条都能改、恢复默认或不使用，固定按键只列出来 */
function EditShortcutSettings({
  recorder,
}: {
  recorder: (slot: RecordingSlot) => Pick<ShortcutRowProps, "recording" | "onRecording" | "check">;
}) {
  const { message } = AntApp.useApp();
  const { info, setInfo } = useSettings();
  const edit = useEditShortcuts();
  if (!info) return null;
  const changed = info.settings.editShortcuts;
  const appKeys = ITEMS.map((i) => ({ key: info.settings[i.field], label: i.label }));

  const saveAll = async (next: Record<string, string | null>, done: string) => {
    try {
      setInfo(await api.setEditShortcuts(next));
      message.success(done);
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  const resetAll = () => {
    // 默认按键已经给了应用快捷键的，要先把那边改掉
    for (const e of CONFIGURABLE_EDIT_SHORTCUTS) {
      const app = appKeys.find((a) => sameShortcut(a.key, e.defaultKey));
      if (app) {
        message.error(`「${e.label}」的默认按键 ${shortcutLabel(e.defaultKey)} 已用于「${app.label}」，请先改掉那个快捷键`);
        return;
      }
    }
    saveAll({}, "编辑快捷键已全部恢复默认");
  };

  /** 这一条的按键和别的重复时（手改过设置文件等），说明实际执行的是哪个 */
  const conflict = (id: EditCommandId, value: string | null): string | undefined => {
    if (!value) return undefined;
    const app = appKeys.find((a) => sameShortcut(a.key, value));
    if (app) return `和「${app.label}」重复，在正文里按下时执行的是「${app.label}」`;
    const fixed = EDIT_SHORTCUTS.find((e) => e.fixed?.some((k) => sameShortcut(k, value)));
    if (fixed) return `和编辑快捷键「${fixed.label}」的固定按键重复，这个不起作用`;
    const before = CONFIGURABLE_EDIT_SHORTCUTS.slice(0, CONFIGURABLE_EDIT_SHORTCUTS.findIndex((e) => e.id === id));
    const earlier = before.find((e) => sameShortcut(edit[e.id], value));
    return earlier ? `和编辑快捷键「${earlier.label}」重复，这个不起作用` : undefined;
  };

  return (
    <>
      <div className="setting-group with-action">
        <span>编辑快捷键</span>
        <Popconfirm title="把编辑快捷键全部恢复成默认？" okText="恢复默认" cancelText="取消" onConfirm={resetAll}>
          <Button type="link" size="small" disabled={!Object.keys(changed).length}>
            全部恢复默认
          </Button>
        </Popconfirm>
      </div>
      <div className="setting-desc">
        在待办正文里使用，默认与 Typora 相同。点按键框后按下新的组合键即可修改，立即生效，随设置一起备份。
      </div>
      {EDIT_SHORTCUT_GROUPS.map((g) => (
        <div className="edit-shortcuts" key={g.title}>
          <div className="edit-shortcuts-title">{g.title}</div>
          {g.items.some((item) => item.id && item.defaultKey) ? (
            g.items.map((item) => {
              const { id, defaultKey } = item;
              if (!id || !defaultKey) return null;
              return (
                <ShortcutRow
                  key={id}
                  compact
                  label={item.label}
                  note={item.fixed?.length ? `（或 ${item.fixed.join(" / ")}）` : undefined}
                  value={edit[id]}
                  defaultValue={defaultKey}
                  warning={conflict(id, edit[id])}
                  {...recorder(`edit:${id}`)}
                  onSave={async (shortcut) => {
                    const next = { ...changed };
                    if (shortcut === defaultKey) delete next[id];
                    else next[id] = shortcut;
                    await saveAll(
                      next,
                      shortcut ? `「${item.label}」已设置为 ${shortcutLabel(shortcut)}` : `「${item.label}」已设为不使用`,
                    );
                  }}
                />
              );
            })
          ) : (
            <div className="edit-shortcuts-grid">
              {g.items.map((item) => (
                <div className="edit-shortcut" key={item.label}>
                  <span>{item.label}</span>
                  <span className="edit-shortcut-keys">
                    {(item.shown ?? item.fixed ?? []).map((k, i) => (
                      <Fragment key={k}>
                        {i > 0 && <span className="keys-plus">/</span>}
                        <Keys parts={k.split("+")} />
                      </Fragment>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** 外观：主题、编辑区背景色和字号，修改后立即生效，不用点保存 */
function AppearanceSettings() {
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

type DelayUnit = "sec" | "min";

const unitOf = (secs: number): DelayUnit => (secs % 60 ? "sec" : "min");

/** 保存：auto save 开关和定时保存的间隔，修改后立即生效 */
function SaveSettings() {
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
          {"关闭时只在按 Ctrl+S、切换待办和从托盘退出时保存。"}
        </div>
      </div>
      <div className="setting-item">
        <div className="setting-label">定时保存</div>
        <div className="setting-desc">
          待办的标题或正文改动后，隔多久自动保存。从第一处未保存的修改开始计时，继续输入不会推迟保存。只在开启 auto save 时生效。
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

interface ShortcutRowProps {
  label: string;
  desc?: string;
  /** 紧凑的一行：名称、按键框、恢复默认、不使用（编辑快捷键用，条目多） */
  compact?: boolean;
  /** 名称后面的补充说明 */
  note?: string;
  value: string | null;
  defaultValue: string | null;
  warning?: string;
  recording: boolean;
  onRecording: (on: boolean) => void;
  /** 录到的快捷键不能用时返回原因 */
  check: (shortcut: string) => string | null;
  onSave: (shortcut: string | null) => Promise<void>;
}

/** 一个快捷键的设置行：点击输入框后按下新的组合键录制 */
function ShortcutRow(p: ShortcutRowProps) {
  const { message } = AntApp.useApp();
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

  /** 恢复默认：默认的按键可能已经给了别的快捷键 */
  const reset = () => {
    const problem = p.defaultValue && p.check(p.defaultValue);
    if (problem) message.error(problem);
    else save(p.defaultValue);
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
    const problem = e.metaKey ? "暂不支持 Win 键组合" : p.check(shortcut);
    if (problem) setHint(problem);
    else save(shortcut);
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (recording && !keyName(e.code)) setHeld(modifiers(e));
  };

  const box = (
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
          <span className="muted">{p.compact ? "按下组合键，Esc 取消" : "请按下新的快捷键，Esc 取消"}</span>
        )
      ) : p.value ? (
        <Keys parts={p.value.split("+")} />
      ) : (
        <span className="muted">{p.compact ? "不使用" : "未设置"}</span>
      )}
    </div>
  );
  const size = p.compact ? "small" : undefined;
  const resetButton = (
    <Button size={size} disabled={recording || p.value === p.defaultValue} onClick={reset}>
      恢复默认
    </Button>
  );
  const clearButton = (
    <Button size={size} disabled={recording || !p.value} onClick={() => save(null)}>
      不使用
    </Button>
  );
  const hints = (
    <>
      {recording && hint && <div className="setting-hint error-text">{hint}</div>}
      {!recording && p.warning && (
        <div className="setting-hint warning-text">
          <ExclamationCircleFilled /> {p.warning}
        </div>
      )}
    </>
  );

  if (p.compact) {
    return (
      <div className="shortcut-compact">
        <div className="setting-row">
          <span className="shortcut-name">
            {p.label}
            {p.note && <span className="shortcut-note muted">{p.note}</span>}
          </span>
          {box}
          {resetButton}
          {clearButton}
        </div>
        {hints}
      </div>
    );
  }

  return (
    <div className="setting-item">
      <div className="setting-label">{p.label}</div>
      {p.desc && <div className="setting-desc">{p.desc}</div>}
      <div className="setting-row">
        {box}
        <Button loading={saving} onMouseDown={(e) => e.preventDefault()} onClick={() => p.onRecording(!recording)}>
          {recording ? "取消" : "修改"}
        </Button>
        {resetButton}
        {clearButton}
      </div>
      {hints}
    </div>
  );
}
