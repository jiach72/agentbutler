/**
 * 组件卸载时安全释放 WebSocket。
 *
 * React StrictMode 会在开发环境短暂执行一次 setup → cleanup → setup。
 * 若 cleanup 直接关闭仍处于 CONNECTING 的连接，浏览器会记录
 * "WebSocket is closed before the connection is established"。先解绑业务
 * 回调，再等连接打开后关闭，可避免这类噪声和卸载后的重连副作用。
 */
export function disposeWebSocket(socket: WebSocket | null): void {
  if (socket === null) return;

  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;

  if (socket.readyState === WebSocket.CONNECTING) {
    const closeWhenOpen = (): void => {
      socket.removeEventListener("open", closeWhenOpen);
      socket.close(1000, "component disposed");
    };
    socket.addEventListener("open", closeWhenOpen, { once: true });
    return;
  }

  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1000, "component disposed");
  }
}
