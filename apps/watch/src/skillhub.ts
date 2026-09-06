/**
 * SkillHub（skillhub.cn）Open API 客户端：技能分类、列表/搜索、下载。
 * 接口约定见官方仓库 github.com/Tencent/skillhub（Base URL https://api.skillhub.cn）；
 * 公开目录无需鉴权，下载接口 302 跳对象存储，需跟随重定向取 zip 包。
 *
 * 设计与 github-trends（skill-assets.ts）同风格：
 * - fetch 可注入（测试）；列表/分类失败不抛异常，返回 200 + error 字段由 UI 提示重试；
 * - 分类做了短 TTL 内存缓存（分类表极少变化，避免每次进入面板都打接口）。
 * 另含无依赖 ZIP 读取器：SkillHub 下载包为 zip（SKILL.md 在根目录），
 * 与 diagnostics.ts 的 store 写入器互补，这里负责读取（store + deflate）。
 */
import { gunzipSync, inflateRawSync } from "node:zlib";

export const SKILLHUB_BASE_URL = "https://api.skillhub.cn";
/** 分类内存缓存时长：分类表由平台调整，文档要求运行时拉取而非硬编码。 */
const CATEGORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** 下载包大小上限：技能 zip 通常是几十 KB 的文本，50MB 已远超正常范围。 */
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;

export type SkillHubSortBy = "updated_at" | "downloads" | "stars" | "installs" | "score";

export interface SkillHubListQuery {
  keyword?: string;
  category?: string;
  sortBy?: SkillHubSortBy;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface SkillHubSkillView {
  slug: string;
  name: string;
  /** 中文描述（缺失回退英文描述）。 */
  description: string;
  category: string;
  subCategories: Array<{ key: string; name: string }>;
  iconUrl: string | null;
  ownerName: string;
  version: string;
  homepage: string;
  downloads: number;
  installs: number;
  stars: number;
  updatedAt: string | null;
  source: string;
  requiresApiKey: boolean;
}

export interface SkillHubListView {
  total: number;
  page: number;
  pageSize: number;
  items: SkillHubSkillView[];
  error?: string;
  detail?: string;
  fix?: string;
}

export interface SkillHubCategoryView {
  key: string;
  name: string;
  nameEn: string | null;
}

export interface SkillHubCategoriesView {
  items: SkillHubCategoryView[];
  syncedAt: string | null;
  error?: string;
  detail?: string;
  fix?: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SkillHubClient {
  categories(): Promise<SkillHubCategoriesView>;
  list(query?: SkillHubListQuery): Promise<SkillHubListView>;
  /** 单技能详情（含 latestVersion）；失败返回 null（网络问题由调用方兜底）。 */
  detail(slug: string): Promise<{ latestVersion: string | null } | null>;
  /** 批量详情：slug → latestVersion 映射（用于已装技能的更新检查）。 */
  latestVersions(slugs: string[]): Promise<Map<string, string>>;
  /** 下载技能 zip（已跟随 302）；网络/超限抛错，由调用方转义。 */
  download(slug: string): Promise<Uint8Array>;
}

export interface SkillHubClientDeps {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 13 位毫秒时间戳 → ISO 字符串；非法返回 null。 */
function msToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function mapSkill(raw: Record<string, unknown>): SkillHubSkillView {
  const labels = isRecord(raw["labels"]) ? raw["labels"] : {};
  const subCategories = Array.isArray(raw["subCategories"])
    ? raw["subCategories"].filter(isRecord).map((item) => ({
        key: asString(item["key"]),
        name: asString(item["name"]),
      })).filter((item) => item.key !== "" || item.name !== "")
    : [];
  const description = asString(raw["description_zh"]) || asString(raw["description"]);
  return {
    slug: asString(raw["slug"]),
    name: asString(raw["name"]) || asString(raw["slug"]),
    description,
    category: asString(raw["category"]),
    subCategories,
    iconUrl: asString(raw["iconUrl"]) === "" ? null : asString(raw["iconUrl"]),
    ownerName: asString(raw["ownerName"]),
    version: asString(raw["version"]),
    homepage: asString(raw["homepage"]),
    downloads: asNumber(raw["downloads"]),
    installs: asNumber(raw["installs"]),
    stars: asNumber(raw["stars"]),
    updatedAt: msToIso(raw["updated_at"]),
    source: asString(raw["source"]),
    requiresApiKey: asString(labels["requires_api_key"]) === "true",
  };
}

/** 网络失败 → 200 + error 字段（与 githubTrends 同风格，UI 据此提示重试）。 */
function failure(error: unknown, fallbackFix: string): { error: string; detail: string; fix: string } {
  const message = error instanceof Error ? error.message : String(error);
  const timeout = error instanceof Error && error.name === "TimeoutError";
  return {
    error: timeout ? "skillhub-timeout" : "skillhub-unreachable",
    detail: `SkillHub 服务暂时无法访问（${message}）。`,
    fix: fallbackFix,
  };
}

export function createSkillHubClient(deps: SkillHubClientDeps = {}): SkillHubClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (deps.baseUrl ?? SKILLHUB_BASE_URL).replace(/\/$/, "");
  const now = deps.now ?? Date.now;

  let categoryCache: { at: number; view: SkillHubCategoriesView } | null = null;

  const getJson = async (path: string, timeoutMs: number): Promise<unknown> => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers: { Accept: "application/json", "User-Agent": "agent-butler/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  return {
    async categories() {
      if (categoryCache !== null && now() - categoryCache.at < CATEGORY_CACHE_TTL_MS) {
        return categoryCache.view;
      }
      try {
        const body = await getJson("/api/v1/categories", 10_000) as { items?: unknown };
        const items = (Array.isArray(body.items) ? body.items : [])
          .filter(isRecord)
          .filter((item) => item["active"] !== false)
          .map((item) => ({
            key: asString(item["key"]),
            name: asString(item["name"]) || asString(item["nameEn"]),
            nameEn: asString(item["nameEn"]) === "" ? null : asString(item["nameEn"]),
          }))
          .filter((item) => item.key !== "" && item.name !== "");
        const view: SkillHubCategoriesView = { items, syncedAt: new Date(now()).toISOString() };
        if (items.length > 0) categoryCache = { at: now(), view };
        return view;
      } catch (error) {
        return { items: [], syncedAt: null, ...failure(error, "稍后重试；分类加载失败不影响搜索。") };
      }
    },

    async list(query: SkillHubListQuery = {}) {
      const params = new URLSearchParams();
      const page = Math.max(1, Math.floor(query.page ?? 1));
      const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 24)));
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      const sortBy = query.sortBy ?? "downloads";
      params.set("sortBy", sortBy);
      params.set("order", query.order ?? "desc");
      const keyword = query.keyword?.trim() ?? "";
      if (keyword !== "") params.set("keyword", keyword);
      const category = query.category?.trim() ?? "";
      if (category !== "") params.set("category", category);
      try {
        const body = await getJson(`/api/skills?${params.toString()}`, 15_000) as { data?: unknown };
        const data = isRecord(body) && isRecord(body["data"]) ? body["data"] : {};
        const total = asNumber(data["total"]);
        const items = (Array.isArray(data["skills"]) ? data["skills"] : [])
          .filter(isRecord)
          .map(mapSkill)
          .filter((item) => item.slug !== "");
        return { total, page, pageSize, items };
      } catch (error) {
        return {
          total: 0,
          page,
          pageSize,
          items: [],
          ...failure(error, "检查网络或代理后重试；也可以改用「从 Git 安装」。"),
        };
      }
    },

    async download(slug: string): Promise<Uint8Array> {
      const clean = slug.trim();
      const response = await fetchImpl(`${baseUrl}/api/v1/download?slug=${encodeURIComponent(clean)}`, {
        headers: { Accept: "application/zip", "User-Agent": "agent-butler/1.0" },
        signal: AbortSignal.timeout(60_000),
        redirect: "follow",
      });
      if (response.status === 404) throw new Error("SkillHub 上不存在该技能或不可见");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > DOWNLOAD_MAX_BYTES) {
        throw new Error(`技能包超过 ${Math.floor(DOWNLOAD_MAX_BYTES / 1024 / 1024)}MB 上限`);
      }
      if (buffer.byteLength < 100) throw new Error("下载内容不是有效的技能包");
      return buffer;
    },

    async detail(slug) {
      const clean = slug.trim();
      try {
        const body = await getJson(`/api/v1/skills/${encodeURIComponent(clean)}`, 15_000) as { latestVersion?: unknown };
        const version = isRecord(body) && isRecord(body["latestVersion"]) ? asString(body["latestVersion"]["version"]) : "";
        return { latestVersion: version === "" ? null : version };
      } catch {
        return null;
      }
    },

    async latestVersions(slugs) {
      const result = new Map<string, string>();
      const clean = slugs.map((slug) => slug.trim()).filter((slug) => slug !== "").slice(0, 1000);
      if (clean.length === 0) return result;
      try {
        const response = await fetchImpl(`${baseUrl}/api/v1/skills/batch`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "agent-butler/1.0" },
          body: JSON.stringify({ slugs: clean }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) return result;
        const body = await response.json() as { items?: unknown };
        for (const item of Array.isArray(body.items) ? body.items : []) {
          if (!isRecord(item) || !isRecord(item["skill"])) continue;
          const slug = asString(item["skill"]["slug"]);
          const version = isRecord(item["latestVersion"]) ? asString(item["latestVersion"]["version"]) : "";
          if (slug !== "" && version !== "") result.set(slug, version);
        }
      } catch {
        // 网络失败返回空映射，调用方按「检查失败」呈现
      }
      return result;
    },
  };
}

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

export interface ZipLimits {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
}

const DEFAULT_ZIP_LIMITS = { maxEntries: 400, maxTotalBytes: 24 * 1024 * 1024, maxFileBytes: 8 * 1024 * 1024 };

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | bytes[offset + 3]! * 0x1000000) >>> 0;
}

function hasFlag(flags: number, bit: number): boolean {
  return (flags & (1 << bit)) !== 0;
}

/**
 * 归一 zip 条目路径：统一正斜杠、拒绝绝对路径与 .. 穿越、拒绝 NUL。
 * 返回 null 表示路径不安全（调用方拒绝整个包，避免 zip-slip）。
 */
function safeZipPath(raw: string): string | null {
  if (raw.includes("\0")) return null;
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const cleaned = segments.filter((segment) => segment !== "" && segment !== ".");
  return cleaned.length === 0 ? null : cleaned.join("/");
}

/**
 * 读取 zip（store 与 deflate 两种方法）为条目数组，跳过目录条目。
 * 安全上限：条目数/总解压字节/单文件字节超限即抛错，防解压炸弹；
 * 加密条目、不安全路径抛错（整包拒绝，而非静默跳过）。
 */
export function readZipEntries(bytes: Uint8Array, limits: ZipLimits = {}): ZipEntry[] {
  const cap = { ...DEFAULT_ZIP_LIMITS, ...limits };
  // 定位 EOCD（注释最长 65535，从尾部扫描）。
  let eocd = -1;
  const scanStart = Math.max(0, bytes.length - 22 - 65_536);
  for (let offset = bytes.length - 22; offset >= scanStart; offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip 包（缺少结束记录）");
  const entryCount = readU16(bytes, eocd + 10);
  if (entryCount > cap.maxEntries) throw new Error(`技能包文件数超过 ${cap.maxEntries} 上限`);
  let cursor = readU32(bytes, eocd + 16);
  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  const decoder = new TextDecoder();
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(bytes, cursor) !== 0x02014b50) throw new Error("zip 中央目录损坏");
    const flags = readU16(bytes, cursor + 8);
    const method = readU16(bytes, cursor + 10);
    const compressedSize = readU32(bytes, cursor + 20);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const localOffset = readU32(bytes, cursor + 42);
    const name = safeZipPath(decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)));
    if (name === null) throw new Error(`技能包含不安全路径：${decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))}`);
    if (hasFlag(flags, 0)) throw new Error("技能包含加密条目，拒绝处理");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue; // 目录条目
    if (method !== 0 && method !== 8) throw new Error(`不支持的压缩方法：${method}`);
    if (readU32(bytes, localOffset) !== 0x04034b50) throw new Error("zip 本地头损坏");
    const localNameLength = readU16(bytes, localOffset + 26);
    const localExtraLength = readU16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    let data: Uint8Array;
    if (method === 0) {
      data = raw;
    } else {
      const inflated = inflateRawSync(raw);
      data = new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
    }
    if (data.byteLength > cap.maxFileBytes) throw new Error(`技能包单个文件超过 ${Math.floor(cap.maxFileBytes / 1024 / 1024)}MB 上限`);
    totalBytes += data.byteLength;
    if (totalBytes > cap.maxTotalBytes) throw new Error(`技能包解压总量超过 ${Math.floor(cap.maxTotalBytes / 1024 / 1024)}MB 上限`);
    entries.push({ path: name, data });
  }
  return entries;
}

/** 解析 tar 头部 124 偏移的八进制长度（兼容 GNU base-256）。 */
function tarSize(header: Uint8Array, offset: number): number {
  if ((header[offset]! & 0x80) !== 0) {
    // GNU base-256：最高位为 1，其余按大端无符号读。
    let value = 0;
    for (let index = 0; index < 12; index += 1) value = value * 256 + header[offset + index]!;
    return value;
  }
  let value = 0;
  for (let index = 0; index < 12; index += 1) {
    const byte = header[offset + index]!;
    if (byte === 0 || byte === 0x20) break;
    value = value * 8 + (byte - 0x30);
  }
  return value;
}

function tarName(header: Uint8Array, length: number): string {
  const decoder = new TextDecoder();
  let end = Math.min(length, 100);
  for (let index = 0; index < end; index += 1) {
    if (header[index] === 0) { end = index; break; }
  }
  return decoder.decode(header.subarray(0, end));
}

/**
 * 读取 tar.gz（GitHub 仓库 tarball 格式）为条目数组，跳过目录与 pax 元数据，
 * 支持 GNU 长文件名（typeflag 'L'）与 pax path 覆盖。安全约束与 zip 读取器一致：
 * 路径穿越/加密不涉及（tar 无加密），条目数与解压总量受同一上限约束。
 */
export function readTarGzEntries(bytes: Uint8Array, limits: ZipLimits = {}): ZipEntry[] {
  const cap = { ...DEFAULT_ZIP_LIMITS, ...limits };
  let tar: Uint8Array;
  try {
    tar = new Uint8Array(gunzipSync(bytes));
  } catch {
    throw new Error("不是有效的 tar.gz 包");
  }
  if (tar.byteLength % 512 !== 0 && tar.byteLength < 512) throw new Error("tar 包已损坏");
  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  let offset = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header[0] === 0) break; // 结束块
    const nameField = tarName(header, 100);
    const size = tarSize(header, 124);
    const typeflag = String.fromCharCode(header[156] ?? 0x30);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength) throw new Error("tar 包已损坏（长度越界）");
    const data = () => tar.subarray(dataStart, dataEnd);
    if (typeflag === "L") {
      longName = new TextDecoder().decode(data()).replace(/\0+$/, "");
    } else if (typeflag === "x") {
      // pax 扩展头：记录里 "len path=..." 覆盖下一个条目名。
      const text = new TextDecoder().decode(data());
      const match = /(?:^|\n)[^=\n]*path=([^\n]+)/.exec(text);
      paxPath = match?.[1] ?? null;
    } else if (typeflag === "0" || typeflag === "\0") {
      const rawName = longName ?? paxPath ?? nameField;
      longName = null;
      paxPath = null;
      const name = safeZipPath(rawName);
      if (name === null) throw new Error(`技能包含不安全路径：${rawName}`);
      const fileData = new Uint8Array(data().buffer, data().byteOffset, size);
      if (size > cap.maxFileBytes) throw new Error(`技能包单个文件超过 ${Math.floor(cap.maxFileBytes / 1024 / 1024)}MB 上限`);
      totalBytes += size;
      if (totalBytes > cap.maxTotalBytes) throw new Error(`技能包解压总量超过 ${Math.floor(cap.maxTotalBytes / 1024 / 1024)}MB 上限`);
      entries.push({ path: name, data: fileData });
    } else {
      longName = null;
      paxPath = null;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0) throw new Error("tar 包中没有文件");
  return entries;
}

export interface GitSource {
  owner: string;
  repo: string;
  /** 分支/标签/commit；缺省为仓库默认分支（HEAD）。 */
  ref?: string;
}

/** 解析用户输入的 GitHub 来源：owner/repo、完整 URL、/tree/branch、.git 后缀。 */
export function parseGitSource(input: string): GitSource | null {
  const raw = input.trim();
  if (raw === "") return null;
  const simplified = raw.replace(/\.git$/i, "");
  const treeMatch = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/tree\/([^/]+)$/i.exec(simplified);
  if (treeMatch) return { owner: treeMatch[1]!, repo: treeMatch[2]!, ref: treeMatch[3] };
  const webMatch = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/i.exec(simplified);
  if (webMatch) return { owner: webMatch[1]!, repo: webMatch[2]! };
  const shorthand = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(simplified);
  if (shorthand) return { owner: shorthand[1]!, repo: shorthand[2]! };
  return null;
}

/** 语义化版本比较：candidate 更大时返回 true；无法解析时退化为字符串比较。 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string) =>
    value.replace(/^v/, "").split(/[.+-]/).map((part) => ( /^\d+$/.test(part) ? Number(part) : part));
  const left = parse(candidate);
  const right = parse(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined && b === undefined) return false;
    const aNum = typeof a === "number" ? a : -1;
    const bNum = typeof b === "number" ? b : -1;
    if (aNum !== bNum) return aNum > bNum;
    if (a !== b) return String(a) > String(b);
  }
  return false;
}
