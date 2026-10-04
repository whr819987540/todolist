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

/**
 * 收到 Rust 端发给这个窗口的事件时回调，如快速记录存好后的 data-changed（数据变了，要刷新）、
 * open-todo（打开刚记下的待办）
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
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [name]);
}

// ----- 隐藏到托盘、退出前把未保存的内容写盘 -----

interface Flusher {
  flush: () => Promise<unknown>;
  /** 正在编辑的待办：隐藏到托盘时受 auto save 开关管；设置等其他内容总是直接写盘 */
  todo: boolean;
}

const flushers = new Set<Flusher>();

export function registerFlusher(flush: () => Promise<unknown>, todo = false): () => void {
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
    Promise.allSettled(list.map((f) => f.flush())),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
