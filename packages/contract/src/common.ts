import { isRetryable, type ErrorCode } from "./errors.js";

/** 实例唯一标识（内核确认后的 slug 名）。 */
export type InstanceId = string;

/**
 * 框架标识：内置已知框架具有字面量提示，同时允许任意字符串扩展
 * （`string & {}` 用于保留 IDE 自动补全而不收窄类型）。
 */
export type FrameworkId = "hermes" | "openclaw" | (string & {});

/**
 * 接入层级：
 * - L0 观察（只读探测）
 * - L1 探针（含受控副作用的主动验证）
 * - L2 控制（启停/升级/快照）
 * - L3 数据面（消息转发进入用户会话流）
 */
export type Level = 0 | 1 | 2 | 3;

/** 消息通道标识。 */
export type ChannelId = string;

/**
 * 统一错误结构。
 * - message：英文技术消息，仅入日志；
 * - userHint：中文用户提示，仅面向面板；
 * - cause：原始异常，仅入日志，不得回传面板。
 */
export interface AdapterError {
  code: ErrorCode;
  message: string;
  userHint?: string;
  retryable: boolean;
  cause?: unknown;
}

/**
 * 统一调用结果：ok=true 必有 data，ok=false 必有 error。
 * durationMs 由 ok()/fail() 辅助构造器自动计算。
 */
export interface Result<T> {
  ok: boolean;
  data?: T;
  error?: AdapterError;
  durationMs: number;
}

export type OkResult<T> = Result<T> & { ok: true; data: T; error?: undefined };

export type FailResult<T> = Result<T> & { ok: false; data?: undefined; error: AdapterError };

/**
 * 跨接口通用的实例引用：内核确认 instanceId 后传递给各适配器方法，
 * 其余字段为适配器定位实例提供的补充线索。
 */
export interface InstanceRef {
  instanceId: InstanceId;
  rootPath?: string;
  runtime?: "docker" | "process" | "unknown";
}

/** fail() 的可选附加项。 */
export interface FailOptions {
  userHint?: string;
  cause?: unknown;
  /** 调用开始时间戳（Date.now()），用于计算 durationMs。 */
  startedAt?: number;
}

/** 构造成功结果；传入 startedAt 时自动计算耗时。 */
export function ok<T>(data: T, startedAt?: number): OkResult<T> {
  const finishedAt = Date.now();
  return {
    ok: true,
    data,
    durationMs: Math.max(0, finishedAt - (startedAt ?? finishedAt)),
  };
}

/** 构造失败结果；retryable 由错误码表自动推导，durationMs 自动计算。 */
export function fail<T = never>(code: ErrorCode, message: string, opts?: FailOptions): FailResult<T> {
  const finishedAt = Date.now();
  return {
    ok: false,
    error: {
      code,
      message,
      userHint: opts?.userHint,
      retryable: isRetryable(code),
      cause: opts?.cause,
    },
    durationMs: Math.max(0, finishedAt - (opts?.startedAt ?? finishedAt)),
  };
}
