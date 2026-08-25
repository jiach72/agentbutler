import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  fail,
  MEMORY_PREVIEW_LIMIT,
  ok,
  type ConfigDriver,
  type DriverScope,
  type MemoryDriver,
  type MemoryEntry,
  type MemoryStats,
  type PluginDriver,
  type PluginMeta,
  type PluginSource,
  type Result,
  type SkillDefinition,
  type SkillDriver,
  type SkillMeta,
  type SkillRef,
  type SkillSource,
} from "@butler/contract";

const SKILL_FILE = "SKILL.md";
const READ_ONLY_MESSAGE = "OpenClaw 适配器当前只提供只读资产消费面，写操作留待经过安全评审的后续版本";

function skillRoots(rootPath: string): string[] {
  return [join(rootPath, "workspace", "skills"), join(rootPath, "skills")].filter(existsSync);
}

function walkFiles(root: string, filename: string, max = 2_000): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 8 || out.length >= max) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name === filename) out.push(path);
    }
  };
  visit(root, 0);
  return out.sort((a, b) => a.localeCompare(b));
}

function frontmatter(raw: string): Record<string, string> {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  const result: Record<string, string> = {};
  if (!match) return result;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && value) result[key] = value;
  }
  return result;
}

function sourceOf(value: string | undefined): SkillSource {
  return value === "builtin" || value === "market" || value === "self-evolved" || value === "user" ? value : "user";
}

function locatedSkills(rootPath: string): Array<{ path: string; meta: SkillMeta; definition: SkillDefinition }> {
  const result: Array<{ path: string; meta: SkillMeta; definition: SkillDefinition }> = [];
  for (const root of skillRoots(rootPath)) {
    for (const path of walkFiles(root, SKILL_FILE)) {
      try {
        const raw = readFileSync(path, "utf8");
        const data = frontmatter(raw);
        const name = data.name ?? basename(dirname(path));
        const version = data.version ?? "未声明";
        const source = sourceOf(data.source);
        const definition: SkillDefinition = {
          ref: { name, version, source }, name, version, source, raw,
          ...(data.description ? { description: data.description } : {}),
          ...(data.entry ? { entry: data.entry } : {}),
        };
        result.push({
          path,
          definition,
          meta: {
            ref: definition.ref,
            name,
            version,
            source,
            enabled: !existsSync(join(dirname(path), ".disabled")),
            ...(data.category ? { category: data.category } : {}),
          },
        });
      } catch {
        // 单个损坏技能不应阻断其它资产。
      }
    }
  }
  return result;
}

function readonly<T>(): Result<T> {
  return fail("E403", READ_ONLY_MESSAGE, { userHint: "当前版本只允许查看，不允许修改 OpenClaw 资产" });
}

export function createOpenClawSkillDriver(): SkillDriver {
  const cache = new Map<string, Array<{ path: string; meta: SkillMeta; definition: SkillDefinition }>>();
  const locate = (rootPath: string) => {
    const value = cache.get(rootPath) ?? locatedSkills(rootPath);
    cache.set(rootPath, value);
    return value;
  };
  return {
    id: "openclaw-skill-readonly",
    async enumerate(scope: DriverScope) {
      const startedAt = Date.now();
      const skills = locate(scope.rootPath);
      if (skills.length === 0 && skillRoots(scope.rootPath).length === 0) {
        return fail("E402", "OpenClaw skills directory not found", { startedAt, userHint: "未找到 OpenClaw skills/ 目录" });
      }
      return ok(skills.map((item) => item.meta), startedAt);
    },
    async parse(ref: SkillRef) {
      const startedAt = Date.now();
      for (const item of locate(ref.source === undefined ? process.env["OPENCLAW_HOME"] ?? "" : process.env["OPENCLAW_HOME"] ?? "")) {
        if (item.meta.name === ref.name && (ref.version === undefined || ref.version === item.meta.version)) return ok(item.definition, startedAt);
      }
      return fail("E402", `OpenClaw skill not found: ${ref.name}`, { startedAt, userHint: "未找到对应技能" });
    },
    async validate(definition: SkillDefinition) {
      const startedAt = Date.now();
      const issues = [] as Array<{ severity: "error" | "warn"; path: string; message: string }>;
      if (definition.name.trim() === "") issues.push({ severity: "error", path: "name", message: "技能名称不能为空" });
      if (definition.raw?.trim() === "") issues.push({ severity: "error", path: "raw", message: "SKILL.md 不能为空" });
      return ok({ valid: issues.every((item) => item.severity !== "error"), issues }, startedAt);
    },
    async setEnabled() { return readonly<void>(); },
    async rollbackVersion() { return readonly<void>(); },
  };
}

function memoryFiles(rootPath: string): string[] {
  const roots = [join(rootPath, "workspace", "memory"), join(rootPath, "memory")].filter(existsSync);
  const files = roots.flatMap((root) => walkFiles(root, "MEMORY.md").concat(walkFiles(root, "memory.md")));
  const top = [join(rootPath, "workspace", "MEMORY.md"), join(rootPath, "workspace", "memory.md")].filter(existsSync);
  const unique = new Map<string, string>();
  for (const file of [...files, ...top]) unique.set(file.toLowerCase(), file);
  return [...unique.values()];
}

function memoryEntry(path: string): MemoryEntry {
  const stat = statSync(path);
  return { entryId: path, writtenAt: stat.mtime.toISOString(), content: readFileSync(path, "utf8"), sizeBytes: stat.size };
}

export function createOpenClawMemoryDriver(): MemoryDriver {
  return {
    id: "openclaw-markdown-memory-readonly",
    async stats(scope: DriverScope) {
      const startedAt = Date.now();
      const entries = memoryFiles(scope.rootPath).map((path) => ({ path, stat: statSync(path) }));
      const byMonth = new Map<string, number>();
      let lastWriteAt: string | null = null;
      for (const item of entries) {
        const iso = item.stat.mtime.toISOString();
        byMonth.set(iso.slice(0, 7), (byMonth.get(iso.slice(0, 7)) ?? 0) + 1);
        if (lastWriteAt === null || iso > lastWriteAt) lastWriteAt = iso;
      }
      const data: MemoryStats = {
        totalEntries: entries.length,
        byMonth: [...byMonth.entries()].map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month)),
        coldCandidates: 0,
        lastWriteAt,
        archivedEntries: 0,
        probeEntries: 0,
        recalledEntries: 0,
        cumulativeRecalls: 0,
        probeWriteAttempts: 0,
        probeWriteFailures: 0,
        probeRecallAttempts: 0,
        probeRecallHits: 0,
      };
      return ok(data, startedAt);
    },
    async preview(scope: DriverScope, query) {
      const startedAt = Date.now();
      const keyword = query.keyword?.toLowerCase();
      const items = memoryFiles(scope.rootPath).map(memoryEntry).filter((item) => keyword === undefined || item.content.toLowerCase().includes(keyword));
      return ok(items.slice(0, Math.min(MEMORY_PREVIEW_LIMIT, query.limit ?? 20)), startedAt);
    },
    async verifyIntegrity(scope: DriverScope) {
      const startedAt = Date.now();
      const problems = [] as Array<{ kind: string; detail: string; entryId?: string }>;
      for (const path of memoryFiles(scope.rootPath)) {
        try { readFileSync(path, "utf8"); } catch (error) { problems.push({ entryId: path, kind: "unreadable", detail: String(error) }); }
      }
      return ok({ healthy: problems.length === 0, checkedAt: new Date().toISOString(), totalChecked: memoryFiles(scope.rootPath).length, problems }, startedAt);
    },
    async analyze(scope: DriverScope) {
      const startedAt = Date.now();
      const count = memoryFiles(scope.rootPath).length;
      return ok({ score: count > 0 ? 100 : 70, checkedAt: new Date().toISOString(), signals: [{ id: "markdown-memory", label: "Markdown 记忆", status: count > 0 ? "ok" : "unknown", detail: count > 0 ? `已发现 ${count} 个 Markdown 记忆文件` : "未发现 Markdown 记忆文件" }], suggestions: [] }, startedAt);
    },
    async archiveCold() { return readonly(); },
    async restoreCold() { return readonly(); },
    async purge() { return readonly(); },
    async rebuildIndex() { return readonly(); },
  };
}

export function createOpenClawPluginDriver(): PluginDriver {
  return {
    id: "openclaw-plugin-readonly",
    async enumerate(scope: DriverScope) {
      const startedAt = Date.now();
      const roots = [join(scope.rootPath, "workspace", "extensions"), join(scope.rootPath, "extensions")].filter(existsSync);
      const plugins: PluginMeta[] = [];
      for (const root of roots) {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          const dir = join(root, entry.name);
          let version = "未声明";
          let description: string | undefined;
          const pkg = join(dir, "package.json");
          if (existsSync(pkg)) {
            try {
              const data = JSON.parse(readFileSync(pkg, "utf8")) as Record<string, unknown>;
              if (typeof data.version === "string") version = data.version;
              if (typeof data.description === "string") description = data.description;
            } catch { /* metadata is optional */ }
          }
          const source: PluginSource = "user";
          plugins.push({ ref: { name: entry.name, version, source }, name: entry.name, version, source, enabled: !existsSync(join(dir, ".disabled")), category: "OpenClaw 扩展", ...(description ? { description } : {}) });
        }
      }
      return ok(plugins, startedAt);
    },
  };
}

export function createOpenClawConfigDriver(): ConfigDriver {
  return {
    id: "openclaw-config-readonly",
    invariants: () => [
      { id: "config-exists", severity: "block", description: "openclaw.json 必须存在" },
      { id: "workspace-exists", severity: "warn", description: "workspace 目录应存在" },
      { id: "state-exists", severity: "warn", description: "state 目录应存在" },
    ],
    async snapshot(scope: DriverScope) {
      const startedAt = Date.now();
      const files = [join(scope.rootPath, "openclaw.json")].filter(existsSync).map((path) => {
        const content = readFileSync(path, "utf8");
        return { path: path.slice(scope.rootPath.length + 1), content, hash: `sha256:${createHash("sha256").update(content).digest("hex")}` };
      });
      return ok({ takenAt: new Date().toISOString(), files }, startedAt);
    },
    async planMigration(_scope: DriverScope, to) {
      const startedAt = Date.now();
      return ok({ target: to, steps: [{ id: "validate", label: "校验目标配置兼容性", risk: "safe" }, { id: "backup", label: "创建配置快照", risk: "safe" }], requiresDowntime: false }, startedAt);
    },
  };
}
