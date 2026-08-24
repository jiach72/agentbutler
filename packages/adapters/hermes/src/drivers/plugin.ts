import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import {
  fail,
  ok,
  type DriverScope,
  type PluginDriver,
  type PluginMeta,
  type PluginSource,
} from "@butler/contract";
import { parse as parseYaml } from "yaml";

const MAX_PLUGIN_FILES = 2_000;
const MAX_PLUGIN_DEPTH = 3;
const PLUGIN_MANIFESTS = ["plugin.yaml", "plugin.yml", "manifest.json", "manifest.yaml", "manifest.yml"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pluginSource(value: unknown): PluginSource | null {
  return value === "builtin" || value === "market" || value === "self-evolved" || value === "user"
    ? value
    : null;
}

function pluginCategory(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

function yamlFile(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = parseYaml(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonFile(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function frontmatterData(raw: string): Record<string, unknown> {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (match === null) return {};
  const parsed = parseYaml(match[1] ?? "") as unknown;
  return isRecord(parsed) ? parsed : {};
}

function pythonMeta(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf8");
    const match = /PLUGIN_META\s*=\s*(\{[^}]*\})/.exec(raw);
    if (match === null) return null;
    const entries = [...match[1]!.matchAll(/(["'])([^"']+)\1\s*:\s*(["'])([^"']*)\3/g)];
    const out: Record<string, unknown> = {};
    for (const entry of entries) out[entry[2]!] = entry[4];
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

function readMeta(dir: string): Record<string, unknown> | null {
  for (const name of PLUGIN_MANIFESTS) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const data = name.endsWith(".json") ? jsonFile(path) : yamlFile(path);
    if (data !== null) return data;
  }
  const packagePath = join(dir, "package.json");
  if (existsSync(packagePath)) {
    const pkg = jsonFile(packagePath);
    if (pkg !== null) return { name: pkg["name"], version: pkg["version"], description: pkg["description"] };
  }
  const skillPath = join(dir, "SKILL.md");
  if (existsSync(skillPath)) {
    try {
      return frontmatterData(readFileSync(skillPath, "utf8"));
    } catch {
      return null;
    }
  }
  const initPath = join(dir, "__init__.py");
  if (existsSync(initPath)) return pythonMeta(initPath);
  return null;
}

function bundledPlugins(root: string): Set<string> {
  const manifestPath = join(root, ".bundled_manifest");
  if (!existsSync(manifestPath)) return new Set();
  try {
    return new Set(
      readFileSync(manifestPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf(":");
          return separator < 1 ? line : line.slice(0, separator);
        }),
    );
  } catch {
    return new Set();
  }
}

function collectPluginDirs(root: string): string[] {
  const dirs: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_PLUGIN_DEPTH || dirs.length >= MAX_PLUGIN_FILES) return;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (dirs.length >= MAX_PLUGIN_FILES) return;
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      const hasManifest =
        PLUGIN_MANIFESTS.some((name) => existsSync(join(path, name))) ||
        existsSync(join(path, "SKILL.md")) ||
        existsSync(join(path, "package.json")) ||
        existsSync(join(path, "__init__.py"));
      if (hasManifest) {
        dirs.push(path);
      } else if (depth + 1 <= MAX_PLUGIN_DEPTH) {
        visit(path, depth + 1);
      }
    }
  };
  visit(root, 0);
  return dirs.sort((a, b) => a.localeCompare(b));
}

function inferCategory(root: string, path: string): string | undefined {
  const relative = path.slice(root.length).replace(/^[\\/]+/, "");
  const segments = relative.split(/[\\/]/);
  if (segments.length <= 1) return undefined;
  const top = segments[0]!;
  const categoryMap: Record<string, string> = {
    platforms: "通道插件",
    adapters: "适配器插件",
    skills: "技能扩展",
    memory: "记忆",
    llm: "模型与 LLM",
    tools: "工具插件",
    webui: "界面",
    a2a: "A2A 协议",
    gateway: "消息网关",
  };
  return categoryMap[top] ?? top;
}

function toMeta(dir: string, root: string, bundles: Set<string>): PluginMeta {
  const fallbackName = basename(dir);
  const data = readMeta(dir) ?? {};
  const name =
    typeof data["name"] === "string" && data["name"].trim() !== ""
      ? data["name"].trim()
      : fallbackName;
  const version =
    typeof data["version"] === "string" && data["version"].trim() !== ""
      ? data["version"].trim()
      : "未声明";
  const source = pluginSource(data["source"]) ?? (bundles.has(name) ? "builtin" : "user");
  const category =
    pluginCategory(data["category"]) ??
    pluginCategory(data["分类"]) ??
    inferCategory(root, dir);
  const description =
    typeof data["description"] === "string" && data["description"].trim() !== ""
      ? data["description"].trim()
      : undefined;
  const enabled = !existsSync(join(dir, ".disabled")) && !existsSync(join(dir, "DISABLED"));
  return {
    ref: { name, version, source },
    name,
    version,
    source,
    enabled,
    ...(category === undefined ? {} : { category }),
    ...(description === undefined ? {} : { description }),
  };
}

export function createHermesPluginDriver(): PluginDriver {
  return {
    id: "hermes-plugin",
    async enumerate(scope: DriverScope) {
      const startedAt = Date.now();
      const pluginsRoot = join(scope.rootPath, "plugins");
      if (!existsSync(pluginsRoot)) {
        return fail("E402", `plugins directory not found: ${pluginsRoot}`, {
          startedAt,
          userHint: "未找到 Hermes plugins/ 目录，将降级为目录统计",
        });
      }
      const bundles = bundledPlugins(pluginsRoot);
      const items = collectPluginDirs(pluginsRoot)
        .map((dir) => toMeta(dir, pluginsRoot, bundles))
        .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
      return ok(items, startedAt);
    },
  };
}
