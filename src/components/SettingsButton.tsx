import { ExclamationCircleFilled, SettingOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Modal, Tooltip } from "antd";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import type { ShortcutInfo } from "../types";

/** 设置按钮，点击打开设置对话框 */
export default function SettingsButton({ type = "default" }: { type?: "default" | "text" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip title="设置">
        <Button type={type} icon={<SettingOutlined />} onClick={() => setOpen(true)} />
      </Tooltip>
      <Modal open={open} title="设置" footer={null} width={520} destroyOnHidden onCancel={() => setOpen(false)}>
        <ShortcutSetting />
      </Modal>
    </>
  );
}

// ----- 全局快捷键 -----

/** 可以作为主键的按键：字母、数字、F1~F24、小键盘数字和下列按键（名称与 KeyboardEvent.code 一致） */
const NAMED_KEYS = new Set([
  "Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote",
  "Comma", "Period", "Slash", "Space", "Enter", "Tab", "Backspace", "Delete", "Insert", "Home", "End",
  "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal",
]);

/** KeyboardEvent.code → 保存用的键名（Rust 端 global-hotkey 能解析的写法）；修饰键等返回 null */
function keyName(code: string): string | null {
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(code);
  if (m) return m[1] ?? m[2];
  if (/^(?:F(?:[1-9]|1\d|2[0-4])|Numpad\d)$/.test(code) || NAMED_KEYS.has(code)) return code;
  return null;
}

const KEY_LABELS: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  NumpadAdd: "Num +", NumpadSubtract: "Num -", NumpadMultiply: "Num *", NumpadDivide: "Num /", NumpadDecimal: "Num .",
};

const keyLabel = (k: string) => KEY_LABELS[k] ?? k.replace(/^Numpad(\d)$/, "Num $1");

/** "Ctrl+Alt+T" → "Ctrl + Alt + T" */
const shortcutLabel = (s: string) => s.split("+").map(keyLabel).join(" + ");

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

function ShortcutSetting() {
  const { message } = AntApp.useApp();
  const [info, setInfo] = useState<ShortcutInfo | null>(null);
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const [hint, setHint] = useState("");
  const [saving, setSaving] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .getToggleShortcut()
      .then(setInfo)
      .catch((e) => message.error(errMsg(e)));
  }, [message]);

  // 录制期间暂停全局快捷键，否则按下当前快捷键会直接把窗口藏起来；结束录制或关闭对话框时恢复
  useEffect(() => {
    if (!recording) return;
    setHeld([]);
    setHint("");
    boxRef.current?.focus();
    api.pauseToggleShortcut(true).catch(() => {});
    return () => {
      api.pauseToggleShortcut(false).catch(() => {});
    };
  }, [recording]);

  const save = async (shortcut: string | null) => {
    setSaving(true);
    try {
      setInfo(await api.setToggleShortcut(shortcut));
      message.success(shortcut ? `快捷键已设置为 ${shortcutLabel(shortcut)}` : "已关闭全局快捷键");
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setSaving(false);
      setRecording(false);
    }
  };

  const modifiers = (e: React.KeyboardEvent) =>
    [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter((x): x is string => !!x);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    // 不让按键触发页面上的其他快捷键（Ctrl+N 新建等）或关闭对话框
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || saving) return;
    const mods = modifiers(e);
    if (e.key === "Escape" && mods.length === 0) {
      setRecording(false);
      return;
    }
    const key = keyName(e.code);
    setHeld(key ? [...mods, key] : mods);
    if (!key) return;
    if (e.metaKey) setHint("暂不支持 Win 键组合");
    else if (!e.ctrlKey && !e.altKey) setHint("需要包含 Ctrl 或 Alt，例如 Ctrl + Alt + T");
    else save([...mods, key].join("+"));
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (recording && !keyName(e.code)) setHeld(modifiers(e));
  };

  if (!info) return <div className="setting-item" />;

  const shortcut = info.shortcut;
  return (
    <div className="setting-item">
      <div className="setting-label">显示 / 隐藏主窗口</div>
      <div className="setting-desc">
        全局快捷键，在任何程序里都能用：主窗口在前台时隐藏到系统托盘，否则调到前台。
      </div>
      <div className="setting-row">
        <div
          ref={boxRef}
          tabIndex={0}
          className={`shortcut-box${recording ? " recording" : ""}`}
          onClick={() => setRecording(true)}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => setRecording(false)}
        >
          {recording ? (
            held.length ? (
              <Keys parts={held} />
            ) : (
              <span className="muted">请按下新的快捷键，Esc 取消</span>
            )
          ) : shortcut ? (
            <Keys parts={shortcut.split("+")} />
          ) : (
            <span className="muted">未设置</span>
          )}
        </div>
        <Button
          loading={saving}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setRecording(!recording)}
        >
          {recording ? "取消" : "修改"}
        </Button>
        <Button disabled={recording || shortcut === info.defaultShortcut} onClick={() => save(info.defaultShortcut)}>
          恢复默认
        </Button>
        <Button disabled={recording || !shortcut} onClick={() => save(null)}>
          不使用
        </Button>
      </div>
      {recording && hint && <div className="setting-hint error-text">{hint}</div>}
      {!recording && shortcut && !info.registered && (
        <div className="setting-hint warning-text">
          <ExclamationCircleFilled /> 快捷键 {shortcutLabel(shortcut)} 未生效，可能已被其他程序占用，请换一个
        </div>
      )}
    </div>
  );
}
