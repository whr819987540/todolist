import { App as AntApp, Button, Popconfirm } from "antd";
import { Fragment, useEffect, useState } from "react";
import { api, errMsg } from "../../api";
import {
  CONFIGURABLE_EDIT_SHORTCUTS,
  type EditCommandId,
  EDIT_SHORTCUT_GROUPS,
  EDIT_SHORTCUTS,
} from "../../editShortcuts";
import { useEditShortcuts, useSettings } from "../../settings";
import { checkShortcut, sameShortcut, shortcutLabel, type TakenShortcut } from "../../shortcuts";
import type { ShortcutAction } from "../../types";
import ShortcutRow, { Keys, type ShortcutRowProps } from "./ShortcutRow";

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

export default function ShortcutSettings() {
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
