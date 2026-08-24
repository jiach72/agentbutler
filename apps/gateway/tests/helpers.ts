import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AlertChannel, OutboundMessage } from "../src/channels";
import type { Clock } from "../src/loop";

/** 每个测试文件用它建独立临时目录，避免污染真实 ~/.agent-butler。 */
export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "butler-gateway-"));
}

export function rmTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 临时目录下的网关队列库文件路径。 */
export function gatewayDbFile(tmp: string): string {
  return path.join(tmp, "data", "gateway.db");
}

/** 可编程假通道：记录全部发送；failures 队列非空时按序抛出（耗尽即成功）。 */
export class FakeChannel implements AlertChannel {
  readonly name: string;
  sends: OutboundMessage[] = [];
  private readonly configured: boolean;
  private readonly failures: Error[];

  constructor(name: string, options: { configured?: boolean; failures?: Error[] } = {}) {
    this.name = name;
    this.configured = options.configured ?? true;
    this.failures = [...(options.failures ?? [])];
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async send(message: OutboundMessage): Promise<void> {
    this.sends.push(message);
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
  }
}

/** 可手动推进的假时钟（投递循环/退避计算测试用）。 */
export function fakeClock(startMs: number = Date.parse("2026-01-01T00:00:00.000Z")): {
  clock: Clock;
  advance(ms: number): void;
} {
  let now = startMs;
  return {
    clock: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}
