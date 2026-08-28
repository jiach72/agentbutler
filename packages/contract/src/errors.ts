/**
 * 适配器契约统一错误码表（E0xx-E4xx）。
 *
 * 分段约定：
 * - E0xx 契约层错误（版本不兼容、入参非法）
 * - E1xx 发现层错误（实例/框架探测）
 * - E2xx 控制层错误（I-2）
 * - E3xx 消息层错误（I-3）
 * - E4xx 驱动层错误（I-4）
 */

/** 本契约的具体版本号。 */
export const CONTRACT_VERSION = "1.0";

/**
 * Web、Watch 与 Gateway 控制面 API 的兼容标识。
 *
 * 这是部署握手用的 schema 版本，不等同于 npm 包或静态资源版本。Web 在读取
 * 进化工作区数据时必须验证该值，防止旧 Watch 实例把新页面降级成看似“无数据”。
 */
export const CONTROL_API_SCHEMA_VERSION = "evolution-v2-charts-v1";

/** 内核支持的契约版本区间（minor 通配，如 "1.x"）。 */
export const KERNEL_SUPPORTED_CONTRACT_RANGE = ["1.x"] as const;

export type ErrorCode =
  | "E001"
  | "E002"
  | "E101"
  | "E102"
  | "E103"
  | "E201"
  | "E202"
  | "E203"
  | "E204"
  | "E301"
  | "E302"
  | "E303"
  | "E401"
  | "E402"
  | "E403";

export interface ErrorTableEntry {
  code: ErrorCode;
  /** 稳定符号名，供日志检索与文档引用。 */
  name: string;
  /** 是否允许内核按纪律表自动重试。 */
  retryable: boolean;
  /** 中文语义说明，供开发参考。 */
  description: string;
}

export const ERROR_TABLE: Readonly<Record<ErrorCode, ErrorTableEntry>> = {
  E001: {
    code: "E001",
    name: "CONTRACT_VERSION",
    retryable: false,
    description: "契约版本不兼容：适配器 manifest 声明的契约版本不被内核支持",
  },
  E002: {
    code: "E002",
    name: "INVALID_ARGS",
    retryable: false,
    description: "调用入参非法（结构/取值不满足契约）",
  },
  E101: {
    code: "E101",
    name: "FRAMEWORK_NOT_FOUND",
    retryable: true,
    description: "目标框架/实例未找到（可能尚未安装或不在探测路径）",
  },
  E102: {
    code: "E102",
    name: "AMBIGUOUS_INSTANCE",
    retryable: false,
    description: "发现多个候选实例且无法唯一定位，需要用户消歧",
  },
  E103: {
    code: "E103",
    name: "SCAN_FAILED",
    retryable: true,
    description: "能力扫描失败（部分探测项异常，可重试）",
  },
  E201: {
    code: "E201",
    name: "CONTROL_NOT_DECLARED",
    retryable: false,
    description: "适配器未声明控制能力（manifest 缺少 control）",
  },
  E202: {
    code: "E202",
    name: "CONTROL_TIMEOUT",
    retryable: true,
    description: "控制操作超时（按纪律表转状态复核而非盲目重试）",
  },
  E203: {
    code: "E203",
    name: "CONTROL_REJECTED",
    retryable: false,
    description: "实例侧拒绝控制操作（如升级预检不过）",
  },
  E204: {
    code: "E204",
    name: "SNAPSHOT_CONFLICT",
    retryable: false,
    description: "快照冲突（目标快照与当前状态不一致/已被淘汰）",
  },
  E301: {
    code: "E301",
    name: "MESSAGING_NOT_DECLARED",
    retryable: false,
    description: "适配器未声明消息能力（manifest 缺少 messaging）",
  },
  E302: {
    code: "E302",
    name: "ENDPOINT_UNREACHABLE",
    retryable: true,
    description: "消息端点不可达（网络抖动，可重试）",
  },
  E303: {
    code: "E303",
    name: "AUTH_FAILED",
    retryable: false,
    description: "消息通道鉴权失败（凭据问题，重试无意义）",
  },
  E401: {
    code: "E401",
    name: "DRIVER_NOT_REGISTERED",
    retryable: false,
    description: "请求的驱动未在 manifest 中登记/未注册",
  },
  E402: {
    code: "E402",
    name: "FORMAT_UNRECOGNIZED",
    retryable: false,
    description: "驱动无法识别目标格式（技能/配置/记忆文件损坏或版本未知）",
  },
  E403: {
    code: "E403",
    name: "READ_ONLY",
    retryable: false,
    description: "只读驱动收到写操作（当前实现不允许变更）",
  },
};

/** 查询错误码是否允许自动重试。 */
export function isRetryable(code: ErrorCode): boolean {
  return ERROR_TABLE[code]?.retryable ?? false;
}

/**
 * 判断某个契约版本声明（如 "1.x" / "1.0"）落在内核支持区间内。
 * 区间与版本均支持以 "x" 作为 minor 通配，major 必须完全相等。
 */
export function isContractVersionSupported(v: string): boolean {
  return KERNEL_SUPPORTED_CONTRACT_RANGE.some((pattern) => matchesRange(v, pattern));
}

function matchesRange(v: string, pattern: string): boolean {
  const [vMajor, vMinor] = v.split(".");
  const [pMajor, pMinor] = pattern.split(".");
  if (pMajor !== "x" && pMajor !== vMajor) return false;
  if (pMinor !== undefined && pMinor !== "x" && vMinor !== "x" && pMinor !== vMinor) {
    return false;
  }
  return true;
}
