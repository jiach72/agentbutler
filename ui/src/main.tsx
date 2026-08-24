/**
 * 面板入口：挂载路由表（6 页面 + Layout 布局）并引入全局样式。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { DashboardPage } from "./pages/Dashboard.js";
import { EvolutionPage } from "./pages/Evolution.js";
import { GatewayPage } from "./pages/Gateway.js";
import { SettingsPage } from "./pages/Settings.js";
import { SkillsPage } from "./pages/Skills.js";
import { VersionsPage } from "./pages/Versions.js";
import "./styles.css";

const el = document.getElementById("root");

if (el) {
  createRoot(el).render(
    <StrictMode>
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
    </StrictMode>,
  );
}
