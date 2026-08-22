import type { Manifest } from "@butler/contract";

/**
 * Hermes 适配器 manifest（与包根 manifest.json 内容一致，供 registry 目录加载）。
 * declaredLevel=3 表示适配器具备受管 Bridge messaging 能力；实际等级仍由实时探针决定。
 */
export const hermesManifest: Manifest = {
  frameworkId: "hermes",
  displayName: "Hermes",
  contractVersion: "1.x",
  adapterVersion: "0.1.0",
  declaredLevel: 3,
  capabilities: ["probe", "control", "messaging", "skill-driver", "memory-driver", "config-driver"],
  drivers: [
    { kind: "skill", id: "hermes-skill" },
    { kind: "memory", id: "sqlite-fts5" },
    { kind: "config", id: "env-based" },
  ],
};
