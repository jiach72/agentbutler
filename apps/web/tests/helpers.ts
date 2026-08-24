import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 每个测试文件用它建独立临时目录，避免污染真实 ~/.agent-butler（对齐 core 测试风格）。 */
export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "butler-web-"));
}

export function rmTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 构造 SPA fixture 目录：内含一个可识别内容的 index.html。 */
export function makeUiDist(root: string): string {
  const dir = path.join(root, "ui-dist");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>fixture-ui</title>", "utf-8");
  return dir;
}

/** 构造"db 不可达"的 home：路径被一个同名文件占位，mkdir/建库必然失败。 */
export function makeBlockedHome(root: string): string {
  const blocked = path.join(root, "blocked-home");
  fs.writeFileSync(blocked, "not a directory", "utf-8");
  return blocked;
}
