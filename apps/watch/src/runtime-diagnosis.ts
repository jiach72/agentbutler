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
  if (probes.length === 0) {
    return { stateCode: "unknown", severity: "unknown", summary: "尚未获得运行检查结果，请重新检查连接。", safeToRetry: false, evidence };
  }
  const failed = probes.filter((probe) => probe.status === "fail");
  const warned = probes.filter((probe) => probe.status === "warn");
  if (failed.length === 0 && warned.length === 0) {
    return { stateCode: "healthy", severity: "ok", summary: "本次运行检查已通过。", safeToRetry: true, evidence };
  }
  if (failed.length === 0) {
    return {
      stateCode: "healthy",
      severity: "warn",
      summary: `运行检查已通过，仍有 ${warned.length} 项提醒需要核对。`,
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
    summary: {
      healthy: "本次运行检查已通过。",
      port_conflict_same: "智能体服务重复占用端口，连接可能受到影响。",
      port_conflict_foreign: "其他程序占用了所需端口，智能体暂时无法连接。",
      token_mismatch: "访问凭据不匹配，请检查连接配置。",
      bridge_offline: "消息连接暂不可用，请检查智能体是否正在运行。",
      config_invalid: "连接配置无法使用，请检查配置后重新验证。",
      auth_missing: "缺少访问凭据，请完成连接配置。",
      network_blocked: "网络连接未通过，请检查网络后重试。",
      service_missing: "未找到正在运行的智能体服务，请检查启动状态。",
      unknown: "运行检查未通过，请查看诊断证据后处理。",
    }[stateCode],
    safeToRetry,
    evidence: [{ source: primary.id, message: primary.detail }, ...evidence],
  };
}
