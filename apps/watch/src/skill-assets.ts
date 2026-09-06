import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { atomicWriteJson, withManagedOperationLock, type Core, type InstanceRecord } from "@butler/core";
import { resolveGithubToken } from "./github-token.js";
import { createSkillHubClient, isNewerVersion, parseGitSource, readTarGzEntries, readZipEntries, type SkillHubCategoriesView, type SkillHubClient, type SkillHubListQuery, type SkillHubListView, type ZipEntry } from "./skillhub.js";
import type { BackupService } from "./backup.js";
import type { BackupGate } from "./backup-gate.js";
import type { SkillsMemoryService } from "./skills.js";

export interface SkillUsageItem { name: string; calls: number; lastUsedAt: string | null; successRate: number | null; avgDurationMs: number | null; status: "known" | "unknown" }
export type UsageGranularity = "day" | "week" | "month";
export interface SkillUsageView { rangeDays: number; granularity: UsageGranularity; coverage: { from: string | null; to: string | null; days: number; source: string; complete: boolean }; series: Array<{ date: string; calls: number }>; skills: SkillUsageItem[]; notice: string }
export interface SkillAssetService {
  usage(rangeDays?: number, granularity?: UsageGranularity): Promise<SkillUsageView>;
  archive(name: string, thresholdDays?: number): Promise<Record<string, unknown>>;
  restore(name: string): Promise<Record<string, unknown>>;
  purge(name: string, confirmed: boolean): Promise<Record<string, unknown>>;
  githubTrends(query?: { filter?: string; sort?: string }): Promise<Record<string, unknown>>;
  refreshGithubTrends(): Promise<Record<string, unknown>>;
  recommendations(): Promise<Record<string, unknown>>;
  stageRecommendation(id: string): Promise<Record<string, unknown>>;
  installStaged(id: string, confirmed: boolean, overwrite?: boolean): Promise<Record<string, unknown>>;
  /** SkillHub（skillhub.cn）目录：一级分类（带短缓存）。 */
  skillHubCategories(): Promise<SkillHubCategoriesView>;
  /** SkillHub 列表/搜索：关键词 + 分类 + 排序 + 分页。 */
  skillHubList(query: SkillHubListQuery): Promise<SkillHubListView>;
  /** SkillHub 技能暂存：下载 zip → 解压校验 → 风险扫描 → 写入隔离区（复用 installStaged 确认安装）。 */
  stageSkillHub(slug: string): Promise<Record<string, unknown>>;
  /** GitHub 仓库暂存：下载 tarball → 定位根目录 SKILL.md → 风险扫描 → 隔离区。 */
  stageGitSource(url: string): Promise<Record<string, unknown>>;
  /** 本机已装技能清单：以 Hermes 技能目录为唯一事实来源。 */
  listLocal(): Promise<LocalSkillsView>;
  /** 删除本机技能：先移入备份区（可手动恢复），confirmed=false 时只返回预览。 */
  removeLocal(name: string, confirmed: boolean): Promise<Record<string, unknown>>;
  /** 已装技能更新检查：SkillHub 比对版本、Git 比对最新 commit。 */
  checkLocalUpdates(): Promise<LocalUpdatesView>;
  /** 更新单个技能：重新下载最新版并覆盖本机（旧版本移入备份区）。 */
  updateLocal(name: string, confirmed: boolean): Promise<Record<string, unknown>>;
}
export interface SkillStaticRiskReport {
  status: "clear" | "blocked";
  externalDomains: string[];
  sensitivePaths: string[];
  dangerousCommands: string[];
  detail: string;
}

/** 本机已装技能（Hermes 技能目录扫描结果）。 */
export interface LocalSkillView {
  /** 目录名（唯一标识）。 */
  name: string;
  displayName: string;
  description: string;
  version: string | null;
  origin: "skillhub" | "git" | "local";
  slug: string | null;
  gitUrl: string | null;
  ref: string | null;
  commit: string | null;
  installedAt: string | null;
}
export interface LocalSkillsView {
  items: LocalSkillView[];
  root: string;
}
export interface LocalUpdateItem {
  name: string;
  status: "up_to_date" | "available" | "unknown";
  installedVersion: string | null;
  latestVersion: string | null;
  reason?: string;
}
export interface LocalUpdatesView {
  items: LocalUpdateItem[];
  checkedAt: string;
}
type ArchivedMeta = { name: string; source: string; originalPath: string; archivePath: string; archivedAt: string; hash: string };
type LogSource = { id: string; path?: string; format?: string };
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type GithubRequestError = Error & {
  status?: number;
  apiMessage?: string;
  rateLimitRemaining?: string | null;
  rateLimitReset?: number | null;
};

const GITHUB_USER_AGENT = "agent-butler/1.0.0-beta.17";

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": GITHUB_USER_AGENT,
    ...(token === "" ? {} : { Authorization: `Bearer ${token}` }),
  };
}

async function githubResponseError(response: Response, operation: string): Promise<GithubRequestError> {
  let apiMessage: string | undefined;
  try {
    const body = await response.json() as { message?: unknown };
    if (typeof body.message === "string") apiMessage = body.message;
  } catch {
    // Some proxies return an empty or non-JSON error body.
  }
  const error = new Error(`${operation} HTTP ${response.status}`) as GithubRequestError;
  error.status = response.status;
  error.apiMessage = apiMessage;
  error.rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  error.rateLimitReset = Number.isFinite(reset) && reset > 0 ? reset : null;
  return error;
}

function githubFailure(error: unknown): { code: string; detail: string; fix: string; retryAt?: string } {
  const failure = error as Partial<GithubRequestError>;
  const message = typeof failure.apiMessage === "string" ? failure.apiMessage : error instanceof Error ? error.message : String(error);
  const rateLimited = failure.status === 429 || (failure.status === 403 && (failure.rateLimitRemaining === "0" || /rate limit exceeded/i.test(message)));
  if (rateLimited) {
    return {
      code: "github-rate-limit",
      detail: "GitHub 公共 API 当前已达到请求限额。",
      fix: "稍后重试；如需立即安装，请在部署环境配置 GITHUB_TOKEN 后重启 Butler。",
      ...(failure.rateLimitReset !== undefined && failure.rateLimitReset !== null ? { retryAt: new Date(failure.rateLimitReset * 1000).toISOString() } : {}),
    };
  }
  if (failure.status === 401 || failure.status === 403) {
    return { code: "github-access-denied", detail: "GitHub 仓库无法访问。", fix: "确认仓库公开且可访问；私有仓库请检查 GITHUB_TOKEN 权限。" };
  }
  if (failure.status === 404) {
    return { code: "github-repository-not-found", detail: "GitHub 仓库或技能文件不存在。", fix: "确认推荐项目仍存在，并包含 SKILL.md 后重试。" };
  }
  if (failure.status === undefined) {
    return { code: "github-network-error", detail: "当前无法连接 GitHub。", fix: "检查网络或代理设置，稍后重试。" };
  }
  return { code: "github-request-failed", detail: "GitHub 暂时无法提供技能文件。", fix: "稍后重试；如果持续失败，请检查仓库状态。" };
}

function iso(now: () => number): string { return new Date(now()).toISOString(); }
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeName(value: string): string | null { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) ? value : null; }
function instanceOf(core: Core): InstanceRecord | undefined { const all = core.instances.listInstances().filter((i) => i.rootPath !== ""); return all.find((i) => i.state === "Serving") ?? all[0]; }
function findSkill(root: string, name: string): string | null {
  const base = join(root, "skills");
  const visit = (dir: string, depth: number): string | null => {
    if (depth > 8) return null;
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === name && existsSync(join(path, "SKILL.md"))) return path;
      const nested = visit(path, depth + 1); if (nested) return nested;
    }
    return null;
  };
  return existsSync(base) ? visit(base, 0) : null;
}
function inside(path: string, root: string): boolean { const rel = relative(resolve(root), resolve(path)); return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !rel.includes(".." + sep)); }

/**
 * 目录落位：优先原子 rename；跨挂载（EXDEV，如 Butler 数据卷 → Hermes 挂载目录）
 * 退化为「复制 → 校验 → 删源」，其余错误原样抛出。verify 在删源前对目标做校验，
 * 失败时清理目标副本，保持源目录完好可重试。
 */
export function moveDirSync(
  from: string,
  to: string,
  options: { verify?: (target: string) => void; rename?: typeof renameSync } = {},
): void {
  const rename = options.rename ?? renameSync;
  try {
    rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") throw error;
  }
  cpSync(from, to, { recursive: true });
  try {
    options.verify?.(to);
  } catch (error) {
    rmSync(to, { recursive: true, force: true });
    throw error;
  }
  rmSync(from, { recursive: true, force: true });
}

function verifySkillDir(target: string): void {
  if (!existsSync(join(target, "SKILL.md"))) throw new Error("落位后缺少 SKILL.md，已回滚");
}

/**
 * 从 SKILL.md frontmatter 提取技能名：先取 `---` 围栏块，再在块内按行匹配 name。
 * 此前直接对全文找「换行 + name:」，而标准 frontmatter 的 name 就在 `---` 下一行，
 * 前置换行已被消费，导致永远匹配不上、安装名回退成暂存 UUID。
 */
export function skillNameFromFrontmatter(raw: string): string | null {
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1];
  if (block === undefined) return null;
  const name = /^[ \t]*name:[ \t]*([A-Za-z0-9][A-Za-z0-9._-]{0,159})[ \t]*\r?$/im.exec(block)?.[1];
  return name ?? null;
}

/** frontmatter 摘要（名称/描述/版本），用于本机技能清单展示。 */
export function skillFrontmatter(raw: string): { name: string | null; description: string | null; version: string | null } {
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1];
  if (block === undefined) return { name: null, description: null, version: null };
  const singleLine = (key: string): string | null => {
    const match = new RegExp(`^[ \\t]*${key}:[ \\t]*(.*?)[ \\t]*\\r?$`, "im").exec(block)?.[1];
    if (match === undefined) return null;
    const value = match.replace(/^["']|["']$/g, "").trim();
    return value === "" ? null : value.slice(0, 400);
  };
  return {
    name: skillNameFromFrontmatter(raw),
    description: singleLine("description"),
    version: singleLine("version"),
  };
}

function isRecordObj(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 读取技能目录内的 source.json（缺失/损坏返回 null）。 */
function readSourceJson(dir: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "source.json"), "utf8")) as unknown;
    return isRecordObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 剥掉包体唯一的顶层目录前缀（SkillHub zip 与 GitHub tarball 都可能整体包裹）。 */
function stripCommonPrefix(files: ZipEntry[]): ZipEntry[] {
  const tops = new Set(files.map((file) => file.path.split("/")[0]!));
  if (tops.size !== 1) return files;
  const prefix = `${[...tops][0]!}/`;
  return files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ path: file.path.slice(prefix.length), data: file.data }));
}
function usageBucket(timestamp: string, granularity: UsageGranularity): string {
  const date = new Date(timestamp);
  if (granularity === "month") return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
  if (granularity === "week") {
    const day = date.getUTCDay();
    date.setUTCDate(date.getUTCDate() + (day === 0 ? -6 : 1 - day));
    return date.toISOString().slice(0, 10);
  }
  return timestamp.slice(0, 10);
}

function logTimestamp(line: string): string | null {
  const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(line)?.[1];
  const spaced = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(line);
  const candidate = iso ?? (spaced ? `${spaced[1]}T${spaced[2]}Z` : null);
  if (candidate === null || !Number.isFinite(Date.parse(candidate))) return null;
  return new Date(candidate).toISOString();
}

function normalizeExternalDomain(value: string): string | null {
  const normalized = value.toLowerCase().replace(/[`'"<>\]}),.;:!?]+$/g, "");
  return normalized === "" || normalized === "..." ? null : normalized;
}

/** 对暂存的 SKILL.md 做轻量静态风险检查；它不是沙箱，也不宣称代码安全。 */
export function inspectSkillText(text: string): SkillStaticRiskReport {
  const externalDomains = [...new Set(
    [...text.matchAll(/\bhttps?:\/\/([^/\s)"'<>，。；;,]+)/gi)]
      .map((match) => normalizeExternalDomain(match[1] ?? ""))
      .filter((domain): domain is string => domain !== null),
  )].slice(0, 20);
  const sensitivePaths = [...new Set(
    [...text.matchAll(/(?:~\/\.ssh|~\/\.aws|\/etc\/[A-Za-z0-9_.-]+|\.env\b|memory_store\.db|\b[A-Za-z0-9][A-Za-z0-9_-]*(?:api[_ -]?key|access[_ -]?token|secret|credential)s?)\b/gi)]
      .map((match) => match[0] ?? ""),
  )].slice(0, 20);
  const dangerousCommands = [...new Set(
    [...text.matchAll(/(?:^|\s)((?:sudo\b|rm\s+-rf\b|curl\b|wget\b|Invoke-WebRequest\b|docker\s+(?:run|exec)\b|chmod\s+777\b)[^\n]*)/gim)]
      .map((match) => match[1]?.trim() ?? ""),
  )].slice(0, 20);
  const blocked = sensitivePaths.length > 0 || dangerousCommands.length > 0;
  const detail = blocked
    ? "检测到敏感路径/凭据相关内容或高风险命令，已阻止安装；请先人工审阅来源。"
    : externalDomains.length > 0
      ? `未发现已知高风险命令，但包含 ${externalDomains.length} 个外联域名，安装前请确认来源。`
      : "未发现已知高风险命令或敏感路径；这不是完整沙箱审计。";
  return { status: blocked ? "blocked" : "clear", externalDomains, sensitivePaths, dangerousCommands, detail };
}

function usedSkillName(line: string): string | null {
  const activity = /\b(?:invoked|started|completed|succeeded|success|failed|failure|executing|executed|running)\b|调用|执行|开始|完成|失败/i;
  if (!activity.test(line)) return null;
  const assignment = /\b(?:skill_name|skill\s+name|skill)\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._/-]{1,159})/i.exec(line)?.[1];
  const quoted = /\bskill\s+["']([A-Za-z0-9][A-Za-z0-9._/-]{1,159})["']\s+(?:was\s+)?(?:invoked|started|completed|succeeded|failed)\b/i.exec(line)?.[1];
  return (assignment ?? quoted)?.split("@")[0] ?? null;
}

const repositoryDescriptions: Record<string, string> = {
  "obra/superpowers": "软件开发任务的规划、实现与复查工作流。",
  "affaan-m/ECC": "面向编码代理的工程规范与开发检查清单。",
  "mattpocock/skills": "TypeScript 和应用开发相关的可复用技能集合。",
  "anthropics/skills": "文档、演示文稿和应用构建相关技能集合。",
  "Shubhamsaboo/awesome-llm-apps": "大模型应用和智能体项目示例集合。",
  "addyosmani/agent-skills": "前端与工程任务中可复用的代理技能示例。",
  "Leonxlnx/taste-skill": "用于改进界面体验和视觉细节的技能示例。",
  "bytedance/deer-flow": "面向复杂任务的多步骤智能体工作流项目。",
};
function describeRepository(name: string): string {
  const known = repositoryDescriptions[name];
  if (known) return known;
  return "公开技能项目，具体用途以仓库说明为准。";
}

export function createSkillAssetService(deps: { core: Core; skills: SkillsMemoryService; backup?: BackupService; backupGate?: BackupGate; logs?: { listSources(instanceId?: string): LogSource[]; readTail(sourceId: string, instanceId?: string, limit?: number): Promise<{ lines: string[] } | null> }; now?: () => number; fetch?: FetchLike; githubToken?: string; skillHub?: SkillHubClient }): SkillAssetService {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const skillHub = deps.skillHub ?? createSkillHubClient({ fetchImpl, now });
  // GitHub 令牌优先级：env（部署显式配置）> 注入 dep（测试）> 设置页保存的
  // <home>/github-token.json（与本体目录同源解析）；都没有则匿名访问（受限流）。
  const githubToken = resolveGithubToken(deps.core.paths.home, deps.githubToken).trim();
  const headers = githubHeaders(githubToken);
  const root = join(deps.core.paths.home, "skill-assets"); const archiveRoot = join(root, "archive"); const stageRoot = join(root, "staged"); const trendPath = join(root, "github-trends.json");
  mkdirSync(archiveRoot, { recursive: true }); mkdirSync(stageRoot, { recursive: true });
  const archived = new Map<string, ArchivedMeta>();
  for (const file of readdirSync(archiveRoot, { withFileTypes: true })) { if (!file.isDirectory()) continue; try { const meta = JSON.parse(readFileSync(join(archiveRoot, file.name, "meta.json"), "utf8")) as ArchivedMeta; archived.set(meta.name, meta); } catch { /* ignore corrupt archive */ } }
  const usage = async (rangeDays = 180, granularity: UsageGranularity = "day"): Promise<SkillUsageView> => {
    const days = [30, 90, 180].includes(rangeDays) ? rangeDays : 180; const instance = instanceOf(deps.core); const view = instance ? await deps.skills.status({ instanceId: instance.instanceId }) : null; const known = new Set((view?.skills.items ?? []).map((i) => i.name));
    const counts = new Map<string, { calls: number; last: string | null; successes: number; failures: number; durations: number[] }>(); const series = new Map<string, number>(); let sources = 0; let from: string | null = null; let to: string | null = null;
    if (deps.logs && instance) {
      const cutoff = now() - Number(days) * 86400000;
      for (const source of deps.logs.listSources(instance.instanceId)) {
        const tail = await deps.logs.readTail(source.id, instance.instanceId, 2000);
        if (!tail) continue;
        sources += 1;
        for (const line of tail.lines) {
          const name = usedSkillName(line);
          const timestamp = logTimestamp(line);
          if (name === null || timestamp === null) continue;
          if (Date.parse(timestamp) < cutoff) continue;
          const item = counts.get(name) ?? { calls: 0, last: null as string | null, successes: 0, failures: 0, durations: [] as number[] };
          item.calls += 1;
          if (/\b(success|succeeded|ok|成功)\b/i.test(line)) item.successes += 1;
          if (/\b(fail(?:ed|ure)?|error|失败|错误)\b/i.test(line)) item.failures += 1;
          const duration = /(?:duration|耗时|latency)[\s:=]+(\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(line);
          if (duration) item.durations.push(Number(duration[1]) * (duration[2]?.toLowerCase() === "s" ? 1000 : 1));
          item.last = item.last === null || item.last < timestamp ? timestamp : item.last;
          counts.set(name, item);
          const date = usageBucket(timestamp, granularity);
          series.set(date, (series.get(date) ?? 0) + 1);
          if (from === null || timestamp.localeCompare(from) < 0) from = timestamp;
          if (to === null || timestamp.localeCompare(to) > 0) to = timestamp;
        }
      }
    }
    const skills = [...new Set([...known, ...counts.keys()])].map((name) => { const item = counts.get(name); const observed = (item?.successes ?? 0) + (item?.failures ?? 0); return { name, calls: item?.calls ?? 0, lastUsedAt: item?.last ?? null, successRate: observed > 0 ? (item?.successes ?? 0) / observed : null, avgDurationMs: item && item.durations.length > 0 ? item.durations.reduce((sum, value) => sum + value, 0) / item.durations.length : null, status: known.has(name) ? "known" as const : "unknown" as const }; }).sort((a, b) => b.calls - a.calls || (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") || a.name.localeCompare(b.name));
    return { rangeDays: days, granularity, coverage: { from, to, days: from && to ? Math.max(1, Math.ceil((Date.parse(to) - Date.parse(from)) / 86400000)) : 0, source: sources ? "Hermes 日志" : "未读取到 Hermes 日志", complete: sources > 0 }, series: [...series.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, calls]) => ({ date, calls })), skills, notice: "成功率和耗时只有在日志明确记录时展示，否则为未知。" };
  };
  /** 把解压后的技能文件写入隔离区；meta 写入 source.json。返回 stageId（失败自动清理）。
   *  根目录 SKILL.md 存在 → 单技能；否则扫描一级子目录的 SKILL.md 作为合集（安装时逐个落位）。 */
  const stageFromEntries = (files: ZipEntry[], sourceUrl: string, meta: Record<string, unknown>): { id: string; name: string | null; risk: SkillStaticRiskReport; collection: number } => {
    const byDepth = (a: ZipEntry, b: ZipEntry) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path);
    const skillEntry = files.find((item) => item.path === "SKILL.md") ?? [...files].filter((item) => item.path.endsWith("/SKILL.md") || item.path === "SKILL.md").sort(byDepth)[0];
    if (skillEntry === undefined) throw new Error("skill-md-missing");
    const skillText = new TextDecoder().decode(skillEntry.data);
    const risk = inspectSkillText(skillText);
    const stageId = randomUUID();
    const path = join(stageRoot, stageId);
    try {
      mkdirSync(path, { recursive: true });
      for (const file of files) {
        const target = join(path, ...file.path.split("/"));
        if (!inside(target, path)) throw new Error("unsafe entry path: " + file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.data, { mode: 0o600 });
      }
      // 合集规模：一级子目录中含 SKILL.md 的数量（根目录 SKILL.md 存在时为 1）。
      const collectionCount = files.some((item) => item.path === "SKILL.md")
        ? 1
        : new Set(files.filter((item) => /^[^/]+\/SKILL\.md$/.test(item.path)).map((item) => item.path.split("/")[0])).size;
      atomicWriteJson(join(path, "source.json"), { id: stageId, sourceUrl, stagedAt: iso(now), ...(collectionCount > 1 ? { collection: collectionCount } : {}), ...meta }, { mode: 0o600, description: "隔离技能来源" });
      return { id: stageId, name: skillNameFromFrontmatter(skillText), risk, collection: collectionCount };
    } catch (error) {
      rmSync(path, { recursive: true, force: true });
      throw error;
    }
  };
  const guardedMutation = async (
    instance: InstanceRecord,
    action: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => withManagedOperationLock(`instance:${instance.instanceId}:skills`, async () => {
    if (deps.backupGate) {
      const gate = await deps.backupGate.ensure({
        instanceId: instance.instanceId,
        framework: instance.frameworkId,
        version: instance.version,
        rootPath: instance.rootPath,
        operation: "skill",
      });
      if (!gate.allowed) {
        return {
          ok: false,
          error: "backup-required",
          fix: gate.detail,
          manualBackupAction: gate.manualBackupAction,
        };
      }
    }
    return action();
  });
  return {
    usage,
    async archive(name, thresholdDays = 90) {
      const safe = safeName(name);
      const instance = instanceOf(deps.core);
      if (!safe) return { ok: false, error: "invalid-name", fix: "使用合法技能名称" };
      if (!instance) return { ok: false, error: "no-instance", fix: "先连接 Hermes 实例" };
      const view = await deps.skills.status({ instanceId: instance.instanceId });
      const item = view.skills.items.find((i) => i.name === safe);
      if (!item) return { ok: false, error: "skill-not-found", fix: "刷新技能清单后重试" };
      if (item.source === "builtin") return { ok: false, error: "builtin-readonly", fix: "内置技能不可物理归档" };
      const dir = findSkill(instance.rootPath, safe);
      if (!dir) return { ok: false, error: "skill-path-not-found", fix: "检查 Hermes skills 目录" };
      const last = (await usage(180)).skills.find((i) => i.name === safe)?.lastUsedAt;
      if (last && now() - Date.parse(last) < thresholdDays * 86400000) return { ok: false, error: "skill-not-idle", fix: "等待达到闲置阈值后再归档" };
      return guardedMutation(instance, async () => {
        try {
          if (!deps.backupGate && deps.backup) await deps.backup.run("event", "归档技能 " + safe);
          const archivePath = join(archiveRoot, safe + "-" + now());
          moveDirSync(dir, archivePath, { verify: verifySkillDir });
          const meta: ArchivedMeta = { name: safe, source: item.source, originalPath: dir, archivePath, archivedAt: iso(now), hash: sha(readFileSync(join(archivePath, "SKILL.md"), "utf8")) };
          atomicWriteJson(join(archivePath, "meta.json"), meta, { mode: 0o600, description: "技能归档元数据" });
          archived.set(safe, meta);
          deps.core.audit.append({ actor: "skills", action: "skill-archived", target: safe, detail: { thresholdDays } });
          return { ok: true, name: safe, archivedAt: meta.archivedAt };
        } catch (error) {
          return { ok: false, error: "archive-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查备份目录和文件权限" };
        }
      });
    },
    async restore(name) {
      const meta = archived.get(name);
      const instance = instanceOf(deps.core);
      if (!meta) return { ok: false, error: "archive-not-found", fix: "只有已归档技能可恢复" };
      if (!instance) return { ok: false, error: "no-instance", fix: "先连接 Hermes 实例" };
      return guardedMutation(instance, async () => {
        try {
          if (!inside(meta.archivePath, archiveRoot) || !inside(meta.originalPath, join(instance.rootPath, "skills"))) throw new Error("path-not-allowed");
          if (existsSync(meta.originalPath)) return { ok: false, error: "target-exists", fix: "清理冲突目录后重试" };
          const hash = sha(readFileSync(join(meta.archivePath, "SKILL.md"), "utf8"));
          if (hash !== meta.hash) return { ok: false, error: "hash-conflict", fix: "归档内容已变化，禁止恢复" };
          mkdirSync(dirname(meta.originalPath), { recursive: true });
          moveDirSync(meta.archivePath, meta.originalPath, { verify: verifySkillDir });
          archived.delete(name);
          return { ok: true, name };
        } catch (error) {
          return { ok: false, error: "restore-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查原始路径和归档目录" };
        }
      });
    },
    async purge(name, confirmed) {
      const meta = archived.get(name);
      const instance = instanceOf(deps.core);
      if (!meta) return { ok: false, error: "archive-not-found", fix: "永久删除仅对已归档技能开放" };
      if (!confirmed) return { ok: false, error: "confirmation-required", fix: "二次确认永久删除" };
      if (!instance) return { ok: false, error: "no-instance", fix: "先连接 Hermes 实例" };
      return guardedMutation(instance, async () => {
        try {
          if (!inside(meta.archivePath, archiveRoot)) throw new Error("path-not-allowed");
          rmSync(meta.archivePath, { recursive: true, force: true });
          archived.delete(name);
          deps.core.audit.append({ actor: "skills", action: "skill-purged", target: name, detail: {} });
          return { ok: true, name };
        } catch (error) {
          return { ok: false, error: "purge-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查归档目录权限" };
        }
      });
    },
    async githubTrends(query = {}) { let cached: Record<string, unknown> = {}; try { cached = JSON.parse(readFileSync(trendPath, "utf8")) as Record<string, unknown>; } catch { /* empty cache */ } const items = Array.isArray(cached.items) ? cached.items.map((item) => { const row = item as Record<string, unknown>; const name = String(row["name"] ?? ""); return { ...row, description: describeRepository(name) }; }) : []; return { items, filter: query.filter ?? "all", sort: query.sort ?? "trend", syncedAt: cached.syncedAt ?? null, source: "GitHub public API cache", notice: "公开仓库趋势，不代表官方 Hermes 技能排名。" }; },
    async refreshGithubTrends() { try { const response = await fetchImpl("https://api.github.com/search/repositories?q=agent+skill+OR+hermes+skill+OR+openclaw+skill&sort=stars&order=desc&per_page=30", { headers, signal: AbortSignal.timeout(10000) }); if (!response.ok) throw await githubResponseError(response, "GitHub search"); const body = await response.json() as { items?: Array<Record<string, unknown>> }; const payload = { syncedAt: iso(now), items: (body.items ?? []).map((i) => { const name = String(i["full_name"] ?? ""); return { name, url: String(i["html_url"] ?? ""), stars: Number(i["stargazers_count"] ?? 0), forks: Number(i["forks_count"] ?? 0), updatedAt: String(i["updated_at"] ?? ""), description: describeRepository(name) }; }) }; atomicWriteJson(trendPath, payload, { mode: 0o600, description: "技能趋势缓存" }); return { ...payload, notice: "公开仓库趋势，不代表官方 Hermes 技能排名。" }; } catch (error) { const failure = githubFailure(error); return { ...(await this.githubTrends()), error: failure.code, detail: failure.detail, fix: failure.fix, ...(failure.retryAt === undefined ? {} : { retryAt: failure.retryAt }), notice: "同步失败，继续使用上次缓存（如有）。" }; } },
    async recommendations() { const stats = await usage(90); const trends = await this.githubTrends(); const installed = new Set(stats.skills.filter((i) => i.status === "known").map((i) => i.name)); const items = (Array.isArray(trends.items) ? trends.items : []).filter((i) => typeof i === "object" && i !== null).map((i) => { const row = i as Record<string, unknown>; const name = String(row["name"] ?? ""); const description = describeRepository(name); return { id: "github:" + name, name, description, reason: description, sourceUrl: row["url"] ?? "", installed: installed.has(name) }; }).filter((i) => !i.installed); return { items, generatedAt: iso(now), notice: "推荐结合本地使用情况和公开仓库信息，不自动安装。" }; },
    async stageRecommendation(id) { if (!id.startsWith("github:")) return { ok: false, error: "invalid-recommendation", fix: "选择公开 GitHub 推荐" }; const source = id.slice("github:".length); if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) return { ok: false, error: "invalid-recommendation", fix: "GitHub 仓库标识无效" }; const stageId = randomUUID(); const path = join(stageRoot, stageId); mkdirSync(path, { recursive: true }); try { const treeResponse = await fetchImpl("https://api.github.com/repos/" + source + "/git/trees/HEAD?recursive=1", { headers, signal: AbortSignal.timeout(15000) }); if (!treeResponse.ok) throw await githubResponseError(treeResponse, "GitHub tree"); const tree = await treeResponse.json() as { tree?: Array<{ path?: string; type?: string }> }; const skillPath = (tree.tree ?? []).find((item) => item.type === "blob" && typeof item.path === "string" && item.path.toLowerCase().endsWith("skill.md"))?.path; if (!skillPath || skillPath.includes("..") || skillPath.startsWith("/")) throw new Error("SKILL.md not found"); const fileResponse = await fetchImpl("https://api.github.com/repos/" + source + "/contents/" + skillPath.split("/").map(encodeURIComponent).join("/"), { headers, signal: AbortSignal.timeout(15000) }); if (!fileResponse.ok) throw await githubResponseError(fileResponse, "GitHub content"); const file = await fileResponse.json() as { content?: string; encoding?: string }; if (file.encoding !== "base64" || typeof file.content !== "string") throw new Error("SKILL.md content unavailable"); const skillText = Buffer.from(file.content.replace(/\\s/g, ""), "base64").toString("utf8"); if (!skillText.trim() || /(^|\\n)\\s*\\.\\.(?:[\\\\/]|$)/.test(skillText)) throw new Error("unsafe SKILL.md"); const risk = inspectSkillText(skillText); writeFileSync(join(path, "SKILL.md"), skillText, { mode: 0o600 }); atomicWriteJson(join(path, "source.json"), { id, sourceUrl: "https://github.com/" + source, sourcePath: skillPath, stagedAt: iso(now) }, { mode: 0o600, description: "隔离技能来源" }); return { ok: true, id: stageId, status: "staged", sourceUrl: "https://github.com/" + source, sourcePath: skillPath, risk, notice: "已下载到 Butler 隔离区并完成初步风险扫描，尚未写入 Hermes；请确认安装" }; } catch (error) { rmSync(path, { recursive: true, force: true }); const failure = error instanceof Error && "status" in error ? githubFailure(error) : { code: "stage-download-failed", detail: "技能文件下载或检查未完成。", fix: "检查仓库是否包含有效 SKILL.md，或稍后重试。" }; return { ok: false, error: failure.code, detail: failure.detail, fix: failure.fix, ...(failure.retryAt === undefined ? {} : { retryAt: failure.retryAt }) }; } },
    async installStaged(id, confirmed, overwrite = false) {
      if (!confirmed) return { ok: false, error: "confirmation-required", fix: "确认安装前不要写入 Hermes" };
      if (!/^[0-9a-f-]{36}$/.test(id)) return { ok: false, error: "invalid-stage-id", fix: "无效的隔离安装标识" };
      const path = join(stageRoot, id);
      if (!inside(path, stageRoot) || !existsSync(path)) return { ok: false, error: "invalid-stage", fix: "隔离区必须包含有效 SKILL.md" };
      // 单技能：隔离区根目录有 SKILL.md；合集：一级子目录各含 SKILL.md（全部安装）。
      const members: Array<{ sourcePath: string; dirName: string; raw: string }> = [];
      if (existsSync(join(path, "SKILL.md"))) {
        members.push({ sourcePath: path, dirName: "", raw: readFileSync(join(path, "SKILL.md"), "utf8") });
      } else {
        let subEntries: import("node:fs").Dirent[];
        try { subEntries = readdirSync(path, { withFileTypes: true }); } catch { subEntries = []; }
        for (const entry of subEntries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const subSkill = join(path, entry.name, "SKILL.md");
          if (existsSync(subSkill)) members.push({ sourcePath: join(path, entry.name), dirName: entry.name, raw: readFileSync(subSkill, "utf8") });
        }
        if (members.length === 0) return { ok: false, error: "invalid-stage", fix: "隔离区必须包含有效 SKILL.md（或含多个带 SKILL.md 的子目录）" };
      }
      // 任一成员命中风险规则即整体拒绝（fail-closed），此时还没有任何目录被移动。
      for (const member of members) {
        const risk = inspectSkillText(member.raw);
        if (risk.status === "blocked") return { ok: false, error: "skill-risk-blocked", risk, fix: risk.detail };
      }
      const instance = instanceOf(deps.core); if (!instance) return { ok: false, error: "no-instance", fix: "先连接 Hermes 实例" };
      const skillsRoot = join(instance.rootPath, "skills");
      const targets = members.map((member) => {
        const rawName = member.dirName === "" ? skillNameFromFrontmatter(member.raw) ?? id : member.dirName;
        return { ...member, targetName: safeName(rawName) };
      });
      if (targets.some((target) => target.targetName === null)) {
        return { ok: false, error: "invalid-skill-name", fix: "技能名称不合法（仅允许字母数字与 . _ -）。" };
      }
      const seenNames = new Set<string>();
      for (const target of targets) {
        if (seenNames.has(target.targetName!)) return { ok: false, error: "duplicate-skill-name", fix: `合集中存在重名技能：${target.targetName}` };
        seenNames.add(target.targetName!);
      }
      for (const target of targets) {
        const dest = join(skillsRoot, target.targetName!);
        if (!inside(dest, skillsRoot)) return { ok: false, error: "path-not-allowed", fix: "拒绝路径穿越" };
        if (existsSync(dest) && !overwrite) return { ok: false, error: "target-exists", fix: "目标技能已存在；更新请走技能卡片的「更新」。" };
      }
      if (deps.backup === undefined && deps.backupGate === undefined) return { ok: false, error: "backup-unavailable", fix: "先恢复 Butler 备份服务" };
      const stageSource = readSourceJson(path);
      return guardedMutation(instance, async () => {
        const installedNames: string[] = [];
        try {
          if (!deps.backupGate && deps.backup) await deps.backup.run("event", (overwrite ? "更新技能 " : "安装技能 ") + targets.map((target) => target.targetName).join(", "));
          for (const target of targets) {
            const dest = join(skillsRoot, target.targetName!);
            if (overwrite && existsSync(dest)) {
              // 旧版本整目录移入备份区，保留可手动恢复的副本。
              const replacedAt = join(archiveRoot, `${target.targetName}-replaced-${now()}`);
              moveDirSync(dest, replacedAt, { verify: verifySkillDir });
              atomicWriteJson(join(replacedAt, "meta.json"), { name: target.targetName!, source: "replaced", originalPath: dest, archivePath: replacedAt, archivedAt: iso(now), hash: sha(readFileSync(join(replacedAt, "SKILL.md"), "utf8")) } satisfies ArchivedMeta, { mode: 0o600, description: "被替换技能备份" });
            }
            mkdirSync(dirname(dest), { recursive: true });
            // 合集安装：把来源元数据复制进各成员目录，供后续清单与更新检查识别。
            if (target.dirName !== "" && stageSource !== null) {
              writeFileSync(join(target.sourcePath, "source.json"), JSON.stringify({ ...stageSource, skillName: target.targetName }, null, 2), { mode: 0o600 });
            }
            moveDirSync(target.sourcePath, dest, { verify: verifySkillDir });
            installedNames.push(target.targetName!);
            deps.core.audit.append({ actor: "skills", action: overwrite ? "skill-updated" : "skill-installed", target: target.targetName!, detail: { target: dest, stageId: id } });
          }
          const single = installedNames.length === 1;
          return { ok: true, name: installedNames[0]!, names: installedNames, count: installedNames.length, installedPath: join(skillsRoot, installedNames[0]!), ...(overwrite ? { replaced: true } : {}), ...(single ? {} : { notice: `已安装 ${installedNames.length} 个技能（合集仓库）` }) };
        } catch (error) {
          return { ok: false, error: "install-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查备份和 Hermes 技能目录权限" };
        }
      });
    },
    async skillHubCategories() { return skillHub.categories(); },
    async skillHubList(query) { return skillHub.list(query); },

    /** SkillHub 暂存：下载 zip → 解压 → 风险扫描 → 隔离区；记录当前版本供更新检查。 */
    async stageSkillHub(slugRaw) {
      const slug = slugRaw.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(slug)) return { ok: false, error: "invalid-slug", fix: "SkillHub 技能标识不合法，请从市场卡片重新发起安装。" };
      let files: ZipEntry[];
      let version: string | null = null;
      try {
        files = stripCommonPrefix(readZipEntries(await skillHub.download(slug)));
      } catch (error) {
        return { ok: false, error: "skillhub-download-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查网络后重试；SkillHub 下载走 api.skillhub.cn。" };
      }
      if (!files.some((item) => item.path === "SKILL.md")) return { ok: false, error: "skill-md-missing", fix: "该技能包缺少 SKILL.md，无法安装。" };
      try {
        const detail = await skillHub.detail(slug);
        version = detail?.latestVersion ?? null;
      } catch { /* 版本获取失败不阻塞安装 */ }
      const sourceUrl = "https://skillhub.cn/skills/" + slug;
      try {
        const staged = stageFromEntries(files, sourceUrl, { source: "skillhub", slug, ...(version === null ? {} : { version }) });
        return { ok: true, id: staged.id, status: "staged", slug, ...(version === null ? {} : { version }), name: staged.name ?? slug, sourceUrl, risk: staged.risk, notice: "已完成安全检查，确认后写入本机技能目录" };
      } catch (error) {
        if (error instanceof Error && error.message === "skill-md-missing") return { ok: false, error: "skill-md-missing", fix: "该技能包缺少 SKILL.md，无法安装。" };
        return { ok: false, error: "skillhub-stage-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查磁盘与权限后重试。" };
      }
    },

    /** GitHub 仓库暂存：下载 tarball → 根目录 SKILL.md → 风险扫描 → 隔离区；记录 commit 供更新检查。 */
    async stageGitSource(urlRaw) {
      const parsed = parseGitSource(urlRaw);
      if (parsed === null) return { ok: false, error: "invalid-git-source", fix: "支持 GitHub 仓库：owner/repo 或完整 https://github.com/owner/repo 地址（可带 /tree/分支）。" };
      const { owner, repo } = parsed;
      const ref = parsed.ref ?? "HEAD";
      let files: ZipEntry[];
      try {
        const response = await fetchImpl(`https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`, { headers, signal: AbortSignal.timeout(90_000), redirect: "follow" });
        if (response.status === 404) throw new Error("仓库或分支不存在");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 100 * 1024 * 1024) throw new Error("仓库压缩包超过 100MB 上限");
        files = stripCommonPrefix(readTarGzEntries(bytes));
      } catch (error) {
        return { ok: false, error: "git-download-failed", detail: error instanceof Error ? error.message : String(error), fix: "确认仓库存在且根目录含 SKILL.md；目前支持 GitHub 仓库。" };
      }
      if (files.length === 0) {
        return { ok: false, error: "skill-md-missing", fix: "仓库里没有找到任何 SKILL.md，无法安装。" };
      }
      const sourceUrl = `https://github.com/${owner}/${repo}${parsed.ref === undefined ? "" : `/tree/${parsed.ref}`}`;
      let commit: string | null = null;
      try {
        const commitResponse = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, { headers, signal: AbortSignal.timeout(15_000) });
        if (commitResponse.ok) {
          const body = await commitResponse.json() as { sha?: unknown };
          if (typeof body.sha === "string") commit = body.sha;
        }
      } catch { /* commit 获取失败不阻塞安装 */ }
      try {
        const staged = stageFromEntries(files, sourceUrl, { source: "git", gitUrl: `https://github.com/${owner}/${repo}`, ref, ...(commit === null ? {} : { commit }) });
        return {
          ok: true,
          id: staged.id,
          status: "staged",
          name: staged.name ?? `${owner}/${repo}`,
          sourceUrl,
          risk: staged.risk,
          ...(staged.collection > 1 ? { collection: staged.collection, notice: `合集仓库：确认后将安装其中 ${staged.collection} 个技能` } : { notice: "已完成安全检查，确认后写入本机技能目录" }),
        };
      } catch (error) {
        if (error instanceof Error && error.message === "skill-md-missing") return { ok: false, error: "skill-md-missing", fix: "仓库里没有找到任何 SKILL.md，无法安装。" };
        return { ok: false, error: "git-stage-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查磁盘与权限后重试。" };
      }
    },

    /** 本机已装清单：扫描 Hermes 技能目录，SKILL.md + source.json 合成视图。 */
    async listLocal() {
      const instance = instanceOf(deps.core);
      if (instance === undefined) return { items: [], root: "" };
      const root = join(instance.rootPath, "skills");
      const items: LocalSkillView[] = [];
      const readSource = (dir: string): Record<string, unknown> | null => {
        try {
          const parsed = JSON.parse(readFileSync(join(dir, "source.json"), "utf8")) as unknown;
          return isRecordObj(parsed) ? parsed : null;
        } catch { return null; }
      };
      const visit = (dir: string, depth: number): void => {
        if (depth > 2) return;
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
          const path = join(dir, entry.name);
          const skillFile = join(path, "SKILL.md");
          if (!existsSync(skillFile)) { visit(path, depth + 1); continue; }
          const fm = skillFrontmatter(readFileSync(skillFile, "utf8"));
          const source = readSource(path);
          const sourceType = typeof source?.["source"] === "string" ? source["source"] : "";
          const sourceUrl = typeof source?.["sourceUrl"] === "string" ? source["sourceUrl"] : "";
          const origin: LocalSkillView["origin"] = sourceType === "skillhub" ? "skillhub" : sourceType === "git" || sourceUrl.includes("github.com") ? "git" : "local";
          const asStr = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
          items.push({
            name: entry.name,
            displayName: fm.name ?? entry.name,
            description: fm.description ?? "",
            version: asStr(source?.["version"]) ?? fm.version,
            origin,
            slug: asStr(source?.["slug"]),
            gitUrl: origin === "git" ? asStr(source?.["gitUrl"]) ?? (sourceUrl.includes("github.com") ? sourceUrl : null) : null,
            ref: asStr(source?.["ref"]),
            commit: asStr(source?.["commit"]),
            installedAt: asStr(source?.["stagedAt"]),
          });
        }
      };
      if (existsSync(root)) visit(root, 0);
      return { items: items.sort((a, b) => a.name.localeCompare(b.name)), root };
    },

    /** 删除本机技能：整目录移入备份区（保留 hash 元数据，可手动恢复）。 */
    async removeLocal(nameRaw, confirmed) {
      const name = nameRaw.trim();
      const safe = safeName(name);
      if (safe === null) return { ok: false, error: "invalid-name", fix: "技能名称不合法。" };
      const instance = instanceOf(deps.core);
      if (instance === undefined) return { ok: false, error: "no-instance", fix: "先连接 Hermes 实例" };
      const skillsRoot = join(instance.rootPath, "skills");
      const dir = findSkill(instance.rootPath, safe) ?? (existsSync(join(skillsRoot, safe)) ? join(skillsRoot, safe) : null);
      if (dir === null) return { ok: false, error: "skill-not-found", fix: "刷新已安装列表后重试。" };
      if (!confirmed) return { ok: true, preview: { name: safe, path: dir, action: "整目录移入 Butler 备份区（不会直接销毁，可手动恢复）" } };
      return guardedMutation(instance, async () => {
        try {
          const archivedAt = join(archiveRoot, `${safe}-removed-${now()}`);
          moveDirSync(dir, archivedAt, { verify: verifySkillDir });
          atomicWriteJson(join(archivedAt, "meta.json"), { name: safe, source: "removed", originalPath: dir, archivePath: archivedAt, archivedAt: iso(now), hash: sha(readFileSync(join(archivedAt, "SKILL.md"), "utf8")) } satisfies ArchivedMeta, { mode: 0o600, description: "被删除技能备份" });
          deps.core.audit.append({ actor: "skills", action: "skill-removed", target: safe, detail: { archivePath: archivedAt } });
          return { ok: true, name: safe };
        } catch (error) {
          return { ok: false, error: "remove-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查技能目录与备份区权限。" };
        }
      });
    },

    /** 更新检查：SkillHub 比对版本号，Git 比对最新 commit。 */
    async checkLocalUpdates() {
      const { items } = await this.listLocal();
      const updates: LocalUpdateItem[] = [];
      const hubSlugs = [...new Set(items.filter((item) => item.origin === "skillhub" && item.slug !== null).map((item) => item.slug!))];
      const hubLatest = hubSlugs.length > 0 ? await skillHub.latestVersions(hubSlugs) : new Map<string, string>();
      const gitRepos = [...new Set(items.filter((item) => item.origin === "git" && item.gitUrl !== null).map((item) => item.gitUrl!))];
      const gitLatest = new Map<string, string | null>();
      for (const gitUrl of gitRepos) {
        const parsed = parseGitSource(gitUrl);
        if (parsed === null) { gitLatest.set(gitUrl, null); continue; }
        try {
          const response = await fetchImpl(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(parsed.ref ?? "HEAD")}`, { headers, signal: AbortSignal.timeout(12_000) });
          if (!response.ok) { gitLatest.set(gitUrl, null); continue; }
          const body = await response.json() as { sha?: unknown };
          gitLatest.set(gitUrl, typeof body.sha === "string" ? body.sha : null);
        } catch { gitLatest.set(gitUrl, null); }
      }
      for (const item of items) {
        if (item.origin === "skillhub" && item.slug !== null) {
          const latest = hubLatest.get(item.slug) ?? null;
          if (latest === null) {
            updates.push({ name: item.name, status: "unknown", installedVersion: item.version, latestVersion: null, reason: "暂时连不上 SkillHub，稍后再查。" });
            continue;
          }
          updates.push({
            name: item.name,
            status: item.version === null || isNewerVersion(latest, item.version) ? "available" : "up_to_date",
            installedVersion: item.version,
            latestVersion: latest,
            ...(item.version === null ? { reason: "本机未记录版本，建议更新一次以建立基线。" } : {}),
          });
          continue;
        }
        if (item.origin === "git" && item.gitUrl !== null) {
          const latest = gitLatest.get(item.gitUrl) ?? null;
          if (latest === null) {
            updates.push({ name: item.name, status: "unknown", installedVersion: null, latestVersion: null, reason: "暂时查不到 GitHub 最新版本，稍后再查。" });
            continue;
          }
          updates.push({
            name: item.name,
            status: item.commit === null || item.commit !== latest ? "available" : "up_to_date",
            installedVersion: item.commit === null ? null : item.commit.slice(0, 7),
            latestVersion: latest.slice(0, 7),
            ...(item.commit === null ? { reason: "本机未记录来源版本，建议更新一次以建立基线。" } : {}),
          });
          continue;
        }
        updates.push({ name: item.name, status: "unknown", installedVersion: item.version, latestVersion: null, reason: "本机技能未记录来源，无法自动检查更新。" });
      }
      return { items: updates, checkedAt: iso(now) } satisfies LocalUpdatesView;
    },

    /** 更新单个技能：重新下载最新版并覆盖本机（旧版本移入备份区）。 */
    async updateLocal(nameRaw, confirmed) {
      const name = nameRaw.trim();
      const { items } = await this.listLocal();
      const item = items.find((candidate) => candidate.name === name);
      if (item === undefined) return { ok: false, error: "skill-not-found", fix: "刷新已安装列表后重试。" };
      if (!confirmed) {
        return { ok: true, preview: { name, action: "重新下载最新版并替换本机版本；旧版本会先移入备份区。", installedVersion: item.version } };
      }
      let staged: Record<string, unknown>;
      if (item.origin === "skillhub" && item.slug !== null) staged = await this.stageSkillHub(item.slug);
      else if (item.origin === "git" && item.gitUrl !== null) staged = await this.stageGitSource(item.gitUrl);
      else return { ok: false, error: "no-source", fix: "该技能没有记录来源，无法自动更新。" };
      if (staged.ok !== true) return staged;
      return this.installStaged(String((staged as { id: unknown }).id), true, true);
    },
  };
}
