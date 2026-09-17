import { Checkbox, Input, InputNumber, Select, Typography } from "antd";
import type { ScheduledTaskDraft } from "@butler/contract";

type Schedule = ScheduledTaskDraft["schedule"];
const DAYS = [
  { label: "周一", value: 1 }, { label: "周二", value: 2 }, { label: "周三", value: 3 },
  { label: "周四", value: 4 }, { label: "周五", value: 5 }, { label: "周六", value: 6 },
  { label: "周日", value: 0 },
];

function describeSchedule(schedule: Schedule, timezone: string): string {
  const tz = timezone || "系统时区";
  if (schedule.kind === "daily") {
    return `每天 ${schedule.time || "09:00"} 执行 (${tz})`;
  }
  if (schedule.kind === "weekdays") {
    return `工作日 (周一至周五) 每天 ${schedule.time || "09:00"} 执行 (${tz})`;
  }
  if (schedule.kind === "weekly") {
    const dayNames = (schedule.weekdays || [])
      .map((d) => DAYS.find((x) => x.value === d)?.label)
      .filter(Boolean)
      .join("、");
    return `每周 ${dayNames || "未指定"} ${schedule.time || "09:00"} 执行 (${tz})`;
  }
  if (schedule.kind === "interval") {
    return `每隔 ${schedule.everyMinutes || 60} 分钟执行一次`;
  }
  if (schedule.kind === "advanced") {
    return `按 Cron 表达式 “${schedule.expression || "* * * * *"}” 执行 (${tz})`;
  }
  return "自定义安排";
}

function computeUpcomingTimes(schedule: Schedule, count = 3): string[] {
  const now = new Date();
  const results: string[] = [];

  const formatShort = (d: Date) => {
    const m = d.getMonth() + 1;
    const date = d.getDate();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${m}月${date}日 ${hh}:${mm}`;
  };

  if (schedule.kind === "interval") {
    const mins = Math.max(1, schedule.everyMinutes || 60);
    for (let i = 1; i <= count; i++) {
      results.push(formatShort(new Date(now.getTime() + i * mins * 60_000)));
    }
    return results;
  }

  if (schedule.kind === "daily" || schedule.kind === "weekdays" || schedule.kind === "weekly") {
    const [hStr, mStr] = (schedule.time || "09:00").split(":");
    const hours = parseInt(hStr, 10) || 0;
    const minutes = parseInt(mStr, 10) || 0;

    const targetDays =
      schedule.kind === "daily"
        ? [0, 1, 2, 3, 4, 5, 6]
        : schedule.kind === "weekdays"
          ? [1, 2, 3, 4, 5]
          : schedule.weekdays || [];

    if (!targetDays || targetDays.length === 0) return [];

    const cursor = new Date(now);
    cursor.setHours(hours, minutes, 0, 0);
    if (cursor.getTime() <= now.getTime()) {
      cursor.setDate(cursor.getDate() + 1);
    }

    while (results.length < count && results.length < 30) {
      if (targetDays.includes(cursor.getDay())) {
        results.push(formatShort(new Date(cursor)));
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return results;
  }

  return [];
}

export function SchedulePicker({ value, timezone, onChange, disabled = false }: {
  value: Schedule; timezone: string; onChange: (schedule: Schedule) => void; disabled?: boolean;
}) {
  const setKind = (kind: Schedule["kind"]) => {
    const time = "time" in value ? value.time : "09:00";
    if (kind === "interval") onChange({ kind, everyMinutes: 60 });
    else if (kind === "advanced") onChange({ kind, expression: "0 9 * * *", timezone });
    else if (kind === "weekly") onChange({ kind, weekdays: [1], time, timezone });
    else onChange({ kind, time, timezone });
  };

  const naturalText = describeSchedule(value, timezone);
  const upcomingTimes = computeUpcomingTimes(value, 3);

  return (
    <div className="task-schedule-fields">
      <label htmlFor="task-frequency">执行频率</label>
      <Select id="task-frequency" value={value.kind} onChange={setKind} disabled={disabled} options={[
        { label: "每天", value: "daily" }, { label: "工作日", value: "weekdays" },
        { label: "每周", value: "weekly" }, { label: "固定间隔", value: "interval" },
        { label: "自定义时间", value: "advanced" },
      ]} />
      {value.kind === "weekly" && <Checkbox.Group aria-label="执行星期" disabled={disabled}
        options={DAYS} value={value.weekdays}
        onChange={(weekdays) => onChange({ ...value, weekdays: weekdays.map(Number) })} />}
      {"time" in value && <>
        <label htmlFor="task-time">执行时间</label>
        <Input id="task-time" type="time" required value={value.time} disabled={disabled}
          onChange={(event) => onChange({ ...value, time: event.target.value })} />
      </>}
      {value.kind === "interval" && <>
        <label htmlFor="task-interval">间隔分钟</label>
        <InputNumber id="task-interval" min={1} max={525600} precision={0} value={value.everyMinutes}
          disabled={disabled} onChange={(everyMinutes) => onChange({ ...value, everyMinutes: everyMinutes ?? 1 })} />
      </>}
      {value.kind === "advanced" && <>
        <label htmlFor="task-expression">Cron 表达式</label>
        <Input id="task-expression" value={value.expression} maxLength={100} disabled={disabled}
          onChange={(event) => onChange({ ...value, expression: event.target.value })} />
      </>}
      <Typography.Text type="secondary">执行时区：{timezone || "尚未确认"}</Typography.Text>
      <div
        className="schedule-natural-preview"
        style={{
          marginTop: 6,
          padding: "10px 14px",
          background: "var(--ab-primary-soft)",
          border: "1px solid var(--ab-primary-soft-border)",
          borderRadius: 8,
          fontSize: 13,
        }}
      >
        <div style={{ fontWeight: 600, color: "var(--ab-primary)", marginBottom: 4 }}>
          🕒 已设定：{naturalText}
        </div>
        {upcomingTimes.length > 0 && (
          <div style={{ color: "var(--ab-text-2)", fontSize: 12 }}>
            未来 3 次预计运行：{upcomingTimes.join("  →  ")}
          </div>
        )}
      </div>
    </div>
  );
}
