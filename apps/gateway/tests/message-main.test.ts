import { describe, expect, it } from "vitest";

import { shouldEnableHermesMessageRuntime } from "../src/main";

describe("gateway Hermes message runtime gate", () => {
  it.each([undefined, "", "auto", "false", "0", "no", "off"]) (
    "does not enable runtime for %s",
    (value) => {
      expect(shouldEnableHermesMessageRuntime(value)).toBe(false);
    },
  );

  it.each(["true", "1", "yes", "on", " TRUE "]) (
    "enables runtime only for explicit truthy value %s",
    (value) => {
      expect(shouldEnableHermesMessageRuntime(value)).toBe(true);
    },
  );
});
