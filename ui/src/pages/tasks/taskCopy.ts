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
  if (reason === "unsupported_version") return "宿主 Hermes 源码版本与控制桥存在差异，写操作已自动保护阻断。若确认 CLI 兼容，可在环境配置 BUTLER_ALLOW_CRON_DRIFT=1 放行。";
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

export interface HumanizedSchedule {
  /** 面向用户的自然语言描述，如 "每 4 小时整点"、"每天 09:00" */
  text: string;
  /** 若原输入为 Cron 表达式，保留原始代码供辅助微标签展示 */
  rawCron?: string;
}

const WEEKDAY_NAMES: Record<string, string> = {
  "0": "周日",
  "1": "周一",
  "2": "周二",
  "3": "周三",
  "4": "周四",
  "5": "周五",
  "6": "周六",
  "7": "周日",
  "SUN": "周日",
  "MON": "周一",
  "TUE": "周二",
  "WED": "周三",
  "THU": "周四",
  "FRI": "周五",
  "SAT": "周六",
};

/**
 * 将技术向的 Cron 表达式或排程文本转化为中文自然语言描述
 */
export function humanizeSchedule(raw: string | null | undefined): HumanizedSchedule {
  if (!raw || !raw.trim()) {
    return { text: "未指定排程" };
  }
  const str = raw.trim();

  // 1. 如果已包含中文字符，直接按既有描述输出
  if (/[\u4e00-\u9fa5]/.test(str)) {
    return { text: str };
  }

  // 2. 常见微格式处理：every 30m / every 2h
  const everyMatch = str.match(/^every\s+(\d+)\s*([mhdw])$/i);
  if (everyMatch) {
    const num = everyMatch[1];
    const unit = everyMatch[2].toLowerCase();
    const unitMap: Record<string, string> = { m: "分钟", h: "小时", d: "天", w: "周" };
    return { text: `每 ${num} ${unitMap[unit] || "分钟"}` };
  }

  // 3. 常见 Cron 宏处理
  if (str === "@hourly") return { text: "每小时整点", rawCron: str };
  if (str === "@daily" || str === "@midnight") return { text: "每天 00:00 (午夜)", rawCron: str };
  if (str === "@weekly") return { text: "每周日 00:00", rawCron: str };
  if (str === "@monthly") return { text: "每月 1 日 00:00", rawCron: str };

  // 4. 标准 5 段 Cron 表达式: minute hour dom month dow
  const parts = str.split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts;
    const isCron = parts.every((p) => /^[0-9*,\-/A-Za-z]+$/.test(p));
    if (isCron) {
      const pad = (n: string | number) => String(n).padStart(2, "0");

      // 4.1 每隔 N 分钟：*/N * * * *
      if (/^\*\/\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
        const interval = min.replace("*/", "");
        return { text: `每隔 ${interval} 分钟`, rawCron: str };
      }

      // 4.2 每分钟：* * * * *
      if (min === "*" && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
        return { text: "每分钟执行一次", rawCron: str };
      }

      // 4.3 每隔 N 小时整点：0 */N * * * 或 M */N * * *
      if (/^\*\/\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") {
        const interval = hour.replace("*/", "");
        if (min === "0") {
          return { text: `每 ${interval} 小时整点`, rawCron: str };
        }
        return { text: `每 ${interval} 小时 (第 ${min} 分)`, rawCron: str };
      }

      // 4.4 每小时整点：0 * * * *
      if (min === "0" && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
        return { text: "每小时整点", rawCron: str };
      }

      // 4.5 每天固定时间点：M H * * *
      if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*") {
        const timeStr = `${pad(hour)}:${pad(min)}`;
        if (dow === "*") {
          return { text: `每天 ${timeStr}`, rawCron: str };
        }
        if (dow === "1-5" || dow.toUpperCase() === "MON-FRI") {
          return { text: `工作日 (周一至周五) ${timeStr}`, rawCron: str };
        }
        if (dow === "0,6" || dow === "6,0" || dow.toUpperCase() === "SAT,SUN" || dow.toUpperCase() === "SUN,SAT") {
          return { text: `周末 ${timeStr}`, rawCron: str };
        }
        if (/^\d$/.test(dow) && WEEKDAY_NAMES[dow]) {
          return { text: `每${WEEKDAY_NAMES[dow]} ${timeStr}`, rawCron: str };
        }
        if (/^[\d,]+$/.test(dow)) {
          const days = dow.split(",").map((d) => WEEKDAY_NAMES[d] || d).join("、");
          return { text: `每${days} ${timeStr}`, rawCron: str };
        }
      }

      // 4.6 每天多时间点：0 H1,H2,H3 * * *
      if (/^\d+$/.test(min) && /^[\d,]+$/.test(hour) && dom === "*" && mon === "*") {
        const times = hour.split(",").map((h) => `${pad(h)}:${pad(min)}`).join("、");
        return { text: `每天 ${times}`, rawCron: str };
      }

      // 4.7 每月固定日：M H D * *
      if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && mon === "*" && dow === "*") {
        return { text: `每月 ${dom} 日 ${pad(hour)}:${pad(min)}`, rawCron: str };
      }

      // 4.8 兜底 Cron
      return { text: `按计划执行`, rawCron: str };
    }
  }

  return { text: str };
}

