import { EditOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Input, Select, type InputRef } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import {
  matchTarget,
  parseTargetKey,
  readDraft,
  submitKey,
  targetExists,
  targetKey,
  targetLabel,
  targetOptions,
  writeDraft,
} from "../quickCapture";
import { shortcutLabel } from "../shortcuts";
import type { QuickTarget, ThemeMode, WorkspaceProjects } from "../types";

/**
 * 快速记录小窗（单独的窗口，按全局快捷键或托盘菜单弹出）：写一段文字，第一行当标题、其余当正文，
 * Enter 存到选好的项目里，Ctrl+Enter 存好后在主窗口里打开。Esc、点到别处时藏起来，没存的草稿留着
 */
export default function QuickCapture({ onTheme }: { onTheme: (mode: ThemeMode) => void }) {
  const { message } = AntApp.useApp();
  const [text, setText] = useState(readDraft);
  const [target, setTarget] = useState<QuickTarget | null>(null);
  const [list, setList] = useState<WorkspaceProjects[]>([]);
  const [shortcut, setShortcut] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<TextAreaRef>(null);
  const savingRef = useRef(false);

  const focusInput = () => {
    (inputRef.current as InputRef | null)?.focus({ cursor: "end" });
  };

  // 每次弹出时重新读：设置（主题、存到哪里、快捷键）可能在主窗口里改过，项目可能增删改名过
  const refresh = useCallback(async () => {
    try {
      const [info, projects] = await Promise.all([api.getSettings(), api.listProjects()]);
      onTheme(info.settings.theme);
      setTarget(info.settings.quickCaptureTarget);
      setShortcut(info.settings.quickCaptureShortcut);
      setList(projects);
    } catch (e) {
      message.error(errMsg(e));
    }
  }, [onTheme, message]);

  useEffect(() => {
    // refresh 里的 setState 都在 await 之后
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const pending = [
      getCurrentWebviewWindow().listen("quick-capture-shown", () => {
        refresh();
        focusInput();
      }),
      // 点到别处（失去焦点）时藏起来；正在保存时不管，保存完 Rust 端会藏
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused && !savingRef.current) api.hideQuickCapture().catch(() => {});
      }),
    ];
    return () => {
      pending.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, [refresh]);

  const changeText = (v: string) => {
    setText(v);
    writeDraft(v);
  };

  const changeTarget = (key: string) => {
    const t = parseTargetKey(key);
    setTarget(t);
    api.setQuickCaptureTarget(t).catch((e) => message.error(errMsg(e)));
    focusInput();
  };

  const save = async (open: boolean) => {
    if (savingRef.current || !target) return;
    if (!text.trim()) {
      message.info("先写点什么再保存");
      focusInput();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await api.quickCapture(text, target, open);
      changeText("");
    } catch (e) {
      message.error(`保存失败：${errMsg(e)}`);
      focusInput();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const action = submitKey(e.nativeEvent);
    if (!action) return;
    e.preventDefault();
    save(action === "open");
  };

  // Esc 藏起来（下拉框打开着时先关下拉框）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || document.querySelector(".ant-select-open")) return;
      e.preventDefault();
      api.hideQuickCapture().catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isNew = !!target && list.length > 0 && !targetExists(list, target);

  return (
    <div className="quick">
      <header className="quick-head" data-tauri-drag-region>
        <span className="quick-title" data-tauri-drag-region>
          <EditOutlined /> 快速记录
          {shortcut && <span className="quick-shortcut">{shortcutLabel(shortcut)}</span>}
        </span>
        <span className="quick-target-label">存到</span>
        <Select
          className="quick-target"
          size="small"
          showSearch={{ filterOption: matchTarget }}
          value={target ? targetKey(target) : undefined}
          options={targetOptions(list, target)}
          optionRender={(o) => <span title={o.data.title}>{o.label}</span>}
          labelRender={() => (target ? targetLabel(target) : "")}
          listHeight={150}
          popupMatchSelectWidth={false}
          placement="bottomRight"
          onChange={changeTarget}
          // 选完、按 Esc 关掉下拉框后接着打字
          onOpenChange={(open) => !open && focusInput()}
          title={isNew ? "这个项目还不在，保存时新建" : undefined}
        />
      </header>
      <Input.TextArea
        ref={inputRef}
        className="quick-input"
        autoFocus
        variant="borderless"
        placeholder={"写下要记的事：第一行是标题，后面是正文（支持 Markdown）"}
        value={text}
        disabled={saving}
        onChange={(e) => changeText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <footer className="quick-foot">
        <span className="quick-hint" title="Enter 保存，Shift+Enter 换行，Ctrl+Enter 保存并在主窗口里打开，Esc 关闭（没存的留着）">
          Enter 保存 · Shift+Enter 换行 · Ctrl+Enter 保存并打开 · Esc 关闭
        </span>
        <Button size="small" disabled={saving} onClick={() => save(true)}>
          保存并打开
        </Button>
        <Button size="small" type="primary" loading={saving} onClick={() => save(false)}>
          保存
        </Button>
      </footer>
    </div>
  );
}
