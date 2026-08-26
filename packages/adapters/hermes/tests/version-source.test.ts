import { describe, expect, it } from "vitest";
import { fail, ok } from "@butler/contract";
import {
  compareVersions,
  createVersionSources,
  listAvailableVersions,
  mirrorUrlOf,
  type VersionListSource,
} from "../src/control/version-source.js";

/* ------------------------------ 测试基础设施 ------------------------------ */

/** 构造伪 Response（ok/status/json）；测试零网络，fetch 一律注入。 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** 按请求 URL 分派的 fake fetch（记录全部请求 URL）。 */
function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return ((url: unknown) => {
    const u = String(url);
    return Promise.resolve(handler(u));
  }) as unknown as typeof fetch;
}

const GITHUB_RELEASES_URL = "https://api.github.com/repos/NousResearch/hermes-agent/releases";
const DOCKER_TAGS_URL = "https://hub.docker.com/v2/repositories/hermes-agent/hermes/tags";
const releasesBody = [
  {
    tag_name: "v2026.8.19",
    prerelease: false,
    body: "# Hermes Agent v0.21.0 (v2026.8.19)\n\n> Patch release\n- 修复 iLink 会话过期后静默丢消息\n- 新增飞书卡片回调白名单",
    published_at: "2026-08-21T12:16:39Z",
  },
  { tag_name: "v0.20.4", prerelease: false },
  { tag_name: "v0.21.0-beta.1", prerelease: true, body: "# Hermes Agent v0.21.0-beta.1" },
  { tag_name: "0.19.0", prerelease: false },
  { tag_name: "v2026.8.19", prerelease: false }, // 重复 tag：去重
];

const dockerBody = {
  results: [{ name: "0.21.0" }, { name: "0.20.4" }, { name: "latest" }, { name: "0.21.0-beta.1" }],
};

/* --------------------------------- 比较器 --------------------------------- */

describe("compareVersions", () => {
  it("按数值段比较（0.21.0 > 0.20.10 > 0.9.9）", () => {
    expect(compareVersions("0.21.0", "0.20.10")).toBeGreaterThan(0);
    expect(compareVersions("0.20.10", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.21.0", "0.21.0")).toBe(0);
  });

  it("数值段相等时无预发布后缀者更高（semver 语义）", () => {
    expect(compareVersions("0.21.0", "0.21.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("0.21.0-beta.1", "0.21.0")).toBeLessThan(0);
  });

  it("段数不等时缺段按缺省比较（1.0 ≈ 1.0.0）", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0")).toBeGreaterThan(0);
  });
});

describe("mirrorUrlOf", () => {
  it("纯主机名 → 同路径换 host", () => {
    expect(mirrorUrlOf("gh-mirror.example.com", GITHUB_RELEASES_URL)).toBe(
      "https://gh-mirror.example.com/repos/NousResearch/hermes-agent/releases",
    );
    expect(mirrorUrlOf("gh-mirror.example.com/", GITHUB_RELEASES_URL)).toBe(
      "https://gh-mirror.example.com/repos/NousResearch/hermes-agent/releases",
    );
  });

  it("含协议 → ghproxy 类前缀形态（原 URL 拼在镜像后）", () => {
    expect(mirrorUrlOf("https://ghproxy.example.com", GITHUB_RELEASES_URL)).toBe(
      `https://ghproxy.example.com/${GITHUB_RELEASES_URL}`,
    );
  });
});

/* ------------------------------ createVersionSources ------------------------------ */

describe("createVersionSources", () => {
  it("默认序列：GitHub → PyPI → Docker Hub（无 mirror 时不插入镜像源）", () => {
    const sources = createVersionSources({});
    expect(sources.map((s) => s.id)).toEqual(["github-releases", "pypi", "docker-hub"]);
  });

  it("提供 mirrorHost 时插入镜像源（GitHub → 镜像 → PyPI → Docker Hub）", () => {
    const sources = createVersionSources({ mirrorHost: "gh-mirror.example.com" });
    expect(sources.map((s) => s.id)).toEqual(["github-releases", "github-releases-mirror", "pypi", "docker-hub"]);
  });

  it("自定义 sources 覆盖默认序列", () => {
    const custom: VersionListSource[] = [{ id: "custom", list: async () => ok({ versions: [] }) }];
    expect(createVersionSources({ sources: custom })).toBe(custom);
  });
});

/* ---------------------------- listAvailableVersions ---------------------------- */

describe("listAvailableVersions", () => {
  it("GitHub 源成功：去 v 前缀、prerelease→beta、去重降序", async () => {
    const r = await listAvailableVersions({
      fetchFn: fakeFetch(() => jsonResponse(releasesBody)),
    });
    expect(r.ok).toBe(true);
    expect(r.data!.source).toBe("github-releases");
    expect(r.data!.versions).toEqual([
      {
        version: "2026.8.19",
        channel: "stable",
        displayVersion: "0.21.0",
        notes: "修复 iLink 会话过期后静默丢消息 新增飞书卡片回调白名单",
        publishedAt: "2026-08-21T12:16:39Z",
      },
      { version: "0.21.0-beta.1", channel: "beta", displayVersion: "0.21.0" },
      { version: "0.20.4", channel: "stable" },
      { version: "0.19.0", channel: "stable" },
    ]);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("GitHub 失败 → 回退镜像源（同路径走镜像 host）", async () => {
    const urls: string[] = [];
    const r = await listAvailableVersions({
      mirrorHost: "gh-mirror.example.com",
      fetchFn: fakeFetch((url) => {
        urls.push(url);
        return url.startsWith("https://gh-mirror.example.com/")
          ? jsonResponse(releasesBody)
          : jsonResponse({ message: "rate limited" }, 403);
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.data!.source).toBe("github-releases-mirror");
    expect(urls[0]).toBe(GITHUB_RELEASES_URL);
    expect(urls[1]).toBe("https://gh-mirror.example.com/repos/NousResearch/hermes-agent/releases");
  });

  it("GitHub 与 PyPI 均失败 → 回退 Docker Hub（过滤 latest 等非版本 tag）", async () => {
    const r = await listAvailableVersions({
      fetchFn: fakeFetch((url) =>
        url === DOCKER_TAGS_URL ? jsonResponse(dockerBody) : jsonResponse({ message: "oops" }, 500),
      ),
    });
    expect(r.ok).toBe(true);
    expect(r.data!.source).toBe("docker-hub");
    expect(r.data!.versions).toEqual([
      { version: "0.21.0", channel: "stable" },
      { version: "0.21.0-beta.1", channel: "stable" },
      { version: "0.20.4", channel: "stable" },
    ]);
  });

  it("解析异常（非数组载荷 / json 抛错）→ 该源失败转下一源", async () => {
    let call = 0;
    const r = await listAvailableVersions({
      fetchFn: fakeFetch(() => {
        call += 1;
        if (call === 1) return jsonResponse({ message: "not an array" }); // GitHub：结构异常
        if (call === 2) {
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw new Error("Unexpected token < in JSON");
            },
          } as unknown as Response; // Docker Hub：JSON 解析失败
        }
        return jsonResponse(releasesBody);
      }),
    });
    expect(call).toBe(3);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("E203");
    expect(r.error!.userHint).toContain("mirrorHost");
  });

  it("空版本列表视为源失败（无 release 的仓库转下一源）", async () => {
    const r = await listAvailableVersions({
      fetchFn: fakeFetch((url) => (url === GITHUB_RELEASES_URL ? jsonResponse([]) : jsonResponse(dockerBody))),
    });
    expect(r.ok).toBe(true);
    expect(r.data!.source).toBe("docker-hub");
  });

  it("全部源失败 → E203 且 userHint 说明可配 mirrorHost", async () => {
    const r = await listAvailableVersions({
      fetchFn: fakeFetch(() => jsonResponse({ message: "down" }, 503)),
    });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("E203");
    expect(r.error!.message).toContain("github-releases");
    expect(r.error!.message).toContain("docker-hub");
    expect(r.error!.userHint).toContain("mirrorHost");
  });

  it("超时：挂起 fetch 经 AbortSignal.timeout 中止 → 全源失败 E203", async () => {
    const hanging = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      })) as unknown as typeof fetch;
    const r = await listAvailableVersions({ fetchFn: hanging, timeoutMs: 30 });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("E203");
  });

  it("自定义 sources：任一成功即返回且不再探测后续源", async () => {
    const listCalls: string[] = [];
    const sources: VersionListSource[] = [
      {
        id: "first",
        list: async () => {
          listCalls.push("first");
          return fail("E203", "first source down");
        },
      },
      {
        id: "second",
        list: async () => {
          listCalls.push("second");
          return ok({ versions: [{ version: "1.2.3", channel: "stable" }] });
        },
      },
    ];
    const r = await listAvailableVersions({ sources });
    expect(listCalls).toEqual(["first", "second"]);
    expect(r.ok).toBe(true);
    expect(r.data!.source).toBe("second");
    expect(r.data!.versions).toEqual([{ version: "1.2.3", channel: "stable" }]);
  });
});
