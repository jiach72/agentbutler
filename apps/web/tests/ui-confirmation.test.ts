import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readUiSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "ui", "src", relativePath), "utf8");
}

describe("UI 危险操作确认层", () => {
  it("Settings 和 Gateway 不再调用浏览器原生 confirm", () => {
    const settings = readUiSource("pages/settings/SettingsPage.tsx");
    const gateway = readUiSource("pages/gateway/GatewayPage.tsx");

    expect(settings).toContain("DangerConfirmModal");
    expect(gateway).toContain("DangerConfirmModal");
    expect(settings).not.toContain("window.confirm");
    expect(gateway).not.toContain("window.confirm");
  });

  it("统一确认组件基于 antd Modal，并在 busy 期间锁死全部退出路径", () => {
    // 对话框语义（role=dialog / 焦点圈禁 / Escape 关闭 / 滚动锁）由 antd Modal 契约提供；
    // 这里断言我们叠加的安全不变式：busy 时禁止关闭与重复确认。
    const modal = readUiSource("components/DangerConfirmModal.tsx");

    expect(modal).toContain("<Modal");
    expect(modal).toContain("mask={{ closable: false }}");
    expect(modal).toContain("keyboard={!busy}");
    expect(modal).toContain("closable={!busy}");
    expect(modal).toContain('okButtonProps={{ danger: true, disabled: busy, loading: busy }}');
    expect(modal).toContain("cancelButtonProps={{ disabled: busy }}");
  });
});
