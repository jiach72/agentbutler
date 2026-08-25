import { existsSync, lstatSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  fail,
  ok,
  type DriverScope,
  type SkillDefinition,
  type SkillDriver,
  type SkillMeta,
  type SkillRef,
  type SkillSource,
} from "@butler/contract";
import { parse as parseYaml } from "yaml";

const MAX_SKILL_FILES = 5_000;
const MAX_SCAN_DEPTH = 8;
const SKILL_FILE = "SKILL.md";

interface LocatedSkill {
  path: string;
  definition: SkillDefinition;
  enabled: boolean;
  category?: string;
}

interface FrontmatterResult {
  data: Record<string, unknown>;
  raw: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function skillSource(value: unknown): SkillSource | null {
  return value === "builtin" || value === "market" || value === "self-evolved" || value === "user"
    ? value
    : null;
}

function frontmatter(raw: string): FrontmatterResult {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (match === null) return { data: {}, raw };
  const parsed = parseYaml(match[1] ?? "") as unknown;
  return { data: isRecord(parsed) ? parsed : {}, raw };
}

function bundledVersions(skillsRoot: string): Map<string, string> {
  const manifestPath = join(skillsRoot, ".bundled_manifest");
  if (!existsSync(manifestPath)) return new Map();
  try {
    return new Map(
      readFileSync(manifestPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf(":");
          return separator < 1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } catch {
    return new Map();
  }
}

function collectSkillFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || files.length >= MAX_SKILL_FILES) return;
    try {
      if (lstatSync(dir).isSymbolicLink()) return;
    } catch {
      return;
    }
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SKILL_FILES) return;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name === SKILL_FILE) files.push(path);
    }
  };
  visit(root, 0);
  return files.sort((a, b) => a.localeCompare(b));
}

function metadataSource(data: Record<string, unknown>): SkillSource | null {
  const direct = skillSource(data["source"]);
  if (direct !== null) return direct;
  const metadata = data["metadata"];
  if (!isRecord(metadata)) return null;
  const fromMetadata = skillSource(metadata["source"]);
  if (fromMetadata !== null) return fromMetadata;
  const hermes = metadata["hermes"];
  return isRecord(hermes) ? skillSource(hermes["source"]) : null;
}

function metadataCategory(data: Record<string, unknown>): string | undefined {
  const direct = data["category"];
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
  const chinese = data["分类"];
  if (typeof chinese === "string" && chinese.trim() !== "") return chinese.trim();
  const metadata = data["metadata"];
  if (!isRecord(metadata)) return undefined;
  const fromMetadata = metadata["category"];
  if (typeof fromMetadata === "string" && fromMetadata.trim() !== "") return fromMetadata.trim();
  const hermes = metadata["hermes"];
  return isRecord(hermes) && typeof hermes["category"] === "string" && hermes["category"].trim() !== ""
    ? hermes["category"].trim()
    : undefined;
}

function parseSkillFile(
  path: string,
  bundles: Map<string, string>,
): LocatedSkill {
  const raw = readFileSync(path, "utf8");
  const parsed = frontmatter(raw).data;
  const fallbackName = basename(dirname(path));
  const name =
    typeof parsed["name"] === "string" && parsed["name"].trim() !== ""
      ? parsed["name"].trim()
      : fallbackName;
  const bundledHash = bundles.get(name);
  const version =
    typeof parsed["version"] === "string" && parsed["version"].trim() !== ""
      ? parsed["version"].trim()
      : bundledHash
        ? `bundled:${bundledHash.slice(0, 8)}`
        : "未声明";
  const source = metadataSource(parsed) ?? (bundledHash !== undefined ? "builtin" : "user");
  const category = metadataCategory(parsed);
  const description =
    typeof parsed["description"] === "string" && parsed["description"].trim() !== ""
      ? parsed["description"].trim()
      : undefined;
  const entry =
    typeof parsed["entry"] === "string" && parsed["entry"].trim() !== ""
      ? parsed["entry"].trim()
      : undefined;
  const ref: SkillRef = { name, version, source };
  const definition: SkillDefinition = {
    ref,
    name,
    version,
    source,
    raw,
    ...(description === undefined ? {} : { description }),
    ...(entry === undefined ? {} : { entry }),
  };
  const dir = dirname(path);
  return {
    path,
    definition,
    enabled: !existsSync(join(dir, ".disabled")) && !existsSync(join(dir, "DISABLED")),
    ...(category === undefined ? {} : { category }),
  };
}

function toMeta(skill: LocatedSkill): SkillMeta {
  const { ref, name, version, source } = skill.definition;
  return {
    ref,
    name,
    version,
    source,
    enabled: skill.enabled,
    ...(skill.category === undefined ? {} : { category: skill.category }),
  };
}

export function createHermesSkillDriver(): SkillDriver {
  const cache = new Map<string, LocatedSkill[]>();

  return {
    id: "hermes-skill",
    async enumerate(scope: DriverScope) {
      const startedAt = Date.now();
      const skillsRoot = join(scope.rootPath, "skills");
      if (!existsSync(skillsRoot)) {
        return fail("E402", `skills directory not found: ${skillsRoot}`, {
          startedAt,
          userHint: "未找到 Hermes skills/ 目录，将降级为目录统计",
        });
      }
      const bundles = bundledVersions(skillsRoot);
      const located: LocatedSkill[] = [];
      for (const path of collectSkillFiles(skillsRoot)) {
        try {
          located.push(parseSkillFile(path, bundles));
        } catch {
          // 单个损坏技能不能拖垮整份清单；降级元数据仍保持可见。
          const name = basename(dirname(path));
          const source: SkillSource = bundles.has(name) ? "builtin" : "user";
          located.push({
            path,
            enabled: !existsSync(join(dirname(path), ".disabled")),
            definition: {
              ref: { name, version: "解析失败", source },
              name,
              version: "解析失败",
              source,
              raw: "",
            },
          });
        }
      }
      cache.clear();
      for (const skill of located) {
        const sameName = cache.get(skill.definition.name) ?? [];
        sameName.push(skill);
        cache.set(skill.definition.name, sameName);
      }
      const metas = located
        .map(toMeta)
        .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
      return ok(metas, startedAt);
    },

    async parse(ref: SkillRef) {
      const startedAt = Date.now();
      const candidates = cache.get(ref.name) ?? [];
      const matched =
        ref.version === undefined
          ? candidates[0]
          : candidates.find((skill) => skill.definition.version === ref.version);
      if (matched === undefined) {
        return fail("E402", `skill not found or enumerate was not called: ${ref.name}`, {
          startedAt,
          userHint: "未找到该技能定义，请先刷新技能清单",
        });
      }
      return ok(matched.definition, startedAt);
    },

    async validate(def: SkillDefinition) {
      const startedAt = Date.now();
      const issues = [];
      if (def.name.trim() === "")
        issues.push({ severity: "error" as const, path: "name", message: "技能名称不能为空" });
      if (def.version.trim() === "")
        issues.push({ severity: "warn" as const, path: "version", message: "技能未声明版本" });
      return ok({ valid: !issues.some((issue) => issue.severity === "error"), issues }, startedAt);
    },

    async setEnabled() {
      return fail("E403", "hermes-skill driver is read-only in V1", {
        userHint: "V1 仅提供技能只读列表，不能启停技能",
      });
    },

    async rollbackVersion() {
      return fail("E403", "hermes-skill driver is read-only in V1", {
        userHint: "V1 仅提供技能只读列表，不能回退技能版本",
      });
    },
  };
}
