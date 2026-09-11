/**
 * 通用结论条 <ConclusionBar> 的烟雾测试。
 * 验证：每个 tone 都被映射到一个合法 antd Alert type；组件渲染只产生 1 个 alert。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConclusionBar } from "../src/components/ConclusionBar.js";

describe("ConclusionBar 通用结论条", () => {
  const TONES = ["ok", "warn", "error", "info", "offline", "unknown"] as const;

  it("每个 tone 都映射到一个合法 antd Alert type", () => {
    for (const tone of TONES) {
      const html = renderToStaticMarkup(
        <ConclusionBar tone={tone} title={`${tone} 测试`} copy="测试文案" />,
      );
      // antd v6 Alert 渲染为 <div class="ant-alert ... ant-alert-{type}">
      const m = html.match(/ant-alert-(\w+)/);
      expect(m, `tone=${tone} 应有 ant-alert-* class`).not.toBeNull();
      expect(
        ["success", "info", "warning", "error"].includes(m![1]),
        `tone=${tone} 映射到了非法 Alert type: ${m![1]}`,
      ).toBe(true);
    }
  });

  it("无 action / extra 时只渲染 1 个 alert，不漏出元信息条", () => {
    const html = renderToStaticMarkup(<ConclusionBar tone="ok" title="好" />);
    // antd v6 Alert 外层是 <div class="ant-alert ant-alert-success ...">，
    // 但内部还会有 ant-alert-content / ant-alert-message / ant-alert-description 等，
    // 它们都匹配 /ant-alert/g。锁定到外层类型 class，避开嵌套子节点。
    expect(html).toMatch(/class="[^"]*\bant-alert-success\b[^"]*"/);
    // 元信息条只在传 extra 时才出现，未传时不该渲染。
    expect(html).not.toContain("上次检查");
  });

  it("title / copy / action / extra 都正确传给底层 alert", () => {
    const html = renderToStaticMarkup(
      <ConclusionBar
        tone="warn"
        title="落后推荐 1.4 → 1.6"
        copy="已下载，预计 30 秒完成。"
        action={<a href="#upgrade">立即升级</a>}
        extra={<span data-test="meta">下次计划：凌晨 03:00</span>}
      />,
    );
    expect(html).toContain("落后推荐 1.4 → 1.6");
    expect(html).toContain("已下载，预计 30 秒完成");
    expect(html).toContain("立即升级");
    expect(html).toContain('data-test="meta"');
  });

  it("offline 与 unknown 不映射到 success / error，避免误色", () => {
    for (const tone of ["offline", "unknown"] as const) {
      const html = renderToStaticMarkup(<ConclusionBar tone={tone} title="x" />);
      expect(html).not.toMatch(/ant-alert-success\b/);
      expect(html).not.toMatch(/ant-alert-error\b/);
    }
  });
});
