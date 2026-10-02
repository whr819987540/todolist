import { DownOutlined, HomeOutlined } from "@ant-design/icons";
import { Button, Checkbox, Popover } from "antd";
import { useState } from "react";
import { api } from "../../api";
import { avatarColor, compareName, firstChar } from "../../utils";

/** 侧栏顶部：选中要显示的工作区，可多选，勾选后立即显示 */
export default function WorkspacePicker(p: { selected: string[]; onChange: (list: string[]) => void; onHome: () => void }) {
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const chosen = new Set(p.selected);
  const only = p.selected.length === 1;

  const toggle = (name: string) => {
    if (!chosen.has(name)) p.onChange([...p.selected, name]);
    else if (!only) p.onChange(p.selected.filter((n) => n !== name));
  };

  const panel = (
    <div className="ws-picker">
      <div className="ws-picker-head">选中要显示的工作区（可多选）</div>
      <div className="ws-picker-list">
        {names.map((n) => {
          const checked = chosen.has(n);
          // 至少要显示一个工作区
          const locked = checked && only;
          return (
            <div
              key={n}
              className={`ws-picker-item${locked ? " locked" : ""}`}
              title={locked ? "至少要选中一个工作区" : undefined}
              onClick={() => toggle(n)}
            >
              <Checkbox className="ws-picker-check" checked={checked} disabled={locked} tabIndex={-1} />
              <span className="ws-avatar" style={{ background: avatarColor(n) }}>
                {firstChar(n)}
              </span>
              <span className="ws-picker-name">{n}</span>
              {!locked && (
                <a
                  className="ws-picker-only"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onChange([n]);
                    setOpen(false);
                  }}
                >
                  仅显示
                </a>
              )}
            </div>
          );
        })}
      </div>
      <div className="ws-picker-foot">
        <Button
          size="small"
          type="text"
          disabled={names.every((n) => chosen.has(n))}
          onClick={() => p.onChange(names)}
        >
          全选
        </Button>
        <Button
          size="small"
          type="text"
          icon={<HomeOutlined />}
          onClick={() => {
            setOpen(false);
            p.onHome();
          }}
        >
          返回首页
        </Button>
      </div>
    </div>
  );

  const [first] = p.selected;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o)
          api
            .listWorkspaces()
            .then((l) => setNames(l.map((w) => w.name).sort(compareName)))
            .catch(() => {});
      }}
      trigger="click"
      placement="bottomLeft"
      arrow={false}
      classNames={{ root: "ws-picker-pop" }}
      content={panel}
    >
      <button className="ws-switcher" title={`正在显示：${p.selected.join("、")}`}>
        {only ? (
          <>
            <span className="ws-avatar" style={{ background: avatarColor(first) }}>
              {firstChar(first)}
            </span>
            <span className="ws-switcher-name">{first}</span>
          </>
        ) : (
          <>
            <span className="ws-avatars">
              {p.selected.slice(0, 3).map((n) => (
                <span key={n} className="ws-avatar" style={{ background: avatarColor(n) }}>
                  {firstChar(n)}
                </span>
              ))}
            </span>
            <span className="ws-switcher-name">{p.selected.length} 个工作区</span>
          </>
        )}
        <DownOutlined className="muted" style={{ fontSize: 10 }} />
      </button>
    </Popover>
  );
}
