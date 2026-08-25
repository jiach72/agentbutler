import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readUiSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "ui", "src", relativePath), "utf8");
}

describe("UI 危险操作确认层", () => {
  it("Settings 和 Gateway 不再调用浏览器原生 confirm", () => {
    const settings = readUiSource("pages/Settings.tsx");
    const gateway = readUiSource("pages/Gateway.tsx");

    expect(settings).toContain("DangerConfirmModal");
    expect(gateway).toContain("DangerConfirmModal");
    expect(settings).not.toContain("window.confirm");
    expect(gateway).not.toContain("window.confirm");
  });

  it("统一确认组件具备对话框、Escape 和焦点回收语义", () => {
    const modal = readUiSource("components/DangerConfirmModal.tsx");

    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain('event.key === "Escape"');
    expect(modal).toContain("previous?.focus()");
  });
});
