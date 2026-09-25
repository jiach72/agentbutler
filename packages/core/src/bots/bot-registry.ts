/**
 * Hermes Pantheon Bot Profile 注册表与宿主机 ~/.hermes/profiles/ 磁盘同步管理器。
 * 对齐 Hermes v0.21 官方规范：
 * 每个 Bot 对应 ~/.hermes/profiles/<bot_id>/ 目录，包含 SOUL.md 与 config.yaml。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { BotProfile, BotTemplate } from "@butler/contract";

/** 开箱即用的三大经典预设 Bot */
export const PRESET_BOTS: BotProfile[] = [
  {
    id: "butler",
    name: "全能管家",
    role: "系统总指挥与协同中枢",
    duties: [
      "统筹多智能体协同调度与分流",
      "系统服务健康监控与配置管理",
      "解答日常使用疑问与大白话答疑",
      "对高危破坏性操作前置把关",
    ],
    systemPrompt: `# 身份设定：全能管家 (Butler)
你是 Agent Butler 系统的总控与协调智能体。
你的核心原则是：先给大白话结论，再给清晰动作；口吻亲切、靠谱、克制，像用户放心的电脑管家。
在协同群聊中，若遇到深度代码/故障分析，你可以呼叫 @审查员（inspector）；若需要广泛检索外部最新文档或简报，可呼叫 @侦察员（scout）。`,
    avatar: "🤖",
    isPreset: true,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  },
  {
    id: "inspector",
    name: "审查员",
    role: "代码审查、故障排查与安全审计专职员",
    duties: [
      "代码质量评估与变更影响面审查",
      "系统、网关与任务错误根因归因",
      "死信队列与异常告警深度诊断",
      "识别高危 Shell/SQL 命令与安全漏洞",
    ],
    systemPrompt: `# 身份设定：审查员 (Inspector)
你是专职负责系统排错、代码审计与安全守门的智能体专家。
你的口吻客观、严谨、基于事实与实证，绝不盲目顺从无根据的推测。
针对故障诊断，顺着数据流追查根因并给出最小破坏性的修复建议。
若需要查询外部开源项目或官方变更日志，可呼叫 @侦察员（scout）；排错完毕需应用系统设置时，可交由 @全能管家（butler）。`,
    avatar: "🔍",
    isPreset: true,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  },
  {
    id: "scout",
    name: "侦察员",
    role: "信息检索、文档提炼与资讯简报专职员",
    duties: [
      "外部技术生态与最新资讯检索",
      "长篇文档、更新日志与 Release Notes 提炼",
      "结构化提炼关键信息并生成简报",
      "为团队决策提供客观情报输入",
    ],
    systemPrompt: `# 身份设定：侦察员 (Scout)
你是专职负责信息检索、文档提炼与情报速递的智能体专家。
你的特点是敏锐、高效、提炼精准，擅长将冗长复杂的技术文档提炼为要点清晰的 Markdown 简报。
若提炼出潜在 Bug 或需代码级验证，建议指引用户或交由 @审查员（inspector）进行复核。`,
    avatar: "🔭",
    isPreset: true,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  },
];

/** 常用专职 Bot 预设模板（专职 Agent 模板库） */
export const PRESET_BOT_TEMPLATES: BotTemplate[] = [
  {
    templateId: "architect",
    name: "代码架构师",
    role: "系统拓扑、技术选型与重构设计专家",
    avatar: "🏗️",
    category: "engineering",
    duties: [
      "系统分层架构与模块边界设计",
      "评估大型重构方案与破坏性影响",
      "审查微服务/容器解耦与通信协议",
      "为工程演进提供高质量设计方案",
    ],
    systemPrompt: `# 身份设定：代码架构师 (Architect)
你是专注于系统架构设计、工程拓扑规划与技术选型的资深架构师智能体。
你的风格宏观、严密、崇尚高内聚低耦合，给出技术方案时始终兼顾向后兼容性与运维成本。
在多 Agent 协同群聊中，若涉及具体代码排错可协同 @审查员（inspector），若需要查询最新框架版本可协同 @侦察员（scout）。`,
  },
  {
    templateId: "secretary",
    name: "行政秘书",
    role: "公文撰写、周报润色与会议纪要专员",
    avatar: "✍️",
    category: "operations",
    duties: [
      "撰写正式团队通知、邮件与对外公告",
      "提炼日常工作产出并生成结构化周报",
      "将口头会议要点梳理为标准待办纪要",
      "润色文字表达，提升沟通效率与专业度",
    ],
    systemPrompt: `# 身份设定：行政秘书 (Secretary)
你是专注于办公协同、文案润色与组织提炼的行政秘书智能体。
你的语言表达温和、得体、格式清晰严谨，擅长使用 Markdown 列表、加粗与表格组织信息。
在多 Agent 协同群聊中，你可以主动帮助总结群聊讨论结论与 Action Items。`,
  },
  {
    templateId: "analyst",
    name: "数据分析师",
    role: "指标透视、系统日志归因与图表解读专家",
    avatar: "📊",
    category: "analysis",
    duties: [
      "分析系统运行耗时、成功率与流量趋势",
      "透视 SQLite/PostgreSQL 业务数据分布",
      "从海量日志中归纳异常模式与峰值分布",
      "提供客观数据洞察与优化建议",
    ],
    systemPrompt: `# 身份设定：数据分析师 (Analyst)
你是精通数据统计、日志透视与指标洞察的数据分析专家智能体。
你的思考基于客观统计分布，擅长用数字说话，杜绝模糊推断。
在群聊协同中，可为 @全能管家（butler）与 @审查员（inspector）提供量化指标佐证。`,
  },
  {
    templateId: "translator",
    name: "专业翻译官",
    role: "技术术语地道双向翻译与本地化专员",
    avatar: "🌐",
    category: "general",
    duties: [
      "中英技术文档、API 说明与注释精准互译",
      "保留专业术语习惯，杜绝机械机翻生硬感",
      "多语言文案与界面国际化字符串校对",
      "跨语言沟通即时翻译与表达优化",
    ],
    systemPrompt: `# 身份设定：专业翻译官 (Translator)
你是精通现代软件工程术语的地道中英互译专家。
你在翻译技术文档时兼顾「信、达、雅」，保留专业惯用术语（如 pipeline, payload, callback, middleware 等）。`,
  },
  {
    templateId: "auditor",
    name: "合规与风控专员",
    role: "Token 预算把控、敏感密钥合规与风险预警",
    avatar: "🛡️",
    category: "operations",
    duties: [
      "监控多模型调用 Token 消耗与成本异常",
      "扫描环境变量与会话记录中的敏感密钥泄漏",
      "对高危操作和不可逆指令提出风控告警",
      "维护系统安全红线与合规审计基线",
    ],
    systemPrompt: `# 身份设定：合规与风控专员 (Auditor)
你是专职负责预算把关、权限隔离与安全合规守门的风控专家。
你对任何潜在的密钥泄露、未鉴权暴露或超预算消耗保持高度警惕。`,
  },
];

/** 校验 Bot ID 安全性（防路径穿越） */
export function sanitizeBotId(rawId: string): string {
  const clean = rawId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!clean) {
    throw new Error(`Invalid bot id: '${rawId}' contains no valid alphanumeric characters`);
  }
  return clean;
}

/** 确保宿主机 ~/.hermes/profiles/ 目录下存在预设 3 大 Bot 的 SOUL.md 与 config.yaml */
export async function ensurePresetProfiles(hermesRoot: string): Promise<void> {
  const profilesDir = path.join(hermesRoot, "profiles");
  try {
    await fs.mkdir(profilesDir, { recursive: true });
  } catch {
    // 忽略目录创建错误
  }

  for (const preset of PRESET_BOTS) {
    const botDir = path.join(profilesDir, preset.id);
    const soulFile = path.join(botDir, "SOUL.md");
    const configFile = path.join(botDir, "config.yaml");

    try {
      await fs.mkdir(botDir, { recursive: true });
      // 写入 SOUL.md（若不存在则写入）
      try {
        await fs.access(soulFile);
      } catch {
        await fs.writeFile(soulFile, preset.systemPrompt, "utf8");
      }

      // 写入 config.yaml（若不存在则写入）
      try {
        await fs.access(configFile);
      } catch {
        const yamlContent = [
          `name: "${preset.name}"`,
          `role: "${preset.role}"`,
          `avatar: "${preset.avatar}"`,
          `duties:`,
          ...preset.duties.map((d) => `  - "${d}"`),
          `preset: true`,
        ].join("\n") + "\n";
        await fs.writeFile(configFile, yamlContent, "utf8");
      }
    } catch {
      // 容错降级
    }
  }
}

/**
 * 获取宿主机全部可用 Bot 名册（从 ~/.hermes/profiles/ 读取并合并预设）。
 */
export async function listBotProfiles(hermesRoot: string): Promise<BotProfile[]> {
  await ensurePresetProfiles(hermesRoot);

  const profilesDir = path.join(hermesRoot, "profiles");
  const result: BotProfile[] = [...PRESET_BOTS];
  const seenIds = new Set(PRESET_BOTS.map((b) => b.id));

  try {
    const entries = await fs.readdir(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const botId = entry.name.toLowerCase();
      if (seenIds.has(botId)) {
        // 尝试从磁盘刷新 SOUL.md 内容
        const soulFile = path.join(profilesDir, botId, "SOUL.md");
        try {
          const soulContent = await fs.readFile(soulFile, "utf8");
          const idx = result.findIndex((b) => b.id === botId);
          if (idx >= 0 && soulContent.trim()) {
            result[idx].systemPrompt = soulContent;
          }
        } catch {
          // 保留预设
        }
        continue;
      }

      // 读取自定义 Bot Profile
      const botDir = path.join(profilesDir, botId);
      const soulFile = path.join(botDir, "SOUL.md");
      const configFile = path.join(botDir, "config.yaml");

      let soulContent = `你是专职智能体 ${botId}。`;
      let name = botId;
      let role = "自定义专职智能体";
      const duties: string[] = ["协助执行协同任务"];
      let avatar = "🤖";

      try {
        soulContent = await fs.readFile(soulFile, "utf8");
      } catch {
        // 无 SOUL.md
      }

      try {
        const configRaw = await fs.readFile(configFile, "utf8");
        const nameMatch = /^name:\s*"?([^"\n]+)"?/m.exec(configRaw);
        if (nameMatch) name = nameMatch[1].trim();
        const roleMatch = /^role:\s*"?([^"\n]+)"?/m.exec(configRaw);
        if (roleMatch) role = roleMatch[1].trim();
        const avatarMatch = /^avatar:\s*"?([^"\n]+)"?/m.exec(configRaw);
        if (avatarMatch) avatar = avatarMatch[1].trim();
      } catch {
        // 无 config.yaml
      }

      seenIds.add(botId);
      result.push({
        id: botId,
        name,
        role,
        duties,
        systemPrompt: soulContent,
        avatar,
        isPreset: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  } catch {
    // 目录不可读时直接返回预设
  }

  return result;
}

/**
 * 保存或更新一个 Bot Profile 到 ~/.hermes/profiles/<bot_id>/。
 */
export async function saveBotProfile(
  hermesRoot: string,
  bot: Partial<BotProfile> & { id: string; name: string },
): Promise<BotProfile> {
  const botId = sanitizeBotId(bot.id);
  const profilesDir = path.join(hermesRoot, "profiles");
  const botDir = path.join(profilesDir, botId);

  await fs.mkdir(botDir, { recursive: true });

  const role = bot.role?.trim() || "专职协同智能体";
  const duties = Array.isArray(bot.duties) && bot.duties.length > 0 ? bot.duties : ["处理专有业务任务"];
  const systemPrompt = bot.systemPrompt?.trim() || `你是专职智能体「${bot.name}」，负责 ${role}。`;
  const avatar = bot.avatar || "🤖";
  const now = new Date().toISOString();

  // 1. 写入 SOUL.md
  await fs.writeFile(path.join(botDir, "SOUL.md"), systemPrompt, "utf8");

  // 2. 写入 config.yaml
  const yamlContent = [
    `name: "${bot.name}"`,
    `role: "${role}"`,
    `avatar: "${avatar}"`,
    `duties:`,
    ...duties.map((d) => `  - "${d}"`),
    `preset: ${Boolean(bot.isPreset)}`,
  ].join("\n") + "\n";
  await fs.writeFile(path.join(botDir, "config.yaml"), yamlContent, "utf8");

  return {
    id: botId,
    name: bot.name,
    role,
    duties,
    systemPrompt,
    avatar,
    isPreset: Boolean(bot.isPreset),
    createdAt: bot.createdAt || now,
    updatedAt: now,
  };
}

/**
 * 删除一个自定义 Bot Profile（禁止删除系统预设 Bot）。
 */
export async function deleteBotProfile(hermesRoot: string, botId: string): Promise<boolean> {
  const cleanId = sanitizeBotId(botId);
  const isPreset = PRESET_BOTS.some((b) => b.id === cleanId);
  if (isPreset) {
    throw new Error(`Cannot delete preset bot '${cleanId}'`);
  }

  const botDir = path.join(hermesRoot, "profiles", cleanId);
  try {
    await fs.rm(botDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 根据预设模板快速创建并激活一个专职 Bot Profile 到 ~/.hermes/profiles/
 */
export async function createBotFromTemplate(
  hermesRoot: string,
  templateId: string,
  options?: { customId?: string; customName?: string },
): Promise<BotProfile> {
  const template = PRESET_BOT_TEMPLATES.find((t) => t.templateId === templateId);
  if (!template) {
    throw new Error(`Bot template '${templateId}' not found`);
  }

  const targetId = options?.customId ? sanitizeBotId(options.customId) : template.templateId;
  const targetName = options?.customName?.trim() || template.name;

  return saveBotProfile(hermesRoot, {
    id: targetId,
    name: targetName,
    role: template.role,
    duties: [...template.duties],
    systemPrompt: template.systemPrompt,
    avatar: template.avatar,
    isPreset: false,
  });
}
