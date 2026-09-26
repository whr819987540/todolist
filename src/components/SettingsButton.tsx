import { ExclamationCircleFilled, SettingOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Modal, Tooltip } from "antd";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { useSettings } from "../settings";
import { checkShortcut, eventShortcut, keyLabel, keyName, modifiers, shortcutLabel } from "../shortcuts";
import type { AppSettings, ShortcutAction } from "../types";

/** 设置按钮，点击打开设置对话框 */
export default function SettingsButton({ type = "default" }: { type?: "default" | "text" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip title="设置">
        <Button type={type} icon={<SettingOutlined />} onClick={() => setOpen(true)} />
      </Tooltip>
      <Modal open={open} title="设置" footer={null} width={540} destroyOnHidden onCancel={() => setOpen(false)}>
        <ShortcutSettings />
      </Modal>
    </>
  );
}

const ITEMS: { action: ShortcutAction; field: keyof AppSettings; label: string; desc: string }[] = [
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
