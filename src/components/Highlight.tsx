/** 把文字中出现的关键字（不区分大小写）标黄 */
export default function Highlight({ text, kw }: { text: string; kw: string }) {
  if (!kw) return <>{text}</>;
  const lower = text.toLowerCase();
  const k = kw.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  for (let j = lower.indexOf(k); j >= 0; j = lower.indexOf(k, i)) {
    parts.push(text.slice(i, j), <mark key={j}>{text.slice(j, j + k.length)}</mark>);
    i = j + k.length;
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}
