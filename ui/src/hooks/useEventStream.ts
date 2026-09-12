/**
 * 事件流订阅：全应用共享一条 /ws 连接（引用计数管理生命周期），
 * useEventStream 按事件类型前缀过滤并做节流刷新信号。
 */
import { useEffect, useRef, useState } from "react";
import { disposeWebSocket } from "../lib/websocket.js";
import { getAccessToken } from "../lib/accessToken.js";
import { postJson } from "../lib/api.js";

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
/** 连接尝试代际号：等待 ticket 的异步间隙里若出现更新尝试，旧结果直接丢弃。 */
let connectGeneration = 0;
const frameListeners = new Set<FrameListener>();
const statusListeners = new Set<StatusListener>();

function notifyStatus(online: boolean): void {
  for (const listener of statusListeners) listener(online);
}

/**
 * WS 握手凭据：优先向后端签发一次性短时 ticket（POST /api/ws-ticket），
 * 真实口令从此不出现在 URL（浏览器历史/代理日志）；旧后端或签发失败时
 * 退回口令 query，行为与旧版一致。
 */
async function handshakeSuffix(): Promise<string> {
  const result = await postJson("/api/ws-ticket", {}, 5000);
  const ticket =
    result.ok && result.data !== null && typeof (result.data as { ticket?: unknown }).ticket === "string"
      ? String((result.data as { ticket?: unknown }).ticket)
      : "";
  if (ticket !== "") return `?ticket=${encodeURIComponent(ticket)}`;
  const token = getAccessToken();
  return token === "" ? "" : `?token=${encodeURIComponent(token)}`;
}

function connect(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  const generation = ++connectGeneration;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  // WebSocket 握手无法携带自定义请求头，凭据只能通过 query 传递（ticket 优先）。
  void handshakeSuffix().then((suffix) => {
    // 等待凭据期间订阅者全部退出或出现更新的连接尝试：丢弃本次结果。
    if (generation !== connectGeneration || refCount === 0) return;
    socket = new WebSocket(`${protocol}://${window.location.host}/ws${suffix}`);
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
  });
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
