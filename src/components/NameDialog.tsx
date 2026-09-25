import { Input, Modal, type InputRef } from "antd";
import { useCallback, useRef, useState } from "react";
import { errMsg } from "../api";

interface Options {
  title: string;
  label?: string;
  placeholder?: string;
  initial?: string;
  okText?: string;
  /** 抛出的错误信息会显示在输入框下方，对话框保持打开 */
  onSubmit: (value: string) => Promise<void>;
}

/** 输入名称的对话框（新建 / 重命名工作区、项目等）。返回 [要渲染的节点, 打开函数] */
export function useNameDialog(): [React.ReactNode, (opts: Options) => void] {
  const [opts, setOpts] = useState<Options | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<InputRef>(null);

  const open = useCallback((o: Options) => {
    setOpts(o);
    setValue(o.initial ?? "");
    setError("");
    setLoading(false);
  }, []);

  const close = () => setOpts(null);

  const submit = async () => {
    if (!opts || loading) return;
    if (!value.trim()) {
      setError("名称不能为空");
      return;
    }
    setLoading(true);
    try {
      await opts.onSubmit(value);
      close();
    } catch (e) {
      setError(errMsg(e));
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  const node = (
    <Modal
      open={!!opts}
      title={opts?.title}
      okText={opts?.okText ?? "确定"}
      cancelText="取消"
      confirmLoading={loading}
      onOk={submit}
      onCancel={close}
      destroyOnHidden
      width={420}
      afterOpenChange={(visible) => {
        if (visible) inputRef.current?.focus({ cursor: "all" });
      }}
    >
      {opts?.label && <div className="dialog-label">{opts.label}</div>}
      <Input
        ref={inputRef}
        value={value}
        placeholder={opts?.placeholder}
        maxLength={64}
        showCount
        status={error ? "error" : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setError("");
        }}
        onPressEnter={submit}
      />
      <div className="dialog-error">{error}</div>
    </Modal>
  );

  return [node, open];
}
