import { describe, expect, it } from "vitest";
import { createDiagnosticZip } from "../src/diagnostics.js";

function readStoredEntries(bytes: Uint8Array): Map<string, string> {
  const decoder = new TextDecoder();
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const signature = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
    if (signature !== 0x04034b50) break;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 30);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const size = view.getUint32(18, true);
    const nameStart = offset + 30;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;
    entries.set(name, decoder.decode(bytes.slice(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  return entries;
}

describe("createDiagnosticZip", () => {
  it("生成标准 ZIP，包含脱敏报告和清单，不包含原始日志文件", () => {
    const zip = createDiagnosticZip("# 报告\n路径：~\n", "2026-08-30T00:00:00.000Z");
    expect(Array.from(zip.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const entries = readStoredEntries(zip);
    expect(entries.get("diagnostic-report.md")).toContain("# 报告");
    expect(entries.get("manifest.json")).toContain('"format": "agent-butler-diagnostic"');
    expect(entries.get("manifest.json")).toContain("paths-usernames-secrets-chat-content-removed");
    expect([...entries.keys()]).toEqual(["diagnostic-report.md", "manifest.json"]);
  });
});
