import { describe, expect, it } from "vitest";

import {
  HERMES_MESSAGE_RUNTIME_FEATURE_FLAG,
  launchHermesGateway,
} from "../src/message/launcher.js";

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
});
