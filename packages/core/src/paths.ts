/**
 * 内核数据目录解析：所有持久化状态的根路径唯一入口。
 *
 * 目录布局（home 之下）：
 * - data/butler.db   SQLite 状态库（事件/指纹/Job/快照登记/审计/实例）
 * - adapters/        外置适配器清单目录（每子目录一个 manifest.json）
 * - snapshots/       快照落盘区
 * - ledger/          台账（升级/进化决策记录等）
 * - logpos.json      日志尾随断点位点
 */
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** home 之下的相对子路径常量（用 path.join 拼接到具体 home）。 */
export const BUTLER_REL_PATHS = {
  dbFile: path.join("data", "butler.db"),
  adaptersDir: "adapters",
  snapshotsDir: "snapshots",
  ledgerDir: "ledger",
  logposFile: "logpos.json",
  promptsDir: "prompts",
} as const;

export interface ButlerPaths {
  home: string;
  dataDir: string;
  dbFile: string;
  adaptersDir: string;
  snapshotsDir: string;
  ledgerDir: string;
  logposFile: string;
  promptsDir: string;
}

/**
 * 解析 Butler 主目录：env BUTLER_HOME 优先（非空白），默认 ~/.agent-butler。
 */
export function resolveButlerHome(): string {
  const fromEnv = process.env["BUTLER_HOME"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return path.resolve(fromEnv.trim());
  }
  return path.join(homedir(), ".agent-butler");
}

/** 基于给定 home 计算全部子路径。 */
export function butlerPaths(home: string = resolveButlerHome()): ButlerPaths {
  return {
    home,
    dataDir: path.dirname(path.join(home, BUTLER_REL_PATHS.dbFile)),
    dbFile: path.join(home, BUTLER_REL_PATHS.dbFile),
    adaptersDir: path.join(home, BUTLER_REL_PATHS.adaptersDir),
    snapshotsDir: path.join(home, BUTLER_REL_PATHS.snapshotsDir),
    ledgerDir: path.join(home, BUTLER_REL_PATHS.ledgerDir),
    logposFile: path.join(home, BUTLER_REL_PATHS.logposFile),
    promptsDir: path.join(home, BUTLER_REL_PATHS.promptsDir),
  };
}

/** 确保主目录与全部子目录存在（幂等），返回完整路径集合。 */
export function ensureButlerHome(home: string = resolveButlerHome()): ButlerPaths {
  const paths = butlerPaths(home);
  for (const dir of [
    paths.home,
    paths.dataDir,
    paths.adaptersDir,
    paths.snapshotsDir,
    paths.ledgerDir,
    paths.promptsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}
