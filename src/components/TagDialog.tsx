import { CloseOutlined } from "@ant-design/icons";
import { App as AntApp, Modal, Select, type RefSelectProps } from "antd";
import { useCallback, useRef, useState } from "react";
import { errMsg } from "../api";
import { cleanTag, hasTag, sameTag, tagClass } from "../tags";

/** 下拉里列出的一个标签，note 是后面的说明（如「12 条」） */
export interface TagOption {
  name: string;
  note?: string;
}

interface Options {
  title: string;
  label?: string;
  /** 打开时已经选着的 */
  initial: readonly string[];
  options: readonly TagOption[];
  /** 能输入新的标签（改一条待办的标签、批量添加）；false 时只能从 options 里选（批量移除） */
  creatable: boolean;
  /** 至少要选一个（批量添加、移除） */
  required?: boolean;
  okText?: string;
  /** 抛出的错误显示在选择框下方，对话框保持打开 */
  onSubmit: (tags: string[]) => Promise<void>;
}

/**
 * 选标签的对话框（右键待办「标签…」、批量添加 / 移除标签）：antd Select 的 tags 模式，输入新的（逗号也算分隔，
 * 不合规则的不加、提示原因）、从用过的里选、点 × 去掉，不区分大小写地去重（输入的和用过的只差大小写时用用过的写法）。
 * 返回 [要渲染的节点, 打开函数]
 */
export function useTagDialog(): [React.ReactNode, (opts: Options) => void] {
  const { message } = AntApp.useApp();
  const [opts, setOpts] = useState<Options | null>(null);
  const [value, setValue] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const selectRef = useRef<RefSelectProps>(null);

  const open = useCallback((o: Options) => {
    setOpts(o);
    setValue([...o.initial]);
    setError("");
    setLoading(false);
  }, []);

  const close = () => setOpts(null);

  /** 选择框改了：新输入的规整一下，和用过的只差大小写时用用过的写法，去重 */
  const change = (next: string[]) => {
    const out: string[] = [];
    for (const raw of next) {
      let tag = raw;
      if (!value.includes(raw)) {
        const r = cleanTag(raw);
        if ("error" in r) {
          message.warning(`「${raw.trim()}」没有加上：${r.error}`);
          continue;
        }
        tag = opts?.options.find((o) => sameTag(o.name, r.tag))?.name ?? r.tag;
      }
      if (!hasTag(out, tag)) out.push(tag);
    }
    setValue(out);
    setError("");
  };

  const submit = async () => {
    if (!opts || loading) return;
    if (opts.required && !value.length) {
      setError("请选择标签");
      return;
    }
    setLoading(true);
    try {
      await opts.onSubmit(value);
      close();
    } catch (e) {
      setError(errMsg(e));
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
      width={460}
      afterOpenChange={(visible) => {
        if (visible) selectRef.current?.focus();
      }}
    >
      {opts?.label && <div className="dialog-label">{opts.label}</div>}
      <Select
        ref={selectRef}
        className="tag-select"
        mode={opts?.creatable ? "tags" : "multiple"}
        value={value}
        onChange={change}
        tokenSeparators={opts?.creatable ? [",", "，"] : undefined}
        placeholder={opts?.creatable ? "输入标签后按 Enter，或从下面选" : "选择要去掉的标签"}
        status={error ? "error" : undefined}
        options={opts?.options.map((o) => ({
          value: o.name,
          label: (
            <span className="tag-option">
              <span className={tagClass(o.name)}>{o.name}</span>
              {o.note && <span className="muted">{o.note}</span>}
            </span>
          ),
        }))}
        tagRender={({ value: v, closable, onClose }) => (
          <span
            className={`${tagClass(String(v))} closable select-chip`}
            // 点 × 时不打开下拉
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {String(v)}
            {closable && <CloseOutlined className="tag-close" onClick={onClose} />}
          </span>
        )}
        notFoundContent={opts?.creatable ? null : "选中的待办都没有标签"}
        style={{ width: "100%" }}
      />
      <div className="dialog-error">{error}</div>
    </Modal>
  );

  return [node, open];
}
