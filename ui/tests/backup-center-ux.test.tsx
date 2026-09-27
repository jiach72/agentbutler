/**
 * 备份中心 (BackupCenter) UI/UX 规范与搜索可用性测试
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App as AntApp } from "antd";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";
import { BackupCenter } from "../src/pages/settings/BackupCenter.js";

describe("备份中心 (BackupCenter) UI/UX 与工效测试", () => {
  it("正常渲染备份操作按钮、保留策略与历史备份记录列表", () => {
    const mockBackups = {
      status: "ready" as const,
      data: {
        items: [
          {
            id: 108,
            kind: "full" as const,
            label: "每日全量自动备份",
            target: "host",
            path: "/data/backups/backup-2026-09-28-full.tar.gz",
            createdAt: new Date().toISOString(),
            sizeBytes: 10485760,
            status: "ready" as const,
          },
        ],
        retention: { full: 7, memory: 14, event: 3 },
        status: {
          lastFullVerification: {
            status: "verified" as const,
            at: new Date().toISOString(),
          },
        },
      },
    };

    const mockButlerSelf = {
      status: "ready" as const,
      data: {
        reachable: true,
        retention: 3,
        snapshots: [],
      },
    };

    const html = renderToStaticMarkup(
      <React.StrictMode>
        <ThemeProvider>
          <AntApp>
            <BackupCenter
              backups={mockBackups}
              butlerSelf={mockButlerSelf}
              busy={null}
              onRetry={() => {}}
              onRunBackup={() => {}}
              onVerifyBackup={() => {}}
              onRequestRestore={() => {}}
            />
          </AntApp>
        </ThemeProvider>
      </React.StrictMode>
    );

    // 核心按钮与区域
    expect(html).toContain("备份记录");
    expect(html).toContain("立即全量备份");
    expect(html).toContain("备份记忆");
    expect(html).toContain("验证最近备份");
    expect(html).toContain("保留策略");

    // 搜索输入框与条数展示
    expect(html).toContain("搜索备份标签 / 类型 / 编号...");
    expect(html).toContain("历史备份记录");
    expect(html).toContain("1 份");

    // 列表项与一键复制属性
    expect(html).toContain("每日全量自动备份");
    expect(html).toContain("#108");
  });

  it("无备份数据时渲染友好空态与创建首个备份按钮", () => {
    const html = renderToStaticMarkup(
      <React.StrictMode>
        <ThemeProvider>
          <AntApp>
            <BackupCenter
              backups={{ status: "ready", data: { items: [], retention: { full: 7, memory: 14, event: 3 } } }}
              butlerSelf={{ status: "ready", data: { reachable: true, retention: 3, snapshots: [] } }}
              busy={null}
              onRetry={() => {}}
              onRunBackup={() => {}}
              onVerifyBackup={() => {}}
              onRequestRestore={() => {}}
            />
          </AntApp>
        </ThemeProvider>
      </React.StrictMode>
    );

    expect(html).toContain("还没有备份记录");
    expect(html).toContain("立即创建首个全量备份");
  });
});
