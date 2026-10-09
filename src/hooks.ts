import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";

/** 窗口获得/失去焦点时回调（从外部编辑器切回来时用于刷新） */
export function useWindowFocus(onChange: (focused: boolean) => void) {
  const ref = useRef(onChange);
  useEffect(() => {
    ref.current = onChange;
  });
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onFocusChanged(({ payload }) => ref.current(payload))
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
 * 收到 Rust 端发给这个窗口的事件时回调，如快速记录存好后的 data-changed（数据变了，要刷新）、
 * open-todo（打开刚记下的待办）；前端自己用 emitAppEvent 发的同名事件也收
 */
export function useAppEvent<T>(name: string, onEvent: (payload: T) => void) {
  const ref = useRef(onEvent);
  useEffect(() => {
    ref.current = onEvent;
  });
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWebviewWindow()
      .listen<T>(name, (e) => ref.current(e.payload))
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    const onLocal = (e: Event) => ref.current((e as CustomEvent<T>).detail);
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
 * 从托盘退出前最多等这么久（ms）：正在编辑的待办存不上时还要另存为新待办，平时几十毫秒就做完了。
 * 超时了不退出（问用户），免得把正在另存的内容截断
 */
export const QUIT_FLUSH_TIMEOUT = 10_000;

/** 退出前写盘的结果：都存好了、有存不下来的（已经提示过）、timeoutMs 内没存完 */
export type QuitFlush = "saved" | "failed" | "timeout";

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
