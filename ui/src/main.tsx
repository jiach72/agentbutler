/**
 * 面板入口：挂载路由表（6 页面 + Layout 布局）并引入全局样式。
 * 主题真源见 theme/tokens.ts；AntdApp 提供主题内联的 message/modal 通道。
 */
import React, { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { App as AntdApp, ConfigProvider } from "antd";
import * as zhCNNamespace from "antd/es/locale/zh_CN.js";
import "antd/dist/reset.css";
import { AccessGate } from "./components/AccessGate.js";
import { Layout } from "./components/Layout.js";
import { PageProgress } from "./components/PageProgress.js";
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
const VersionsPage = lazy(() => import("./pages/Versions.js").then(({ VersionsPage: Page }) => ({ default: Page })));
const LogsPage = lazy(() => import("./pages/Logs.js").then(({ LogsPage: Page }) => ({ default: Page })));
const AssetsPage = lazy(() => import("./pages/Assets.js").then(({ AssetsPage: Page }) => ({ default: Page })));
const TroubleshootPage = lazy(() => import("./pages/troubleshoot/TroubleshootPage.js").then(({ TroubleshootPage: Page }) => ({ default: Page })));
const SetupPage = lazy(() => import("./pages/setup/SetupPage.js").then(({ SetupPage: Page }) => ({ default: Page })));
const CoreFilesPage = lazy(() => import("./pages/CoreFilesPage.js").then(({ CoreFilesPage: Page }) => ({ default: Page })));

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
          <Suspense fallback={<PageProgress title="正在打开页面" detail="本机资源正在加载。" compact indeterminate />}>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/versions" element={<VersionsPage />} />
                <Route path="/gateway" element={<GatewayPage />} />
                <Route path="/evolution" element={<EvolutionPage />} />
                <Route path="/recovery" element={<Navigate to="/troubleshoot" replace />} />
                <Route path="/troubleshoot" element={<TroubleshootPage />} />
                <Route path="/setup" element={<SetupPage />} />
                <Route path="/logs" element={<LogsPage />} />
                <Route path="/assets" element={<AssetsPage />} />
                <Route path="/prompt" element={<Navigate to="/gateway" replace />} />
                <Route path="/skills" element={<SkillsPage />} />
                <Route path="/core-files" element={<CoreFilesPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/preferences" element={<Navigate to="/settings" replace />} />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  );
}
