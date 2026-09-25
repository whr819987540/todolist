/** 应用图标：蓝色圆角方块 + 清单勾选 */
export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4096ff" />
          <stop offset="1" stopColor="#0958d9" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#logo-bg)" />
      <path d="M15 22l5 5 9-10" fill="none" stroke="#fff" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="34" y="18" width="16" height="5" rx="2.5" fill="#fff" />
      <path d="M15 42l5 5 9-10" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="34" y="38" width="16" height="5" rx="2.5" fill="#fff" fillOpacity=".55" />
    </svg>
  );
}
