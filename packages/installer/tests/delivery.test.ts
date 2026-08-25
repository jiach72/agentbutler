import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("delivery contract", () => {
  it.each(["watch", "gateway", "web"])("%s package exposes a real start script", (app) => {
    const pkg = readJson(join(repoRoot, "apps", app, "package.json"));
    expect(pkg["scripts"]).toMatchObject({ start: "node dist/main.js" });
  });

  it.each([
    ["watch", "7533", "apps/watch/dist/main.js"],
    ["gateway", "7532", "apps/gateway/dist/main.js"],
    ["web", "7531", "apps/web/dist/main.js"],
  ])("%s image builds the monorepo and runs the service as non-root", (app, port, entry) => {
    const dockerfile = readFileSync(join(repoRoot, "apps", app, "Dockerfile"), "utf8");
    expect(dockerfile).not.toContain("placeholder");
    expect(dockerfile).toContain("corepack pnpm install --frozen-lockfile");
    expect(dockerfile).toContain("corepack pnpm exec tsc -b --force");
    expect(dockerfile).toContain("corepack pnpm --filter @butler/ui exec vite build");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain(`EXPOSE ${port}`);
    expect(dockerfile).toContain(`CMD ["node", "${entry}"]`);
  });

  it("compose uses root build contexts, internal DNS, loopback publishing, and persistent home", () => {
    const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose.match(/context: \./g)).toHaveLength(3);
    expect(compose).toContain("BUTLER_GATEWAY_URL: http://butler-gateway:7532");
    expect(compose).toContain("BUTLER_WATCH_URL: http://butler-watch:7533");
    expect(compose).toContain('127.0.0.1:7531:7531');
    expect(compose.match(/butler-data:\/home\/butler/g)).toHaveLength(3);
    expect(compose).toContain("condition: service_healthy");
  });
});
