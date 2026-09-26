import { CloudUploadOutlined, FolderOpenOutlined, ReloadOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Form, Input, Spin } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMsg } from "../api";
import { useSettings } from "../settings";
import type { RemoteBackup, SettingsInfo, WebDavConfig, WebDavInfo } from "../types";
import { fullTime } from "../utils";

type FormValues = WebDavConfig & { password: string };

/** 本地备份包大小上限，与 Rust 端一致；设置备份只有几 KB */
const MAX_FILE_BYTES = 1024 * 1024;

const formatSize = (n: number | null) => (n == null ? "" : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/** 设置里的「备份与恢复」：WebDAV 连接、立即备份、从 WebDAV 或本地 zip 恢复 */
export default function BackupSettings() {
  const { message, modal } = AntApp.useApp();
  const { setInfo } = useSettings();
  const [form] = Form.useForm<FormValues>();
  const [saved, setSaved] = useState<WebDavInfo | null>(null);
  const [values, setValues] = useState<FormValues | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | "backup" | null>(null);
  const [backups, setBackups] = useState<RemoteBackup[] | null>(null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshList = useCallback(async () => {
    setListing(true);
    setListError("");
    try {
      setBackups(await api.listWebdavBackups());
    } catch (e) {
      setListError(errMsg(e));
    } finally {
      setListing(false);
    }
  }, []);

  const applySaved = useCallback(
    (info: WebDavInfo) => {
      const v = { ...info.config, password: "" };
      setSaved(info);
      form.setFieldsValue(v);
      setValues(v);
    },
    [form],
  );

  useEffect(() => {
    api
      .getWebdav()
      .then((info) => {
        applySaved(info);
        if (info.config.url) refreshList();
      })
      .catch((e) => message.error(errMsg(e)));
  }, [applySaved, refreshList, message]);

  const configOf = (v: FormValues): WebDavConfig => ({ url: v.url ?? "", username: v.username ?? "", dir: v.dir ?? "" });
  const dirty =
    !!saved &&
    !!values &&
    ((values.url ?? "").trim() !== saved.config.url ||
      (values.username ?? "").trim() !== saved.config.username ||
      (values.dir ?? "").trim() !== saved.config.dir ||
      !!values.password);

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  /** 保存界面上的配置；没改过就什么都不做 */
  const save = async () => {
    if (!dirty || !values) return;
    const info = await api.saveWebdav(configOf(values), values.password || null);
    applySaved(info);
    return info;
  };

  const onTest = () =>
    run("test", async () => {
      if (!values) return;
      message.success(await api.testWebdav(configOf(values), values.password || null));
    });

  const onSave = () =>
    run("save", async () => {
      const info = await save();
      message.success("WebDAV 设置已保存");
      if (info?.config.url) refreshList();
      else setBackups(null);
    });

  const onBackup = () =>
    run("backup", async () => {
      await save();
      const name = await api.backupToWebdav();
      message.success(`已备份到 WebDAV：${name}`);
      refreshList();
    });

  const restored = (info: SettingsInfo) => {
    setInfo(info);
    const shortcut = info.settings.toggleShortcut;
    if (shortcut && !info.toggleShortcutRegistered)
      message.warning(`设置已恢复，但全局快捷键 ${shortcut} 被其他程序占用，请在「快捷键」里换一个`);
    else message.success("设置已恢复");
  };

  const confirmRestore = (what: string, doRestore: () => Promise<SettingsInfo>) =>
    modal.confirm({
      title: "恢复设置？",
      content: `将用${what}覆盖当前的设置（快捷键等），待办数据不受影响。`,
      okText: "恢复",
      cancelText: "取消",
      onOk: async () => {
        try {
          restored(await doRestore());
        } catch (e) {
          message.error(errMsg(e));
        }
      },
    });

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许再次选择同一个文件
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      message.error("文件超过 1 MB，不是本软件的设置备份");
      return;
    }
    confirmRestore(`本地文件「${file.name}」`, async () =>
      api.restoreFromFile(new Uint8Array(await file.arrayBuffer())),
    );
  };

  const configured = !!saved?.config.url;

  let list: React.ReactNode;
  if (!configured) list = <div className="backup-empty muted">填写并保存 WebDAV 服务器后，这里会列出服务器上的备份</div>;
  else if (listError)
    list = (
      <div className="backup-empty error-text">
        {listError}
        <Button type="link" size="small" onClick={refreshList}>
          重试
        </Button>
      </div>
    );
  else if (!backups) list = <div className="backup-empty"><Spin size="small" /></div>;
  else if (!backups.length) list = <div className="backup-empty muted">服务器上还没有备份</div>;
  else
    list = (
      <div className="backup-list">
        {backups.map((b) => (
          <div className="backup-item" key={b.name}>
            <div className="backup-info">
              <div className="backup-time">{fullTime(b.time)}</div>
              <div className="backup-name muted" title={b.name}>
                {b.name}
                {b.size != null && <span className="sep">·</span>}
                {formatSize(b.size)}
              </div>
            </div>
            <Button size="small" onClick={() => confirmRestore(` ${fullTime(b.time)} 的备份`, () => api.restoreFromWebdav(b.name))}>
              恢复
            </Button>
          </div>
        ))}
      </div>
    );

  return (
    <>
      <div className="setting-group">WebDAV 服务器</div>
      <div className="setting-desc">
        坚果云地址为 https://dav.jianguoyun.com/dav/，密码填「第三方应用管理」里生成的应用密码；远程目录不存在时自动创建。
      </div>
      <Form
        form={form}
        className="webdav-form"
        labelCol={{ flex: "82px" }}
        autoComplete="off"
        onValuesChange={(_, all) => setValues(all)}
      >
        <Form.Item label="服务器地址" name="url" className="webdav-wide">
          <Input placeholder="https://dav.jianguoyun.com/dav/" />
        </Form.Item>
        <Form.Item label="用户名" name="username">
          <Input placeholder="坚果云为登录邮箱" />
        </Form.Item>
        <Form.Item label="密码" name="password" labelCol={{ flex: "none" }}>
          <Input.Password
            autoComplete="new-password"
            placeholder={saved?.hasPassword ? "已保存，不修改请留空" : "密码或应用密码"}
          />
        </Form.Item>
        <Form.Item label="远程目录" name="dir">
          <Input placeholder="TodoList" />
        </Form.Item>
        <div className="webdav-actions">
          <Button loading={busy === "test"} disabled={!values?.url?.trim()} onClick={onTest}>
            测试连接
          </Button>
          <Button type="primary" loading={busy === "save"} disabled={!dirty} onClick={onSave}>
            保存
          </Button>
        </div>
      </Form>

      <div className="setting-group backup-head">
        <span>备份与恢复</span>
        <span className="backup-tools">
          {configured && (
            <Button type="text" size="small" icon={<ReloadOutlined />} loading={listing} onClick={refreshList}>
              刷新
            </Button>
          )}
          <Button type="text" size="small" icon={<FolderOpenOutlined />} onClick={() => fileRef.current?.click()}>
            从本地文件恢复…
          </Button>
        </span>
      </div>
      <div className="backup-bar">
        <Button
          type="primary"
          icon={<CloudUploadOutlined />}
          loading={busy === "backup"}
          disabled={!values?.url?.trim()}
          onClick={onBackup}
        >
          立即备份到 WebDAV
        </Button>
        <span className="setting-desc">只含快捷键等设置（.settings.json），不含待办数据和密码</span>
      </div>
      {list}
      <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={onPickFile} />
    </>
  );
}
