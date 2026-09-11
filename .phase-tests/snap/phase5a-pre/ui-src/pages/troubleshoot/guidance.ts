import type { RecoveryDiagnosisView } from "../dashboard/types.js";

export interface RecoveryGuidance {
  to: string;
  label: string;
  detail: string;
}

/** 将机器诊断映射成普通用户下一步能去的页面，而不是只留一段错误文本。 */
export function guidanceForDiagnosis(diagnosis: RecoveryDiagnosisView | null): RecoveryGuidance {
  const text = [
    diagnosis?.rootCause,
    diagnosis?.primaryFinding?.title,
    diagnosis?.primaryFinding?.detail,
    ...(diagnosis?.probes.map((probe) => `${probe.label} ${probe.detail}`) ?? []),
  ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();

  if (/(llm|模型|api key|凭据|鉴权|credential|token)/i.test(text)) {
    return { to: "/settings", label: "检查模型与 API Key", detail: "确认端点、模型名、探针结果和实例绑定。" };
  }
  if (/(消息|通道|channel|gateway|送达)/i.test(text)) {
    return { to: "/gateway", label: "检查消息通知", detail: "查看通道连接、发送节流和最近送达记录。" };
  }
  if (/(记忆|memory|索引|index)/i.test(text)) {
    return { to: "/skills", label: "检查记忆与技能", detail: "确认记忆自检和技能状态，再决定是否重建索引。" };
  }
  return { to: "/logs", label: "查看原始日志", detail: "打开最近日志，或下载诊断报告后再寻求帮助。" };
}
