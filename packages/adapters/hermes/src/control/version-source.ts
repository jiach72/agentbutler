/**
 * 版本源模块（Task 13.2 版本源部分）：可用版本列表的逐源探测。
 *
 * 默认源序列（任一成功即返回并携带 source id，全败 → E203）：
 * 1. github-releases         GitHub Releases API（api.github.com/repos/<repo>/releases）
 * 2. github-releases-mirror  GitHub API 镜像（提供 mirrorHost 时插入，同路径走镜像）
 * 3. pypi                    PyPI package metadata（pypi.org/pypi/<package>/json）
 * 4. docker-hub              Docker Hub tags API（hub.docker.com/v2/repositories/<image>/tags）
 *
 * 纪律约束（discipline.ts read-only 行）：只读探测、10s 超时（AbortSignal.timeout）、
 * 零副作用；fetch 一律走注入的 fetchFn（缺省全局 fetch，测试零网络）；
 * 所有失败以 Result 包装返回，绝不抛裸异常。版本列表去重后按 semver 近似
 * 数值段降序排列。
 */
import { fail, ok, type Result } from "@butler/contract";

export interface VersionListEntry {
  version: string;
  channel?: "stable" | "beta";
  /**
   * 上游工件 tag（git repo tag / docker image tag，保留原始 v 前缀，如 "v2026.9.24"）。
   * 升级拉取（git checkout / docker pull）用它定位工件；缺省按 version 拉取。
   * version 始终是与实例 pyproject 同轨的语义版本（release 正文可提取时优先），
   * 二者分离避免「日期 tag 可拉取但 pyproject 复核必失败」的虚假承诺。
   */
  tag?: string;
  /** 展示用版本号（与 version 同轨；保留字段兼容旧视图）。 */
  displayVersion?: string;
  /** 发布说明摘要（去掉 Markdown 标题后的正文，截断 220 字）。 */
  notes?: string;
  /** 发布时间（ISO 8601，来自 release published_at）。 */
  publishedAt?: string;
}

export interface VersionListSource {
  /** 源标识（如 "github-releases" / "github-releases-mirror" / "docker-hub"）。 */
  id: string;
  url?: string;
  /** 拉取版本列表；失败返回 fail（调用方转试下一源）。 */
  list(): Promise<Result<{ versions: VersionListEntry[] }>>;
}

export interface VersionSourceAttempt {
  id: string;
  url: string | null;
  status: "ok" | "failed";
  error?: string;
  durationMs: number;
}

export interface VersionSourceOptions {
  /** 注入 fetch（测试零网络）；缺省全局 fetch。 */
  fetchFn?: typeof fetch;
  /** 覆盖默认源序列。 */
  sources?: VersionListSource[];
  /** GitHub 仓库（默认 "NousResearch/hermes-agent"）。 */
  repo?: string;
  /** Docker Hub 镜像（默认 "nousresearch/hermes-agent"）。 */
  dockerImage?: string;
  /** PyPI 包名（默认 hermes-agent）。 */
  pypiPackage?: string;
  /** ghproxy 类 GitHub API 镜像（见 mirrorUrlOf）。 */
  mirrorHost?: string;
  /** GitHub API 访问令牌；配置后 api.github.com 不再受匿名限流（403）。 */
  githubToken?: string;
  /** 单源请求超时（默认 10_000，只读纪律）。 */
  timeoutMs?: number;
}

const PYPI_VERSION_RE = /^\d+(?:\.\d+)*(?:-[\w.+-]+)?$/;
/** 版本号形态约束：数值段开头，可带 -beta.1 类预发布后缀；latest/canary（+ 号）等非版本 tag 过滤。 */
const VERSION_SHAPE_RE = /^\d+(?:\.\d+)*(?:-[\w.+-]+)?$/;

/**
 * 由原始 tag 与（可选的）正文语义版本组装版本条目：
 * - 正文给出形态合法的语义版本时 version 用它（与实例 pyproject 同轨，拉取后复核才
 *   可能通过）；无正文版本时 version 退化为剥 v 的 tag（semver tag 仓库旧行为不变）；
 * - 两者皆不可得（canary「+」号 tag 等）→ 返回 null 丢弃：给出无法通过拉取复核的
 *   候选即是虚假承诺。
 * tag 字段始终保留原始工件标识（含 v 前缀），供 git checkout / docker pull 定位。
 */
function buildVersionEntry(input: {
  rawTag: string;
  bodySemver?: string;
  prerelease?: boolean;
  notes?: string;
  publishedAt?: string;
}): VersionListEntry | null {
  const tagVersion = stripVPrefix(input.rawTag);
  const version =
    input.bodySemver !== undefined && VERSION_SHAPE_RE.test(input.bodySemver)
      ? input.bodySemver
      : VERSION_SHAPE_RE.test(tagVersion)
        ? tagVersion
        : null;
  if (version === null) return null;
  return {
    version,
    tag: input.rawTag,
    channel: input.prerelease === true || version.includes("-") ? "beta" : "stable",
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.publishedAt !== undefined ? { publishedAt: input.publishedAt } : {}),
  };
}

function createPypiSource(packageName: string, fetchFn: typeof fetch, timeoutMs: number): VersionListSource {
  const url = `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`;
  return {
    id: "pypi",
    url,
    list: async () => {
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        return fail("E203", `version source pypi request failed: ${String(error)}`, { startedAt });
      }
      if (!response.ok) return fail("E203", `version source pypi HTTP ${response.status}`, { startedAt });
      try {
        const payload = (await response.json()) as { releases?: Record<string, unknown> };
        const versions = Object.keys(payload.releases ?? {})
          .filter((version) => PYPI_VERSION_RE.test(version))
          .map((version) => ({
            version,
            tag: version,
            channel: version.includes("-") ? "beta" as const : "stable" as const,
          }));
        if (versions.length === 0) return fail("E203", "version source pypi parsed 0 releases", { startedAt });
        return ok({ versions: dedupeAndSortDesc(versions) }, startedAt);
      } catch (error) {
        return fail("E203", `version source pypi returned invalid JSON: ${String(error)}`, { startedAt });
      }
    },
  };
}

/* --------------------- GitHub Releases（Atom 订阅兜底） --------------------- */

/**
 * releases.atom 兜底源：走 github.com 的 Atom 订阅（非 api.github.com），
 * 不受 GitHub API 匿名限流影响。逐条目解析：链接定位 tag，条目正文（content+title）
 * 提取语义版本作为 version（与 API 源同轨），tag 保留为工件标识。
 */
export function parseReleasesAtom(xml: string): VersionListEntry[] {
  const versions: VersionListEntry[] = [];
  const seenTags = new Set<string>();
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  for (const entryMatch of xml.matchAll(entryPattern)) {
    const block = entryMatch[1] ?? "";
    // 兼容两种形态：链接 https://github.com/<repo>/releases/tag/<tag> 与
    // 条目 id tag:github.com,2008:Repository/<owner>/<repo>/<tag>。
    const tagPattern = /(?:\/releases\/tag\/|Repository\/[^/]+\/[^/]+\/)(v?[0-9][A-Za-z0-9.+]*)/g;
    const rawTag = tagPattern.exec(block)?.[1];
    if (rawTag === undefined || seenTags.has(rawTag)) continue;
    seenTags.add(rawTag);
    // 语义版本只从 content 提取：标题即 tag 本体，扫描标题会把 canary tag
    // （v0.21.4+canary…）误提升为稳定版本 0.21.4，造成重复候选。
    const content = /<content[^>]*>([\s\S]*?)<\/content>/.exec(block)?.[1] ?? "";
    const contentSemver = displayVersionOf(content);
    const entry = buildVersionEntry({ rawTag, bodySemver: contentSemver });
    if (entry !== null) versions.push(entry);
  }
  return versions;
}

function createGithubReleasesAtomSource(
  id: string,
  atomUrl: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): VersionListSource {
  return {
    id,
    url: atomUrl,
    list: async () => {
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetchFn(atomUrl, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        return fail("E203", `version source ${id} request failed: ${String(e)}`, { startedAt });
      }
      if (!response.ok) {
        return fail("E203", `version source ${id} HTTP ${response.status}`, {
          userHint:
            response.status === 404
              ? `版本源 ${id} HTTP 404：上游仓库不存在或不可见，可用 BUTLER_VERSION_REPO 指定实际仓库`
              : `版本源 ${id} 返回 HTTP ${response.status}`,
          startedAt,
        });
      }
      let xml = "";
      try {
        xml = await response.text();
      } catch {
        xml = "";
      }
      const versions = parseReleasesAtom(xml);
      if (versions.length === 0) {
        return fail("E203", `version source ${id} parsed 0 releases`, { startedAt });
      }
      return ok({ versions: dedupeAndSortDesc(versions) }, startedAt);
    },
  };
}

/** GitHub 仓库缺省值。 */
export const DEFAULT_VERSION_REPO = "NousResearch/hermes-agent";
/** Docker Hub 镜像缺省值。 */
export const DEFAULT_VERSION_DOCKER_IMAGE = "nousresearch/hermes-agent";
/** 单源请求缺省超时（毫秒）。 */
export const DEFAULT_VERSION_TIMEOUT_MS = 10_000;

/** 剥离 tag 的 v/V 前缀（v0.21.0 → 0.21.0）。 */
function stripVPrefix(tag: string): string {
  return tag.startsWith("v") || tag.startsWith("V") ? tag.slice(1) : tag;
}

/** semver 近似比较（升序）：按 "." 数值段逐段比较（非数值段回退字典序；缺段按 0，
 * 即 1.0 ≈ 1.0.0）；数值段全部相等时，无预发布后缀（-beta.1 等）者更高（semver 语义），
 * 均有后缀时按后缀字典序（beta.1 < beta.2）。 */
export function compareVersions(a: string, b: string): number {
  const coreA = a.split("-")[0]!.split(".");
  const coreB = b.split("-")[0]!.split(".");
  const len = Math.max(coreA.length, coreB.length);
  for (let i = 0; i < len; i += 1) {
    const sa = coreA[i] ?? "0"; // 缺段按 0
    const sb = coreB[i] ?? "0";
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
      continue;
    }
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  const hasPreA = a.includes("-");
  const hasPreB = b.includes("-");
  if (hasPreA !== hasPreB) return hasPreA ? -1 : 1;
  if (!hasPreA) return 0; // 数值段相等且均无预发布 → 相等（1.0 ≈ 1.0.0）
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 去重（首见优先）并按版本降序排列。 */
function dedupeAndSortDesc(entries: VersionListEntry[]): VersionListEntry[] {
  const byVersion = new Map<string, VersionListEntry>();
  for (const entry of entries) {
    if (!byVersion.has(entry.version)) byVersion.set(entry.version, entry);
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * 镜像 URL 组装：
 * - mirrorHost 含协议（如 "https://ghproxy.example.com"）→ ghproxy 类前缀形态，
 *   原完整 GitHub API URL 拼在镜像之后；
 * - 否则视为纯主机名 → 同路径换 host（https://<mirrorHost>/repos/<repo>/releases）。
 */
export function mirrorUrlOf(mirrorHost: string, originalUrl: string): string {
  const host = mirrorHost.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(host)) return `${host}/${originalUrl}`;
  const path = originalUrl.replace(/^https?:\/\/[^/]+/i, "");
  return `https://${host}${path}`;
}

/* ------------------------------ GitHub Releases ----------------------------- */

/** GitHub release 载荷的最小面（tag_name + prerelease + body + published_at）。 */
interface GithubReleaseLike {
  tag_name?: unknown;
  prerelease?: unknown;
  body?: unknown;
  published_at?: unknown;
}

/** 从 release 正文第一处 vX.Y.Z（可带 -beta.1 预发布后缀）提取语义版本。 */
function displayVersionOf(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  const match = body.match(/v?(\d+\.\d+\.\d+(?:-[\w.+-]+)?)/);
  return match === null ? undefined : match[1];
}

/** 发布说明摘要：去掉 Markdown 标题与引用符号，压缩空白后截断 220 字（空结果 → undefined）。 */
function notesOf(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  const text = body
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/^>\s*.*$/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? undefined : text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

function createGithubReleasesSource(
  id: string,
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  token?: string,
): VersionListSource {
  return {
    id,
    url,
    list: async () => {
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetchFn(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            accept: "application/vnd.github+json",
            ...(token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` }),
          },
        });
      } catch (e) {
        return fail("E203", `version source ${id} request failed: ${String(e)}`, {
          userHint: `版本源 ${id} 请求失败（网络不可达或超时）`,
          cause: e,
          startedAt,
        });
      }
      if (!response.ok) {
        return fail("E203", `version source ${id} HTTP ${response.status}`, {
          userHint:
            response.status === 403 || response.status === 429
              ? `版本源 ${id} 触发 GitHub API 限流（HTTP ${response.status}）；配置 GITHUB_TOKEN 可解除`
              : response.status === 404
                ? `版本源 ${id} HTTP 404：上游仓库不存在或不可见，可用 BUTLER_VERSION_REPO 指定实际仓库`
                : `版本源 ${id} 返回 HTTP ${response.status}`,
          startedAt,
        });
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (e) {
        return fail("E203", `version source ${id} returned invalid JSON: ${String(e)}`, {
          userHint: `版本源 ${id} 返回内容无法解析为 JSON`,
          cause: e,
          startedAt,
        });
      }
      if (!Array.isArray(payload)) {
        return fail("E203", `version source ${id} payload is not an array`, {
          userHint: `版本源 ${id} 返回结构异常（应为 releases 数组）`,
          startedAt,
        });
      }
      const versions: VersionListEntry[] = [];
      const seenTags = new Set<string>();
      for (const item of payload as GithubReleaseLike[]) {
        const tag = item?.tag_name;
        if (typeof tag !== "string" || tag.trim() === "") continue;
        const rawTag = tag.trim();
        if (seenTags.has(rawTag)) continue; // 重复 tag：首见优先（正文可能不同，以首个为准）
        seenTags.add(rawTag);
        const entry = buildVersionEntry({
          rawTag,
          bodySemver: displayVersionOf(item?.body),
          prerelease: item.prerelease === true,
          notes: notesOf(item?.body),
          publishedAt: typeof item?.published_at === "string" ? item.published_at : undefined,
        });
        if (entry !== null) versions.push(entry);
      }
      if (versions.length === 0) {
        return fail("E203", `version source ${id} parsed 0 releases`, {
          userHint: `版本源 ${id} 未解析到任何版本号`,
          startedAt,
        });
      }
      return ok({ versions: dedupeAndSortDesc(versions) }, startedAt);
    },
  };
}

/* -------------------------------- Docker Hub -------------------------------- */

/** Docker Hub tags 载荷的最小面（{ results: [{ name }] }）。 */
interface DockerTagsLike {
  results?: unknown;
}

/** Docker tag 版本形态：数值段开头，可带预发布后缀（latest/edge 等不以数字开头的非版本 tag 过滤）。 */
const DOCKER_VERSION_RE = /^\d+(\.\d+)*(?:-[\w.+-]+)?$/;

function createDockerHubSource(
  image: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): VersionListSource {
  const url = `https://hub.docker.com/v2/repositories/${image}/tags`;
  return {
    id: "docker-hub",
    url,
    list: async () => {
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        return fail("E203", `version source docker-hub request failed: ${String(e)}`, {
          userHint: "版本源 docker-hub 请求失败（网络不可达或超时）",
          cause: e,
          startedAt,
        });
      }
      if (!response.ok) {
        return fail("E203", `version source docker-hub HTTP ${response.status}`, {
          userHint: `版本源 docker-hub 返回 HTTP ${response.status}`,
          startedAt,
        });
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (e) {
        return fail("E203", `version source docker-hub returned invalid JSON: ${String(e)}`, {
          userHint: "版本源 docker-hub 返回内容无法解析为 JSON",
          cause: e,
          startedAt,
        });
      }
      const results = (payload as DockerTagsLike | null)?.results;
      if (!Array.isArray(results)) {
        return fail("E203", "version source docker-hub payload has no results array", {
          userHint: "版本源 docker-hub 返回结构异常（应为 { results: [...] }）",
          startedAt,
        });
      }
      const versions: VersionListEntry[] = [];
      for (const item of results as Array<{ name?: unknown }>) {
        if (typeof item?.name !== "string") continue;
        const version = stripVPrefix(item.name.trim());
        if (!DOCKER_VERSION_RE.test(version)) continue; // latest 等非版本 tag 过滤
        versions.push({ version, tag: item.name.trim(), channel: "stable" });
      }
      if (versions.length === 0) {
        return fail("E203", "version source docker-hub parsed 0 version tags", {
          userHint: "版本源 docker-hub 未解析到任何版本号",
          startedAt,
        });
      }
      return ok({ versions: dedupeAndSortDesc(versions) }, startedAt);
    },
  };
}

/* ---------------------------------- 出入口 ---------------------------------- */

/** 组装默认源序列：GitHub → 镜像（mirrorHost 提供时）→ PyPI → Docker Hub。 */
export function createVersionSources(options: VersionSourceOptions = {}): VersionListSource[] {
  if (options.sources) return options.sources;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const repo = options.repo ?? DEFAULT_VERSION_REPO;
  const dockerImage = options.dockerImage ?? DEFAULT_VERSION_DOCKER_IMAGE;
  const pypiPackage = options.pypiPackage ?? "hermes-agent";
  const githubToken = options.githubToken;

  const githubUrl = `https://api.github.com/repos/${repo}/releases`;
  const sources: VersionListSource[] = [
    createGithubReleasesSource("github-releases", githubUrl, fetchFn, timeoutMs, githubToken),
  ];
  if (options.mirrorHost) {
    sources.push(
      createGithubReleasesSource(
        "github-releases-mirror",
        mirrorUrlOf(options.mirrorHost, githubUrl),
        fetchFn,
        timeoutMs,
        githubToken,
      ),
    );
  }
  // Atom 兜底：github.com 页面订阅（非 API），匿名限流下依然可用。
  sources.push(
    createGithubReleasesAtomSource(
      "github-releases-atom",
      `https://github.com/${repo}/releases.atom`,
      fetchFn,
      timeoutMs,
    ),
  );
  sources.push(createPypiSource(pypiPackage, fetchFn, timeoutMs));
  sources.push(createDockerHubSource(dockerImage, fetchFn, timeoutMs));
  return sources;
}

/** 逐源探测可用版本：任一源成功即返回（携带 source id）；全败 → E203。 */
export async function listAvailableVersions(
  options: VersionSourceOptions = {},
): Promise<Result<{ source: string; versions: VersionListEntry[]; attempts: VersionSourceAttempt[] }>> {
  const startedAt = Date.now();
  const sources = createVersionSources(options);
  const failures: string[] = [];
  const attempts: VersionSourceAttempt[] = [];
  for (const source of sources) {
    const attemptStartedAt = Date.now();
    const r = await source.list();
    if (r.ok) {
      attempts.push({ id: source.id, url: source.url ?? null, status: "ok", durationMs: Date.now() - attemptStartedAt });
      return ok({ source: source.id, versions: r.data!.versions, attempts }, startedAt);
    }
    attempts.push({ id: source.id, url: source.url ?? null, status: "failed", error: r.error?.message ?? "unknown", durationMs: Date.now() - attemptStartedAt });
    failures.push(`${source.id}: ${r.error?.message ?? "unknown"}`);
  }
  return fail("E203", `all version sources failed: ${failures.join("; ")}`, {
    userHint: `所有版本源（${sources.length} 个）均不可用；可配置 mirrorHost 走 GitHub API 镜像，或检查网络后重试`,
    startedAt,
    cause: attempts,
  });
}
