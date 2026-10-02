import { ExclamationCircleFilled } from "@ant-design/icons";
import { App as AntApp, Button } from "antd";
import { Fragment, useEffect, useRef, useState } from "react";
import { eventShortcut, keyLabel, keyName, modifiers } from "../../shortcuts";

export function Keys({ parts }: { parts: string[] }) {
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

export interface ShortcutRowProps {
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
export default function ShortcutRow(p: ShortcutRowProps) {
  const { message } = AntApp.useApp();
  const { recording } = p;
  const [held, setHeld] = useState<string[]>([]);
  const [hint, setHint] = useState("");
  const [saving, setSaving] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 开始录制时清掉上次留下的按键和提示，并把焦点放到按键框上（录制状态由外层管，可能由别的按钮开始）
  useEffect(() => {
    if (!recording) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
