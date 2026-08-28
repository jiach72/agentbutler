import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CRITICAL_PROBE_INTERVAL_MIN,
  DEFAULT_INSPECT_INTERVAL_MIN,
  loadWatchConfig,
} from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadWatchConfig", () => {
  it("defaults inspection to five minutes for the ten-minute recovery SLA", () => {
    vi.stubEnv("BUTLER_INSPECT_INTERVAL_MIN", "");

    expect(DEFAULT_INSPECT_INTERVAL_MIN).toBe(5);
    expect(loadWatchConfig().inspectIntervalMin).toBe(5);
  });

  it("allows a positive inspection interval override and rejects invalid values", () => {
    vi.stubEnv("BUTLER_INSPECT_INTERVAL_MIN", "3");
    expect(loadWatchConfig().inspectIntervalMin).toBe(3);

    vi.stubEnv("BUTLER_INSPECT_INTERVAL_MIN", "0");
    expect(loadWatchConfig().inspectIntervalMin).toBe(5);
  });

  it("defaults the critical memory probe to one minute and rejects intervals above five minutes", () => {
    vi.stubEnv("BUTLER_CRITICAL_PROBE_INTERVAL_MIN", "");
    expect(DEFAULT_CRITICAL_PROBE_INTERVAL_MIN).toBe(1);
    expect(loadWatchConfig().criticalProbeIntervalMin).toBe(1);

    vi.stubEnv("BUTLER_CRITICAL_PROBE_INTERVAL_MIN", "3");
    expect(loadWatchConfig().criticalProbeIntervalMin).toBe(3);

    vi.stubEnv("BUTLER_CRITICAL_PROBE_INTERVAL_MIN", "6");
    expect(loadWatchConfig().criticalProbeIntervalMin).toBe(1);
  });

  it("reads an explicit Hermes root for container deployments", () => {
    vi.stubEnv("BUTLER_HERMES_ROOT", "/home/butler/hermes");
    vi.stubEnv("HERMES_ROOT", "/legacy/hermes");

    expect(loadWatchConfig().hermesRoot).toBe("/home/butler/hermes");
  });

  it("falls back to HERMES_ROOT and lets explicit overrides win", () => {
    vi.stubEnv("BUTLER_HERMES_ROOT", "");
    vi.stubEnv("HERMES_ROOT", "/legacy/hermes");

    expect(loadWatchConfig().hermesRoot).toBe("/legacy/hermes");
    expect(loadWatchConfig({ hermesRoot: "/test/hermes" }).hermesRoot).toBe("/test/hermes");
  });

  it("keeps credential writes closed for non-loopback listeners unless explicitly enabled", () => {
    vi.stubEnv("BUTLER_WATCH_HOST", "0.0.0.0");
    vi.stubEnv("BUTLER_CREDENTIAL_WRITES_ALLOWED", "");
    expect(loadWatchConfig().credentialWritesAllowed).toBe(false);

    vi.stubEnv("BUTLER_CREDENTIAL_WRITES_ALLOWED", "true");
    expect(loadWatchConfig().credentialWritesAllowed).toBe(true);
  });

  it("allows credential writes by default for loopback listeners", () => {
    vi.stubEnv("BUTLER_WATCH_HOST", "127.0.0.1");
    vi.stubEnv("BUTLER_CREDENTIAL_WRITES_ALLOWED", "");
    expect(loadWatchConfig().credentialWritesAllowed).toBe(true);
  });

  it("derives the default from an explicit host override", () => {
    vi.stubEnv("BUTLER_CREDENTIAL_WRITES_ALLOWED", "");
    expect(loadWatchConfig({ watchHttpHost: "0.0.0.0" }).credentialWritesAllowed).toBe(false);
  });
});
