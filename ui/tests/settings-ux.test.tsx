/**
 * 设置页 UX 焦点测试（TDD：先写断言观察失败，再实现）。
 *
 * 验收点：
 *  1. 撤掉首屏恒定报平安的横幅（ConclusionBar "管家在线，各项设置实时生效"）与常驻的
 *     SourceStatusBar；失败的数据源只在对应分区 / 折叠诊断区显示可重试错误。
 *  2. 措辞诚实：就绪数据源标注「已更新（时间）」，绝不写「正常 / 业务正常」；
 *     诊断信息收进默认折叠的 <details>。
 *  3. 删除一揽子承诺文案（"改动会立即写入配置并自动备份"）。
 *  4. LlmProfileManager 重排：先展示已有配置与使用情况，再给显式「添加模型配置」按钮
 *     （非常开表单）；添加与绑定是两步有意操作；绑定表用可读名而非裸 ID；探针/动作平实；
 *     请求失败或切标签时草稿不丢。
 *  5. 查询键兼容：?tab=about 等全部保留；about 显示名改为「版本与升级」。
 *
 * 注：vitest environment 为 node，组件用 renderToStaticMarkup 渲染（effect 不执行），
 * 首屏默认处于 loading 态，正好用来验证「首屏不该恒定报平安」。
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App } from "antd";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage } from "../src/pages/settings/SettingsPage.js";
import {
  resolveCategoryKey,
  SETTINGS_CATEGORIES,
  SettingsCategoryNav,
} from "../src/pages/settings/SettingsCategoryNav.js";
import { SourceStatusBar } from "../src/pages/settings/SourceStatusBar.js";
import { LlmProfileManager, addDraftStore } from "../src/pages/settings/LlmProfileManager.js";
import { createInitialSources } from "../src/pages/settings/helpers.js";

/** 包一层 antd <App>（提供 message 上下文）+ MemoryRouter（SettingsPage 依赖路由）。 */
function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    React.createElement(App, null, React.createElement(MemoryRouter, null, node)),
  );
}

describe("① 首屏不再恒定报平安", () => {
  it("不渲染恒定在线的结论横幅（管家在线 / 各项设置实时生效）", () => {
    const html = render(React.createElement(SettingsPage));
    expect(html).not.toContain("管家在线");
    expect(html).not.toContain("各项设置实时生效");
  });

  it("不再常驻数据源状态概览 Card（旧 aria-label 已移除）", () => {
    const html = render(React.createElement(SettingsPage));
    expect(html).not.toContain("数据源状态概览");
  });

  it("数据源诊断收进默认折叠的 <details>（首屏不展开占用）", () => {
    const html = render(React.createElement(SettingsPage));
    // 折叠区存在，且默认不带 open 属性（收起）。
    expect(html).toMatch(/<details[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*\bopen\b[^>]*>/);
    expect(html).toContain("<summary>");
  });
});

describe("② 措辞诚实", () => {
  it("就绪数据源标注「已更新（时间）」，绝不写「正常 / 业务正常」", () => {
    const sources = createInitialSources();
    sources.backups = {
      status: "ready",
      data: {
        watchReachable: true,
        items: [],
        status: { enabled: true, lastFullAt: null, lastMemoryAt: null, hourlyTickMs: 3600_000 },
      },
    };
    const html = renderToStaticMarkup(
      React.createElement(SourceStatusBar, {
        sources,
        checkedAt: { backups: new Date("2026-09-13T08:30:00.000Z").getTime() },
      }),
    );
    expect(html).toContain("已更新");
    expect(html).not.toContain("业务正常");
    // 状态概览里不应再出现把降级/读不到说成「正常」的口吻。
    expect(html).not.toMatch(/>正常</);
  });

  it("失败数据源显示可重试错误（重试按钮存在）", () => {
    const sources = createInitialSources();
    sources.backups = { status: "failed", reason: "watch-unreachable" };
    const onRetry = vi.fn();
    const html = renderToStaticMarkup(
      React.createElement(SourceStatusBar, { sources, onRetry }),
    );
    expect(html).toContain("未更新");
    expect(html).toContain("重试");
  });

  it("页面不含一揽子承诺文案", () => {
    const html = render(React.createElement(SettingsPage));
    expect(html).not.toContain("改动会立即写入配置并自动备份");
  });
});

describe("⑤ 关于分类改名与查询键兼容", () => {
  it("about 显示名改为「版本与升级」", () => {
    const about = SETTINGS_CATEGORIES.find((c) => c.key === "about");
    expect(about).toBeDefined();
    expect(about!.label).toBe("版本与升级");
  });

  it("所有历史 ?tab= 键仍映射到对应分类", () => {
    for (const category of SETTINGS_CATEGORIES) {
      expect(resolveCategoryKey(category.key)).toBe(category.key);
    }
    // about 仍是合法深链值。
    expect(resolveCategoryKey("about")).toBe("about");
  });

  it("未知 tab 回落到第一个分类（本机安全）", () => {
    expect(resolveCategoryKey("does-not-exist")).toBe(SETTINGS_CATEGORIES[0].key);
    expect(resolveCategoryKey(null)).toBe(SETTINGS_CATEGORIES[0].key);
  });

  it("导航渲染「版本与升级」而非「关于」", () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsCategoryNav, { active: "about", onSelect: () => undefined }),
    );
    expect(html).toContain("版本与升级");
    expect(html).not.toContain(">关于<");
  });
});

describe("④ 模型管理重排", () => {
  it("先展示已有配置，再给显式「添加模型配置」按钮（表单默认不展开）", () => {
    const html = render(React.createElement(LlmProfileManager));
    // 已有配置表（列头）先于添加按钮存在。
    expect(html).toContain("提供商 / 模型");
    expect(html).toContain("添加模型配置");
    // 表单默认未展开：提交按钮与端点输入框不应在默认首屏 DOM 中。
    expect(html).not.toContain("保存并测试连接");
    expect(html).not.toContain("https://api.example.com/v1");
  });

  it("添加模型与高级绑定是两步有意操作：绑定有独立按钮且默认未展开", () => {
    const html = render(React.createElement(LlmProfileManager));
    expect(html).toContain("添加绑定");
    // 绑定表单默认未展开。
    expect(html).not.toContain("建立绑定");
  });

  it("绑定表用可读名而非裸 profileId，范围保持精确", () => {
    const html = render(
      React.createElement(LlmProfileManager, {
        seed: {
          profiles: [
            {
              profileId: "prof_raw_123",
              instanceId: "hermes-main",
              provider: "DeepSeek",
              protocol: "openai-compatible",
              endpoint: "https://api.deepseek.com/v1",
              model: "deepseek-chat",
              status: "active",
              maskedKey: "sk-***",
              bindingCount: 1,
              probe: { status: "pass", category: "model", detail: "ok", checkedAt: "2026-09-13T08:00:00.000Z" },
            },
          ],
          bindings: [
            {
              bindingId: "bind_1",
              scope: "instance",
              instanceId: "hermes-main",
              frameworkId: "hermes",
              targetRef: null,
              profileId: "prof_raw_123",
            },
          ],
          status: {
            vault: { available: true },
            profiles: 1,
            activeProfiles: 1,
            bindings: 1,
            activeBindings: 1,
            ready: true,
            blocked: [],
          },
          discovered: [],
        },
      }),
    );
    // 可读名可见。
    expect(html).toContain("DeepSeek · deepseek-chat");
    // 探针动作用平实文案。
    expect(html).toContain("测试连接");
    // 范围精确保留。
    expect(html).toContain("instance");
  });

  it("请求失败或切标签时草稿不丢：模块级草稿在重挂载后恢复", () => {
    // 模拟用户已展开添加表单并填了一部分。
    addDraftStore.open = true;
    addDraftStore.values = {
      provider: "DeepSeek",
      protocol: "openai-compatible",
      endpoint: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKey: "sk-test",
    };
    try {
      const html = render(React.createElement(LlmProfileManager));
      // 表单因草稿 open 而展开，且恢复出已填的提供商（model 草稿一并持久）。
      expect(html).toContain("保存并测试连接");
      expect(html).toContain("DeepSeek");
      expect(html).toContain("deepseek-chat");
    } finally {
      // 清理，避免影响其它用例。
      addDraftStore.open = false;
      addDraftStore.values = {};
    }
  });
});
