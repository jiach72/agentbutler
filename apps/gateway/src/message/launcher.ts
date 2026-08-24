/**
 * Dedicated tracked launcher for the Hermes-backed message runtime.
 *
 * Build: corepack pnpm --filter @butler/gateway exec tsc -p tsconfig.json
 * Run:   node apps/gateway/dist/message/launcher.js
 */
import { pathToFileURL } from "node:url";

import { createGatewayServer, type GatewayApp } from "../server.js";
import {
  createHermesMessageRuntime,
  type HermesMessageRuntime,
  type HermesMessageRuntimeOptions,
} from "./runtime.js";

export interface HermesGatewayLauncherOptions {
  host?: string;
  port?: number;
  runtime?: HermesMessageRuntimeOptions;
}

export interface RunningHermesGateway {
  app: GatewayApp;
  runtime: HermesMessageRuntime;
  close(): Promise<void>;
}

export async function launchHermesGateway(
  options: HermesGatewayLauncherOptions = {},
): Promise<RunningHermesGateway> {
  const host = options.host?.trim() || process.env["BUTLER_GATEWAY_HOST"]?.trim() || "127.0.0.1";
  const port = options.port ?? parsePort(process.env["BUTLER_GATEWAY_PORT"]);
  const runtime = createHermesMessageRuntime(options.runtime);
  let app: GatewayApp | undefined;

  try {
    await runtime.start();
    app = createGatewayServer({
      messageService: runtime.service,
      messageStore: runtime.store,
      inboundHistory: (limit) => runtime.inboundHistory(limit),
    });
    await app.listen({ host, port });
  } catch (error) {
    try {
      if (app !== undefined) await app.gateway.close();
    } finally {
      await runtime.stop();
    }
    throw error;
  }

  const runningApp = app;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      try {
        await runningApp.gateway.close();
      } finally {
        await runtime.stop();
      }
    })();
    return closePromise;
  };
  return { app: runningApp, runtime, close };
}

function parsePort(raw: string | undefined): number {
  const value = raw?.trim() || "7532";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("BUTLER_GATEWAY_PORT must be an integer between 1 and 65535");
  }
  return port;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void launchHermesGateway()
    .then((running) => {
      const address = running.app.server.address();
      console.log(`[gateway] Hermes message runtime listening at ${JSON.stringify(address)}`);
      let closing = false;
      const shutdown = (signal: string): void => {
        if (closing) return;
        closing = true;
        void running.close().then(
          () => process.exit(0),
          (error: unknown) => {
            console.error(`[gateway] ${signal} shutdown failed:`, error);
            process.exit(1);
          },
        );
      };
      process.once("SIGTERM", () => shutdown("SIGTERM"));
      process.once("SIGINT", () => shutdown("SIGINT"));
    })
    .catch((error: unknown) => {
      console.error("[gateway] Hermes message runtime startup failed:", error);
      process.exit(1);
    });
}
