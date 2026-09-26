/**
 * 安全下载 Blob 资源：挂载至 DOM 触发点击，并延迟 10 秒释放 ObjectURL，
 * 避免浏览器下载管理器尚未读取流即被注销导致的下载空文件或静默失败。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
