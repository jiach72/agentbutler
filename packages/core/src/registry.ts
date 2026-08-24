/**
 * 适配器注册表：
 * - register(bundle)：程序化注册（MVP 主路径），manifest 经 parseManifest 复验，
 *   重复 frameworkId 且已有实现 → E002 拒绝；
 * - loadFromDir(dir)：扫描子目录 manifest.json，校验失败 → 记 adapter-rejected
 *   事件并跳过（不抛异常），成功 → 登记 manifest-only 条目（等待程序化接线）。
 */
import fs from "node:fs";
import path from "node:path";
import {
  fail,
  ok,
  parseManifest,
  type AdapterBundle,
  type ErrorCode,
  type Manifest,
  type Result,
} from "@butler/contract";
import type { EventBus } from "./events.js";

export interface RegisteredAdapter {
  manifest: Manifest;
  /** 程序化注册后存在；loadFromDir 登记的 manifest-only 条目为空。 */
  bundle?: AdapterBundle;
  source: "programmatic" | "dir";
  dir?: string;
}

export interface AdapterRejection {
  dir: string;
  frameworkId?: string;
  code: ErrorCode;
  message: string;
}

export interface LoadSummary {
  loaded: number;
  skipped: number;
  rejections: AdapterRejection[];
}

export class AdapterRegistry {
  private adapters = new Map<string, RegisteredAdapter>();
  private bus: EventBus;

  constructor(deps: { bus: EventBus }) {
    this.bus = deps.bus;
  }

  /**
   * 程序化注册适配器 bundle：
   * - manifest 结构/契约版本非法 → E001；
   * - frameworkId 已有 bundle → E002（重复注册拒绝）；
   * - frameworkId 仅有 manifest-only 条目（loadFromDir 预登记）→ 附着实现。
   */
  register(bundle: AdapterBundle): Result<RegisteredAdapter> {
    const manifestResult = parseManifest(bundle.manifest);
    if (!manifestResult.ok) {
      const error = manifestResult.error!;
      const declaredId = readDeclaredFrameworkId(bundle.manifest);
      this.emitRejected({ frameworkId: declaredId, code: "E001", message: error.message });
      return fail("E001", error.message, { userHint: error.userHint });
    }
    const manifest = manifestResult.data!;
    const existing = this.adapters.get(manifest.frameworkId);
    if (existing !== undefined && existing.bundle !== undefined) {
      return fail("E002", `adapter "${manifest.frameworkId}" already registered with an implementation`, {
        userHint: "同一框架的适配器已注册，拒绝重复注册",
      });
    }
    const entry: RegisteredAdapter = {
      manifest,
      bundle,
      source: existing?.source ?? "programmatic",
      dir: existing?.dir,
    };
    this.adapters.set(manifest.frameworkId, entry);
    return ok(entry);
  }

  /**
   * 从目录加载适配器清单：每个子目录读 manifest.json 并用 parseManifest 校验。
   * 任何失败（目录缺失/无 manifest/JSON 损坏/校验不过/重复 frameworkId）只记
   * adapter-rejected 事件并跳过，绝不抛异常。
   */
  loadFromDir(dir: string): Result<LoadSummary> {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return fail("E002", `adapter directory not found: ${dir}`, { userHint: "适配器目录不存在" });
    }
    const summary: LoadSummary = { loaded: 0, skipped: 0, rejections: [] };
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(dir, entry.name);
      const manifestFile = path.join(subDir, "manifest.json");
      if (!fs.existsSync(manifestFile)) {
        this.reject(summary, { dir: subDir, code: "E002", message: "manifest.json not found in adapter directory" });
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
      } catch (error) {
        this.reject(summary, {
          dir: subDir,
          code: "E001",
          message: `manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const manifestResult = parseManifest(json);
      if (!manifestResult.ok) {
        this.reject(summary, { dir: subDir, code: "E001", message: manifestResult.error!.message });
        continue;
      }
      const manifest = manifestResult.data!;
      if (this.adapters.has(manifest.frameworkId)) {
        this.reject(summary, {
          dir: subDir,
          frameworkId: manifest.frameworkId,
          code: "E002",
          message: `adapter "${manifest.frameworkId}" already registered`,
        });
        continue;
      }
      this.adapters.set(manifest.frameworkId, { manifest, source: "dir", dir: subDir });
      summary.loaded += 1;
    }
    return ok(summary);
  }

  /** 取登记条目（含 manifest-only）；未登记返回 undefined。 */
  get(frameworkId: string): RegisteredAdapter | undefined {
    return this.adapters.get(frameworkId);
  }

  /** 取已附着实现的 bundle；仅 manifest-only 时返回 undefined。 */
  getBundle(frameworkId: string): AdapterBundle | undefined {
    return this.adapters.get(frameworkId)?.bundle;
  }

  has(frameworkId: string): boolean {
    return this.adapters.has(frameworkId);
  }

  list(): RegisteredAdapter[] {
    return [...this.adapters.values()];
  }

  private reject(summary: LoadSummary, rejection: AdapterRejection): void {
    summary.skipped += 1;
    summary.rejections.push(rejection);
    this.emitRejected(rejection);
  }

  private emitRejected(rejection: { dir?: string; frameworkId?: string; code: ErrorCode; message: string }): void {
    this.bus.emit("adapter-rejected", {
      dir: rejection.dir,
      frameworkId: rejection.frameworkId,
      code: rejection.code,
      message: rejection.message,
    });
  }
}

function readDeclaredFrameworkId(manifest: unknown): string | undefined {
  if (typeof manifest === "object" && manifest !== null && "frameworkId" in manifest) {
    const id = (manifest as { frameworkId?: unknown }).frameworkId;
    if (typeof id === "string") return id;
  }
  return undefined;
}
