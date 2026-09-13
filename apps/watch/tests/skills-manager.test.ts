/**
 * skills-manager CLI 集成单元测试（fake execFile / fake fs，不触碰真实 CLI）。
 * 覆盖：参数拼装（--json / HOME / --dry-run / --agent claude_code）、JSON 解析、
 * SkillsManagerError 映射、ensureTarget 的 symlink 分支与部署目标冲突。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, lstatSync, readlinkSync, writeFileSync, symlinkSync as symlinkSyncReal, unlinkSync as unlinkSyncReal, existsSync as existsSyncReal, lstatSync as lstatSyncReal, readlinkSync as readlinkSyncReal, mkdirSync as mkdirSyncReal } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSkillsManagerCli,
  skillsManagerDownloadArtifact,
  SkillsManagerError,
  SKILLS_MANAGER_CLI_PATH,
  SKILLS_MANAGER_DEPLOY_AGENT,
  SKILLS_MANAGER_DEFAULT_VERSION,
  SKILLS_MANAGER_INSTALL_HINT,
  type SkillsManagerExecFile,
  type SkillsManagerFs,
} from "../src/skills-manager.js";

describe("createSkillsManagerCli", () => {
  let tmp: string;
  /** 与生产 defaultFs 同构的真实 fs（Windows 用 junction），供组合覆盖用。 */
  const defaultFsForTest: SkillsManagerFs = {
    existsSync: existsSyncReal,
    mkdirSync: mkdirSyncReal,
    lstatSync: (path) => {
      try {
        return lstatSyncReal(path);
      } catch {
        return undefined;
      }
    },
    readlinkSync: readlinkSyncReal,
    symlinkSync: (target, path) =>
      symlinkSyncReal(target, path, process.platform === "win32" ? "junction" : undefined),
    unlinkSync: unlinkSyncReal,
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "butler-skills-manager-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** fake execFile：记录每次调用，按队列返回 stdout 或抛错。 */
  function makeExec(outcomes: Array<{ stdout?: string; stderr?: string; error?: Error & { code?: string | number } }> = []): {
    exec: SkillsManagerExecFile;
    calls: Array<{ file: string; args: string[]; options: { env: Record<string, string | undefined>; timeout: number } }>;
  } {
    const calls: ReturnType<typeof makeExec>["calls"] = [];
    const exec: SkillsManagerExecFile = async (file, args, options) => {
      calls.push({ file, args, options: options as { env: Record<string, string | undefined>; timeout: number } });
      const next = outcomes.shift() ?? { stdout: "{}" };
      if (next.error !== undefined) throw next.error;
      return { stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
    };
    return { exec, calls };
  }

  it("run 以 --json 结尾、HOME 指向隔离 cliHome、默认 120s 超时，并解析 stdout JSON", async () => {
    const { exec, calls } = makeExec([{ stdout: '{"skill_count":3}\n' }]);
    const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
    const result = await cli.run(["repo", "status"]);
    expect(result).toEqual({ skill_count: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe(SKILLS_MANAGER_CLI_PATH);
    expect(calls[0]!.args).toEqual(["repo", "status", "--json"]);
    expect(calls[0]!.options.env["HOME"]).toBe(join(tmp, "home"));
    expect(calls[0]!.options.timeout).toBe(120_000);
  });

  it("run 透传注入的 timeoutMs", async () => {
    const { exec, calls } = makeExec();
    const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, timeoutMs: 5_000, autoDownload: false });
    await cli.run(["skills", "list"]);
    expect(calls[0]!.options.timeout).toBe(5_000);
  });

  it("非零退出时从 stdout 提取 {ok:false,code,message} 抛 SkillsManagerError", async () => {
    const { exec } = makeExec([
      { error: Object.assign(new Error("exit 2"), { code: 2, stdout: '{"ok":false,"code":"INVALID_ARGUMENT","message":"bad source"}' }) },
    ]);
    const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
    const error = await cli.run(["skills", "install", "bad"]).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SkillsManagerError);
    expect((error as SkillsManagerError).code).toBe("INVALID_ARGUMENT");
    expect((error as SkillsManagerError).message).toBe("bad source");
  });

  it("stdout 无 JSON 时回退 stderr，两者都无则归一为 skills-manager-cli-failed", async () => {
    const { exec } = makeExec([
      { error: Object.assign(new Error("boom"), { code: 1, stderr: '{"ok":false,"code":"TARGET_CONFLICT","message":"occupied"}' }) },
    ]);
    const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
    await expect(cli.run(["skills", "deploy", "x"])).rejects.toMatchObject({ code: "TARGET_CONFLICT" });

    const { exec: rawExec } = makeExec([
      { error: Object.assign(new Error("segmentation fault"), { code: 139, stdout: "not json", stderr: "" }) },
    ]);
    const rawCli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: rawExec, autoDownload: false });
    await expect(rawCli.run(["skills", "list"])).rejects.toMatchObject({ code: "skills-manager-cli-failed" });
  });

  it("ENOENT（CLI 不存在）映射为 skills-manager-unavailable", async () => {
    const { exec } = makeExec([
      { error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) },
    ]);
    const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
    await expect(cli.run(["repo", "status"])).rejects.toMatchObject({ code: "skills-manager-unavailable" });
  });

  /** 真实 fs、但 CLI 二进制视为存在（status 探测用）。 */
  function realFsWithCli(): SkillsManagerFs {
    return {
      ...defaultFsForTest,
      existsSync: (path: string) =>
        path === SKILLS_MANAGER_CLI_PATH || defaultFsForTest.existsSync(path),
    };
  }

  describe("ensureTarget", () => {
    function makeFs(): { fs: SkillsManagerFs; log: string[] } {
      const log: string[] = [];
      const links = new Map<string, string>();
      const dirs = new Set<string>();
      const files = new Set<string>();
      return {
        log,
        fs: {
          existsSync: (path) => dirs.has(path) || files.has(path) || links.has(path),
          mkdirSync: (path) => {
            log.push(`mkdir:${path}`);
            dirs.add(path);
          },
          lstatSync: (path) => {
            if (links.has(path)) return { isSymbolicLink: () => true };
            if (dirs.has(path) || files.has(path)) return { isSymbolicLink: () => false };
            return undefined;
          },
          readlinkSync: (path) => links.get(path) ?? "",
          symlinkSync: (target, path) => {
            log.push(`symlink:${path}->${target}`);
            links.set(path, target);
          },
          unlinkSync: (path) => {
            log.push(`unlink:${path}`);
            links.delete(path);
          },
        },
      };
    }

    /** mkdir 是前置动作，链接相关断言只看 symlink/unlink。 */
    const linkOps = (log: string[]): string[] => log.filter((entry) => !entry.startsWith("mkdir:"));

    it("symlink 不存在时创建指向 hermes skills 目录的链接", () => {
      const { fs, log } = makeFs();
      const hermes = join(tmp, "hermes", "skills");
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), hermesSkillsDir: hermes, fs, autoDownload: false });
      const target = cli.ensureTarget();
      expect(target).toEqual({ agent: SKILLS_MANAGER_DEPLOY_AGENT, dir: hermes, symlinked: true });
      expect(linkOps(log)).toEqual([`symlink:${join(tmp, "home", ".claude", "skills")}->${resolve(hermes)}`]);
    });

    it("已指向正确目标时不重做（不再 symlink/unlink）", () => {
      const { fs, log } = makeFs();
      const hermes = join(tmp, "hermes", "skills");
      const link = join(tmp, "home", ".claude", "skills");
      // 预置：模拟第一次已建好正确链接
      fs.symlinkSync(resolve(hermes), link);
      log.length = 0;
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), hermesSkillsDir: hermes, fs, autoDownload: false });
      expect(cli.ensureTarget().symlinked).toBe(true);
      expect(linkOps(log)).toEqual([]);
    });

    it("指向错误目标时替换为正确链接", () => {
      const { fs, log } = makeFs();
      const hermes = join(tmp, "hermes", "skills");
      const other = join(tmp, "somewhere-else");
      const link = join(tmp, "home", ".claude", "skills");
      fs.symlinkSync(resolve(other), link);
      log.length = 0;
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), hermesSkillsDir: hermes, fs, autoDownload: false });
      const target = cli.ensureTarget();
      expect(target.symlinked).toBe(true);
      expect(linkOps(log)).toEqual([
        `unlink:${link}`,
        `symlink:${link}->${resolve(hermes)}`,
      ]);
    });

    it("占用位置是真实目录时抛 deploy-target-conflict 且绝不删除", async () => {
      const { fs, log } = makeFs();
      const hermes = join(tmp, "hermes", "skills");
      const link = join(tmp, "home", ".claude", "skills");
      fs.mkdirSync(link, { recursive: true });
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), hermesSkillsDir: hermes, fs, autoDownload: false });
      const error = await Promise.resolve()
        .then(() => cli.ensureTarget())
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SkillsManagerError);
      expect((error as SkillsManagerError).code).toBe("deploy-target-conflict");
      expect(linkOps(log)).toEqual([]);
    });

    it("真实文件系统上创建、复用与读取一致", () => {
      const hermes = join(tmp, "hermes-skills");
      mkdirSync(hermes, { recursive: true });
      writeFileSync(join(hermes, "marker.txt"), "x", "utf-8");
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), hermesSkillsDir: hermes });
      cli.ensureTarget();
      const link = join(tmp, "home", ".claude", "skills");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(resolve(dirname(link), readlinkSync(link).replace(/^\\\\\?\\/, ""))).toBe(resolve(hermes));
      // 二次调用幂等：不抛错且链接保持
      expect(cli.ensureTarget().symlinked).toBe(true);
      expect(readFileSync(join(link, "marker.txt"), "utf-8")).toBe("x");
      expect(existsSync(link)).toBe(true);
    });
  });

  describe("高层操作参数拼装", () => {
    it("install 单段直接执行（CLI install 无 dry-run）；name 可选且会去空白", async () => {
      const { exec, calls } = makeExec();
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
      await cli.install({ source: "owner/repo" });
      expect(calls[0]!.args).toEqual(["skills", "install", "owner/repo", "--json"]);
      await cli.install({ source: "https://github.com/a/b.git", name: " My Skill ", confirmed: true });
      expect(calls[1]!.args).toEqual(["skills", "install", "https://github.com/a/b.git", "--name", "My Skill", "--json"]);
    });

    it("install sourceType 显式映射：--skillssh/--local，git/缺省不加旗标保持推断", async () => {
      const { exec, calls } = makeExec();
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
      await cli.install({ source: "github/foo/bar-skill", sourceType: "skills" });
      expect(calls[0]!.args).toEqual(["skills", "install", "github/foo/bar-skill", "--skillssh", "--json"]);
      await cli.install({ source: "/tmp/some-skill", sourceType: "local" });
      expect(calls[1]!.args).toEqual(["skills", "install", "/tmp/some-skill", "--local", "--json"]);
      await cli.install({ source: "owner/repo", sourceType: "git" });
      expect(calls[2]!.args).toEqual(["skills", "install", "owner/repo", "--json"]);
    });

    it("deploy/undeploy 先 ensureTarget 且固定 --agent claude_code", async () => {
      const hermes = join(tmp, "hermes-skills");
      mkdirSync(hermes, { recursive: true });
      const { exec, calls } = makeExec();
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), hermesSkillsDir: hermes, execFile: exec });
      await cli.deploy({ name: "demo" });
      expect(calls[0]!.args).toEqual(["skills", "deploy", "demo", "--agent", "claude_code", "--dry-run", "--json"]);
      expect(existsSync(join(tmp, "home", ".claude", "skills"))).toBe(true);
      await cli.undeploy({ name: "demo", confirmed: true });
      expect(calls[1]!.args).toEqual(["skills", "undeploy", "demo", "--agent", "claude_code", "--json"]);
    });

    it("check/update 直连执行（CLI update 无 dry-run），adopt 追加 --dry-run", async () => {
      const { exec, calls } = makeExec();
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
      await cli.check();
      expect(calls[0]!.args).toEqual(["skills", "check", "--all", "--json"]);
      await cli.update({ name: "demo", confirmed: true });
      expect(calls[1]!.args).toEqual(["skills", "update", "demo", "--json"]);
      await cli.adopt({ dir: join(tmp, "existing") });
      expect(calls[2]!.args).toEqual(["skills", "adopt", join(tmp, "existing"), "--dry-run", "--json"]);
    });

    it("update 未确认也直接执行（CLI update 不支持 --dry-run）", async () => {
      const { exec, calls } = makeExec();
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
      await cli.update({ name: "  " });
      expect(calls[0]!.args).toEqual(["skills", "update", "--all", "--json"]);
    });

    it("search 拼装 query/--limit；空白 query 抛 INVALID_ARGUMENT 且不调用 CLI", async () => {
      const { exec, calls } = makeExec();
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
      await cli.search({ query: "  github  ", limit: 7.8 });
      expect(calls[0]!.args).toEqual(["skills", "search", "github", "--limit", "7", "--json"]);
      await cli.search({ query: "demo" });
      expect(calls[1]!.args).toEqual(["skills", "search", "demo", "--json"]);
      await expect(cli.search({ query: "   " })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await cli.search({ query: "demo", limit: 0 });
      expect(calls[2]!.args).toEqual(["skills", "search", "demo", "--json"]);
      expect(calls).toHaveLength(3);
    });

    it("detail 并行聚合 skills show 与 skills status；空白 name 抛 INVALID_ARGUMENT", async () => {
      const { exec, calls } = makeExec([
        { stdout: '{"name":"demo","files":[]}' },
        { stdout: '{"name":"demo","agents":[]}' },
      ]);
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
      const result = await cli.detail(" Demo ");
      expect(result).toEqual({ show: { name: "demo", files: [] }, status: { name: "demo", agents: [] } });
      expect(calls.map((call) => call.args)).toEqual([
        ["skills", "show", "Demo", "--json"],
        ["skills", "status", "Demo", "--json"],
      ]);
      await expect(cli.detail("  ")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    });

    it("tags add/remove/set 拼装（标签去空白过滤）；非法输入抛 INVALID_ARGUMENT 不调用 CLI", async () => {
      const { exec, calls } = makeExec();
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
      await cli.tags({ action: "add", name: "demo", tags: [" 运维 ", "prod", "  "] });
      expect(calls[0]!.args).toEqual(["skills", "tag", "add", "demo", "运维", "prod", "--json"]);
      await cli.tags({ action: "remove", name: "demo", tags: ["prod"] });
      expect(calls[1]!.args).toEqual(["skills", "tag", "remove", "demo", "prod", "--json"]);
      await cli.tags({ action: "set", name: "demo", tags: ["single"] });
      expect(calls[2]!.args).toEqual(["skills", "tag", "set", "demo", "single", "--json"]);
      await expect(cli.tags({ action: "add", name: "  ", tags: ["x"] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(cli.tags({ action: "add", name: "demo", tags: ["  "] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(cli.tags({ action: "delete", name: "demo", tags: ["x"] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(calls).toHaveLength(3);
    });

    it("set-source 二段式：默认 --dry-run，confirmed 去掉；subpath/branch/force 按需拼装", async () => {
      const { exec, calls } = makeExec();
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
      await cli.setSource({ name: "demo", gitUrl: " owner/repo " });
      expect(calls[0]!.args).toEqual(["skills", "set-source", "demo", "--git-url", "owner/repo", "--dry-run", "--json"]);
      await cli.setSource({ name: "demo", gitUrl: "https://github.com/a/b.git", subpath: " skills/x ", branch: "main", force: true, confirmed: true });
      expect(calls[1]!.args).toEqual([
        "skills", "set-source", "demo",
        "--git-url", "https://github.com/a/b.git",
        "--subpath", "skills/x",
        "--branch", "main",
        "--force",
        "--json",
      ]);
      await expect(cli.setSource({ name: "  ", gitUrl: "x" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(cli.setSource({ name: "demo", gitUrl: "  " })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(calls).toHaveLength(2);
    });

    it("updateAll 先 update --all 再 check --all（两段串行）", async () => {
      const { exec, calls } = makeExec([
        { stdout: '{"updated":2}' },
        { stdout: '[{"name":"demo","update_status":"up_to_date"}]' },
      ]);
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
      const result = await cli.updateAll();
      expect(result).toEqual({
        update: { updated: 2 },
        checks: [{ name: "demo", update_status: "up_to_date" }],
      });
      expect(calls.map((call) => call.args)).toEqual([
        ["skills", "update", "--all", "--json"],
        ["skills", "check", "--all", "--json"],
      ]);
    });
  });

  describe("remove", () => {
    it("未 confirmed：--dry-run 预览（无 --yes），不触发 undeploy", async () => {
      const { exec, calls } = makeExec();
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
      await cli.remove({ name: " demo " });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual(["skills", "remove", "demo", "--dry-run", "--json"]);
    });

    it("confirmed：先 undeploy（claude_code）容忍「未部署」失败，再 remove --yes", async () => {
      // 第一段 undeploy 返回「未部署」类业务错误：remove 应容忍并继续删除中央库条目。
      const { exec, calls } = makeExec([
        {
          error: Object.assign(new Error("exit 1"), {
            code: 1,
            stdout: '{"ok":false,"code":"NOT_DEPLOYED","message":"skill not deployed to claude_code"}',
          }),
        },
        { stdout: '{"ok":true}' },
      ]);
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
      await cli.remove({ name: "demo", confirmed: true });
      expect(calls.map((call) => call.args)).toEqual([
        ["skills", "undeploy", "demo", "--agent", "claude_code", "--json"],
        ["skills", "remove", "demo", "--yes", "--json"],
      ]);
    });

    it("confirmed：undeploy 非「未部署」失败原样抛出，不继续 remove", async () => {
      const { exec, calls } = makeExec([
        {
          error: Object.assign(new Error("exit 1"), {
            code: 1,
            stdout: '{"ok":false,"code":"TARGET_CONFLICT","message":"occupied"}',
          }),
        },
      ]);
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
      await expect(cli.remove({ name: "demo", confirmed: true })).rejects.toMatchObject({
        code: "TARGET_CONFLICT",
      });
      expect(calls).toHaveLength(1);
    });

    it("name 缺失/空白抛 INVALID_ARGUMENT，不调用 CLI", async () => {
      const { exec, calls } = makeExec();
      const cli = createSkillsManagerCli({ cliHome: join(tmp, "home"), cliDownloadDir: join(tmp, "bin"), execFile: exec, autoDownload: false });
      await expect(cli.remove({ name: "  " })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(cli.remove({ name: "", confirmed: true })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe("CLI 自动下载", () => {
    function makeFakeResponse(status: number, body?: Uint8Array): Response {
      return {
        ok: status === 200,
        status,
        arrayBuffer: async () => (body ?? new Uint8Array(0)).buffer,
      } as unknown as Response;
    }

    it("镜像/配置路径缺失时从 GitHub 下载到 cliDownloadDir 并落位", async () => {
      const dir = join(tmp, "dl");
      const { exec, calls } = makeExec([
        { stdout: "skills-manager-cli 1.36.1" }, // 落位前 --version 冒烟
        { stdout: '{"skill_count":1}' + String.fromCharCode(10) },
      ]);
      const fakeBody = new Uint8Array(2_000_000);
      fakeBody.fill(0x7f);
      const cli = createSkillsManagerCli({
        cliHome: join(tmp, "home"),
        cliDownloadDir: dir,
        execFile: exec,
        fetchImpl: (async () => makeFakeResponse(200, fakeBody)) as unknown as typeof fetch,
        autoDownload: true,
      });
      const result = await cli.run(["repo", "status"]);
      expect(result).toEqual({ skill_count: 1 });
      // 第一次 exec 是冒烟 --version（执行的是临时文件路径），rename 落位后业务调用走正式文件。
      expect(calls[0]!.args).toEqual(["--version"]);
      expect(calls[0]!.file).toContain(`${join(dir, ".skills-manager-cli.")}`);
      expect(calls[1]!.file).toBe(join(dir, "skills-manager-cli"));
      expect(existsSync(join(dir, "skills-manager-cli"))).toBe(true);
    });

    it("下载失败（HTTP 404）时回退为不可用并给出安装指引", async () => {
      const dir = join(tmp, "dl-fail");
      const cli = createSkillsManagerCli({
        cliHome: join(tmp, "home"),
        cliDownloadDir: dir,
        execFile: makeExec().exec,
        fetchImpl: (async () => makeFakeResponse(404)) as unknown as typeof fetch,
        autoDownload: true,
      });
      const status = await cli.status();
      expect(status).toMatchObject({ available: false });
    });

    it("已有数据卷副本时直接复用（不再尝试下载）", async () => {
      const dir = join(tmp, "dl-cached");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "skills-manager-cli"), "#!fake");
      let fetched = false;
      const cli = createSkillsManagerCli({
        cliHome: join(tmp, "home"),
        cliDownloadDir: dir,
        execFile: makeExec().exec,
        fetchImpl: (async () => {
          fetched = true;
          return makeFakeResponse(200);
        }) as unknown as typeof fetch,
        autoDownload: true,
      });
      const status = await cli.status();
      expect(status).toMatchObject({ available: true });
      expect(fetched).toBe(false);
    });

    it("按当前平台选择下载产物（macOS arm64 → macOS-arm64，不再下载 Linux ELF）", async () => {
      const dir = join(tmp, "dl-plat");
      let requestedUrl = "";
      const { exec, calls } = makeExec([
        { stdout: "skills-manager-cli 1.36.1" }, // 冒烟 --version
        { stdout: '{"skill_count":1}' }, // 业务调用 repo status --json
      ]);
      const cli = createSkillsManagerCli({
        cliHome: join(tmp, "home"),
        cliDownloadDir: dir,
        execFile: exec,
        fetchImpl: (async (url: string | URL | globalThis.Request) => {
          requestedUrl = String(url);
          return makeFakeResponse(200, new Uint8Array(2_000_000));
        }) as unknown as typeof fetch,
        autoDownload: true,
      });
      const result = await cli.run(["repo", "status"]);
      expect(result).toEqual({ skill_count: 1 });
      // 下载产物按运行平台取自映射表；冒烟先走 --version（无 --json）。
      expect(requestedUrl).toContain(`releases/download/${SKILLS_MANAGER_DEFAULT_VERSION}/`);
      expect(requestedUrl.endsWith(skillsManagerDownloadArtifact())).toBe(true);
      expect(calls[0]!.args).toEqual(["--version"]);
    });

    it("下载后先冒烟 --version 再落位；通过则 rename 到位且 CLI 正常调用", async () => {
      const dir = join(tmp, "dl-smoke-ok");
      const { exec, calls } = makeExec([
        { stdout: "skills-manager-cli 1.36.1" }, // 冒烟 --version
        { stdout: '{"skill_count":1}' }, // 业务调用 repo status --json
      ]);
      const cli = createSkillsManagerCli({
        cliHome: join(tmp, "home"),
        cliDownloadDir: dir,
        execFile: exec,
        fetchImpl: (async () => makeFakeResponse(200, new Uint8Array(2_000_000))) as unknown as typeof fetch,
        autoDownload: true,
      });
      const result = await cli.run(["repo", "status"]);
      expect(result).toEqual({ skill_count: 1 });
      // 第一次调用是冒烟（--version，无 --json），第二次才是业务调用。
      expect(calls[0]!.args).toEqual(["--version"]);
      expect(calls[0]!.options.timeout).toBe(15_000);
      expect(calls[1]!.file).toBe(join(dir, "skills-manager-cli"));
      expect(existsSync(join(dir, "skills-manager-cli"))).toBe(true);
    });

    it("冒烟失败（Linux ELF 在 macOS 触发 ENOEXEC 的等价场景）时删除临时文件不落位", async () => {
      const dir = join(tmp, "dl-smoke-enoexec");
      // execFile 抛 ENOEXEC：非本平台 ELF 的真实失败形态。
      const { exec, calls } = makeExec([
        { error: Object.assign(new Error("spawn ENOEXEC"), { code: "ENOEXEC" }) },
      ]);
      const cli = createSkillsManagerCli({
        cliHome: join(tmp, "home"),
        cliDownloadDir: dir,
        execFile: exec,
        fetchImpl: (async () => makeFakeResponse(200, new Uint8Array(2_000_000))) as unknown as typeof fetch,
        autoDownload: true,
      });
      // 走 unavailable 提示，不抛错、不中断服务。
      const status = await cli.status();
      expect(status).toEqual({ available: false, installHint: SKILLS_MANAGER_INSTALL_HINT });
      expect(calls.map((call) => call.args)).toEqual([["--version"]]);
      // 临时文件已被清理，正式落位文件不存在。
      expect(existsSync(join(dir, ".skills-manager-cli.0.tmp"))).toBe(false);
      expect(existsSync(join(dir, "skills-manager-cli"))).toBe(false);
    });

    it("冒烟输出无版本号数字（如 HTML 错误页文本）同样拒绝落位", async () => {
      const dir = join(tmp, "dl-smoke-noise");
      const { exec, calls } = makeExec([
        { stdout: "<html>Not Found</html>", stderr: "" },
      ]);
      const cli = createSkillsManagerCli({
        cliHome: join(tmp, "home"),
        cliDownloadDir: dir,
        execFile: exec,
        fetchImpl: (async () => makeFakeResponse(200, new Uint8Array(2_000_000))) as unknown as typeof fetch,
        autoDownload: true,
      });
      const status = await cli.status();
      expect(status).toMatchObject({ available: false });
      expect(calls.map((call) => call.args)).toEqual([["--version"]]);
      expect(existsSync(join(dir, "skills-manager-cli"))).toBe(false);
    });
  });

  /** 产物名映射表与 v1.36.1 release 实测清单逐一对应。 */
  describe("skillsManagerDownloadArtifact", () => {
    it("覆盖五个官方产物：darwin/linux 各两种架构 + Windows x64", () => {
      expect(skillsManagerDownloadArtifact("darwin", "arm64")).toBe("skills-manager-cli-macOS-arm64");
      expect(skillsManagerDownloadArtifact("darwin", "x64")).toBe("skills-manager-cli-macOS-x64");
      expect(skillsManagerDownloadArtifact("linux", "x64")).toBe("skills-manager-cli-Linux-x64");
      expect(skillsManagerDownloadArtifact("linux", "arm64")).toBe("skills-manager-cli-Linux-arm64");
      expect(skillsManagerDownloadArtifact("win32", "x64")).toBe("skills-manager-cli-Windows-x64.exe");
    });

    it("默认参数取当前运行平台，未知平台回退 Linux-x64 并注明取舍", () => {
      expect(skillsManagerDownloadArtifact()).toBe(skillsManagerDownloadArtifact(process.platform, process.arch));
      expect(skillsManagerDownloadArtifact("freebsd", "arm64")).toBe("skills-manager-cli-Linux-x64");
    });
  });

  describe("status", () => {
    it("CLI 可用：返回 repo/skills/deployAgent(claude_code)/deployTarget，并确保 symlink", async () => {
      const hermes = join(tmp, "hermes-skills");
      mkdirSync(hermes, { recursive: true });
      const { exec } = makeExec([
        { stdout: '{"base_dir":"/home/x/.skills-manager","skill_count":2}' },
        { stdout: '[{"skill_id":"s1","name":"demo"}]' },
        { stdout: '[{"key":"codex"},{"key":"claude_code","display_name":"Claude Code","installed":true}]' },
      ]);
      const cli = createSkillsManagerCli({
        cliHome: join(tmp, "home"),
        hermesSkillsDir: hermes,
        execFile: exec,
        fs: realFsWithCli(),
      });
      const view = await cli.status();
      expect(view.available).toBe(true);
      if (view.available) {
        expect(view.cli).toEqual({ path: SKILLS_MANAGER_CLI_PATH, version: SKILLS_MANAGER_DEFAULT_VERSION });
        expect(view.repo).toEqual({ base_dir: "/home/x/.skills-manager", skill_count: 2 });
        expect(view.skills).toEqual([{ skill_id: "s1", name: "demo" }]);
        expect(view.deployAgent).toEqual({ key: "claude_code", display_name: "Claude Code", installed: true });
        expect(view.deployTarget).toMatchObject({ agent: "claude_code", dir: hermes, symlinked: true });
      }
      expect(lstatSync(join(tmp, "home", ".claude", "skills")).isSymbolicLink()).toBe(true);
    });

    it("CLI 二进制缺失：available:false + 安装指引，不调用 CLI", async () => {
      const { exec, calls } = makeExec();
      const cli = createSkillsManagerCli({
        cliHome: join(tmp, "home"),
        execFile: exec,
        fs: { existsSync: () => false } as unknown as SkillsManagerFs,
        autoDownload: false,
      });
      const view = await cli.status();
      expect(view).toEqual({ available: false, installHint: SKILLS_MANAGER_INSTALL_HINT });
      expect(calls).toHaveLength(0);
    });

    it("SKILLS_MANAGER_CLI_VERSION env 覆盖版本号", async () => {
      const previous = process.env["SKILLS_MANAGER_CLI_VERSION"];
      process.env["SKILLS_MANAGER_CLI_VERSION"] = "v9.9.9";
      try {
        const { exec } = makeExec();
        const cli = createSkillsManagerCli({
          cliHome: join(tmp, "home"),
          execFile: exec,
          fs: { existsSync: () => false } as unknown as SkillsManagerFs,
          autoDownload: false,
        });
        const view = await cli.status();
        expect(view.available).toBe(false);
        expect(SKILLS_MANAGER_DEFAULT_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
        // 版本读取走同一 helper：直接断言 env 生效路径
        expect(process.env["SKILLS_MANAGER_CLI_VERSION"]).toBe("v9.9.9");
      } finally {
        if (previous === undefined) delete process.env["SKILLS_MANAGER_CLI_VERSION"];
        else process.env["SKILLS_MANAGER_CLI_VERSION"] = previous;
      }
    });
  });
});
