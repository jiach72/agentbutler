export type RuntimeStateCode =
  | "healthy"
  | "port_conflict_same"
  | "port_conflict_foreign"
  | "token_mismatch"
  | "bridge_offline"
  | "config_invalid"
  | "auth_missing"
  | "network_blocked"
  | "service_missing"
  | "unknown";

export interface RuntimeEvidenceItem {
  source: string;
  message: string;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  occurrences?: number;
}

export interface RuntimeProbeInput {
  id: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface RuntimeDiagnosis {
  stateCode: RuntimeStateCode;
  severity: "ok" | "warn" | "error" | "unknown";
  summary: string;
  safeToRetry: boolean;
  evidence: RuntimeEvidenceItem[];
}

function stateFromProbe(probe: RuntimeProbeInput): RuntimeStateCode {
  const detail = probe.detail;
  if (/port|端口/i.test(detail)) return /another|foreign|其他|外部/i.test(detail) ? "port_conflict_foreign" : "port_conflict_same";
  if (/token|密钥|凭据|auth|401|403/i.test(detail)) return /missing|缺失|未配置/i.test(detail) ? "auth_missing" : "token_mismatch";
  if (/bridge|连接|offline|离线|refused|不可达/i.test(detail)) return "bridge_offline";
  if (/config|配置|yaml|json/i.test(detail)) return "config_invalid";
  if (/service|进程|未找到|missing/i.test(detail)) return "service_missing";
  if (/network|网络|dns|timeout|超时/i.test(detail)) return "network_blocked";
  return "unknown";
}

export function classifyRuntimeState(probes: RuntimeProbeInput[], evidence: RuntimeEvidenceItem[] = []): RuntimeDiagnosis {
  const failed = probes.filter((probe) => probe.status === "fail");
  const warned = probes.filter((probe) => probe.status === "warn");
  if (failed.length === 0 && warned.length === 0) {
    return { stateCode: "healthy", severity: "ok", summary: "当前运行正常。", safeToRetry: true, evidence };
  }
  if (failed.length === 0) {
    return {
      stateCode: "healthy",
      severity: "warn",
      summary: `当前运行正常，但有 ${warned.length} 项提醒。`,
      safeToRetry: true,
      evidence,
    };
  }
  const primary = failed[0]!;
  const stateCode = stateFromProbe(primary);
  const safeToRetry = !["config_invalid", "auth_missing", "token_mismatch"].includes(stateCode);
  return {
    stateCode,
    severity: "error",
    summary: primary.detail,
    safeToRetry,
    evidence: [{ source: primary.id, message: primary.detail }, ...evidence],
  };
}
