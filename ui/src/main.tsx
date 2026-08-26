/**
 * 面板入口：挂载路由表（6 页面 + Layout 布局）并引入全局样式。
 * 主题真源见 theme/tokens.ts；AntdApp 提供主题内联的 message/modal 通道。
 */
import React from "react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { App as AntdApp, ConfigProvider } from "antd";
import * as zhCNNamespace from "antd/es/locale/zh_CN.js";
import "antd/dist/reset.css";
import { Layout } from "./components/Layout.js";
import { DashboardPage } from "./pages/Dashboard.js";
import { EvolutionPage } from "./pages/Evolution.js";
import { GatewayPage } from "./pages/Gateway.js";
import { SettingsPage } from "./pages/Settings.js";
import { SkillsPage } from "./pages/Skills.js";
import { VersionsPage } from "./pages/Versions.js";
import { ThemeProvider, antdThemeFor, useTheme } from "./theme/ThemeProvider.js";
import { initialThemeMode, applyThemeCssBridge } from "./theme/tokens.js";
import "./styles.css";

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
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/versions" element={<VersionsPage />} />
              <Route path="/gateway" element={<GatewayPage />} />
              <Route path="/evolution" element={<EvolutionPage />} />
              <Route path="/prompt" element={<Navigate to="/gateway" replace />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  );
}
