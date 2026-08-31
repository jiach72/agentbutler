import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  HERMES_MESSAGE_RUNTIME_FEATURE_FLAG,
  launchHermesGateway,
} from "../src/message/launcher.js";
import { withHostHermesDefaults } from "../src/main.js";
import { MESSAGE_RUNTIME_ENV } from "../src/message/runtime.js";

describe("Hermes message launcher boundary", () => {
  it("rejects startup when the experimental feature flag is absent", async () => {
    await expect(launchHermesGateway({ env: {} })).rejects.toThrow(
      new RegExp(HERMES_MESSAGE_RUNTIME_FEATURE_FLAG),
    );
  });

  it("requires the normal runtime configuration after the flag is explicitly enabled", async () => {
    await expect(
      launchHermesGateway({ env: { [HERMES_MESSAGE_RUNTIME_FEATURE_FLAG]: "true" } }),
    ).rejects.toThrow(/BUTLER_HERMES_BRIDGE_URL/);
  });

  it("补齐 macOS 宿主 Hermes 的默认消息运行时环境", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "butler-hermes-defaults-"));
    try {
      const hermesRoot = path.join(root, ".hermes");
      const tokenFile = path.join(hermesRoot, "agent-butler", "bridge.token");
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, "test-token", { mode: 0o600 });
      const resolved = withHostHermesDefaults({
        BUTLER_FRAMEWORK: "hermes",
        HOME: root,
      });
      expect(resolved[MESSAGE_RUNTIME_ENV.bridgeUrl]).toBe("http://127.0.0.1:8754");
      expect(resolved[MESSAGE_RUNTIME_ENV.hermesRoot]).toBe(hermesRoot);
      expect(resolved[MESSAGE_RUNTIME_ENV.tokenFile]).toBe(tokenFile);
      expect(resolved[MESSAGE_RUNTIME_ENV.projectionDbFile]).toBe(path.join(root, ".agent-butler", "messages.sqlite"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("保留显式消息运行时配置，并对非 Hermes 环境不做推断", () => {
    expect(
      withHostHermesDefaults({
        BUTLER_FRAMEWORK: "openclaw",
        BUTLER_HERMES_BRIDGE_URL: "http://custom.test:8754",
      }),
    ).toEqual({
      BUTLER_FRAMEWORK: "openclaw",
      BUTLER_HERMES_BRIDGE_URL: "http://custom.test:8754",
    });
  });
});
