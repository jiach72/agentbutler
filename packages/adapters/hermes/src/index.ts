import {
  fail,
  type AdapterBundle,
  type DiscoveryAdapter,
  type InstanceRef,
} from "@butler/contract";
import { capabilityScan, parseRootPath } from "./capability-scan.js";
import { createHermesControl, type HermesControlOptions } from "./control/index.js";
import { detect } from "./detect.js";
import { createHermesMemoryDriver, createHermesSkillDriver } from "./drivers/index.js";
import { logSources } from "./log-sources.js";
import { hermesManifest } from "./manifest.js";
import { createHermesMessaging, type HermesMessagingOptions } from "./messaging/index.js";

/** 从 InstanceRef 解析 rootPath：优先 rootPath 字段，回退解析 "instanceId|rootPath" 复合形式。 */
function rootPathFromRef(ref: InstanceRef): string | null {
  return ref.rootPath ?? parseRootPath(ref.instanceId);
}

/** 组装 Hermes 适配器的可注入项（控制面执行器/store/快照目录，全部可选）。 */
export type HermesAdapterOptions = HermesControlOptions & {
  messaging?: {
    bridgeUrl?: string;
    bridgeToken?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
};

/**
 * 组装 Hermes 适配器（manifest + 只读发现面 + L2 控制面 + 探针驱动 L3 消息面 + I-4 只读格式驱动）。
 * discovery 三方法均为无副作用观察；control 按 runtime 分派双执行器，
 * 常规控制幂等、长操作同步收敛为终态 Job。
 */
export function createHermesAdapter(options: HermesAdapterOptions = {}): AdapterBundle {
  const discovery: DiscoveryAdapter = {
    frameworkId: "hermes",
    detect: (hint) => detect(hint),
    capabilityScan: async (ref) => {
      const rootPath = rootPathFromRef(ref);
      if (!rootPath) {
        return fail(
          "E002",
          "InstanceRef must carry rootPath (or 'instanceId|rootPath') for hermes capability scan",
          {
            userHint: "缺少实例根路径，无法执行能力扫描",
          },
        );
      }
      return capabilityScan(rootPath, {
        messaging: {
          instanceId: ref.instanceId,
          bridgeUrl: options.messaging?.bridgeUrl,
          bridgeToken: options.messaging?.bridgeToken,
          fetchImpl: options.messaging?.fetchImpl,
          timeoutMs: options.messaging?.timeoutMs,
        },
      });
    },
    logSources: (ref) => {
      const rootPath = rootPathFromRef(ref);
      return rootPath ? logSources(rootPath) : [];
    },
  };

  const messagingOptions = toMessagingOptions(options.messaging);

  return {
    manifest: hermesManifest,
    discovery,
    control: createHermesControl(options),
    messaging: messagingOptions === null ? undefined : createHermesMessaging(messagingOptions),
    drivers: {
      skill: createHermesSkillDriver(),
      memory: createHermesMemoryDriver(),
    },
  };
}

function toMessagingOptions(
  options: HermesAdapterOptions["messaging"],
): HermesMessagingOptions | null {
  const bridgeUrl = options?.bridgeUrl?.trim();
  const bridgeToken = options?.bridgeToken?.trim();
  if (!bridgeUrl || !bridgeToken) return null;
  return {
    baseUrl: bridgeUrl,
    token: bridgeToken,
    fetchImpl: options?.fetchImpl,
    timeoutMs: options?.timeoutMs,
    pollIntervalMs: options?.pollIntervalMs,
  };
}

export { hermesManifest } from "./manifest.js";
export { readHermesConfig, type HermesConfig, type HermesApiServerConfig } from "./config.js";
export {
  DEFAULT_API_PORT,
  PROBE_TIMEOUT_MS,
  defaultProber,
  detect,
  findVenvPython,
  type DetectOptions,
  type PortProber,
} from "./detect.js";
export { capabilityScan, parseRootPath, type ScanOptions } from "./capability-scan.js";
export { logSources } from "./log-sources.js";
export {
  BridgeHttpError,
  HermesBridgeClient,
  REQUIRED_MESSAGING_COVERAGE,
  createHermesMessaging,
  probeHermesMessagingCapability,
  type HermesBridgeClientOptions,
  type HermesMessagingCapabilityOptions,
  type HermesMessagingCapabilityResult,
  type HermesMessagingOptions,
} from "./messaging/index.js";
export {
  createHermesMemoryDriver,
  createHermesSkillDriver,
  type HermesMemoryDriverOptions,
  type ReadonlySqliteOpener,
} from "./drivers/index.js";
export { createHermesControl, type HermesControlOptions } from "./control/index.js";
export {
  createDefaultPullStrategy,
  createUpgradePipeline,
  listAvailableVersions,
  createVersionSources,
  type HealthVerifier,
  type PullOutcome,
  type PullStrategy,
  type UpgradeControl,
  type UpgradeJobStatus,
  type UpgradeJobView,
  type UpgradePipeline,
  type UpgradePipelineDeps,
  type UpgradeRunInput,
  type VersionListEntry,
  type VersionListSource,
  type VersionSourceOptions,
} from "./control/index.js";
export {
  MIN_SEND_INTERVAL_HARD_FLOOR_SEC,
  PATCH_REGISTRY,
  createPatchManager,
  findPatch,
  isWhitelistedTarget,
  type AppliedEntry,
  type ApplyOutcome,
  type DriftDiff,
  type DriftReport,
  type PatchCallContext,
  type PatchDefinition,
  type PatchManager,
  type PatchManagerOptions,
  type PatchParams,
} from "./patches/index.js";
export {
  DEFAULT_DOCKER_HOST,
  DEFAULT_START_TIMEOUT_SEC,
  DEFAULT_STOP_TIMEOUT_SEC,
  DockerExecutor,
  ProcessExecutor,
  createExecFileExecutor,
  dockerodeConnectOptions,
  resolveDockerHost,
  type CommandExecutor,
  type CommandResult,
  type ContainerLike,
  type DockerExecutorOptions,
  type DockerLike,
  type DockerodeFactory,
  type ExecutorOutcome,
  type ProcessExecutorOptions,
} from "./control/executor.js";
