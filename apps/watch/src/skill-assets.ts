import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { atomicWriteJson, withManagedOperationLock, type Core, type InstanceRecord } from "@butler/core";
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
  installStaged(id: string, confirmed: boolean): Promise<Record<string, unknown>>;
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

export function createSkillAssetService(deps: { core: Core; skills: SkillsMemoryService; backup?: BackupService; backupGate?: BackupGate; logs?: { listSources(instanceId?: string): LogSource[]; readTail(sourceId: string, instanceId?: string, limit?: number): { lines: string[] } | null }; now?: () => number; fetch?: FetchLike; githubToken?: string }): SkillAssetService {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const githubToken = (deps.githubToken ?? process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? "").trim();
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
        const tail = deps.logs.readTail(source.id, instance.instanceId, 2000);
        if (!tail) continue;
        sources += 1;
        for (const line of tail.lines) {
          const match = /(?:skill|技能)(?:\s*(?:name|名称))?["'=:\s]+([A-Za-z0-9][A-Za-z0-9._/-]{1,159})/i.exec(line);
          if (!match) continue;
          const parsedTimestamp = /^(\d{4}-\d{2}-\d{2}T[^ ]+)/.exec(line)?.[1];
          const timestamp: string = parsedTimestamp ?? new Date(now()).toISOString();
          if (Date.parse(timestamp) < cutoff) continue;
          const name = match[1]!.split("@")[0]!;
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
          renameSync(dir, archivePath);
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
          renameSync(meta.archivePath, meta.originalPath);
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
    async stageRecommendation(id) { if (!id.startsWith("github:")) return { ok: false, error: "invalid-recommendation", fix: "选择公开 GitHub 推荐" }; const source = id.slice("github:".length); if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) return { ok: false, error: "invalid-recommendation", fix: "GitHub 仓库标识无效" }; const stageId = randomUUID(); const path = join(stageRoot, stageId); mkdirSync(path, { recursive: true }); try { const treeResponse = await fetchImpl("https://api.github.com/repos/" + source + "/git/trees/HEAD?recursive=1", { headers, signal: AbortSignal.timeout(15000) }); if (!treeResponse.ok) throw await githubResponseError(treeResponse, "GitHub tree"); const tree = await treeResponse.json() as { tree?: Array<{ path?: string; type?: string }> }; const skillPath = (tree.tree ?? []).find((item) => item.type === "blob" && typeof item.path === "string" && item.path.toLowerCase().endsWith("skill.md"))?.path; if (!skillPath || skillPath.includes("..") || skillPath.startsWith("/")) throw new Error("SKILL.md not found"); const fileResponse = await fetchImpl("https://api.github.com/repos/" + source + "/contents/" + skillPath.split("/").map(encodeURIComponent).join("/"), { headers, signal: AbortSignal.timeout(15000) }); if (!fileResponse.ok) throw await githubResponseError(fileResponse, "GitHub content"); const file = await fileResponse.json() as { content?: string; encoding?: string }; if (file.encoding !== "base64" || typeof file.content !== "string") throw new Error("SKILL.md content unavailable"); const skillText = Buffer.from(file.content.replace(/\\s/g, ""), "base64").toString("utf8"); if (!skillText.trim() || /(^|\\n)\\s*\\.\\.(?:[\\\\/]|$)/.test(skillText)) throw new Error("unsafe SKILL.md"); writeFileSync(join(path, "SKILL.md"), skillText, { mode: 0o600 }); atomicWriteJson(join(path, "source.json"), { id, sourceUrl: "https://github.com/" + source, sourcePath: skillPath, stagedAt: iso(now) }, { mode: 0o600, description: "隔离技能来源" }); return { ok: true, id: stageId, status: "staged", sourceUrl: "https://github.com/" + source, sourcePath: skillPath, notice: "已下载到 Butler 隔离区并通过基础结构检查，尚未写入 Hermes；请确认安装" }; } catch (error) { rmSync(path, { recursive: true, force: true }); const failure = error instanceof Error && "status" in error ? githubFailure(error) : { code: "stage-download-failed", detail: "技能文件下载或检查未完成。", fix: "检查仓库是否包含有效 SKILL.md，或稍后重试。" }; return { ok: false, error: failure.code, detail: failure.detail, fix: failure.fix, ...(failure.retryAt === undefined ? {} : { retryAt: failure.retryAt }) }; } },
    async installStaged(id, confirmed) {
      if (!confirmed) return { ok: false, error: "confirmation-required", fix: "确认安装前不要写入 Hermes" };
      if (!/^[0-9a-f-]{36}$/.test(id)) return { ok: false, error: "invalid-stage-id", fix: "无效的隔离安装标识" };
      const path = join(stageRoot, id); const skillFile = join(path, "SKILL.md");
      if (!inside(path, stageRoot) || !existsSync(skillFile)) return { ok: false, error: "invalid-stage", fix: "隔离区必须包含有效 SKILL.md" };
      const raw = readFileSync(skillFile, "utf8");
      const nameMatch = /^---\s*\r?\n[\s\S]*?\r?\nname:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,159})\s*\r?\n[\s\S]*?\r?\n---/i.exec(raw);
      const targetName = safeName(nameMatch?.[1] ?? id);
      if (!targetName) return { ok: false, error: "invalid-skill-name", fix: "SKILL.md 必须声明安全的技能名称" };
      const instance = instanceOf(deps.core); if (!instance) return { ok: false, error: "no-instance", fix: "先连接 Hermes 实例" };
      const skillsRoot = join(instance.rootPath, "skills"); const target = join(skillsRoot, targetName);
      if (!inside(target, skillsRoot)) return { ok: false, error: "path-not-allowed", fix: "拒绝路径穿越" };
      if (existsSync(target)) return { ok: false, error: "target-exists", fix: "目标技能已存在，请先查看当前版本" };
      if (deps.backup === undefined && deps.backupGate === undefined) return { ok: false, error: "backup-unavailable", fix: "先恢复 Butler 备份服务" };
      return guardedMutation(instance, async () => {
        try {
          if (!deps.backupGate && deps.backup) await deps.backup.run("event", "安装技能 " + targetName);
          mkdirSync(dirname(target), { recursive: true });
          renameSync(path, target);
          deps.core.audit.append({ actor: "skills", action: "skill-installed", target: targetName, detail: { target, stageId: id } });
          return { ok: true, name: targetName, installedPath: target };
        } catch (error) {
          return { ok: false, error: "install-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查备份和 Hermes 技能目录权限" };
        }
      });
    },
  };
}
