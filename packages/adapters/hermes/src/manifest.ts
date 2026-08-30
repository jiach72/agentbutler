import type { Manifest } from "@butler/contract";

/**
 * Hermes 适配器 manifest（与包根 manifest.json 内容一致，供 registry 目录加载）。
 * Hermes V1 仅支持 L0-L2；上游没有可验证的出站前扩展点，因此不申报 messaging。
 */
export const hermesManifest: Manifest = {
  frameworkId: "hermes",
  displayName: "Hermes",
  contractVersion: "1.x",
  adapterVersion: "1.0.0-beta.15",
  declaredLevel: 2,
  capabilities: ["probe", "control", "skill-driver", "memory-driver", "config-driver"],
  drivers: [
    { kind: "skill", id: "hermes-skill" },
    { kind: "memory", id: "sqlite-fts5" },
    { kind: "config", id: "env-based" },
  ],
};
