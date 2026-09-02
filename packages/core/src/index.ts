/**
 * @butler/core —— Agent 管家内核（Task 2）。
 *
 * 模块：paths（数据目录）/ events（事件总线）/ store（SQLite 状态存储）/
 * audit（追加式审计）/ registry（适配器注册）/ lifecycle（实例状态机）/
 * router（能力路由）/ executor（调用纪律执行器）/
 * tail（日志尾随断点续读）/ fingerprint（错误指纹聚合，Task 4）。
 */
import { CONTRACT_VERSION, type Result } from "@butler/contract";
import { AuditLog } from "./audit.js";
import { AdapterExecutor, type InvokeOptions } from "./executor.js";
import { EventBus } from "./events.js";
import { InstanceManager } from "./lifecycle.js";
import { butlerPaths, ensureButlerHome, resolveButlerHome } from "./paths.js";
import { AdapterRegistry } from "./registry.js";
import { CapabilityRouter } from "./router.js";
import { SqliteStore } from "./store.js";

export * from "./paths.js";
export * from "./events.js";
export * from "./store.js";
export * from "./audit.js";
export * from "./registry.js";
export * from "./lifecycle.js";
export * from "./router.js";
export * from "./executor.js";
export * from "./tail.js";
export * from "./fingerprint.js";
export * from "./llm-credentials.js";
export * from "./atomic-write.js";
export * from "./operation-lock.js";
export * from "./user-facing-error.js";

export const CORE_VERSION = `core@1.0.0-beta.20+${CONTRACT_VERSION}`;

export interface CoreOptions {
  /** 覆盖 Butler 主目录（测试注入）；缺省 resolveButlerHome()。 */
  home?: string;
}

export interface Core {
  paths: ReturnType<typeof butlerPaths>;
  store: SqliteStore;
  bus: EventBus;
  audit: AuditLog;
  registry: AdapterRegistry;
  instances: InstanceManager;
  router: CapabilityRouter;
  executor: AdapterExecutor;
  /** executor.invokeAdapter 的快捷入口（调用纪律全部生效）。 */
  invoke<T>(fn: () => Promise<Result<T>>, opts: InvokeOptions): Promise<Result<T>>;
  close(): void;
}

/** 组装内核：paths → store → bus → audit → registry → instances → router → executor。 */
export function createCore(options: CoreOptions = {}): Core {
  const home = options.home ?? resolveButlerHome();
  const paths = ensureButlerHome(home);

  const store = new SqliteStore(paths.dbFile);
  const bus = new EventBus();

  // 事件流持久化：全部总线事件落 events 表（降级/拒绝类标 warn）。
  bus.onAny((event) => {
    store.insertEvent({
      type: event.type,
      severity: event.type === "capability-degraded" || event.type === "adapter-rejected" ? "warn" : "info",
      source: "core",
      payload: event.payload,
    });
  });

  const audit = new AuditLog({ store, bus });
  const registry = new AdapterRegistry({ bus });
  const instances = new InstanceManager({ store, bus });
  const router = new CapabilityRouter({ bus, instances });
  const executor = new AdapterExecutor({ audit, store, bus, router, instances });

  // 外置适配器目录存在子目录时预登记 manifest（失败只记事件不抛异常）。
  registry.loadFromDir(paths.adaptersDir);

  const invoke = <T>(fn: () => Promise<Result<T>>, opts: InvokeOptions): Promise<Result<T>> =>
    executor.invokeAdapter(fn, opts);

  return {
    paths,
    store,
    bus,
    audit,
    registry,
    instances,
    router,
    executor,
    invoke,
    close: () => store.close(),
  };
}
