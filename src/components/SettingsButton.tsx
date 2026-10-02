import { SettingOutlined } from "@ant-design/icons";
import { Button, Modal, Tabs, Tooltip } from "antd";
import { useState } from "react";
import AppearanceSettings from "./settings/AppearanceSettings";
import BackupSettings from "./settings/BackupSettings";
import GeneralSettings from "./settings/GeneralSettings";
import SaveSettings from "./settings/SaveSettings";
import ShortcutSettings from "./settings/ShortcutSettings";

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
