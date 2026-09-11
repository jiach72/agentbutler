/**
 * 阶段 3（组件层统一）验收测试。
 *
 * 规范依据 docs/brand/03 §3.2（徽标 tone 全集与样式）、§3.7（危险弹窗必填四项 + 高危勾选）、
 * §3.9（空态三件套）、§3.11（高级详情记忆）、§1 P3（AI 内容必须标注来源）。
 *
 * 说明：本包测试环境是 node（无 jsdom），antd Modal 需要 DOM 才能渲染，
 * 所以 DangerConfirmModal 用**源码契约扫描**验证（必填 props / 勾选 / 禁用逻辑），
 * 其余纯展示组件用 renderToStaticMarkup 做真实渲染断言。
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StatusBadge, TONE_TITLE } from "../src/components/StatusBadge.js";
import type { SemanticTone } from "../src/components/StatusBadge.js";
import { Empty } from "../src/components/Empty.js";
import { AiGeneratedNotice } from "../src/components/AiGeneratedNotice.js";
import { } from "../src/components/StatStrip.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** 递归读取 src 下所有 .ts/.tsx 源码（含文件名）。 */
function readAllSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const abs = `${dir}${name}`;
      const childRel = `${rel}${name}`;
      if (statSync(abs).isDirectory()) walk(`${abs}/`, `${childRel}/`);
      else if (/\.(ts|tsx)$/.test(name)) out.push({ file: childRel, text: readFileSync(abs, "utf8") });
    }
  };
  walk(SRC, "");
  return out;
}

const SOURCES = readAllSources();

describe("徽标语义 tone 收敛为规范定义的 6 种", () => {
  it("tone 全集恰好是 ok / warn / error / offline / unknown / brand", () => {
    expect(Object.keys(TONE_TITLE).sort()).toEqual(
      ["brand", "error", "offline", "ok", "unknown", "warn"].sort(),
    );
  });

  it("不再存在 v1.2 的 muted / info / pulse（含 pulse 的紫色已从色板外剔除）", () => {
    const offenders: string[] = [];
    for (const { file, text } of SOURCES) {
      // ConclusionBar 的 ConclusionTone 合法包含 info（对应 antd Alert info，
      // 阶段 4C 设计决定：结论条是陈述语义，徽标才是 6 档状态语义）。
      // 因此本断言只约束**徽标域**：排除引入 ConclusionBar 的文件里的 info。
      const usesConclusionBar = /from\s+"[^"]*ConclusionBar\.js"/.test(text);
      const banned = usesConclusionBar ? /(muted|pulse)/ : /(muted|info|pulse)/;
      // 只找 tone 字面量，不误伤注释与迁移对照表里对这些旧名字的说明。
      if (new RegExp(`tone[:=]\\s*["'](${banned.source})["']`).test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("状态 tone 必须渲染文字标签，不允许只有色点", () => {
    const tones: SemanticTone[] = ["ok", "warn", "error", "offline", "unknown", "brand"];
    for (const tone of tones) {
      const html = renderToStaticMarkup(
        React.createElement(StatusBadge, { tone, label: "标签文字" }),
      );
      expect(html).toContain("标签文字");
      expect(html).toContain(`data-tone="${tone}"`);
    }
  });

  it("状态类 tone 带状态图标（颜色 + 图标 + 文字三者齐备），brand 作为标记不带图标", () => {
    for (const tone of ["ok", "warn", "error", "offline", "unknown"] as SemanticTone[]) {
      const html = renderToStaticMarkup(React.createElement(StatusBadge, { tone, label: "x" }));
      expect(html, `${tone} 应带状态图标`).toContain("<svg");
    }
    const brandHtml = renderToStaticMarkup(
      React.createElement(StatusBadge, { tone: "brand", label: "推荐" }),
    );
    expect(brandHtml).not.toContain("<svg");
  });
});

describe("空态三件套（§3.9）", () => {
  it("渲染一句结论 + 一句怎么做 + 一个按钮", () => {
    const html = renderToStaticMarkup(
      React.createElement(Empty, {
        title: "还没有备份",
        hint: "升级或回滚前，管家会自动做一次",
        action: React.createElement("button", { type: "button" }, "现在做一次备份"),
      }),
    );
    expect(html).toContain("还没有备份");
    expect(html).toContain("升级或回滚前，管家会自动做一次");
    expect(html).toContain("现在做一次备份");
  });

  it("默认带品牌角色插画，且不出现「暂无数据」这种敷衍文案", () => {
    const html = renderToStaticMarkup(React.createElement(Empty, { title: "还没有记录" }));
    expect(html).toContain("brand-mascot");
    expect(html).not.toContain("暂无数据");
  });
});

describe("AI 生成内容必须标注来源（§1 P3）", () => {
  it("输出「由模型生成 · 未经人工确认」", () => {
    const html = renderToStaticMarkup(React.createElement(AiGeneratedNotice, {}));
    expect(html).toContain("由模型生成");
    expect(html).toContain("未经人工确认");
  });

  it("支持补充说明，且不使用状态色（来源不是好坏）", () => {
    const html = renderToStaticMarkup(
      React.createElement(AiGeneratedNotice, { detail: "请自行判断后再采纳", compact: true }),
    );
    expect(html).toContain("请自行判断后再采纳");
    expect(html).toContain("is-compact");
    expect(html).not.toContain("data-tone");
  });
});

describe("数值卡不再出现硬编码色值（§6 验收第 1 条）", () => {
  it("StatStrip 的 tone 取色全部走 brand 变量", () => {
    const statStrip = SOURCES.find((s) => s.file === "components/StatStrip.tsx");
    expect(statStrip).toBeDefined();
    expect(statStrip!.text).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(statStrip!.text).toContain("--ab-ok");
    expect(statStrip!.text).toContain("--ab-brand");
  });
});

describe("危险确认弹窗四项必填 + 高危勾选（§3.7）", () => {
  const modal = SOURCES.find((s) => s.file === "components/DangerConfirmModal.tsx");

  it("影响范围 / 能否撤回 / 耗时 三项都是必填 prop（不是可选）", () => {
    expect(modal).toBeDefined();
    const text = modal!.text;
    for (const field of ["impact", "reversible", "duration"]) {
      // 必填：形如 `field: React.ReactNode;`，不能带 `?`
      expect(text, `${field} 必须必填`).toMatch(new RegExp(`\\b${field}:\\s*React\\.ReactNode;`));
      expect(text, `${field} 不应是可选项`).not.toMatch(new RegExp(`\\b${field}\\?:`));
    }
  });

  it("高危操作渲染手动勾选框，且未勾选时确认按钮禁用", () => {
    const text = modal!.text;
    expect(text).toContain("acknowledge");
    expect(text).toMatch(/needAck\s*&&/); // 条件渲染勾选框
    expect(text).toMatch(/blocked\s*=/); // 未勾选即 blocked
    expect(text).toMatch(/disabled:\s*blocked/); // 落到确认按钮上
    expect(text).toContain("<Checkbox");
  });

  it("每次打开都重置勾选状态（避免上次的勾选被顺手带进来）", () => {
    expect(modal!.text).toMatch(/if\s*\(open\)\s*setAcknowledged\(false\)/);
  });
});

describe("状态不再只靠颜色表达（§1 P3 / §6）", () => {
  it("三个原先只有色点的裸 antd Badge 已全部替换", () => {
    for (const file of [
      "pages/dashboard/InstanceHealthCard.tsx",
      "pages/dashboard/IssuesSection.tsx",
      "pages/settings/SecurityBaseline.tsx",
    ]) {
      const src = SOURCES.find((s) => s.file === file);
      expect(src, file).toBeDefined();
      expect(src!.text, `${file} 不应再出现裸 <Badge`).not.toMatch(/<Badge\s/);
      expect(src!.text, `${file} 应使用 StatusBadge`).toContain("StatusBadge");
    }
  });
});

describe("高级详情记忆展开状态（§3.11）", () => {
  it("按页面把展开状态写进 localStorage", () => {
    const src = SOURCES.find((s) => s.file === "components/AdvancedDetails.tsx");
    expect(src).toBeDefined();
    expect(src!.text).toContain("butler.advanced-details.");
    expect(src!.text).toContain("localStorage");
    // 隐私模式下 localStorage 会抛错，必须兜底
    expect(src!.text).toMatch(/try\s*\{[\s\S]*?catch\s*\{/);
  });
});
