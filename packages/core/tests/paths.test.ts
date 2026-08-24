import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUTLER_REL_PATHS, butlerPaths, ensureButlerHome, resolveButlerHome } from "../src/paths";
import { makeTempDir, rmTempDir } from "./helpers";

describe("resolveButlerHome", () => {
  const original = process.env["BUTLER_HOME"];
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env["BUTLER_HOME"];
    } else {
      process.env["BUTLER_HOME"] = original;
    }
    rmTempDir(tmp);
  });

  it("BUTLER_HOME 环境变量优先", () => {
    process.env["BUTLER_HOME"] = path.join(tmp, "custom-home");
    expect(resolveButlerHome()).toBe(path.resolve(path.join(tmp, "custom-home")));
  });

  it("BUTLER_HOME 为空白时回落默认值", () => {
    process.env["BUTLER_HOME"] = "   ";
    expect(resolveButlerHome()).toBe(path.join(homedir(), ".agent-butler"));
  });

  it("未设置时默认 ~/.agent-butler", () => {
    delete process.env["BUTLER_HOME"];
    expect(resolveButlerHome()).toBe(path.join(homedir(), ".agent-butler"));
  });

  it("butlerPaths 组合全部子路径常量", () => {
    const paths = butlerPaths(path.join(tmp, "home"));
    expect(paths.dbFile).toBe(path.join(tmp, "home", "data", "butler.db"));
    expect(paths.adaptersDir).toBe(path.join(tmp, "home", BUTLER_REL_PATHS.adaptersDir));
    expect(paths.snapshotsDir).toBe(path.join(tmp, "home", BUTLER_REL_PATHS.snapshotsDir));
    expect(paths.ledgerDir).toBe(path.join(tmp, "home", BUTLER_REL_PATHS.ledgerDir));
    expect(paths.logposFile).toBe(path.join(tmp, "home", BUTLER_REL_PATHS.logposFile));
    expect(paths.promptsDir).toBe(path.join(tmp, "home", BUTLER_REL_PATHS.promptsDir));
  });

  it("ensureButlerHome 幂等创建全部目录", () => {
    const home = path.join(tmp, "home");
    const first = ensureButlerHome(home);
    const second = ensureButlerHome(home);
    for (const dir of [
      first.dataDir,
      first.adaptersDir,
      first.snapshotsDir,
      first.ledgerDir,
      first.promptsDir,
    ]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
    expect(second.home).toBe(first.home);
  });
});
