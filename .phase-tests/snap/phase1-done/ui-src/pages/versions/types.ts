/**
 * 版本页数据类型：/api/versions、/api/butler/version、/api/butler/self 三组载荷与确认动作。
 */

export interface InstanceView {
  instanceId: string;
  state: string;
  runtime: string;
  version: string | null;
}

export interface UpgradeStepView {
  id: string;
  label: string;
  status: string;
  detail?: string;
}

export interface UpgradeJobView {
  jobId: string;
  instanceId: string;
  targetVersion: string;
  channel?: string;
  trigger?: string;
  status: string;
  rolledBack?: boolean;
  snapshotId?: string;
  steps: UpgradeStepView[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface ManagedUpgradeTarget {
  version: string;
  channel?: string;
  displayVersion?: string;
}

export interface PendingManagedUpgrade {
  target: ManagedUpgradeTarget;
  jobId: string | null;
}

export interface AvailableVersionEntry {
  version: string;
  channel?: string;
  displayVersion?: string;
  notes?: string;
  publishedAt?: string;
}

export interface AvailableVersionsView {
  reachable: boolean;
  source?: string;
  versions: AvailableVersionEntry[];
  checkedAt?: string;
  attempts?: Array<{ id: string; url: string | null; status: string; error?: string; durationMs: number }>;
}

export interface ButlerRuntimeView {
  kind: string;
  distro: string | null;
  user: string | null;
  detail: string;
  sourceDir?: string;
  butlerDataDir?: string;
  hermesRoot?: string;
  openclawRoot?: string;
  npmGlobalRoot?: string | null;
}

export interface SnapshotView {
  id: number;
  instance: string;
  label: string | null;
  createdAt: string;
  status: string;
}

export interface VersionsPayload {
  instances?: InstanceView[];
  upgradeJob?: UpgradeJobView | null;
  availableVersions?: AvailableVersionsView;
  snapshots?: SnapshotView[];
  watchReachable?: boolean;
  degraded?: string[];
}

export interface ButlerVersionView {
  reachable: boolean;
  version: string | null;
  source: string | null;
  branch: string | null;
  commit: string | null;
  tag: string | null;
  repository: string | null;
  repositoryConfigured?: boolean;
  repositorySource?: "git-origin" | "configured-default";
  runtime?: ButlerRuntimeView;
  changelog?: Array<{ hash: string; subject: string; at: string }> | null;
  checkedAt: string | null;
}

export interface ButlerSelfPrefs {
  channel: "stable" | "beta";
  locked: boolean;
}

export interface ButlerSelfSnapshot {
  id: string;
  at: string;
  version: string;
  commit: string;
  tag: string | null;
  channel: string;
  reason: string;
  backupId: number | null;
}

export interface ButlerSelfJobView {
  jobId: string;
  kind: "upgrade" | "rollback";
  status: "running" | "done" | "failed" | "rolled-back";
  phase: string;
  target: string;
  from: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  snapshotId: string | null;
}

export interface ButlerAvailableUpdate {
  version: string;
  channel: "stable" | "beta";
  commit: string | null;
  tag: string | null;
  notes?: string;
}

export interface ButlerSelfView {
  reachable: boolean;
  source: string;
  version: string;
  branch: string | null;
  commit: string | null;
  tag: string | null;
  repository: string | null;
  repositorySource?: "git-origin" | "configured-default";
  repositoryConfigured?: boolean;
  repoClean: boolean;
  remoteConfigured: boolean;
  upgradeSupported?: boolean;
  prefs: ButlerSelfPrefs;
  snapshots: ButlerSelfSnapshot[];
  availableUpdates: ButlerAvailableUpdate[];
  lastJob: ButlerSelfJobView | null;
  checkedAt: string;
}

/** 预检结果项（precheck 步骤 detail 的结构化形态，尽力解析）。 */
export interface PrecheckItem {
  id: string;
  status: string;
  detail?: string;
}

/** parsePrecheckDetail 的返回：结构化清单或纯文本行（二选一非空）。 */
export interface PrecheckDetail {
  items: PrecheckItem[];
  lines: string[];
}

export type ConfirmAction =
  | { kind: "upgrade"; target: ManagedUpgradeTarget }
  | { kind: "rollback"; snapshot: SnapshotView }
  | { kind: "self-upgrade"; target: ButlerAvailableUpdate }
  | { kind: "self-rollback"; snapshot: ButlerSelfSnapshot };
