import { CloseOutlined, FlagFilled, FlagOutlined, PlusOutlined } from "@ant-design/icons";
import { App as AntApp, AutoComplete, Select } from "antd";
import { useRef, useState } from "react";
import { PRIORITIES, priorityText } from "../priority";
import { tagHit } from "../search";
import { cleanTag, hasTag, suggestTags, tagClass, type TagCount, visibleTags } from "../tags";
import type { Priority } from "../types";

// 待办标题旁边的标记：优先级的小旗子、标签（tag，和右侧的标签页不是一回事）

/** 优先级的小旗子：高红、中橙、低蓝（浅色、深色各一套，在 styles.css 里），无优先级时什么都不显示 */
export function PriorityFlag({ priority }: { priority: Priority }) {
  if (!priority) return null;
  return <FlagFilled className={`prio-flag prio-${priority}`} title={priorityText(priority)} aria-label={priorityText(priority)} />;
}

/** 选优先级用的一项：小旗子和文字（无优先级是空心的灰旗子） */
export function PriorityLabel({ priority }: { priority: Priority }) {
  return (
    <span className="prio-label">
      {priority ? <FlagFilled className={`prio-flag prio-${priority}`} /> : <FlagOutlined className="prio-flag prio-0" />}
      {priorityText(priority)}
    </span>
  );
}

/** 编辑区上方元信息一行里的优先级下拉 */
export function PrioritySelect({ value, onChange }: { value: Priority; onChange: (p: Priority) => void }) {
  return (
    <Select
      className="prio-select"
      size="small"
      variant="borderless"
      value={value}
      onChange={onChange}
      popupMatchSelectWidth={false}
      options={PRIORITIES.map((p) => ({ value: p, label: <PriorityLabel priority={p} /> }))}
    />
  );
}

/**
 * 待办标题后面的标签：放不下时只显示前 max 个，后面是「+N」（悬停看全部）；搜索时名字里有关键字的加一圈描边
 * （藏在「+N」里的命中时描「+N」）。侧栏的行很多，这里只用普通元素，不用 antd 的 Tag、Tooltip
 */
export function TagChips({
  tags,
  max,
  keyword = "",
}: {
  tags: readonly string[];
  max: number;
  /** 搜索的关键字（search.ts 的 tagHit 判断哪些命中） */
  keyword?: string;
}) {
  if (!tags.length) return null;
  const { shown, rest } = visibleTags(tags, max);
  const restHit = rest > 0 && tags.slice(shown.length).some((t) => tagHit(t, keyword));
  return (
    <span className="tag-list">
      {shown.map((tag) => (
        <span key={tag} className={`${tagClass(tag)}${tagHit(tag, keyword) ? " hit" : ""}`} title={tag}>
          {tag}
        </span>
      ))}
      {rest > 0 && (
        <span className={`tag-chip tag-more${restHit ? " hit" : ""}`} title={`标签：${tags.join("、")}`}>
          +{rest}
        </span>
      )}
    </span>
  );
}

/**
 * 编辑区上方元信息一行里的标签：每个上面有 ×（去掉）；「+ 标签」点开输入框，Enter 加上（输入框留着接着加），
 * Esc、点到别处收起；输入时从 allTags（侧栏里显示的工作区用过的）里联想，↑↓ 选、Enter 或点一下加上。
 * onChange 收到全部标签，存好了返回 true（没存好的已经提示过）
 */
export function TagEditor({
  tags,
  allTags,
  onChange,
}: {
  tags: readonly string[];
  allTags: readonly TagCount[];
  onChange: (tags: string[]) => Promise<boolean>;
}) {
  const { message } = AntApp.useApp();
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  // Enter 选中了下拉里的一项（onSelect 先于 onKeyDown）：这次 Enter 不再把输入的字加上
  const picked = useRef(false);

  const add = async (raw: string) => {
    const r = cleanTag(raw);
    if ("error" in r) {
      message.warning(r.error);
      return;
    }
    if (hasTag(tags, r.tag)) {
      message.info(`已经有标签「${r.tag}」了`);
      setInput("");
      return;
    }
    if (await onChange([...tags, r.tag])) setInput("");
  };

  const close = () => {
    setAdding(false);
    setInput("");
  };

  return (
    <span className="tag-editor">
      {tags.map((tag) => (
        <span key={tag} className={`${tagClass(tag)} closable`} title={tag}>
          {tag}
          <CloseOutlined
            className="tag-close"
            aria-label={`去掉标签「${tag}」`}
            onClick={() => onChange(tags.filter((t) => t !== tag))}
          />
        </span>
      ))}
      {adding ? (
        <AutoComplete
          className="tag-input"
          size="small"
          autoFocus
          // 一打开就列出最常用的
          defaultOpen
          // 默认不选中下拉的第一项：Enter 加上的是输入的字，按了 ↑↓ 才是选中的那项
          defaultActiveFirstOption={false}
          placeholder="输入标签，Enter 加上"
          value={input}
          options={suggestTags(allTags, input, tags).map((t) => ({ value: t, label: <span className={tagClass(t)}>{t}</span> }))}
          onChange={setInput}
          onSelect={(v: string) => {
            // 用鼠标点的后面没有 Enter：过了这一下就不算
            picked.current = true;
            window.setTimeout(() => (picked.current = false));
            add(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!picked.current && input.trim()) add(input);
            }
          }}
          onBlur={close}
        />
      ) : (
        <span className="tag-add" role="button" onClick={() => setAdding(true)}>
          <PlusOutlined /> 标签
        </span>
      )}
    </span>
  );
}
