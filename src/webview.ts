// 主窗口和快速记录小窗共用：屏蔽 WebView 里网页相关的默认行为

/** 只在输入框和正文编辑器里保留系统右键菜单（复制 / 粘贴），其他地方用应用自己的菜单；屏蔽刷新、打印、查找、缩放重置等浏览器快捷键 */
export function blockBrowserDefaults() {
  document.addEventListener("contextmenu", (e) => {
    if (!(e.target as HTMLElement).closest("input, textarea, [contenteditable='true']")) e.preventDefault();
  });
  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (
      e.key === "F5" ||
      e.key === "F3" ||
      e.key === "F7" ||
      (ctrl && ["r", "p", "g", "j", "u", "h", "f", "n", "s", "o"].includes(key)) ||
      (ctrl && e.shiftKey && key === "r")
    ) {
      e.preventDefault();
    }
  });
}
