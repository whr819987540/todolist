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

// ----- 关闭窗口前把未保存的内容写盘 -----

const flushers = new Set<() => Promise<void>>();

export function registerFlusher(fn: () => Promise<void>): () => void {
  flushers.add(fn);
  return () => {
    flushers.delete(fn);
  };
}

export async function flushAll(timeoutMs = 3000): Promise<void> {
  await Promise.race([
    Promise.allSettled([...flushers].map((f) => f())),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
