import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Ollama 本地引擎配置卡片交互体验契约", () => {
  const source = readFileSync(
    new URL("../src/pages/settings/OllamaConfigCard.tsx", import.meta.url),
    "utf8",
  );

  it("引入 useNavigate 实现与即时通讯工作台的无缝跳转", () => {
    expect(source).toContain('import { useNavigate } from "react-router-dom";');
    expect(source).toContain("const navigate = useNavigate();");
  });

  it("已生效为主对话模型的 Ollama 模型卡片提供一键在即时通讯中对话按钮", () => {
    expect(source).toContain("isPrimary && (");
    expect(source).toContain("在即时通讯中对话");
    expect(source).toContain("/gateway?tab=im&prefill=");
  });

  it("在线冒烟测试与 Token 探测成功后支持在即时通讯中深入对话", () => {
    expect(source).toContain("chatResult.ok && (");
    expect(source).toContain("在即时通讯中深入对话");
    expect(source).toContain("针对「${testPrompt}」的回答");
  });

  it("模型名称提供原生 copyable 属性以支持快速复制", () => {
    expect(source).toContain('copyable={{ text: item.name, tooltips: ["复制模型名称", "已复制"] }}');
  });
});
