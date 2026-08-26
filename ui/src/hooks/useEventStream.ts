/**
 * 事件流订阅：全应用共享一条 /ws 连接（引用计数管理生命周期），
 * useEventStream 按事件类型前缀过滤并做节流刷新信号。
 */
import { useEffect, useRef, useState } from "react";
import { disposeWebSocket } from "../lib/websocket.js";

export interface EventFrame {
  type?: unknown;
  [key: string]: unknown;
}

type FrameListener = (frame: EventFrame) => void;
type StatusListener = (online: boolean) => void;

const RECONNECT_MS = 5000;

let socket: WebSocket | null = null;
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const frameListeners = new Set<FrameListener>();
const statusListeners = new Set<StatusListener>();

function notifyStatus(online: boolean): void {
  for (const listener of statusListeners) listener(online);
}

function connect(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  socket.onopen = () => notifyStatus(true);
  socket.onmessage = (msg) => {
    try {
      const frame = JSON.parse(String(msg.data)) as EventFrame;
      for (const listener of frameListeners) listener(frame);
    } catch {
      // 忽略无法解析的帧
    }
  };
  socket.onerror = () => {
    // onclose 会随后触发，由 onclose 统一安排重连
  };
  socket.onclose = () => {
    socket = null;
    notifyStatus(false);
    if (refCount > 0 && reconnectTimer === undefined) {
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    }
  };
}

/** 订阅共享事件流；返回退订函数，最后一个订阅者退出时释放连接。 */
export function subscribeEventStream(onFrame: FrameListener): () => void {
  frameListeners.add(onFrame);
  refCount += 1;
  if (socket === null && reconnectTimer === undefined && refCount === 1) connect();
  return () => {
    frameListeners.delete(onFrame);
    refCount -= 1;
    if (refCount === 0) {
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      disposeWebSocket(socket);
      socket = null;
    }
  };
}

interface UseEventStreamOptions {
  /** 关心的事件类型前缀，如 ["job-event", "inspection-"]；空数组表示不过滤。 */
  prefixes?: readonly string[];
  /** 命中前缀时触发（节流后）。用于驱动页面刷新。 */
  onSignal: () => void;
  throttleMs?: number;
}

/** 页面级事件订阅：命中前缀的事件按 trailing 节流合并成一次刷新信号。 */
export function useEventStream({
  prefixes = [],
  onSignal,
  throttleMs = 5000,
}: UseEventStreamOptions): void {
  const signalRef = useRef(onSignal);
  signalRef.current = onSignal;
  const prefixKey = prefixes.join("|");

  useEffect(() => {
    const parts = prefixKey.length === 0 ? [] : prefixKey.split("|");
    let lastFired = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const fire = (): void => {
      lastFired = Date.now();
      signalRef.current();
    };
    const unsubscribe = subscribeEventStream((frame) => {
      const type = typeof frame.type === "string" ? frame.type : "";
      if (parts.length > 0 && !parts.some((prefix) => type.startsWith(prefix))) return;
      const remaining = throttleMs - (Date.now() - lastFired);
      if (remaining <= 0) {
        fire();
        return;
      }
      if (trailing === undefined) {
        trailing = setTimeout(() => {
          trailing = undefined;
          fire();
        }, remaining);
      }
    });
    return () => {
      if (trailing !== undefined) clearTimeout(trailing);
      unsubscribe();
    };
  }, [prefixKey, throttleMs]);
}

/** 共享连接的在位状态：底部 ticker 与页面连接指示共用。 */
export function useEventStreamStatus(): boolean {
  const [online, setOnline] = useState(socket !== null && socket.readyState === WebSocket.OPEN);
  useEffect(() => {
    const listener = (value: boolean): void => setOnline(value);
    statusListeners.add(listener);
    return () => {
      statusListeners.delete(listener);
    };
  }, []);
  return online;
}
