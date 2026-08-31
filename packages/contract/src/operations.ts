export interface DestructiveActionPreview {
  operation: string;
  deleteItems: string[];
  keepItems: string[];
  backupItems: string[];
  warnings: string[];
  blockedReasons: string[];
  manualNextStep: string[];
  canRun: boolean;
}

export interface ConfigChangeSet {
  targetPath: string;
  changes: Array<{ path: string; before: string | number | boolean | null; after: string | number | boolean | null; impact?: string }>;
  redacted: boolean;
}

export interface InstallationCandidate {
  framework: string;
  rootPath: string;
  source: "configured" | "home" | "local-app-data" | "workspace" | "unknown";
  version: string | null;
  ownership: "managed" | "unmanaged" | "unknown";
  active: boolean;
  fingerprint: string | null;
}

export interface ManagedMarkdownFile {
  fileId: string;
  instanceId: string;
  frameworkId: "hermes" | "openclaw";
  key: "user" | "agent" | "soul" | "memory";
  label: string;
  pathDisplay: string;
  /** 仅 Watch 内部使用，Web 响应必须移除。 */
  absolutePath: string;
  exists: boolean;
  editable: boolean;
  readOnlyReason?: string;
  sizeBytes: number;
  modifiedAt: string | null;
  sha256: string | null;
  sensitivity: "normal" | "contains-secret-pattern";
}

export interface MarkdownFileRevision {
  revisionId: string;
  fileId: string;
  instanceId: string;
  createdAt: string;
  createdBy: "user" | "system" | "restore";
  sha256: string;
  sizeBytes: number;
  note?: string;
}

export interface MarkdownFilePreview {
  file: ManagedMarkdownFile;
  baseSha256: string;
  currentSha256: string;
  changedSinceRead: boolean;
  diff: string;
  warnings: string[];
  canApply: boolean;
  blockedReasons: string[];
}

export interface MarkdownFileApplyInput {
  content: string;
  baseSha256: string;
  confirmed: boolean;
  note?: string;
}
