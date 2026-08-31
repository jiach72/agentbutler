export interface OperationLockOptions {
  timeoutMs?: number;
}

const tails = new Map<string, Promise<void>>();

/** 进程内 tail-chaining 锁；Watch 是所有受管写操作的单点入口。 */
export async function withManagedOperationLock<T>(
  key: string,
  operation: () => Promise<T> | T,
  options: OperationLockOptions = {},
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  tails.set(key, queued);
  await previous;
  const timeoutMs = options.timeoutMs ?? 300_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`操作 ${key} 超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    release();
    if (tails.get(key) === queued) tails.delete(key);
  }
}

export function resetManagedOperationLocksForTests(): void {
  tails.clear();
}
