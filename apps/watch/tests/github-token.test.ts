/**
 * GitHub 访问令牌存储单元测试：写入/读取/清除的文件语义与权限位。
 * 文件位于数据目录（github-token.json），值绝不回显、损坏按未配置处理。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGithubToken, tokenFilePath, writeGithubToken } from "../src/github-token.js";

describe("github-token 存储", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "butler-github-token-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("tokenFilePath 固定在数据目录根下的 github-token.json", () => {
    expect(tokenFilePath(join(tmp, "data"))).toBe(join(tmp, "data", "github-token.json"));
  });

  it("写入后读取回环；文件内容是 {token} JSON", () => {
    writeGithubToken(tmp, "ghp_abcdef12345678");
    const file = tokenFilePath(tmp);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ token: "ghp_abcdef12345678" });
    expect(readGithubToken(tmp)).toBe("ghp_abcdef12345678");
  });

  it("未写入/文件缺失时读取返回 null", () => {
    expect(readGithubToken(tmp)).toBeNull();
  });

  it("文件损坏（非法 JSON / 缺 token 字段 / 类型不对）按未配置处理返回 null", () => {
    writeFileSync(tokenFilePath(tmp), "not json", "utf8");
    expect(readGithubToken(tmp)).toBeNull();
    writeFileSync(tokenFilePath(tmp), JSON.stringify({ other: 1 }), "utf8");
    expect(readGithubToken(tmp)).toBeNull();
    writeFileSync(tokenFilePath(tmp), JSON.stringify({ token: 42 }), "utf8");
    expect(readGithubToken(tmp)).toBeNull();
  });

  it("writeGithubToken(…, null) 删除文件；文件本就不存在时也不抛错", () => {
    writeGithubToken(tmp, "ghp_abcdef12345678");
    writeGithubToken(tmp, null);
    expect(existsSync(tokenFilePath(tmp))).toBe(false);
    expect(readGithubToken(tmp)).toBeNull();
    expect(() => writeGithubToken(tmp, null)).not.toThrow();
  });

  it("覆盖写入用新值替换旧值", () => {
    writeGithubToken(tmp, "ghp_old_old_old");
    writeGithubToken(tmp, "ghp_new_new_new");
    expect(readGithubToken(tmp)).toBe("ghp_new_new_new");
  });

  it.skipIf(process.platform === "win32")("写入的文件权限位为 0600", () => {
    writeGithubToken(tmp, "ghp_abcdef12345678");
    expect(statSync(tokenFilePath(tmp)).mode & 0o777).toBe(0o600);
  });
});
