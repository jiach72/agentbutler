/**
 * Hermes 常用命令与配置指引（HermesGuideCard）测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App as AntApp } from "antd";
import { describe, expect, it } from "vitest";
import { HermesGuideCard } from "../src/pages/tools/HermesGuideCard.js";

function renderHermesGuide(): string {
  return renderToStaticMarkup(
    <React.StrictMode>
      <AntApp>
        <HermesGuideCard />
      </AntApp>
    </React.StrictMode>
  );
}

describe("Hermes 使用指引与常用命令卡片（HermesGuideCard）", () => {
  it("渲染卡片标题与四大分类标签", () => {
    const html = renderHermesGuide();

    expect(html).toContain("Hermes 引擎指引与常用运维命令");
    expect(html).toContain("CLI CHEATSHEET");
    expect(html).toContain("服务状态与管理");
    expect(html).toContain("网关与 Bridge 诊断");
    expect(html).toContain("配置修改与预检");
    expect(html).toContain("任务与常用 CLI");
  });

  it("包含核心运维命令与复制按钮", () => {
    const html = renderHermesGuide();

    expect(html).toContain("systemctl --user status hermes-gateway");
    expect(html).toContain("systemctl --user restart hermes-gateway");
    expect(html).toContain("docker compose ps");
    expect(html).toContain("docker compose logs -f --tail=100 butler-gateway");
    expect(html).toContain("ab-btn-copy");
  });

  it("包含安全边界与回环红线警示", () => {
    const html = renderHermesGuide();

    expect(html).toContain("Bridge 127.0.0.1:8754 回环");
    expect(html).toContain("配置修改后必须重启宿主网关，Bridge 才会重新加载策略并与 Butler 连接");
  });
});
