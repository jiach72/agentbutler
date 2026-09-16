export function taskStatusLabel(status: string): string {
  return ({
    success: "执行成功",
    failed: "执行失败",
    delivery_failed: "通知未送达",
    running: "正在执行",
    never: "尚未执行",
    unknown: "结果待确认",
    completed: "执行成功",
    claimed: "等待执行",
  } as Record<string, string>)[status] ?? "结果待确认";
}

export function taskTime(value: string | null | undefined, timezone?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "尚未确定";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone || undefined,
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(value));
  } catch {
    return "时间待确认";
  }
}

type SortableTask = { enabled: boolean; lastStatus: string; nextRunAt: string | null };
export function compareTasks(left: SortableTask, right: SortableTask): number {
  const rank = (task: SortableTask) => !task.enabled ? 2 : ["failed", "delivery_failed", "unknown"].includes(task.lastStatus) ? 0 : 1;
  const timestamp = (task: SortableTask) => task.nextRunAt && Number.isFinite(Date.parse(task.nextRunAt))
    ? Date.parse(task.nextRunAt) : Number.MAX_SAFE_INTEGER;
  return rank(left) - rank(right) || timestamp(left) - timestamp(right);
}

export function taskMutationError(status: number, data: unknown): string {
  const reason = data !== null && typeof data === "object" && "reason" in data ? data.reason : null;
  if (reason === "backup_failed") return "任务备份未能完成，未执行修改。请检查磁盘空间和备份目录权限。";
  if (reason === "manual_run_not_supported") return "当前 Hermes 版本暂不支持安全的下一轮执行请求。";
  if (reason === "timezone_mismatch") return "执行时区与 Hermes 不一致，请刷新后重新确认执行时间。";
  if (reason === "not_editable") return "此类任务包含特殊配置，请在 Hermes 中编辑。";
  if (reason === "outcome_unknown" || reason === "operation_in_progress") return "上一次操作结果尚未确认，请刷新列表核对，不要重复创建。";
  if (status === 0) return "连接中断，操作结果尚未确认。请刷新任务列表后再重试，不要重复创建。";
  if (status === 400 || status === 422) return "任务内容或执行时间不符合要求，请检查表单后重试。";
  if (status === 401 || status === 403) return "无法操作，请检查面板访问口令。";
  if (status === 404) return "任务已不存在，请刷新列表。";
  if (status === 409) return "任务状态已变化或上一次操作仍待确认，请刷新后检查。";
  if (status === 501) return "当前 Hermes 版本暂不支持此操作。";
  return "操作未能确认，请检查 Hermes 连接与备份目录后重试。草稿仍然保留。";
}

export function taskFailureLabel(type: string): string {
  return ({
    rate_limit: "请求过于频繁，请稍后再检查",
    timeout: "执行超时，请检查任务耗时",
    auth: "访问凭据不可用，请检查模型或通知配置",
    delivery: "任务结果未能送达，请检查消息通知",
    config: "任务配置有误，请检查设置",
    script: "脚本执行失败，请在 Hermes 中检查",
    agent: "智能体执行失败，请检查模型与连接",
  } as Record<string, string>)[type] ?? "执行未完成，请查看执行历史并检查 Hermes";
}

export function scheduleConfirmation(label: string, nextRunAt: string | null, timezone: string): string {
  return nextRunAt
    ? `${label}；下一次 ${taskTime(nextRunAt, timezone)}（${timezone}）`
    : `${label}；下一次执行时间尚未得到 Hermes 确认`;
}
