import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteJson, atomicWriteText, withManagedOperationLock, type Core, type InstanceRecord } from "@butler/core";
import type {
  ManagedMarkdownCandidate,
  ManagedMarkdownFile,
  MarkdownFileApplyInput,
  MarkdownFilePreview,
  MarkdownFileRevision,
} from "@butler/contract";
import type { BackupGate } from "./backup-gate.js";

export const MAX_MARKDOWN_EDIT_BYTES = 1024 * 1024;
const MAX_REVISIONS = 50;

export class MarkdownFileError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly userHint: string,
    readonly nextStep: string,
  ) {
    super(message);
    this.name = "MarkdownFileError";
  }
}

interface RevisionIndex { revisions: MarkdownFileRevision[] }

export interface MarkdownFileService {
  list(instanceId?: string): ManagedMarkdownFile[];
  read(fileId: string): { file: ManagedMarkdownFile; content: string };
  preview(fileId: string, content: string, baseSha256: string): MarkdownFilePreview;
  apply(fileId: string, input: MarkdownFileApplyInput): Promise<{ file: ManagedMarkdownFile; revision: MarkdownFileRevision }>;
  revisions(fileId: string): MarkdownFileRevision[];
  backup(fileId: string, note?: string): MarkdownFileRevision;
  restore(fileId: string, revisionId: string, confirmed: boolean, baseSha256: string): Promise<{ file: ManagedMarkdownFile; revision: MarkdownFileRevision }>;
  download(fileId: string): { filename: string; content: string; sensitivity: ManagedMarkdownFile["sensitivity"] };
}

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function inside(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function sensitivity(content: string): ManagedMarkdownFile["sensitivity"] {
  return /(?:api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*[^\s]{8,}/i.test(content)
    ? "contains-secret-pattern"
    : "normal";
}

function diffLines(before: string, after: string): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const out = ["--- 当前", "+++ 草稿"];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if (a[i] === b[i]) out.push(`  ${a[i] ?? ""}`);
    else {
      if (a[i] !== undefined) out.push(`- ${a[i]}`);
      if (b[i] !== undefined) out.push(`+ ${b[i]}`);
    }
  }
  return out.join("\n");
}

function safeRevisionId(id: string): boolean { return /^[A-Za-z0-9_-]+$/.test(id); }

export function createMarkdownFileService(options: { core: Core; backupGate: BackupGate }): MarkdownFileService {
  const { core, backupGate } = options;
  const historyRoot = resolve(join(core.paths.home, "markdown-history"));

  const instance = (instanceId: string): InstanceRecord => {
    const record = core.instances.getInstance(instanceId);
    if (record === undefined || record.rootPath.trim() === "") {
      throw new MarkdownFileError("markdown-file-not-found", 404, `instance ${instanceId} not found`, "没有找到可管理的实例。", "返回实例列表并重新选择实例。");
    }
    return record;
  };

  const candidateFor = (record: InstanceRecord, fileId: string): { candidate: ManagedMarkdownCandidate; absolutePath: string } => {
    const expectedPrefix = `${record.frameworkId}:`;
    if (!fileId.startsWith(expectedPrefix)) throw new MarkdownFileError("markdown-file-not-found", 404, "unknown markdown file id", "文件不存在。", "刷新核心文件列表后重试。");
    const parts = fileId.split(":");
    const key = parts.at(-1) as ManagedMarkdownCandidate["key"];
    const encodedInstance = parts.slice(1, -1).join(":");
    if (encodedInstance !== "" && decodeURIComponent(encodedInstance) !== record.instanceId) throw new MarkdownFileError("markdown-file-not-found", 404, "markdown file instance mismatch", "文件不存在。", "刷新核心文件列表后重试。");
    if (!["user", "agent", "soul", "memory"].includes(key)) throw new MarkdownFileError("markdown-file-not-found", 404, "unknown markdown file key", "文件不存在。", "刷新核心文件列表后重试。");
    const bundle = core.registry.getBundle(record.frameworkId);
    const candidates = bundle?.discovery.managedMarkdownFiles?.({ instanceId: record.instanceId, rootPath: record.rootPath, runtime: record.runtime }) ?? [];
    const candidate = candidates.find((item) => item.key === key);
    if (candidate === undefined) throw new MarkdownFileError("markdown-file-not-found", 404, "markdown file is not declared", "当前框架没有声明这个核心文件。", "请确认实例框架和版本支持核心文件管理。");
    const root = resolve(record.rootPath);
    const absolutePath = resolve(root, candidate.relativePath);
    if (!inside(absolutePath, root)) throw new MarkdownFileError("markdown-path-not-allowed", 400, "markdown path escapes instance root", "文件路径不在受管实例目录内。", "请检查实例目录配置后重试。");
    if (existsSync(absolutePath)) {
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new MarkdownFileError("markdown-path-not-allowed", 400, "markdown path is not a regular file", "文件路径不安全，已拒绝访问。", "请移除符号链接或改用实例目录内的普通文件。");
      const realRoot = existsSync(root) ? realpathSync(root) : root;
      const realFile = realpathSync(absolutePath);
      if (!inside(realFile, realRoot)) throw new MarkdownFileError("markdown-path-not-allowed", 400, "markdown realpath escapes instance root", "文件路径不安全，已拒绝访问。", "请检查实例目录配置后重试。");
    }
    return { candidate, absolutePath };
  };

  const metadata = (record: InstanceRecord, fileId: string): ManagedMarkdownFile => {
    const { candidate, absolutePath } = candidateFor(record, fileId);
    let exists = false;
    let sizeBytes = 0;
    let modifiedAt: string | null = null;
    let currentHash: string | null = null;
    let fileSensitivity: ManagedMarkdownFile["sensitivity"] = "normal";
    try {
      const stat = statSync(absolutePath);
      exists = stat.isFile();
      sizeBytes = stat.size;
      modifiedAt = stat.mtime.toISOString();
      const raw = readFileSync(absolutePath);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      currentHash = sha256(text);
      fileSensitivity = sensitivity(text);
    } catch (error) {
      if (exists) throw new MarkdownFileError("markdown-read-failed", 500, String(error), "文件无法读取。", "确认文件权限和编码后重试。");
    }
    const editable = candidate.editable !== false && sizeBytes <= MAX_MARKDOWN_EDIT_BYTES;
    return {
      fileId,
      instanceId: record.instanceId,
      frameworkId: record.frameworkId === "openclaw" ? "openclaw" : "hermes",
      key: candidate.key,
      label: candidate.label,
      pathDisplay: candidate.relativePath.replaceAll("\\", "/"),
      absolutePath,
      exists,
      editable,
      ...(candidate.readOnlyReason ? { readOnlyReason: candidate.readOnlyReason } : sizeBytes > MAX_MARKDOWN_EDIT_BYTES ? { readOnlyReason: "文件超过 1 MiB，仅允许查看或下载" } : {}),
      sizeBytes,
      modifiedAt,
      sha256: currentHash,
      sensitivity: fileSensitivity,
    };
  };

  const findFile = (fileId: string): ManagedMarkdownFile => {
    const parts = fileId.split(":");
    const framework = parts[0];
    const encodedInstance = parts.slice(1, -1).join(":");
    const instanceId = encodedInstance ? decodeURIComponent(encodedInstance) : undefined;
    const record = core.instances.listInstances().find((item) => item.frameworkId === framework && (instanceId === undefined || item.instanceId === instanceId));
    if (record === undefined) throw new MarkdownFileError("markdown-file-not-found", 404, "instance for markdown file not found", "文件所属实例不存在。", "刷新实例列表后重试。");
    return metadata(record, fileId);
  };

  const historyDir = (file: ManagedMarkdownFile) => join(historyRoot, encodeURIComponent(file.instanceId), file.fileId.replace(/[^A-Za-z0-9_-]/g, "_"));
  const readIndex = (file: ManagedMarkdownFile): RevisionIndex => {
    try {
      const raw = readFileSync(join(historyDir(file), "index.json"), "utf8");
      const parsed = JSON.parse(raw) as Partial<RevisionIndex>;
      return { revisions: Array.isArray(parsed.revisions) ? parsed.revisions : [] };
    } catch { return { revisions: [] }; }
  };
  const saveIndex = (file: ManagedMarkdownFile, index: RevisionIndex): void => {
    mkdirSync(historyDir(file), { recursive: true });
    atomicWriteJson(join(historyDir(file), "index.json"), index, { mode: 0o600, description: "Markdown 文件版本索引" });
  };
  const createRevision = (file: ManagedMarkdownFile, content: string, createdBy: MarkdownFileRevision["createdBy"], note?: string): MarkdownFileRevision => {
    const revisionId = randomUUID();
    const revision: MarkdownFileRevision = { revisionId, fileId: file.fileId, instanceId: file.instanceId, createdAt: new Date().toISOString(), createdBy, sha256: sha256(content), sizeBytes: Buffer.byteLength(content, "utf8"), ...(note ? { note } : {}) };
    const dir = historyDir(file);
    mkdirSync(dir, { recursive: true });
    atomicWriteText(join(dir, `${revisionId}.md`), content, { mode: 0o600, description: "Markdown 文件版本" });
    const index = readIndex(file);
    const allRevisions = [revision, ...index.revisions];
    index.revisions = allRevisions.slice(0, MAX_REVISIONS);
    for (const old of allRevisions.slice(MAX_REVISIONS)) {
      if (safeRevisionId(old.revisionId)) rmSync(join(dir, `${old.revisionId}.md`), { force: true });
    }
    saveIndex(file, index);
    return revision;
  };

  const readContent = (file: ManagedMarkdownFile): string => {
    if (!file.exists) throw new MarkdownFileError("markdown-file-not-found", 404, "markdown file does not exist", "文件当前不存在。", "请先让实例生成该文件，再刷新页面。");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file.absolutePath)); }
    catch (error) { throw new MarkdownFileError("markdown-read-failed", 500, String(error), "文件无法读取。", "确认文件权限和 UTF-8 编码后重试。"); }
  };

  return {
    list(instanceId?: string) {
      const records = instanceId ? [instance(instanceId)] : core.instances.listInstances();
      return records.flatMap((record) => {
        const candidates = core.registry.getBundle(record.frameworkId)?.discovery.managedMarkdownFiles?.({ instanceId: record.instanceId, rootPath: record.rootPath, runtime: record.runtime }) ?? [];
        return candidates.map((candidate) => metadata(record, `${record.frameworkId}:${encodeURIComponent(record.instanceId)}:${candidate.key}`));
      });
    },
    read(fileId) {
      const file = findFile(fileId);
      return { file, content: readContent(file) };
    },
    preview(fileId, content, baseSha256) {
      const file = findFile(fileId);
      const current = file.exists ? readContent(file) : "";
      const currentSha = sha256(current);
      const warnings: string[] = [];
      const blockedReasons: string[] = [];
      if (!file.editable) blockedReasons.push(file.readOnlyReason ?? "该文件不可编辑");
      if (Buffer.byteLength(content, "utf8") > MAX_MARKDOWN_EDIT_BYTES) blockedReasons.push("内容超过 1 MiB");
      if (sensitivity(content) === "contains-secret-pattern") warnings.push("草稿包含疑似密钥或令牌模式，请确认后再保存。");
      const changedSinceRead = baseSha256 !== currentSha;
      if (changedSinceRead) blockedReasons.push("文件已被外部修改，请重新读取后再预览");
      return { file, baseSha256, currentSha256: currentSha, changedSinceRead, diff: diffLines(current, content), warnings, canApply: blockedReasons.length === 0, blockedReasons };
    },
    async apply(fileId, input) {
      if (input.confirmed !== true) throw new MarkdownFileError("markdown-confirmation-required", 400, "apply requires confirmation", "保存前需要确认修改。", "查看 Diff 后再次确认保存。");
      const initial = findFile(fileId);
      if (!initial.editable) throw new MarkdownFileError("markdown-readonly", 409, "markdown file is read-only", initial.readOnlyReason ?? "该文件只读。", "请在记忆管理中处理运行时记忆，或选择可编辑文件。");
      if (Buffer.byteLength(input.content, "utf8") > MAX_MARKDOWN_EDIT_BYTES) throw new MarkdownFileError("markdown-write-failed", 413, "markdown content too large", "文件超过 1 MiB，无法保存。", "减少内容后再试。");
      return withManagedOperationLock(`instance:${initial.instanceId}:markdown`, async () => {
        const file = findFile(fileId);
        const current = readContent(file);
        const currentSha = sha256(current);
        if (currentSha !== input.baseSha256) throw new MarkdownFileError("markdown-conflict", 409, "markdown base hash mismatch", "文件已被外部修改，未覆盖最新内容。", "重新读取文件，合并你的修改后再保存。");
        const record = instance(file.instanceId);
        const gate = await backupGate.ensure({ instanceId: record.instanceId, framework: record.frameworkId, version: record.version, rootPath: record.rootPath, operation: "markdown" });
        if (!gate.allowed) throw new MarkdownFileError("markdown-backup-required", 409, gate.detail, "保存前备份没有完成，操作已阻止。", "确认备份目录可写，或按页面提示完成手动备份后重试。");
        const revision = createRevision(file, current, "user", input.note);
        try { atomicWriteText(file.absolutePath, input.content, { mode: 0o600, description: "核心 Markdown 文件" }); }
        catch (error) { throw new MarkdownFileError("markdown-write-failed", 500, String(error), "文件保存失败，原文件未被安全覆盖。", "确认文件权限和磁盘空间后重试。"); }
        core.audit.append({ actor: "user", action: "markdown-file-apply", target: file.instanceId, detail: { key: file.key, revisionId: revision.revisionId, oldSha256: revision.sha256, newSha256: sha256(input.content) } });
        return { file: metadata(record, fileId), revision };
      });
    },
    revisions(fileId) { return readIndex(findFile(fileId)).revisions.slice(0, MAX_REVISIONS); },
    backup(fileId, note) {
      const file = findFile(fileId);
      const revision = createRevision(file, readContent(file), "system", note ?? "手动备份");
      core.audit.append({ actor: "user", action: "markdown-file-backup", target: file.instanceId, detail: { key: file.key, revisionId: revision.revisionId, sha256: revision.sha256 } });
      return revision;
    },
    async restore(fileId, revisionId, confirmed, baseSha256) {
      if (!confirmed) throw new MarkdownFileError("markdown-confirmation-required", 400, "restore requires confirmation", "恢复版本前需要确认。", "确认将当前内容备份后再恢复。");
      if (!safeRevisionId(revisionId)) throw new MarkdownFileError("markdown-revision-not-found", 404, "invalid revision id", "版本不存在。", "刷新版本历史后重试。");
      const initial = findFile(fileId);
      if (!initial.editable) throw new MarkdownFileError("markdown-readonly", 409, "markdown file is read-only", initial.readOnlyReason ?? "该文件只读。", "请选择可编辑文件。");
      return withManagedOperationLock(`instance:${initial.instanceId}:markdown`, async () => {
        const file = findFile(fileId);
        const current = readContent(file);
        if (sha256(current) !== baseSha256) throw new MarkdownFileError("markdown-conflict", 409, "markdown restore base hash mismatch", "文件已被外部修改，未执行恢复。", "重新读取文件后再尝试恢复。");
        const history = readIndex(file).revisions.find((item) => item.revisionId === revisionId);
        if (history === undefined) throw new MarkdownFileError("markdown-revision-not-found", 404, "revision not found", "版本不存在或已被清理。", "刷新版本历史后选择仍保留的版本。");
        const content = readFileSync(join(historyDir(file), `${revisionId}.md`), "utf8");
        const record = instance(file.instanceId);
        const gate = await backupGate.ensure({ instanceId: record.instanceId, framework: record.frameworkId, version: record.version, rootPath: record.rootPath, operation: "markdown" });
        if (!gate.allowed) throw new MarkdownFileError("markdown-backup-required", 409, gate.detail, "恢复前备份没有完成，操作已阻止。", "确认备份目录可写后重试。");
        const before = createRevision(file, current, "restore", "恢复前自动备份");
        atomicWriteText(file.absolutePath, content, { mode: 0o600, description: "恢复核心 Markdown 文件" });
        core.audit.append({ actor: "user", action: "markdown-file-restore", target: file.instanceId, detail: { key: file.key, revisionId, beforeRevisionId: before.revisionId, oldSha256: before.sha256, newSha256: sha256(content) } });
        return { file: metadata(record, fileId), revision: before };
      });
    },
    download(fileId) {
      const file = findFile(fileId);
      return { filename: basename(file.pathDisplay) || `${file.key}.md`, content: readContent(file), sensitivity: file.sensitivity };
    },
  };
}
