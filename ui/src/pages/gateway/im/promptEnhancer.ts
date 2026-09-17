/**
 * 提示词增强引擎（Prompt Enhancer）：
 * 1. 规则快道（Fast Rule Optimization）：移植系统 message_optimizer 规则，去客套语、代词消解、动词归一；
 * 2. AI 深度增强（AI Deep Enhancement）：调用智能体/后端重构为可验收、高明确度的指令；
 * 3. 离线无缝降级：网络或后端未就绪时自动以规则快道产出，确保 100% 响应。
 */
import { postJson } from "../../../lib/api.js";
import type { PromptEnhanceResult } from "./imTypes.js";

const FILLER_PREFIX_RE =
  /^(?:请你?帮我看看|请帮我看看|麻烦你帮我看看|帮我看看|请你?帮我|请帮我|麻烦你帮我|麻烦你|帮我一下|帮我个忙|帮我检查|帮我查|能不能帮我|可以帮我|能不能|帮我|麻烦)\s*/i;

const ANAPHORA_PAIRS: Array<[RegExp, string]> = [
  [/你现在的这台电脑|你现在的这台机器|你现在这台电脑|我这台电脑|我的这台电脑|你这台电脑|这台电脑|这台机器|这台设备|这台主机|这台服务器|我的电脑|我的机器|我电脑/g, "本机"],
];

const VERB_NORMALIZE_PAIRS: Array<[RegExp, string]> = [
  [/弄好一点|弄好点|弄好/g, "改进"],
  [/搞一下|弄一下|整一下/g, "处理"],
  [/检查一下|查看一下|看一下|查一下/g, "检查"],
  [/调一下/g, "调整"],
  [/试试看|试一下/g, "尝试"],
  [/看看|查查/g, "检查"],
  [/弄成/g, "设置为"],
  [/发一下/g, "发送"],
  [/(检查|查看|确认|测试|重启|更新|清理|恢复|暂停|运行|打开|关闭|调整|处理|优化|改进|完善|修复|设置|修改|删除|安装|卸载)(?:一下|下)/g, "$1"],
];

/** 规则式快速优化 */
export function enhancePromptRules(rawText: string): { enhanced: string; changes: string[] } {
  let text = rawText.trim();
  const changes: string[] = [];

  // 1. 去除口语客套语
  if (FILLER_PREFIX_RE.test(text)) {
    text = text.replace(FILLER_PREFIX_RE, "").trim();
    changes.push("去除口语客套语");
  }

  // 2. 指代消解
  for (const [regex, replacement] of ANAPHORA_PAIRS) {
    if (regex.test(text)) {
      text = text.replace(regex, replacement);
      changes.push("消解设备代词为「本机」");
    }
  }

  // 3. 动词归一
  for (const [regex, replacement] of VERB_NORMALIZE_PAIRS) {
    if (regex.test(text)) {
      text = text.replace(regex, replacement);
      changes.push("口语动词规范化");
    }
  }

  // 4. 疑问句转明确任务
  const questionMatch = text.match(
    /^(?:检查|查看|确认|测试)(.{1,50}?)(正常了吗|正常么|正常吗|是不是正常|有没有问题|有问题吗|还能用吗|能用吗|够用吗)[？?]?$/
  );
  if (questionMatch) {
    const target = questionMatch[1]?.trim() ?? "";
    text = `检查并验证 ${target} 的运行状态是否正常`;
    changes.push("疑问句转化为明确验收任务");
  } else if (text.endsWith("？") || text.endsWith("?")) {
    text = text.replace(/[？?]+$/, "");
    if (!text.startsWith("请") && !text.startsWith("查询") && !text.startsWith("检查")) {
      text = `查询并分析：${text}`;
      changes.push("疑问转为结构化查询");
    }
  }

  // 5. 超短文本格式补充
  if (text.length <= 4 && !text.includes("：") && !text.includes(":")) {
    text = `请针对「${text}」展开分析，并提供具体的行动建议与状态`;
    changes.push("补充任务上下文与行动建议");
  }

  return { enhanced: text, changes };
}

/** 智能提示词增强（优先后端 AI 重构，降级规则快道） */
export async function enhancePrompt(
  rawText: string,
  timeoutMs = 12_000
): Promise<PromptEnhanceResult> {
  const ruleResult = enhancePromptRules(rawText);
  const trimmed = rawText.trim();
  if (trimmed === "") {
    return { original: "", enhanced: "", mode: "rule", changes: [] };
  }

  try {
    const res = await postJson(
      "/api/messages/prompt-enhance",
      { prompt: trimmed },
      timeoutMs
    );

    const data = res.data as {
      ok?: boolean;
      enhanced?: string;
      reply?: string;
      mode?: "rule" | "llm";
      changes?: string[];
    } | null;

    if (res.ok && data?.enhanced && data.enhanced.trim() !== "") {
      return {
        original: trimmed,
        enhanced: data.enhanced.trim(),
        mode: data.mode ?? "llm",
        changes: data.changes ?? ["AI 深度结构化增强"],
      };
    }
  } catch {
    // 降级使用规则快道
  }

  return {
    original: trimmed,
    enhanced: ruleResult.enhanced,
    mode: "rule",
    changes: ruleResult.changes.length > 0 ? ruleResult.changes : ["规则快速规范"],
  };
}
