/**
 * 密钥逐项校验引导。
 *
 * 声明式清单描述各功能所需的环境变量组（组内全部就绪才算 present），
 * checkSecrets 逐项判定并输出引导文案（缺失项 + 获取方式 + 写入位置 + export 示例）。
 * 除生成留空的 .env 模板外，不写入任何真实密钥文件。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/** 单个密钥项的定义。 */
export interface SecretItem {
  key: string;
  label: string;
  /** 从哪里获取的一句话说明。 */
  hint: string;
}

/** 一组功能所需的密钥（组内全部 present 才算该功能可用）。 */
export interface SecretGroup {
  id: string;
  feature: string;
  items: SecretItem[];
}

/** 建议写入的 env 文件位置（~/.agent-butler/env）。 */
export function defaultEnvPath(): string {
  return path.join(homedir(), ".agent-butler", "env");
}

/** 声明式默认清单（可注入扩展）。 */
export const DEFAULT_SECRET_GROUPS: SecretGroup[] = [
  {
    id: "telegram",
    feature: "Telegram 告警通知",
    items: [
      {
        key: "BUTLER_TELEGRAM_BOT_TOKEN",
        label: "Telegram Bot Token",
        hint: "在 Telegram 中与 @BotFather 对话创建 Bot 后获取",
      },
      {
        key: "BUTLER_TELEGRAM_CHAT_ID",
        label: "Telegram Chat ID",
        hint: "与 @userinfobot 对话或调用 Bot getUpdates 接口获取目标会话 ID",
      },
    ],
  },
  {
    id: "smtp",
    feature: "SMTP 邮件告警",
    items: [
      { key: "BUTLER_SMTP_HOST", label: "SMTP 服务器地址", hint: "邮件服务商的 SMTP 地址（如 smtp.qq.com、smtp.163.com）" },
      { key: "BUTLER_SMTP_PORT", label: "SMTP 端口", hint: "邮件服务商说明页给出的端口（常见 465 或 587）" },
      { key: "BUTLER_SMTP_FROM", label: "发件邮箱", hint: "在你自己的邮箱账户中开启 SMTP 服务后使用的发件地址" },
      { key: "BUTLER_SMTP_TO", label: "收件邮箱", hint: "接收告警邮件的邮箱地址" },
    ],
  },
  {
    id: "llm",
    feature: "LLM 智能探针",
    items: [
      { key: "BUTLER_LLM_API_KEY", label: "模型服务 API Key", hint: "在模型服务商控制台创建（如 OpenAI、阿里云百炼）" },
      {
        key: "BUTLER_LLM_BASE_URL",
        label: "模型服务端点",
        hint: "模型服务商的 OpenAI 兼容端点（如 https://dashscope.aliyuncs.com/compatible-mode/v1）",
      },
    ],
  },
];

/** 单项校验结果。 */
export interface SecretItemStatus extends SecretItem {
  present: boolean;
}

/** 单组校验结果。 */
export interface SecretGroupReport {
  id: string;
  feature: string;
  status: "present" | "missing";
  items: SecretItemStatus[];
  missingKeys: string[];
  /** 缺失时的引导文案；present 时为空串。 */
  guidance: string;
}

/** 全部组校验结果。 */
export interface SecretsReport {
  groups: SecretGroupReport[];
  allPresent: boolean;
  missingGroups: SecretGroupReport[];
  /** 建议写入位置（~/.agent-butler/env）。 */
  envPath: string;
}

function isPresent(env: Record<string, string | undefined>, key: string): boolean {
  const value = env[key];
  return value !== undefined && value.trim() !== "";
}

/** 逐项校验并生成引导文案。 */
export function checkSecrets(
  env: Record<string, string | undefined> = process.env,
  groups: SecretGroup[] = DEFAULT_SECRET_GROUPS,
): SecretsReport {
  const envPath = defaultEnvPath();
  const reports = groups.map((group): SecretGroupReport => {
    const items = group.items.map(
      (item): SecretItemStatus => ({ ...item, present: isPresent(env, item.key) }),
    );
    const missingKeys = items.filter((i) => !i.present).map((i) => i.key);
    const guidance =
      missingKeys.length === 0
        ? ""
        : [
            `缺失: ${missingKeys.join(", ")}`,
            `获取: ${items
              .filter((i) => !i.present)
              .map((i) => `${i.key}（${i.hint}）`)
              .join("；")}`,
            `建议写入 ${envPath}，或临时导出: export ${missingKeys.map((k) => `${k}=<值>`).join(" ")}`,
          ].join("\n");
    return {
      id: group.id,
      feature: group.feature,
      status: missingKeys.length === 0 ? "present" : "missing",
      items,
      missingKeys,
      guidance,
    };
  });
  const missingGroups = reports.filter((r) => r.status === "missing");
  return {
    groups: reports,
    allPresent: missingGroups.length === 0,
    missingGroups,
    envPath,
  };
}

/** 生成 .env 模板（含注释、键默认留空），写入 path 并返回内容。不落任何真实密钥。 */
export function writeEnvTemplate(filePath: string, groups: SecretGroup[] = DEFAULT_SECRET_GROUPS): string {
  const lines: string[] = [
    "# Agent Butler 环境变量模板（安装器生成，键默认留空，不含任何真实密钥）",
    `# 填好后保存为 ${defaultEnvPath()}，或逐项 export 后再运行安装器/服务。`,
    "",
  ];
  for (const group of groups) {
    lines.push(`# ===== ${group.feature} =====`);
    for (const item of group.items) {
      lines.push(`# ${item.key}: ${item.label}。${item.hint}。`);
      lines.push(`${item.key}=`);
    }
    lines.push("");
  }
  const content = lines.join("\n");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return content;
}
