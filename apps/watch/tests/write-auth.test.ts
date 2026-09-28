/**
 * watch 写请求鉴权（writeRequestAuthorized）回归测试。
 *
 * 审计 K-3：RFC1918 内网源 IP 不再被视作回环——Compose 内服务间写调用必须凭
 * BUTLER_INTERNAL_TOKEN（web 代理自动附加）；审计 K-5：Origin 白名单不再接受
 * 可伪造的 butler-web 主机名。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";

import { writeRequestAuthorized } from "../src/http-common.js";

function fakeRequest(
  method: string,
  remoteAddress: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  return {
    method,
    headers,
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

const SAVED_ENV: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete SAVED_ENV[key];
  }
});

function withEnv(key: string, value: string | undefined): void {
  if (!(key in SAVED_ENV)) SAVED_ENV[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("watch 写请求鉴权", () => {
  it("读请求不拦截", () => {
    withEnv("BUTLER_ACCESS_TOKEN", "");
    withEnv("BUTLER_INTERNAL_TOKEN", "");
    expect(writeRequestAuthorized(fakeRequest("GET", "192.168.1.9"))).toBe(true);
  });

  it("未配置任何口令时，回环连接放行、RFC1918 内网拒绝（K-3）", () => {
    withEnv("BUTLER_ACCESS_TOKEN", "");
    withEnv("BUTLER_INTERNAL_TOKEN", "");
    expect(writeRequestAuthorized(fakeRequest("POST", "127.0.0.1"))).toBe(true);
    expect(writeRequestAuthorized(fakeRequest("POST", "::1"))).toBe(true);
    expect(writeRequestAuthorized(fakeRequest("POST", "172.18.0.5"))).toBe(false);
    expect(writeRequestAuthorized(fakeRequest("POST", "10.0.0.7"))).toBe(false);
    expect(writeRequestAuthorized(fakeRequest("POST", "192.168.1.9"))).toBe(false);
  });

  it("配置内部口令后，携带 x-butler-internal-token 的容器间调用放行", () => {
    withEnv("BUTLER_ACCESS_TOKEN", "");
    withEnv("BUTLER_INTERNAL_TOKEN", "internal-secret");
    expect(
      writeRequestAuthorized(
        fakeRequest("POST", "172.18.0.5", { "x-butler-internal-token": "internal-secret" }),
      ),
    ).toBe(true);
    expect(
      writeRequestAuthorized(
        fakeRequest("POST", "172.18.0.5", { "x-butler-internal-token": "wrong" }),
      ),
    ).toBe(false);
    expect(writeRequestAuthorized(fakeRequest("POST", "172.18.0.5"))).toBe(false);
  });

  it("配置访问口令后，x-butler-token 放行且内部口令同样有效", () => {
    withEnv("BUTLER_ACCESS_TOKEN", "access-secret");
    withEnv("BUTLER_INTERNAL_TOKEN", "internal-secret");
    expect(
      writeRequestAuthorized(fakeRequest("POST", "192.168.1.9", { "x-butler-token": "access-secret" })),
    ).toBe(true);
    expect(
      writeRequestAuthorized(
        fakeRequest("POST", "192.168.1.9", { "x-butler-internal-token": "internal-secret" }),
      ),
    ).toBe(true);
  });
});
