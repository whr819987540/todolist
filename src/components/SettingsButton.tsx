import { SettingOutlined } from "@ant-design/icons";
import { Button, Modal, Tabs, Tooltip } from "antd";
import { useState, type ReactNode } from "react";
import AppearanceSettings from "./settings/AppearanceSettings";
import BackupSettings from "./settings/BackupSettings";
import GeneralSettings from "./settings/GeneralSettings";
import SaveSettings from "./settings/SaveSettings";
import ShortcutSettings from "./settings/ShortcutSettings";

/**
 * 标签页的内容区：几个标签页一样高（内容多的在里面滚动），切换时对话框不变高变矮。
 * 包一层自己的元素，不靠 antd 内部的类名（antd 6 把 .ant-tabs-content-holder 改了名，原来写在它上面的高度悄悄失效了）
 */
const pane = (content: ReactNode) => <div className="settings-pane">{content}</div>;

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
            { key: "general", label: "常规", children: pane(<GeneralSettings />) },
            { key: "shortcuts", label: "快捷键", children: pane(<ShortcutSettings />) },
            { key: "appearance", label: "外观", children: pane(<AppearanceSettings />) },
            { key: "save", label: "保存", children: pane(<SaveSettings />) },
            { key: "backup", label: "备份与恢复", children: pane(<BackupSettings />) },
          ]}
        />
      </Modal>
    </>
  );
}
