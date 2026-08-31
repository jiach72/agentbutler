import { randomUUID } from "node:crypto";

export type UserFacingErrorCode =
  | "permission"
  | "config-invalid"
  | "gateway-unready"
  | "network-blocked"
  | "write-failure"
  | "auth-missing"
  | "unknown";

export interface UserFacingError {
  code: UserFacingErrorCode;
  detail: string;
  nextStep: string;
  errorId: string;
}

// ANSI/control bytes are deliberately removed before any error text reaches a client.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function normalizeErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(ANSI_RE, "").replace(CONTROL_RE, " ").replace(/\r?\n+/g, " ").trim();
}

export function redactErrorText(raw: string): string {
  return raw
    .replace(/\b[a-zA-Z]:\\[^\s"']+/g, "[路径]")
    .replace(/\/(?:home|Users|mnt\/[a-z])\/[^\s"':]+/g, "[路径]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[地址]");
}

function classify(text: string): UserFacingErrorCode {
  if (/permission denied|eacces|权限|拒绝访问/i.test(text)) return "permission";
  if (/invalid config|config(?:uration)? error|配置.{0,8}(无效|错误)|yaml|json/i.test(text)) return "config-invalid";
  if (/gateway|网关|未就绪|not ready|connection refused/i.test(text)) return "gateway-unready";
  if (/network|timeout|timed out|不可达|网络|dns|代理/i.test(text)) return "network-blocked";
  if (/write|rename|filesystem|写入|磁盘|enoent/i.test(text)) return "write-failure";
  if (/token|credential|api key|密钥|凭据|unauthori[sz]ed|401|403/i.test(text)) return "auth-missing";
  return "unknown";
}

const COPY: Record<UserFacingErrorCode, { detail: string; nextStep: string }> = {
  permission: { detail: "管家没有权限完成这项操作。", nextStep: "检查目录权限，或在有权限的终端重新运行。" },
  "config-invalid": { detail: "当前配置格式或内容不正确。", nextStep: "打开设置检查配置，再重新检查。" },
  "gateway-unready": { detail: "AI 网关还没有准备好。", nextStep: "确认实例正在运行，然后点击重新检查。" },
  "network-blocked": { detail: "网络连接暂时不可用。", nextStep: "检查网络或代理设置，稍后重试。" },
  "write-failure": { detail: "管家保存文件时失败了。", nextStep: "确认磁盘可写且没有其他操作正在进行，然后重试。" },
  "auth-missing": { detail: "访问凭据缺失或无效。", nextStep: "在设置中补充凭据并执行一次连接检查。" },
  unknown: { detail: "管家处理这项操作时遇到了问题。", nextStep: "点击重新检查；如果仍失败，请导出诊断报告。" },
};

export function toUserFacingError(error: unknown, fallback?: Partial<Pick<UserFacingError, "detail" | "nextStep">>): UserFacingError {
  const normalized = normalizeErrorText(error);
  const safe = redactErrorText(normalized);
  const code = classify(safe);
  return {
    code,
    detail: fallback?.detail ?? COPY[code].detail,
    nextStep: fallback?.nextStep ?? COPY[code].nextStep,
    errorId: `err-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
  };
}
