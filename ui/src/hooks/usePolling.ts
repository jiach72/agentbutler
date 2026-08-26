/**
 * 轮询 hook：标签页隐藏时自动暂停、回到前台立即补一次刷新，
 * 取代散落在各页面的裸 setInterval 编排。
 */
import { useEffect, useRef } from "react";

export interface UsePollingOptions {
  /** 后台标签页是否继续轮询（默认暂停）。 */
  whenHidden?: boolean;
}

export function usePolling(
  callback: () => void,
  intervalMs: number | null,
  options?: UsePollingOptions,
): void {
  const whenHidden = options?.whenHidden ?? false;
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (intervalMs === null || intervalMs <= 0) return;
    const tick = (): void => {
      if (whenHidden || document.visibilityState !== "hidden") callbackRef.current();
    };
    const id = setInterval(tick, intervalMs);
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") callbackRef.current();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, whenHidden]);
}
