/**
 * 排查常见问题与避坑指南（TroubleshootFaq）结构与交互契约测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App as AntApp } from "antd";
import { describe, expect, it } from "vitest";
import { TroubleshootFaq } from "../src/pages/troubleshoot/TroubleshootFaq.js";

function renderTroubleshootFaq(props: React.ComponentProps<typeof TroubleshootFaq> = {}): string {
  return renderToStaticMarkup(
    <React.StrictMode>
      <AntApp>
        <TroubleshootFaq {...props} />
      </AntApp>
    </React.StrictMode>
  );
}

describe("常见问题与避坑指南（TroubleshootFaq）", () => {
  it("默认渲染 6 大生产级常见问题", () => {
    const html = renderTroubleshootFaq();

    // 1. Hermes Bridge 断连
    expect(html).toContain("Hermes Bridge 显示未连接或频繁重连？");
    expect(html).toContain("bash scripts/bridge-healthcheck.sh");

    // 2. WSL EACCES
    expect(html).toContain("WSL 环境下执行 pnpm 或 docker build 报 EACCES 权限错误？");
    expect(html).toContain("ext4");

    // 3. 模型 401
    expect(html).toContain("模型探针与记忆写入整片失败，后台大量 401 报错？");
    expect(html).toContain("curl -s -H");

    // 4. Windows 端口打不开
    expect(html).toContain("容器状态均为 healthy，但 Windows 浏览器打不开 7531 端口？");
    expect(html).toContain("fix-portproxy.ps1");

    // 5. SQLite 瞬态锁
    expect(html).toContain("日志偶见 SQLITE_BUSY 或 database is locked 报警？");
    expect(html).toContain("WAL");

    // 6. 通道应用中
    expect(html).toContain("在面板修改消息通道后，状态一直卡在「应用中」？");
    expect(html).toContain("journalctl");
  });

  it("渲染分类筛选过滤器与搜索框", () => {
    const html = renderTroubleshootFaq();

    expect(html).toContain("全部");
    expect(html).toContain("消息网关");
    expect(html).toContain("环境构建");
    expect(html).toContain("模型服务");
    expect(html).toContain("数据存储");
    expect(html).toContain("网络访问");
    expect(html).toContain("搜索问题、错误关键字");
  });

  it("提供复制命令按钮与根因分析", () => {
    const html = renderTroubleshootFaq();

    expect(html).toContain("根因本质与底层逻辑");
    expect(html).toContain("诊断与预检命令");
    expect(html).toContain("推荐修复命令");
    expect(html).toContain("ab-btn-copy");
  });

  it("当提供 onSelectSymptom 回调时展示向导排查入口", () => {
    const html = renderTroubleshootFaq({ onSelectSymptom: () => {} });
    expect(html).toContain("使用向导排查「它不回我消息了」现象");
  });
});
