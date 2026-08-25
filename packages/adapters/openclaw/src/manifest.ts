import type { Manifest } from "@butler/contract";

export const openClawManifest: Manifest = {
  frameworkId: "openclaw",
  displayName: "OpenClaw",
  contractVersion: "1.x",
  adapterVersion: "1.0.0-beta.2",
  declaredLevel: 2,
  capabilities: ["probe", "control", "skill-driver", "memory-driver", "config-driver"],
  drivers: [
    { kind: "skill", id: "openclaw-skill-readonly" },
    { kind: "memory", id: "openclaw-markdown-memory-readonly" },
    { kind: "config", id: "openclaw-config-readonly" },
  ],
};
