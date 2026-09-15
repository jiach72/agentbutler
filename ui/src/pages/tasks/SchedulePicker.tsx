import { Checkbox, Input, InputNumber, Select, Typography } from "antd";
import type { ScheduledTaskDraft } from "@butler/contract";

type Schedule = ScheduledTaskDraft["schedule"];
const DAYS = [
  { label: "周一", value: 1 }, { label: "周二", value: 2 }, { label: "周三", value: 3 },
  { label: "周四", value: 4 }, { label: "周五", value: 5 }, { label: "周六", value: 6 },
  { label: "周日", value: 0 },
];

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
    </div>
  );
}
