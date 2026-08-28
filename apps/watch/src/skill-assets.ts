import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Core, InstanceRecord } from "@butler/core";
import type { BackupService } from "./backup.js";
import type { SkillsMemoryService } from "./skills.js";

export interface SkillUsageItem { name: string; calls: number; lastUsedAt: string | null; successRate: number | null; avgDurationMs: number | null; status: "known" | "unknown" }
export interface SkillUsageView { rangeDays: number; coverage: { from: string | null; to: string | null; days: number; source: string; complete: boolean }; series: Array<{ date: string; calls: number }>; skills: SkillUsageItem[]; notice: string }
export interface SkillAssetService {
  usage(rangeDays?: number): Promise<SkillUsageView>;
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

export function createSkillAssetService(deps: { core: Core; skills: SkillsMemoryService; backup?: BackupService; logs?: { listSources(instanceId?: string): LogSource[]; readTail(sourceId: string, instanceId?: string, limit?: number): { lines: string[] } | null }; now?: () => number }): SkillAssetService {
  const now = deps.now ?? Date.now;
  const root = join(deps.core.paths.home, "skill-assets"); const archiveRoot = join(root, "archive"); const stageRoot = join(root, "staged"); const trendPath = join(root, "github-trends.json");
  mkdirSync(archiveRoot, { recursive: true }); mkdirSync(stageRoot, { recursive: true });
  const archived = new Map<string, ArchivedMeta>();
  for (const file of readdirSync(archiveRoot, { withFileTypes: true })) { if (!file.isDirectory()) continue; try { const meta = JSON.parse(readFileSync(join(archiveRoot, file.name, "meta.json"), "utf8")) as ArchivedMeta; archived.set(meta.name, meta); } catch { /* ignore corrupt archive */ } }
  const usage = async (rangeDays = 180): Promise<SkillUsageView> => {
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
          const date = timestamp.slice(0, 10);
          series.set(date, (series.get(date) ?? 0) + 1);
          if (from === null || timestamp.localeCompare(from) < 0) from = timestamp;
          if (to === null || timestamp.localeCompare(to) > 0) to = timestamp;
        }
      }
    }
    const skills = [...new Set([...known, ...counts.keys()])].map((name) => { const item = counts.get(name); const observed = (item?.successes ?? 0) + (item?.failures ?? 0); return { name, calls: item?.calls ?? 0, lastUsedAt: item?.last ?? null, successRate: observed > 0 ? (item?.successes ?? 0) / observed : null, avgDurationMs: item && item.durations.length > 0 ? item.durations.reduce((sum, value) => sum + value, 0) / item.durations.length : null, status: known.has(name) ? "known" as const : "unknown" as const }; }).sort((a, b) => b.calls - a.calls || (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") || a.name.localeCompare(b.name));
    return { rangeDays: days, coverage: { from, to, days: from && to ? Math.max(1, Math.ceil((Date.parse(to) - Date.parse(from)) / 86400000)) : 0, source: sources ? "Hermes 日志" : "未读取到 Hermes 日志", complete: sources > 0 }, series: [...series.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, calls]) => ({ date, calls })), skills, notice: "成功率和耗时只有在日志明确记录时展示，否则为未知。" };
  };
  return {
    usage,
    async archive(name, thresholdDays = 90) { const safe = safeName(name); const instance = instanceOf(deps.core); if (!safe) return { ok: false, error: "invalid-name", fix: "使用合法技能名称" }; if (!instance) return { ok: false, error: "no-instance", fix: "先连接 Hermes 实例" }; const view = await deps.skills.status({ instanceId: instance.instanceId }); const item = view.skills.items.find((i) => i.name === safe); if (!item) return { ok: false, error: "skill-not-found", fix: "刷新技能清单后重试" }; if (item.source === "builtin") return { ok: false, error: "builtin-readonly", fix: "内置技能不可物理归档" }; const dir = findSkill(instance.rootPath, safe); if (!dir) return { ok: false, error: "skill-path-not-found", fix: "检查 Hermes skills 目录" }; const last = (await usage(180)).skills.find((i) => i.name === safe)?.lastUsedAt; if (last && now() - Date.parse(last) < thresholdDays * 86400000) return { ok: false, error: "skill-not-idle", fix: "等待达到闲置阈值后再归档" }; try { if (deps.backup) await deps.backup.run("event", "归档技能 " + safe); const archivePath = join(archiveRoot, safe + "-" + now()); renameSync(dir, archivePath); const meta: ArchivedMeta = { name: safe, source: item.source, originalPath: dir, archivePath, archivedAt: iso(now), hash: sha(readFileSync(join(archivePath, "SKILL.md"), "utf8")) }; writeFileSync(join(archivePath, "meta.json"), JSON.stringify(meta, null, 2), { mode: 0o600 }); archived.set(safe, meta); deps.core.audit.append({ actor: "skills", action: "skill-archived", target: safe, detail: { thresholdDays } }); return { ok: true, name: safe, archivedAt: meta.archivedAt }; } catch (error) { return { ok: false, error: "archive-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查备份目录和文件权限" }; } },
    async restore(name) { const meta = archived.get(name); if (!meta) return { ok: false, error: "archive-not-found", fix: "只有已归档技能可恢复" }; try { const instance = instanceOf(deps.core); if (!instance || !inside(meta.archivePath, archiveRoot) || !inside(meta.originalPath, join(instance.rootPath, "skills"))) throw new Error("path-not-allowed"); if (existsSync(meta.originalPath)) return { ok: false, error: "target-exists", fix: "清理冲突目录后重试" }; const hash = sha(readFileSync(join(meta.archivePath, "SKILL.md"), "utf8")); if (hash !== meta.hash) return { ok: false, error: "hash-conflict", fix: "归档内容已变化，禁止恢复" }; mkdirSync(dirname(meta.originalPath), { recursive: true }); renameSync(meta.archivePath, meta.originalPath); archived.delete(name); return { ok: true, name }; } catch (error) { return { ok: false, error: "restore-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查原始路径和归档目录" }; } },
    async purge(name, confirmed) { const meta = archived.get(name); if (!meta) return { ok: false, error: "archive-not-found", fix: "永久删除仅对已归档技能开放" }; if (!confirmed) return { ok: false, error: "confirmation-required", fix: "二次确认永久删除" }; try { if (!inside(meta.archivePath, archiveRoot)) throw new Error("path-not-allowed"); rmSync(meta.archivePath, { recursive: true, force: true }); archived.delete(name); deps.core.audit.append({ actor: "skills", action: "skill-purged", target: name, detail: {} }); return { ok: true, name }; } catch (error) { return { ok: false, error: "purge-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查归档目录权限" }; } },
    async githubTrends(query = {}) { let cached: Record<string, unknown> = {}; try { cached = JSON.parse(readFileSync(trendPath, "utf8")) as Record<string, unknown>; } catch { /* empty cache */ } return { items: Array.isArray(cached.items) ? cached.items : [], filter: query.filter ?? "all", sort: query.sort ?? "trend", syncedAt: cached.syncedAt ?? null, source: "GitHub public API cache", notice: "公开仓库趋势，不代表官方 Hermes 技能排名。" }; },
    async refreshGithubTrends() { try { const response = await fetch("https://api.github.com/search/repositories?q=agent+skill+OR+hermes+skill+OR+openclaw+skill&sort=stars&order=desc&per_page=30", { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) }); if (!response.ok) throw new Error("GitHub HTTP " + response.status); const body = await response.json() as { items?: Array<Record<string, unknown>> }; const payload = { syncedAt: iso(now), items: (body.items ?? []).map((i) => ({ name: String(i["full_name"] ?? ""), url: String(i["html_url"] ?? ""), stars: Number(i["stargazers_count"] ?? 0), forks: Number(i["forks_count"] ?? 0), updatedAt: String(i["updated_at"] ?? "") })) }; writeFileSync(trendPath, JSON.stringify(payload, null, 2), { mode: 0o600 }); return { ...payload, notice: "公开仓库趋势，不代表官方 Hermes 技能排名。" }; } catch (error) { return { ...(await this.githubTrends()), error: error instanceof Error ? error.message : String(error), notice: "同步失败，继续使用上次缓存（如有）。" }; } },
    async recommendations() { const stats = await usage(90); const trends = await this.githubTrends(); const installed = new Set(stats.skills.filter((i) => i.status === "known").map((i) => i.name)); const items = (Array.isArray(trends.items) ? trends.items : []).filter((i) => typeof i === "object" && i !== null).map((i) => { const row = i as Record<string, unknown>; const name = String(row["name"] ?? ""); return { id: "github:" + name, name, reason: "本地使用缺口与 GitHub 公开趋势匹配；请先在隔离区扫描", sourceUrl: row["url"] ?? "", installed: installed.has(name) }; }).filter((i) => !i.installed); return { items, generatedAt: iso(now), notice: "推荐结合本地使用缺口和公开仓库趋势，不自动安装。" }; },
    async stageRecommendation(id) { if (!id.startsWith("github:")) return { ok: false, error: "invalid-recommendation", fix: "选择公开 GitHub 推荐" }; const source = id.slice("github:".length); if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) return { ok: false, error: "invalid-recommendation", fix: "GitHub 仓库标识无效" }; const stageId = randomUUID(); const path = join(stageRoot, stageId); mkdirSync(path, { recursive: true }); try { const headers = { Accept: "application/vnd.github+json" }; const treeResponse = await fetch("https://api.github.com/repos/" + source + "/git/trees/HEAD?recursive=1", { headers, signal: AbortSignal.timeout(15000) }); if (!treeResponse.ok) throw new Error("GitHub tree HTTP " + treeResponse.status); const tree = await treeResponse.json() as { tree?: Array<{ path?: string; type?: string }> }; const skillPath = (tree.tree ?? []).find((item) => item.type === "blob" && typeof item.path === "string" && item.path.toLowerCase().endsWith("skill.md"))?.path; if (!skillPath || skillPath.includes("..") || skillPath.startsWith("/")) throw new Error("SKILL.md not found"); const fileResponse = await fetch("https://api.github.com/repos/" + source + "/contents/" + skillPath.split("/").map(encodeURIComponent).join("/"), { headers, signal: AbortSignal.timeout(15000) }); if (!fileResponse.ok) throw new Error("GitHub content HTTP " + fileResponse.status); const file = await fileResponse.json() as { content?: string; encoding?: string }; if (file.encoding !== "base64" || typeof file.content !== "string") throw new Error("SKILL.md content unavailable"); const skillText = Buffer.from(file.content.replace(/\\s/g, ""), "base64").toString("utf8"); if (!skillText.trim() || /(^|\\n)\\s*\\.\\.(?:[\\\\/]|$)/.test(skillText)) throw new Error("unsafe SKILL.md"); writeFileSync(join(path, "SKILL.md"), skillText, { mode: 0o600 }); writeFileSync(join(path, "source.json"), JSON.stringify({ id, sourceUrl: "https://github.com/" + source, sourcePath: skillPath, stagedAt: iso(now) }, null, 2), { mode: 0o600 }); return { ok: true, id: stageId, status: "staged", sourceUrl: "https://github.com/" + source, sourcePath: skillPath, notice: "已下载到 Butler 隔离区并通过基础结构检查，尚未写入 Hermes；请确认安装" }; } catch (error) { rmSync(path, { recursive: true, force: true }); return { ok: false, error: "stage-download-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查仓库是否包含有效 SKILL.md，或稍后重试" }; } },
    async installStaged(id, confirmed) { if (!confirmed) return { ok: false, error: "confirmation-required", fix: "确认安装前不要写入 Hermes" }; if (!/^[0-9a-f-]{36}$/.test(id)) return { ok: false, error: "invalid-stage-id", fix: "无效的隔离安装标识" }; const path = join(stageRoot, id); const skillFile = join(path, "SKILL.md"); if (!inside(path, stageRoot) || !existsSync(skillFile)) return { ok: false, error: "invalid-stage", fix: "隔离区必须包含有效 SKILL.md" }; const raw = readFileSync(skillFile, "utf8"); const nameMatch = /^---\\s*\\r?\\n[\\s\\S]*?\\r?\\nname:\\s*([A-Za-z0-9][A-Za-z0-9._-]{0,159})\\s*\\r?\\n[\\s\\S]*?\\r?\\n---/i.exec(raw); const targetName = safeName(nameMatch?.[1] ?? id); if (!targetName) return { ok: false, error: "invalid-skill-name", fix: "SKILL.md 必须声明安全的技能名称" }; const instance = instanceOf(deps.core); if (!instance) return { ok: false, error: "no-instance", fix: "先连接 Hermes 实例" }; const skillsRoot = join(instance.rootPath, "skills"); const target = join(skillsRoot, targetName); if (!inside(target, skillsRoot)) return { ok: false, error: "path-not-allowed", fix: "拒绝路径穿越" }; if (existsSync(target)) return { ok: false, error: "target-exists", fix: "目标技能已存在，请先查看当前版本" }; if (deps.backup === undefined) return { ok: false, error: "backup-unavailable", fix: "先恢复 Butler 备份服务" }; try { await deps.backup.run("event", "安装技能 " + targetName); mkdirSync(dirname(target), { recursive: true }); renameSync(path, target); deps.core.audit.append({ actor: "skills", action: "skill-installed", target: targetName, detail: { target, stageId: id } }); return { ok: true, name: targetName, installedPath: target }; } catch (error) { return { ok: false, error: "install-failed", detail: error instanceof Error ? error.message : String(error), fix: "检查备份和 Hermes 技能目录权限" }; } },
  };
}
