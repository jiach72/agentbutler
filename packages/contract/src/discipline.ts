/**
 * 调用纪律表：内核执行器对适配器方法统一施加的超时/自动重试/幂等约束。
 *
 * | 类别       | 方法举例                                   | 超时    | 自动重试 | 幂等要求                    |
 * |-----------|--------------------------------------------|---------|----------|-----------------------------|
 * | read-only | detect / stats / enumerate                 | 10s     | ≤2 次    | 天然幂等                    |
 * | probe     | verifyIntegrity / prewarm                  | 30s     | 不重试   | 受控副作用，禁止盲目重试    |
 * | control   | start / stop / restart                     | 120s    | 不重试   | 必须幂等（重复 start 不报错），超时转状态复核 |
 * | long-op   | upgrade / rollback / snapshot              | 1800s   | 不重试   | idempotencyKey 同键返回同一 Job |
 * | messaging | forwardInbound                             | 5s      | ≤1 次    | 按 messageId 去重           |
 */

export type CallCategory = "read-only" | "probe" | "control" | "long-op" | "messaging";

export interface CallDiscipline {
  category: CallCategory;
  /** 单次调用超时（毫秒），超时后按类别进入重试/状态复核。 */
  timeoutMs: number;
  /** 可重试错误（见 errors.ts retryable 标记）下的自动重试上限，0 表示不自动重试。 */
  maxAutoRetries: number;
  /** 是否要求实现幂等。 */
  idempotent: boolean;
  /** 纪律说明，供执行器日志与实现者对照。 */
  note: string;
}

export const CALL_DISCIPLINE = {
  "read-only": {
    category: "read-only",
    timeoutMs: 10_000,
    maxAutoRetries: 2,
    idempotent: true,
    note: "只读探测天然幂等；失败可自动重试最多 2 次",
  },
  probe: {
    category: "probe",
    timeoutMs: 30_000,
    maxAutoRetries: 0,
    idempotent: false,
    note: "探针含受控副作用（写入测试记忆等），不自动重试",
  },
  control: {
    category: "control",
    timeoutMs: 120_000,
    maxAutoRetries: 0,
    idempotent: true,
    note: "常规控制不自动重试，超时转状态复核；必须幂等（重复 start 不报错）",
  },
  "long-op": {
    category: "long-op",
    timeoutMs: 1_800_000,
    maxAutoRetries: 0,
    idempotent: true,
    note: "长操作不自动重试；必须以 idempotencyKey 幂等（同键返回同一 Job）",
  },
  messaging: {
    category: "messaging",
    timeoutMs: 5_000,
    maxAutoRetries: 1,
    idempotent: true,
    note: "消息转发按 messageId 去重，最多自动重试 1 次",
  },
} as const satisfies Record<CallCategory, CallDiscipline>;

const METHOD_DISCIPLINE: Readonly<Record<string, CallCategory>> = {
  // read-only：只读探测与查询
  detect: "read-only",
  capabilityScan: "read-only",
  logSources: "read-only",
  stats: "read-only",
  enumerate: "read-only",
  parse: "read-only",
  preview: "read-only",
  validate: "read-only",
  invariants: "read-only",
  analyze: "read-only",
  // probe：受控副作用探针
  verifyIntegrity: "probe",
  prewarm: "probe",
  prewarmChannel: "probe",
  // control：常规控制
  start: "control",
  stop: "control",
  restart: "control",
  validateConfig: "control",
  setEnabled: "control",
  attachOutbound: "control",
  subscribeTaskEvents: "control",
  restoreCold: "control",
  // long-op：长操作
  upgrade: "long-op",
  rollback: "long-op",
  snapshot: "long-op",
  rollbackVersion: "long-op",
  archiveCold: "long-op",
  purge: "long-op",
  planMigration: "long-op",
  // messaging：消息转发
  forwardInbound: "messaging",
};

/**
 * 按适配器方法名取调用纪律。
 * 未知方法保守回落到 read-only（内核只应调用契约已知方法）。
 */
export function getDiscipline(methodName: string): CallDiscipline {
  const category = METHOD_DISCIPLINE[methodName] ?? "read-only";
  return CALL_DISCIPLINE[category];
}
