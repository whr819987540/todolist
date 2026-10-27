import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";

/**
 * 恢复待办数据期间（dataBackup.ts 的 restoreData）：数据目录里的工作区正被整个换掉，监听到的变化（data-changed）、
 * 快速记录要打开刚记下的待办（open-todo，打开前先重新加载）、窗口获得焦点（分屏两边的编辑区、侧栏、首页都是经
 * useWindowFocus 收的）、F5 都不刷新，免得读到换掉之后、整页重新加载之前的数据，报「工作区不存在」、关掉标签、退回首页。
 * 恢复成功后整页重新加载（这里跟着重来）；失败时（数据没换）放开
 */
let refreshHeld = false;

/** 恢复待办数据期间不交给回调的事件（都会从磁盘重新读） */
const HELD_EVENTS: ReadonlySet<string> = new Set(["data-changed", "open-todo"]);

export function holdDataRefresh(held: boolean) {
  refreshHeld = held;
}

/** 现在是不是在恢复待办数据、不刷新（见 holdDataRefresh） */
export const dataRefreshHeld = () => refreshHeld;

/** 窗口获得/失去焦点时回调（从外部编辑器切回来时用于刷新）；恢复待办数据期间获得焦点的不回调 */
export function useWindowFocus(onChange: (focused: boolean) => void) {
  const ref = useRef(onChange);
  useEffect(() => {
    ref.current = onChange;
  });
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onFocusChanged(({ payload }) => {
        if (payload && refreshHeld) return;
        ref.current(payload);
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/**
 * 从资源管理器往窗口里拖文件：enter（拖进窗口，带着文件的路径）、over（拖着移动）、drop（放下）、leave（拖出去、取消）。
 * x、y 是视口里的位置（CSS 像素）
 */
export type FileDrag =
  | { type: "enter" | "drop"; paths: string[]; x: number; y: number }
  | { type: "over"; x: number; y: number }
  | { type: "leave" };

/**
 * 从资源管理器拖进窗口的文件。Tauri 在 Windows 上接管了系统的拖放（网页里的 drop 事件拿不到文件），经它的事件拿到路径
 * 和位置；侧栏里拖动待办、项目是自己用鼠标事件做的，不受影响
 */
export function useFileDrag(onDrag: (e: FileDrag) => void) {
  const ref = useRef(onDrag);
  useEffect(() => {
    ref.current = onDrag;
  });
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent(({ payload: p }) => {
        if (p.type === "leave") return ref.current({ type: "leave" });
        // Tauri 给的是窗口里的物理像素
        const { x, y } = p.position.toLogical(window.devicePixelRatio);
        ref.current(p.type === "over" ? { type: "over", x, y } : { type: p.type, paths: p.paths, x, y });
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/** 前端自己发的事件（emitAppEvent）在 window 上的名字 */
const localEvent = (name: string) => `app-event:${name}`;

/**
 * 收到 Rust 端发给这个窗口的事件时回调，如 data-changed（数据目录在外部变了，带着变了什么，见 watch.ts；
 * 快速记录存好后等也发，不带内容）、open-todo（打开刚记下的待办）；前端自己用 emitAppEvent 发的同名事件也收。
 * 恢复待办数据期间 data-changed、open-todo 不回调（见 holdDataRefresh）
 */
export function useAppEvent<T>(name: string, onEvent: (payload: T) => void) {
  const ref = useRef(onEvent);
  useEffect(() => {
    ref.current = onEvent;
  });
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const deliver = (payload: T) => {
      if (refreshHeld && HELD_EVENTS.has(name)) return;
      ref.current(payload);
    };
    getCurrentWebviewWindow()
      .listen<T>(name, (e) => deliver(e.payload))
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    const onLocal = (e: Event) => deliver((e as CustomEvent<T>).detail);
    window.addEventListener(localEvent(name), onLocal);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener(localEvent(name), onLocal);
    };
  }, [name]);
}

/**
 * 在这个窗口里发一个 useAppEvent 收得到的事件，不经过 Rust 端。例如离开一条待办时存不上、另存成了新待办：
 * 发 data-changed，正显示着的首页或工作区视图刷新（那时编辑器已经卸载了，不能再经它通知外层）
 */
export function emitAppEvent(name: string, payload?: unknown) {
  window.dispatchEvent(new CustomEvent(localEvent(name), { detail: payload }));
}

// ----- 隐藏到托盘、退出前把未保存的内容写盘 -----

interface Flusher {
  /**
   * quitting：从托盘退出前（正在编辑的待办这时存不上的另存为新待办）。
   * 返回 false 表示有修改存不下来（已经提示过）；其他返回值都算存好了
   */
  flush: (quitting: boolean) => Promise<unknown>;
  /** 正在编辑的待办：隐藏到托盘时受 auto save 开关管；设置等其他内容总是直接写盘 */
  todo: boolean;
}

const flushers = new Set<Flusher>();

export function registerFlusher(flush: (quitting: boolean) => Promise<unknown>, todo = false): () => void {
  const f = { flush, todo };
  flushers.add(f);
  return () => {
    flushers.delete(f);
  };
}

/** 写盘；todos 为 false 时不管正在编辑的待办（auto save 关闭时隐藏到托盘） */
export async function flushAll(todos = true, timeoutMs = 3000): Promise<void> {
  const list = [...flushers].filter((f) => todos || !f.todo);
  await Promise.race([
    Promise.allSettled(list.map((f) => f.flush(false))),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * 打开着的待办都立即存盘（分屏时两边的：每条打开着的待办一个会话，两边开着同一条时共用一个），返回是否都存好了：
 * 有存不上的（弹出了冲突对话框、保存失败已提示）或 timeoutMs 内没存完时为 false。没有打开着的待办时为 true。
 * 恢复待办数据前用：存不上时不恢复（同改名、移动、删除前的 saveFirst）
 */
export async function flushTodos(timeoutMs: number): Promise<boolean> {
  const list = [...flushers].filter((f) => f.todo);
  const all = Promise.allSettled(list.map((f) => f.flush(false))).then((rs) =>
    rs.every((r) => r.status === "fulfilled" && r.value !== false),
  );
  let timer = 0;
  const timeout = new Promise<boolean>((resolve) => {
    timer = window.setTimeout(() => resolve(false), timeoutMs);
  });
  const ok = await Promise.race([all, timeout]);
  window.clearTimeout(timer);
  return ok;
}

/**
 * 从托盘退出前最多等这么久（ms）：正在编辑的待办存不上时还要另存为新待办，平时几十毫秒就做完了。
 * 超时了不退出（问用户），免得把正在另存的内容截断
 */
export const QUIT_FLUSH_TIMEOUT = 10_000;

/** 退出前写盘的结果：都存好了、有存不下来的（已经提示过）、timeoutMs 内没存完 */
export type QuitFlush = "saved" | "failed" | "timeout";

/**
 * 从托盘退出、自动更新前写盘没存好（flushBeforeQuit 的结果不是 saved）时，问还要不要接着做的确认框里写什么；
 * action 是要接着做的事
 */
export function unsavedWarning(r: Exclude<QuitFlush, "saved">, action: "退出" | "更新"): { title: string; content: string } {
  return r === "failed"
    ? { title: "有修改没能保存", content: `正在编辑的待办里有修改没能保存下来（见上方的提示），现在${action}会丢掉这些修改。` }
    : {
        title: "还没保存完",
        content: `正在编辑的内容 ${QUIT_FLUSH_TIMEOUT / 1000} 秒内没有保存完，现在${action}可能丢掉还没保存的修改。`,
      };
}

/** 从托盘退出前写盘：都写，正在编辑的待办存不上的另存为新待办（见 TodoEditor 的 leave） */
export async function flushBeforeQuit(timeoutMs = QUIT_FLUSH_TIMEOUT): Promise<QuitFlush> {
  const list = [...flushers];
  const all = (async (): Promise<QuitFlush> => {
    // 先存正在编辑的待办：另存为新待办时会记下新待办的编辑位置、编辑模式，界面状态要在这之后写
    const todos = await Promise.allSettled(list.filter((f) => f.todo).map((f) => f.flush(true)));
    const rest = await Promise.allSettled(list.filter((f) => !f.todo).map((f) => f.flush(true)));
    return [...todos, ...rest].some((r) => r.status === "rejected" || r.value === false) ? "failed" : "saved";
  })();
  let timer = 0;
  const timeout = new Promise<QuitFlush>((resolve) => {
    timer = window.setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const result = await Promise.race([all, timeout]);
  window.clearTimeout(timer);
  return result;
}
