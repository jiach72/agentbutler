/**
 * TypeSafe Jev 原语契约类型定义：
 * 涵盖 System One 类型化判定基础原语（Choice、Score、Noul），
 * 以及针对 Agent Butler 定时任务错误诊断与即时通讯消息分流的类型化契约。
 */

export type JevSource = "jev" | "heuristic";

/** 定时任务错误诊断请求 */
export interface TaskDiagnosisRequest {
  taskName: string;
  exitCode?: number | null;
  errorSnippet: string;
  durationMs?: number;
  schedule?: string;
  runtimeContext?: Record<string, unknown>;
}

/** 任务错误根因分类（6 档精准分类） */
export type TaskRootCauseCategory =
  | "credential_expired"   // API Key 失效或鉴权 401/403
  | "rate_limited"         // 遭遇 LLM 或通道限流 429
  | "syntax_or_format"     // 脚本语法错误、JSON 解析失败或 Prompt 格式不匹配
  | "timeout_or_killed"    // 执行超时被系统终止或 OOM
  | "network_or_offline"   // 网络不可达、连接断开或 DNS 解析失败
  | "unknown_runtime";     // 其他未知内部运行异常

/** 定时任务错误诊断结论 */
export interface TaskDiagnosisResult {
  rootCause: TaskRootCauseCategory;
  severity: number; // 1-5：1=轻微波动无害，5=关键任务完全阻断
  confidence: number;
  recommendedAction: string; // 大白话单一动作（如「检查模型密钥」、「稍后重试」、「调整调度频率」）
  explanation: string; // 简要大白话归因
  source: JevSource;
}

/** 即时消息分流判定请求 */
export interface MessageTriageRequest {
  channel: string;
  sender?: string;
  summary: string;
  status: "delivered" | "failed" | "unknown" | "pending_approval" | "need_confirmation";
  userActiveHours?: boolean;
}

/** 消息业务分类（4 档） */
export type MessageTriageCategory =
  | "approval_request"     // 待审批高危指令
  | "critical_failure"     // 投递彻底失败或重要告警
  | "task_completion"     // 例行任务顺利完成播报
  | "heartbeat_chatter";    // 冗余心跳或低价值闲聊

/** 即时消息分流判定结果 */
export interface MessageTriageResult {
  requiresUrgentAttention: boolean; // 是否应立即推送到通知中心或打扰用户
  urgencyProbability: number;       // 判定概率 (0.0 ~ 1.0)
  category: MessageTriageCategory;
  confidence: number;
  explanation: string;
  source: JevSource;
}
