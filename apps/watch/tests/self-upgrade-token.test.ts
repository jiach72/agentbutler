import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createButlerSelfUpgradeService, type CommandResult } from "../src/self-upgrade.js";

/**
 * #32 回归：默认 Compose 部署把未配置的口令注入成**空字符串**（`${VAR:-}`），
 * 而空字符串不是 nullish —— 用 `??` 串起来的回退链会在第一项就停下，
 * 于是 watch 判定「未配置口令」并把 updater 标为 safe-locked，面板「一键升级/回滚」
 * 透传空口令后全部 401。这里锁住「空字符串应继续回退」的行为。
 */

const TOKEN_KEYS = ["BUTLER_UPDATER_ACCESS_TOKEN", "BUTLER_INTERNAL_TOKEN", "BUTLER_ACCESS_TOKEN"] as const;

let home = "";
const saved: Record<string, string | undefined> = {};

// 宿主/CI 环境可能残留真实口令，先隔离，再按用例逐个设置。
const failingExec = (): CommandResult => ({ ok: false, stdout: "", error: "not a git repository" });

beforeEach(() => {
  home = mkdtempSync(join(os.tmpdir(), "butler-self-token-"));
  for (const key of TOKEN_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TOKEN_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function makeService(updaterToken?: string) {
  return createButlerSelfUpgradeService({
    sourceDir: home,
    homeDir: home,
    updaterUrl: "http://butler-updater:7540",
    exec: failingExec,
    ...(updaterToken === undefined ? {} : { updaterToken }),
  });
}

describe("updater 口令回退（Compose 默认注入空字符串）", () => {
  it("BUTLER_UPDATER_ACCESS_TOKEN 为空字符串时回退到 BUTLER_INTERNAL_TOKEN，不再报安全锁定", () => {
    process.env["BUTLER_UPDATER_ACCESS_TOKEN"] = "";
    process.env["BUTLER_ACCESS_TOKEN"] = "";
    process.env["BUTLER_INTERNAL_TOKEN"] = "internal-token-abc";

    expect(makeService().status().updater).toBeUndefined();
  });

  it("独立口令为空、共享口令可用时回退到 BUTLER_ACCESS_TOKEN", () => {
    process.env["BUTLER_UPDATER_ACCESS_TOKEN"] = "";
    process.env["BUTLER_ACCESS_TOKEN"] = "shared-token-xyz";
    process.env["BUTLER_INTERNAL_TOKEN"] = "";

    expect(makeService().status().updater).toBeUndefined();
  });

  it("三个口令都是空字符串（真正未配置）时仍报告安全锁定", () => {
    process.env["BUTLER_UPDATER_ACCESS_TOKEN"] = "";
    process.env["BUTLER_ACCESS_TOKEN"] = "";
    process.env["BUTLER_INTERNAL_TOKEN"] = "";

    expect(makeService().status().updater).toMatchObject({ locked: true });
  });

  it("显式传入 deps.updaterToken='' 时保持空口令语义，不被环境变量覆盖", () => {
    process.env["BUTLER_INTERNAL_TOKEN"] = "internal-token-abc";

    expect(makeService("").status().updater).toMatchObject({ locked: true });
  });
});
