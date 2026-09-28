/**
 * 面板侧文件路径安全工具（知识库文档、收件箱等以相对路径落盘的功能共用）。
 * 与 apps/watch/src/markdown-files.ts 的 inside() 同一安全水位：
 * resolve 后比较相对路径，拒绝 `..` 与绝对路径逃逸。
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

/** candidate 是否位于 root 之内（含等于 root）。 */
export function isInsideRoot(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * 清洗外部提供的相对路径（用户上传、清单回读）：统一分隔符后逐段校验。
 * 拒绝 `..` 段、盘符段（C:）、绝对路径与空路径；返回 null 表示不合法——
 * 策略是"拒绝而非重写"，避免清洗后路径语义漂移。
 */
export function sanitizeRelativePath(input: string): string | null {
  const normalized = input.replace(/\\/g, "/").trim();
  if (normalized === "" || normalized.startsWith("/")) return null;
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "..")) return null;
  if (segments.some((segment) => /^[a-zA-Z]:$/.test(segment))) return null;
  return segments.join("/");
}
