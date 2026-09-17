/**
 * 跨虚拟化/挂载安全 SQLite 快照访问（Issue #11）
 *
 * 动机：在 macOS + virtiofs 共享挂载下，容器内直接使用 DatabaseSync 打开
 * 宿主 live state.db（及其 -wal/-shm）会建立 POSIX 文件锁与 mmap 映射。当宿主 Python 进程
 * 在 WAL 模式下写库或发生页面换代时，会导致虚拟机与宿主 macOS 之间的内存映射失效，
 * 引发宿主进程遭遇致命 SIGBUS (138) / FS pagein error: 22。
 *
 * 解决方案：
 * 绝不直接对宿主 live state.db 建立 SQLite 句柄。通过操作系统纯文件读流（copyFileSync）
 * 将数据库主文件及 -wal、-shm 复制到容器私有 /tmp 目录，彻底隔离宿主 live 句柄与锁，
 * 对本地私有快照打开 SQLite 执行查询，并在使用后清理临时文件。
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SafeDbSnapshotOptions {
  /** 是否启用安全快照（缺省 true；可通过环境变量 BUTLER_HERMES_STATE_DB_SNAPSHOT=false 禁用）。 */
  enabled?: boolean;
}

export function withSafeDbSnapshot<T>(
  dbPath: string,
  fn: (db: InstanceType<typeof DatabaseSync>) => T,
  options?: SafeDbSnapshotOptions,
): T {
  if (!existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`);
  }

  const enabled =
    options?.enabled ?? (process.env["BUTLER_HERMES_STATE_DB_SNAPSHOT"] !== "false");

  if (!enabled) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  function executeSnapshot(): T {
    const tempDir = mkdtempSync(join(tmpdir(), "butler-state-snap-"));
    const base = basename(dbPath);
    const snapDb = join(tempDir, base);

    try {
      // 1. 复制主数据库文件（纯 read() 复制，不触发 SQLite lock/mmap）
      copyFileSync(dbPath, snapDb);

      // 2. 若存在 -wal，复制 -wal
      const walPath = dbPath + "-wal";
      if (existsSync(walPath)) {
        try {
          copyFileSync(walPath, snapDb + "-wal");
        } catch {
          // WAL 瞬态轮转时可能不可读，由主库兜底
        }
      }

      // 3. 若存在 -shm，复制 -shm
      const shmPath = dbPath + "-shm";
      if (existsSync(shmPath)) {
        try {
          copyFileSync(shmPath, snapDb + "-shm");
        } catch {
          // -shm 复制失败不阻断
        }
      }

      // 4. 打开本地私有快照并执行回调
      const db = new DatabaseSync(snapDb, { readOnly: true });
      try {
        return fn(db);
      } finally {
        db.close();
      }
    } finally {
      // 5. 确保清理临时目录
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // 忽略清理临时目录失败
      }
    }
  }

  try {
    return executeSnapshot();
  } catch (firstError) {
    // 若并发写入复制时产生瞬态异常，重试一次
    try {
      return executeSnapshot();
    } catch {
      throw firstError;
    }
  }
}
