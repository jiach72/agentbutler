/**
 * 面板入口：挂载路由表（6 页面 + Layout 布局）并引入全局样式。
 * 主题真源见 theme/tokens.ts；AntdApp 提供主题内联的 message/modal 通道。
 */
import React, { lazy, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { App as AntdApp, ConfigProvider } from "antd";
import * as zhCNNamespace from "antd/es/locale/zh_CN.js";
import "antd/dist/reset.css";
import { AccessGate } from "./components/AccessGate.js";
import { Layout } from "./components/Layout.js";
import { isSetupCompleted } from "./pages/setup/state.js";
import { loadJson } from "./lib/api.js";
import { ThemeProvider, antdThemeFor, useTheme } from "./theme/ThemeProvider.js";
import { initialThemeMode, applyThemeCssBridge } from "./theme/tokens.js";
import "./styles.css";

const DashboardPage = lazy(() => import("./pages/dashboard/DashboardPage.js").then(({ DashboardPage: Page }) => ({ default: Page })));
const EvolutionPage = lazy(() => import("./pages/evolution/EvolutionPage.js").then(({ EvolutionPage: Page }) => ({ default: Page })));
const GatewayPage = lazy(() => import("./pages/gateway/GatewayPage.js").then(({ GatewayPage: Page }) => ({ default: Page })));
const SettingsPage = lazy(() => import("./pages/settings/SettingsPage.js").then(({ SettingsPage: Page }) => ({ default: Page })));
const SkillsPage = lazy(() => import("./pages/skills/SkillsPage.js").then(({ SkillsPage: Page }) => ({ default: Page })));
const LogsPage = lazy(() => import("./pages/Logs.js").then(({ LogsPage: Page }) => ({ default: Page })));
const TroubleshootPage = lazy(() => import("./pages/troubleshoot/TroubleshootPage.js").then(({ TroubleshootPage: Page }) => ({ default: Page })));
const SetupPage = lazy(() => import("./pages/setup/SetupPage.js").then(({ SetupPage: Page }) => ({ default: Page })));
const CoreFilesPage = lazy(() => import("./pages/CoreFilesPage.js").then(({ CoreFilesPage: Page }) => ({ default: Page })));
const WallPage = lazy(() => import("./pages/wall/WallPage.js").then(({ WallPage: Page }) => ({ default: Page })));
const CostPage = lazy(() => import("./pages/cost/CostPage.js").then(({ CostPage: Page }) => ({ default: Page })));
const AuditPage = lazy(() => import("./pages/audit/AuditPage.js").then(({ AuditPage: Page }) => ({ default: Page })));
const EventsPage = lazy(() => import("./pages/events/EventsPage.js").then(({ EventsPage: Page }) => ({ default: Page })));
const ReportPage = lazy(() => import("./pages/report/ReportPage.js").then(({ ReportPage: Page }) => ({ default: Page })));
const SessionsPage = lazy(() => import("./pages/sessions/SessionsPage.js").then(({ SessionsPage: Page }) => ({ default: Page })));
const SessionDetailPage = lazy(() => import("./pages/sessions/SessionDetailPage.js").then(({ SessionDetailPage: Page }) => ({ default: Page })));
const ApprovalsPage = lazy(() => import("./pages/approvals/ApprovalsPage.js").then(({ ApprovalsPage: Page }) => ({ default: Page })));
const ApprovalDetailPage = lazy(() => import("./pages/approvals/ApprovalDetailPage.js").then(({ ApprovalDetailPage: Page }) => ({ default: Page })));
const CanaryPage = lazy(() => import("./pages/canary/CanaryPage.js").then(({ CanaryPage: Page }) => ({ default: Page })));
const ProgressPage = lazy(() => import("./pages/progress/ProgressPage.js").then(({ ProgressPage: Page }) => ({ default: Page })));
const MemoryDiffPage = lazy(() => import("./pages/memory/MemoryDiffPage.js").then(({ MemoryDiffPage: Page }) => ({ default: Page })));
const FederationPage = lazy(() => import("./pages/federation/FederationPage.js").then(({ FederationPage: Page }) => ({ default: Page })));

function FirstRunRedirect() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (location.pathname === "/setup") return;
    let cancelled = false;
    void loadJson<{ configured?: boolean }>("/api/setup/status", 8_000).then((result) => {
      if (!cancelled && result.ok && result.data.configured !== true && !isSetupCompleted()) {
        navigate("/setup", { replace: true });
      }
    });
    return () => { cancelled = true; };
  }, [location.pathname, navigate]);
  return null;
}

const initialMode = initialThemeMode(
  getLocalStorage(),
  typeof window === "undefined" ? undefined : (query) => window.matchMedia(query),
);
applyThemeCssBridge(initialMode);

function getLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * antd v6 的 locale 子路径在 NodeNext + 声明输出模式下默认导出解析异常：
 * 运行时兼容 CJS/ESM 两种互操作形态，再显式收窄到 ConfigProvider 的 locale 类型。
 */
const zhCNRaw = zhCNNamespace as { default?: unknown };
const zhCNValue = zhCNRaw.default ?? zhCNNamespace;
const zhCN = zhCNValue as React.ComponentProps<typeof ConfigProvider>["locale"];

const el = document.getElementById("root");

if (el) {
  createRoot(el).render(
    <StrictMode>
      <ThemeProvider>
        <ThemedApp locale={zhCN} />
      </ThemeProvider>
    </StrictMode>,
  );
}

function ThemedApp({ locale }: { locale: React.ComponentProps<typeof ConfigProvider>["locale"] }) {
  const { mode } = useTheme();
  return (
    <ConfigProvider locale={locale} theme={antdThemeFor(mode)}>
      <AntdApp>
        <AccessGate />
        <BrowserRouter>
          <FirstRunRedirect />
          {/* Suspense 由 Layout 在 <Outlet /> 处接管：懒加载页首载只换内容区，
              不再整树卸载 Layout（其 Drawer/Popover 等 Portal 容器保持稳定，
              避免 React 19 提交删除阶段与 rc-motion 动画的 removeChild 竞态）。 */}
          <Routes>
            {/* /wall 大屏：全屏只读结论层，不进 Layout（无侧栏顶栏），画布自身等比缩放。 */}
            <Route path="/wall" element={<WallPage />} />
            <Route element={<Layout />}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/versions" element={<Navigate to="/settings?tab=about" replace />} />
              <Route path="/gateway" element={<GatewayPage />} />
              <Route path="/evolution" element={<EvolutionPage />} />
              <Route path="/recovery" element={<Navigate to="/troubleshoot" replace />} />
              <Route path="/assets" element={<Navigate to="/skills" replace />} />
              <Route path="/troubleshoot" element={<TroubleshootPage />} />              <Route path="/setup" element={<SetupPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/prompt" element={<Navigate to="/gateway" replace />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/core-files" element={<CoreFilesPage />} />
              {/* 信任层（Trust Layer）：成本 / 行为审计 / 事件中心 / Agent 周报 */}
              <Route path="/cost" element={<CostPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/events" element={<EventsPage />} />
              <Route path="/report" element={<ReportPage />} />
              <Route path="/sessions" element={<SessionsPage />} />
              <Route path="/sessions/:id" element={<SessionDetailPage />} />
              <Route path="/approvals" element={<ApprovalsPage />} />
              <Route path="/approvals/:id" element={<ApprovalDetailPage />} />
              <Route path="/canary" element={<CanaryPage />} />
              <Route path="/progress" element={<ProgressPage />} />
              <Route path="/memory-diff" element={<MemoryDiffPage />} />
              <Route path="/federation" element={<FederationPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/preferences" element={<Navigate to="/settings" replace />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  );
}
