import {
  fail,
  type AdapterBundle,
  type DiscoveryAdapter,
  type InstanceRef,
  type ManagedMarkdownCandidate,
} from "@butler/contract";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { capabilityScan, parseRootPath } from "./capability-scan.js";
import { createHermesControl, type HermesControlOptions } from "./control/index.js";
import { detect } from "./detect.js";
import {
  createHermesMemoryDriver,
  createHermesPluginDriver,
  createHermesSkillDriver,
} from "./drivers/index.js";
import { logSources } from "./log-sources.js";
import { hermesManifest } from "./manifest.js";

/** 从 InstanceRef 解析 rootPath：优先 rootPath 字段，回退解析 "instanceId|rootPath" 复合形式。 */
function rootPathFromRef(ref: InstanceRef): string | null {
  return ref.rootPath ?? parseRootPath(ref.instanceId);
}

function managedMarkdownFiles(ref: InstanceRef): ManagedMarkdownCandidate[] {
  const root = rootPathFromRef(ref);
  const pick = (key: ManagedMarkdownCandidate["key"], label: string, paths: string[], editable = true, readOnlyReason?: string): ManagedMarkdownCandidate => ({
    key,
    label,
    relativePath: root === null ? paths[0] : (paths.find((item) => existsSync(join(root, item))) ?? paths[0]),
    editable,
    ...(readOnlyReason ? { readOnlyReason } : {}),
  });
  return [
    // Hermes 的用户画像与长期记忆位于 memories/，不是实例根目录。
    pick("user", "USER.md", ["memories/USER.md", "memories/user.md", "USER.md", "user.md"]),
    // Hermes 没有独立 agent.md；实际使用仓库根部的 AGENTS.md 作为项目指令。
    pick("agent", "AGENTS.md（项目指令）", ["hermes-agent/AGENTS.md", "hermes-agent/agents.md", "AGENTS.md", "agents.md"]),
    pick("soul", "SOUL.md", ["SOUL.md", "soul.md", "workspace/SOUL.md", "workspace/soul.md"]),
    pick("memory", "MEMORY.md", ["memories/MEMORY.md", "memories/memory.md", "MEMORY.md", "memory.md"], false, "运行时记忆与人工 Markdown 分开管理"),
  ];
}

/** 组装 Hermes 适配器的可注入项（控制面执行器/store/快照目录，全部可选）。 */
export type HermesAdapterOptions = HermesControlOptions;

/**
 * 组装 Hermes 适配器（manifest + 只读发现面 + L2 控制面 + I-4 只读格式驱动）。
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
      return capabilityScan(rootPath);
    },
    logSources: (ref) => {
      const rootPath = rootPathFromRef(ref);
      return rootPath ? logSources(rootPath) : [];
    },
    managedMarkdownFiles,
  };

  return {
    manifest: hermesManifest,
    discovery,
    control: createHermesControl(options),
    drivers: {
      skill: createHermesSkillDriver(),
      plugin: createHermesPluginDriver(),
      memory: createHermesMemoryDriver(),
    },
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
export * from "./messaging/channel-control.js";
export {
  createHermesMemoryDriver,
  createHermesPluginDriver,
  createHermesSkillDriver,
  type HermesMemoryDriverOptions,
  type ReadonlySqliteOpener,
} from "./drivers/index.js";
export { createHermesControl, type HermesControlInvoker, type HermesControlOptions } from "./control/index.js";
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
  type VersionSourceAttempt,
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
