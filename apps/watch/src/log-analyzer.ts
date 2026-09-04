/**
 * 系统日志错误分析与一键修复（V1.7 对齐 PRD M1）。
 *
 * 只读扫描各日志源尾部 → 按错误指纹聚合 → 输出可执行修复建议。
 * 修复动作复用 runbook 执行器（快照 → 重启/重连 → 探针复验），
 * HTTP 层要求 confirmed=true 后才执行；无法自动修复的问题标记
 * suggestedAction=null，交给用户人工处理，避免管家乱动系统。
 */

import { createHash } from "node:crypto";

/** 日志源只读视图（与 HTTP 层 logs.listSources 输出一致）。 */
export interface LogSourceView {
  id: string;
  path: string;
  format: string;
  modifiedAt: string | null;
  sizeBytes: number;
}

/** 日志尾部只读视图（与 HTTP 层 logs.readTail 输出一致）。 */
export interface LogTailView {
  sourceId: string;
  path: string;
  format: string;
  lines: string[];
  truncated: boolean;
  limit: number;
  totalLines: number;
  error?: string;
}

/** 一条聚合后的日志问题。 */
export interface LogIssueView {
  id: string;
  kind: string;
  severity: "error" | "warn";
  title: string;
  detail: string;
  count: number;
  sources: string[];
  examples: string[];
  suggestedAction: "rb-restart" | "rb-reconnect" | null;
  actionLabel: string | null;
  lastSeenAt?: string | null;
  skill?: string | null;
  tool?: string | null;
  candidateSkills?: string[];
}

export interface LogAnalyzeView {
  issues: LogIssueView[];
  scannedSources: number;
  scannedLines: number;
  analyzedAt: string;
  coverage?: { from: string | null; to: string | null; sources: number; lines: number; rotatedLogs: boolean; range: "24h" | "7d" | "30d" };
}

export interface LogAnalyzerDeps {
  listSources(instanceId?: string): LogSourceView[];
  readTail(sourceId: string, instanceId?: string, limit?: number): LogTailView | null;
}

interface Rule {
  kind: string;
  severity: "error" | "warn";
  title: string;
  detail: string;
  match: RegExp;
  action: "rb-restart" | "rb-reconnect" | null;
  actionLabel: string | null;
}

/** 每个日志源最多扫描的尾部行数（足够覆盖常见故障窗口，避免大日志卡住管家）。 */
const TAIL_LIMIT = 300;
/** 全部日志源累计扫描行数上限。 */
const MAX_SCANNED_LINES = 20_000;
/** 每条问题最多保留的原始示例行数。 */
const MAX_EXAMPLES = 2;
/** 每条问题最多列出的来源数。 */
const MAX_SOURCES = 3;

const RULES: Rule[] = [
  {
    kind: "llm-billing",
    severity: "error",
    title: "模型账户余额不足",
    detail: "模型服务返回余额不足（HTTP 402）。请充值或切换到可用的备用模型；重启服务无法解决账户余额问题。",
    match: /(\b402\b|insufficient\s+balance|payment\s+required|billing\s+(?:error|required)|quota\s+(?:exhausted|depleted))/i,
    action: null,
    actionLabel: null,
  },
  {
    kind: "llm-auth",
    severity: "error",
    title: "模型凭据失效",
    detail: "模型端点拒绝鉴权（401/403 或无效 Key）。进化任务应保持阻断，先检查 Hermes 的 API Key 与权限。",
    match: /(\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid\s*(?:api[ _-]?)?key|api[ _-]?key.{0,24}(invalid|expired|revoked)|凭据.{0,12}(失效|无效)|密钥.{0,12}(失效|无效))/i,
    action: null,
    actionLabel: null,
  },
  {
    kind: "llm-route",
    severity: "error",
    title: "模型端点或模型名配置错误",
    detail: "模型补全路由返回 404 或模型不存在。进化任务应保持阻断，检查 Base URL、/chat/completions 路径和模型名。",
    match: /(\b404\b|model.{0,24}(not\s+found|does\s+not\s+exist)|unknown\s+model|endpoint.{0,24}not\s+found|chat\/completions.{0,24}not\s+found)/i,
    action: null,
    actionLabel: null,
  },
  {
    kind: "config-error",
    severity: "error",
    title: "Hermes 配置解析失败",
    detail: "配置或环境变量无法解析。Butler 不会自动改写配置，请修复 YAML、变量名或变量值后重试。",
    match: /(yaml|ya?ml|config(?:uration)?|environment\s+variable|env(?:ironment)?\s+var).{0,80}(parse|syntax|invalid|missing|required|error)|(?:parse|syntax).{0,80}(yaml|ya?ml|config|\.env)/i,
    action: null,
    actionLabel: null,
  },
  {
    kind: "tool-failure",
    severity: "error",
    title: "技能工具调用失败",
    detail: "可归属到技能的工具调用失败。先检查日志示例，确认目标后可生成隔离候选进行评估。",
    match: /(?:tool(?:\s+call|\s+invocation)?|function\s+call|技能).{0,80}(fail(?:ed|ure)?|error|exception|timed?\s*out)|(?:fail(?:ed|ure)?|error|exception).{0,80}(tool(?:\s+call|\s+invocation)?|function\s+call|技能)/i,
    action: null,
    actionLabel: null,
  },
  {
    kind: "trajectory-interrupted",
    severity: "error",
    title: "智能体轨迹中断",
    detail: "智能体执行轨迹意外中断。确认具体技能后可生成隔离候选；不自动替换 baseline。",
    match: /(trajectory|trace|agent\s+(?:run|execution)|执行轨迹).{0,80}(interrupt|abort|cancel|stopp?ed|crash|中断|终止|崩溃)/i,
    action: null,
    actionLabel: null,
  },
  {
    kind: "quality-loop",
    severity: "warn",
    title: "输出质量反复修正",
    detail: "发现低质量、格式不符或重复修正信号。建议前往提示词优化页生成候选并做成对评估。",
    match: /(low\s+quality|quality\s+(?:fail|score|regression)|format(?:ting)?\s+(?:fail|invalid|mismatch)|重复修正|反复修改|用户反馈.{0,32}(失败|不满意|错误)|格式.{0,24}(不符|错误|失败))/i,
    action: null,
    actionLabel: null,
  },
  {
    kind: "rate-limit",
    severity: "warn",
    title: "消息限流",
    detail:
      "微信 / iLink 等消息通道被限流。重连通道可以恢复；若反复出现，建议检查节流补丁是否生效。",
    match: /(rate\s?limit|限流|too\s+many\s+requests|429|flood|frequency\s+limit)/i,
    action: "rb-reconnect",
    actionLabel: "重连消息通道",
  },
  {
    kind: "network-timeout",
    severity: "warn",
    title: "网络超时",
    detail: "连接外部服务超时（长轮询 / API / 模型端点）。重连可恢复多数瞬时故障。",
    match: /(timed?\s?out|timeout|ETIMEDOUT|连接超时|超时)/i,
    action: "rb-reconnect",
    actionLabel: "重连消息通道",
  },
  {
    kind: "connection-reset",
    severity: "warn",
    title: "连接被重置",
    detail: "对端主动断开连接（常见于双网关抢占账号或网络抖动）。清理残留进程并重启可恢复。",
    match: /(ECONNRESET|ConnectionReset|connection\s+reset|连接被重置|重置连接)/i,
    action: "rb-reconnect",
    actionLabel: "清理残留进程并重连",
  },
  {
    kind: "port-conflict",
    severity: "error",
    title: "端口被占用",
    detail: "启动失败：端口已被其他进程占用。管家会先清理孤儿进程再重启服务。",
    match: /(EADDRINUSE|address\s+already\s+in\s+use|端口.{0,8}占用|占用.{0,8}端口|port.{0,12}in\s+use)/i,
    action: "rb-restart",
    actionLabel: "清理并重启服务",
  },
  {
    kind: "gateway-crash",
    severity: "error",
    title: "消息网关启动失败",
    detail: "网关多次拒绝启动或崩溃。管家会清理残留进程并重启，随后复验通道。",
    match: /(拒绝启动|gateway.{0,24}(crash|exit|restart|fail)|startup.{0,16}fail|launch.{0,16}fail)/i,
    action: "rb-restart",
    actionLabel: "重启消息网关",
  },
  {
    kind: "oom",
    severity: "error",
    title: "内存不足",
    detail: "进程被系统杀死或内存耗尽。重启可临时恢复，若反复出现建议检查模型端点的并发设置。",
    match: /(out\s+of\s+memory|OOM|memory.{0,12}exhaust|内存不足|killed\s+process)/i,
    action: "rb-restart",
    actionLabel: "重启服务",
  },
  {
    kind: "dependency",
    severity: "error",
    title: "依赖缺失",
    detail: "代码依赖未安装或导入失败。管家不会自动安装依赖，请按提示手动补齐后重启。",
    match: /(ModuleNotFoundError|ImportError|No\s+module\s+named|Cannot\s+find\s+module|依赖缺失|not\s+installed)/i,
    action: null,
    actionLabel: null,
  },
  {
    kind: "disk-space",
    severity: "error",
    title: "磁盘空间不足",
    detail: "磁盘已满，写文件失败。管家不会自动删除数据，请清理磁盘空间后重试。",
    match: /(ENOSPC|no\s+space\s+left|磁盘空间|disk\s+full|device\s+full)/i,
    action: null,
    actionLabel: null,
  },
  {
    kind: "generic-error",
    severity: "error",
    title: "系统错误",
    detail: "日志中出现未归类的错误。管家可尝试重启服务；若问题仍在，请查看原始日志定位。",
    match: /(^|\s)(ERROR|CRITICAL|FATAL|Traceback|Exception)(\s|:|\()/i,
    action: "rb-restart",
    actionLabel: "重启服务",
  },
];

/** 错误指纹：去掉时间戳、数字、路径等变量，把同类错误归为一条。 */
function fingerprint(line: string): string {
  return line
    .replace(/[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}/g, "DATE")
    .replace(/[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?/g, "TIME")
    .replace(/\b[0-9]+(\.[0-9]+)+\b/g, "N")
    .replace(/\b[0-9]+\b/g, "N")
    .replace(/[`"'()[\]{}:;,|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 160);
}

function stableId(kind: string, fp: string): string {
  return createHash("sha1").update(`${kind}:${fp}`).digest("hex").slice(0, 12);
}

interface Bucket {
  id: string;
  kind: string;
  severity: "error" | "warn";
  title: string;
  detail: string;
  count: number;
  sources: Set<string>;
  examples: string[];
  action: "rb-restart" | "rb-reconnect" | null;
  actionLabel: string | null;
  lastSeenAt: number | null;
  skill: string | null;
  tool: string | null;
}

export interface LogAnalyzer {
  analyze(instanceId?: string, range?: "24h" | "7d" | "30d"): LogAnalyzeView;
}

export function createLogAnalyzer(deps: LogAnalyzerDeps): LogAnalyzer {
  function analyze(instanceId?: string, range: "24h" | "7d" | "30d" = "7d"): LogAnalyzeView {
    const sources = deps.listSources(instanceId);
    const buckets = new Map<string, Bucket>();
    let scannedLines = 0;
    const now = Date.now();
    const windowMs = range === "24h" ? 24 * 3600_000 : range === "30d" ? 30 * 86400_000 : 7 * 86400_000;
    const from = new Date(now - windowMs);
    let minSeen: number | null = null;
    let maxSeen: number | null = null;
    let rotatedLogs = false;
    const parseTimestamp = (line: string): number | null => {
      const match = line.match(/(20\d\d[-/]\d\d?[-/]\d\d?(?:[T ]\d\d?:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)?)/);
      if (!match) return null;
      const value = Date.parse(match[1]!.replace(/\//g, "-"));
      return Number.isFinite(value) ? value : null;
    };
    const redact = (line: string): string => line
      .replace(/((?:api[_ -]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/((?:prompt|message|content|chat)\s*[:=])[^\n]*/gi, "$1 [REDACTED]")
      .replace(/(?:[A-Za-z]:\\|\/home\/|\/Users\/|\/mnt\/)[^\s]+/g, "[PATH]")
      .slice(0, 240);
    const extractSkill = (line: string): string | null => line.match(/(?:skills?[\\/]|--skill[= ]|skill(?:Name|Ref)?[=: ]+)([A-Za-z0-9._/-]+)/i)?.[1] ?? null;
    const extractTool = (line: string): string | null => line.match(/(?:tool|function)(?:\s+call|\s+invocation)?[=: ]+([A-Za-z0-9._/-]+)/i)?.[1] ?? null;

    for (const source of sources) {
      const tail = deps.readTail(source.id, instanceId, TAIL_LIMIT);
      if (tail === null || tail.error !== undefined) continue;
      if (/rotat|\.\d+(?:\.[A-Za-z0-9]+)*$|\.bak(?:\.gz)?$|\.gz$/i.test(source.path)) rotatedLogs = true;
      for (const line of tail.lines) {
        if (scannedLines >= MAX_SCANNED_LINES) break;
        const seen = parseTimestamp(line);
        if (seen !== null) {
          if (seen < from.getTime()) continue;
          minSeen = minSeen === null ? seen : Math.min(minSeen, seen);
          maxSeen = maxSeen === null ? seen : Math.max(maxSeen, seen);
        }
        scannedLines += 1;
        const rule = RULES.find((item) => item.match.test(line));
        if (rule === undefined) continue;
        const fp = fingerprint(line);
        const key = `${rule.kind}:${fp}`;
        let bucket = buckets.get(key);
        if (bucket === undefined) {
          bucket = {
            id: stableId(rule.kind, fp),
            kind: rule.kind,
            severity: rule.severity,
            title: rule.title,
            detail: rule.detail,
            count: 0,
            sources: new Set(),
            examples: [],
            action: rule.action,
            actionLabel: rule.actionLabel,
            lastSeenAt: null,
            skill: null,
            tool: null,
          };
          buckets.set(key, bucket);
        }
        bucket.count += 1;
        if (seen !== null) bucket.lastSeenAt = bucket.lastSeenAt === null ? seen : Math.max(bucket.lastSeenAt, seen);
        const rawSkill = extractSkill(line);
        const rawTool = extractTool(line);
        if (rawSkill !== null) bucket.skill = rawSkill;
        if (rawTool !== null) bucket.tool = rawTool;
        if (bucket.sources.size < MAX_SOURCES) bucket.sources.add(source.id);
        if (bucket.examples.length < MAX_EXAMPLES) bucket.examples.push(redact(line));
      }
    }

    const issues = [...buckets.values()]
      .sort(
        (a, b) =>
          b.count - a.count ||
          (a.severity === "error" ? -1 : 1) - (b.severity === "error" ? -1 : 1),
      )
      .map((bucket) => ({
        id: bucket.id,
        kind: bucket.kind,
        severity: bucket.severity,
        title: bucket.title,
        detail: bucket.detail,
        count: bucket.count,
        sources: [...bucket.sources],
        examples: bucket.examples,
        suggestedAction: bucket.action,
        actionLabel: bucket.actionLabel,
        lastSeenAt: bucket.lastSeenAt === null ? null : new Date(bucket.lastSeenAt).toISOString(),
        skill: bucket.skill,
        tool: bucket.tool,
        candidateSkills: [],
      }));

    return {
      issues,
      scannedSources: sources.length,
      scannedLines,
      analyzedAt: new Date().toISOString(),
      coverage: { from: minSeen === null ? from.toISOString() : new Date(minSeen).toISOString(), to: maxSeen === null ? new Date(now).toISOString() : new Date(maxSeen).toISOString(), sources: sources.length, lines: scannedLines, rotatedLogs, range },
    };
  }

  return { analyze };
}
