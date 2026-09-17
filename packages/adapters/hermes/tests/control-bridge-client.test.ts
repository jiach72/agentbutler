import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermesControlBridgeClient } from "../src/control-bridge.js";
import { capabilityScan } from "../src/capability-scan.js";

describe("HermesControlBridgeClient ternary status support", () => {
  it("accepts active: null when supervisor is unavailable (macOS / container)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "control-bridge-test-"));
    const tokenFile = join(tempDir, "control.token");
    writeFileSync(tokenFile, "test-token\n", "utf8");

    try {
      const fakeFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            active: null,
            unit: "hermes-gateway.service",
            supervisor: "unavailable",
            supervisorReason: "systemctl_missing",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );

      const client = new HermesControlBridgeClient({
        baseUrl: "http://127.0.0.1:8756",
        tokenFile,
        fetchImpl: fakeFetch,
      });

      const status = await client.status();
      expect(status.active).toBeNull();
      expect(status.unit).toBe("hermes-gateway.service");
      expect(status.supervisor).toBe("unavailable");

      const isAlive = await client.probe();
      expect(isAlive).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles boolean active status normally", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "control-bridge-test-"));
    const tokenFile = join(tempDir, "control.token");
    writeFileSync(tokenFile, "test-token\n", "utf8");

    try {
      const fakeFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            active: true,
            unit: "hermes-gateway.service",
            supervisor: "systemd",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );

      const client = new HermesControlBridgeClient({
        baseUrl: "http://127.0.0.1:8756",
        tokenFile,
        fetchImpl: fakeFetch,
      });

      const status = await client.status();
      expect(status.active).toBe(true);
      expect(status.supervisor).toBe("systemd");
      expect(await client.probe()).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails probe on invalid responses or HTTP 401", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "control-bridge-test-"));
    const tokenFile = join(tempDir, "control.token");
    writeFileSync(tokenFile, "test-token\n", "utf8");

    try {
      const unauthFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

      const client = new HermesControlBridgeClient({
        baseUrl: "http://127.0.0.1:8756",
        tokenFile,
        fetchImpl: unauthFetch,
      });

      expect(await client.probe()).toBe(false);
      await expect(client.status()).rejects.toThrow("Hermes control bridge request failed (401)");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("sets capability.probe to not-implemented when api_server is not configured", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cap-scan-test-"));
    writeFileSync(join(tempDir, "config.yaml"), "gateway:\n  platforms:\n    a2a:\n      port: 9900\n", "utf8");
    try {
      const result = await capabilityScan(tempDir, {
        prober: async () => false,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.capabilities.probe).toBe("not-implemented");
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
