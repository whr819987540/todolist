// 注入页面的工具函数：在页面里执行（不是在 Node 里），挂在 window.__e2e 上，cdp.mjs 的 ev 在每段代码前取出来用

export function installPageHelpers() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 5000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const v = fn();
      if (v) return v;
      await sleep(50);
    }
    return null;
  };
  /** 侧栏里的一行：工作区、项目或待办 */
  const row = (ws, p, id) => document.querySelector(`.tree-row[data-sel='${JSON.stringify([ws, p ?? "", id ?? ""])}']`);
  /** 正文编辑器（CodeMirror 的 EditorView） */
  const view = () => document.querySelector(".cm-content")?.cmTile?.root?.view;
  /** 点侧栏里的待办，等正文加载好（测试数据里标题就是文件名） */
  const openTodo = async (ws, p, id) => {
    const r = await waitFor(() => row(ws, p, id));
    if (!r) return "no row " + id;
    r.click();
    await sleep(200);
    await waitFor(() => view() && view().state.doc.length > 0 && document.querySelector(".editor-title")?.value === id);
    await sleep(300);
    return "ok";
  };
  /** 打开着的右键菜单、下拉菜单里文字是 text 的一项 */
  const menuItem = (text) =>
    [
      ...document.querySelectorAll(
        ".ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item, .ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden) .ant-dropdown-menu-item, .ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-submenu-title",
      ),
    ].find((e) => e.textContent.trim() === text);
  /** 给 React 管着的输入框填值 */
  const setInput = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  /** antd 把两个汉字的按钮渲染成「保 存」，比较时去掉空格 */
  const button = (text, root = document) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent.split(" ").join("").includes(text));
  const invoke = (cmd, args = {}) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  /** 模拟窗口事件（获得 / 失去焦点、关闭请求、托盘退出）：只到前端，不经过 Rust 端的窗口处理 */
  const emit = (event) => invoke("plugin:event|emit", { event, payload: null });
  window.__e2e = { sleep, waitFor, row, view, openTodo, menuItem, setInput, button, invoke, emit };
}

/** 每段页面代码前面加上的：没装过（页面刷新过）就装上，再把工具函数取成局部变量 */
export const PRELUDE = `if (!window.__e2e) (${installPageHelpers.toString()})();
const { sleep, waitFor, row, view, openTodo, menuItem, setInput, button, invoke, emit } = window.__e2e;`;
