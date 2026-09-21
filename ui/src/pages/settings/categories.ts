import {
  CalendarOutlined,
  HistoryOutlined,
  KeyOutlined,
  SafetyOutlined,
} from "@ant-design/icons";

export const SETTINGS_CATEGORIES = [
  { key: "security", label: "本机安全", icon: SafetyOutlined },
  { key: "tasks", label: "定时任务默认值", icon: CalendarOutlined },
  { key: "backups", label: "备份与升级", icon: HistoryOutlined },
  { key: "llm", label: "API 密钥与服务", icon: KeyOutlined },
];

const LEGACY_CATEGORIES: Record<string, string> = {
  about: "backups",
  preferences: "llm",
  diagnostics: "advanced",
  advanced: "advanced",
};

export function resolveCategoryKey(raw: string | null): string {
  if (raw === null) return "security";
  return (
    LEGACY_CATEGORIES[raw] ??
    SETTINGS_CATEGORIES.find((item) => item.key === raw)?.key ??
    "security"
  );
}

const REPORT_PATHS = [
  "/cost",
  "/report",
  "/sessions",
  "/memory-diff",
  "/audit",
  "/events",
  "/approvals",
  "/progress",
];
const EXPERT_PATHS = ["/setup", "/troubleshoot", "/logs", "/core-files", "/canary"];

export function settingsToolPaths(experiments: boolean, instanceCount: number | null) {
  return {
    reports: REPORT_PATHS,
    expert: [
      ...EXPERT_PATHS,
      ...(experiments ? ["/evolution"] : []),
      ...(instanceCount !== null && instanceCount >= 2 ? ["/federation"] : []),
    ],
  };
}
