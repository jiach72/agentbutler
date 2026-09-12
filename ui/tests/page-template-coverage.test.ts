/**
 * 页面模板覆盖率守卫（评审 P0-2）。
 *
 * 规范 03 §2.3 的页面模板是硬门槛：
 *   1. 页面标题（h1）+ 一句话说明
 *   2. **结论条 / 状态条**  ← 必须有
 *   3. 主内容
 *   4. 高级详情（折叠）
 *
 * 落地前 22 个路由页里有 11 个没有第 2 条——「必须有」写成规范却没人守。
 * 这份测试就是那个守卫：新增路由页若没接结论条，CI 直接红。
 *
 * 例外只有两类，且都必须显式登记：
 *   · 页面自己实现了更丰富的结论块（登记在 BESPOKE_CONCLUSION，测试会校验它确实还在用那个自定义块）；
 *   · 脱离 Layout 的独立大屏（登记在 STANDALONE，全屏只读结论层，本就没有页头）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function source(relativePath: string): string {
  return readFileSync(`${SRC}${relativePath}`, "utf8");
}

/**
 * 路由页 → 承载其结论条的文件（可能委托给子组件）。
 * 键是路由页文件，值里任一个文件出现 `ConclusionBar` 即视为满足模板。
 */
const ROUTE_PAGES: Array<{ route: string; files: string[] }> = [
  { route: "/dashboard", files: ["pages/dashboard/DashboardPage.tsx", "pages/dashboard/HeroConclusion.tsx"] },
  { route: "/skills", files: ["pages/skills/SkillsPage.tsx"] },
  { route: "/gateway", files: ["pages/gateway/GatewayPage.tsx"] },
  { route: "/cost", files: ["pages/cost/CostPage.tsx"] },
  { route: "/report", files: ["pages/report/ReportPage.tsx"] },
  { route: "/sessions", files: ["pages/sessions/SessionsPage.tsx"] },
  { route: "/sessions/:id", files: ["pages/sessions/SessionDetailPage.tsx"] },
  { route: "/memory-diff", files: ["pages/memory/MemoryDiffPage.tsx"] },
  { route: "/audit", files: ["pages/audit/AuditPage.tsx"] },
  { route: "/events", files: ["pages/events/EventsPage.tsx"] },
  { route: "/approvals", files: ["pages/approvals/ApprovalsPage.tsx"] },
  { route: "/approvals/:id", files: ["pages/approvals/ApprovalDetailPage.tsx"] },
  { route: "/progress", files: ["pages/progress/ProgressPage.tsx"] },
  { route: "/federation", files: ["pages/federation/FederationPage.tsx"] },
  { route: "/canary", files: ["pages/canary/CanaryPage.tsx"] },
  { route: "/core-files", files: ["pages/CoreFilesPage.tsx"] },
  { route: "/evolution", files: ["pages/evolution/EvolutionPage.tsx"] },
  { route: "/logs", files: ["pages/Logs.tsx"] },
  { route: "/settings", files: ["pages/settings/SettingsPage.tsx"] },
];

/** 自定义结论块：页面自带更丰富的形态（携带通用结论条装不下的信息），保留但显式登记。 */
const BESPOKE_CONCLUSION: Record<string, { marker: string; reason: string }> = {
  "pages/troubleshoot/steps/TriageOverview.tsx": {
    marker: "ts-result",
    reason: "体检结论块额外承载「最可能的原因」，通用结论条的 copy 装不下这个层级",
  },
  "pages/setup/SetupPage.tsx": {
    marker: "setup-verdict",
    reason: "三环链路体检结论块带每环进度，属页面专有形态",
  },
};

/** 脱离 Layout 的独立大屏：全屏只读结论层，没有页头，不适用页面模板。 */
const STANDALONE = ["pages/wall/WallPage.tsx"];

describe("页面模板：每个路由页都必须有结论条（规范 03 §2.3 ②）", () => {
  it("20 个路由页都能在其自身或委托组件里找到 ConclusionBar", () => {
    const missing: string[] = [];
    for (const page of ROUTE_PAGES) {
      const satisfied = page.files.some((file) => source(file).includes("ConclusionBar"));
      if (!satisfied) missing.push(`${page.route}（检查了 ${page.files.join(" / ")}）`);
    }
    expect(missing).toEqual([]);
  });

  it("例外必须显式登记，且自定义结论块仍然存在（防止例外变成漏网之鱼）", () => {
    for (const [file, spec] of Object.entries(BESPOKE_CONCLUSION)) {
      const text = source(file);
      expect(text, `${file} 的自定义结论块标记 ${spec.marker} 已消失，请改用 ConclusionBar`).toContain(
        spec.marker,
      );
      // 自定义块也不许退回「只有色点」：必须有文案标签
      expect(text).toMatch(/<Text strong/);
    }
  });

  it("独立大屏不套用页面模板，但必须是无需登录即可退出的只读层", () => {
    for (const file of STANDALONE) {
      const text = source(file);
      // 全屏页面必须提供回到主控制台的出口，否则用户会被困住
      expect(text, `${file} 缺少返回控制台的出口`).toContain("/dashboard");
    }
  });
});
