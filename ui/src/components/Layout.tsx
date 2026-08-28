/**
 * 应用外壳：左侧固定导航（图标 + 双行文案，底部安全区说明）+ 顶栏（页题、通知、主题切换）
 * + 右侧内容路由出口。移动端侧栏收进 Drawer。
 */
import {
  ApiOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  DashboardOutlined,
  FileTextOutlined,
  MenuOutlined,
  MoonOutlined,
  NotificationOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  SunOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { Button, Drawer } from "antd";
import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { NotificationCenter } from "./NotificationCenter.js";
import { NotificationsProvider } from "../hooks/useNotifications.js";
import { useTheme } from "../theme/ThemeProvider.js";

const NAV_ITEMS = [
  { to: "/dashboard", icon: <DashboardOutlined />, label: "首页", note: "运行总览与一键检查" },
  { to: "/versions", icon: <CloudUploadOutlined />, label: "版本管理", note: "升级前自动备份" },
  { to: "/gateway", icon: <NotificationOutlined />, label: "消息通知", note: "频率控制与送达记录" },
  { to: "/evolution", icon: <ThunderboltOutlined />, label: "改进与优化", note: "日志分析与变更评估" },
  { to: "/skills", icon: <ApiOutlined />, label: "技能与记忆", note: "技能、插件与记忆" },
  { to: "/recovery", icon: <ToolOutlined />, label: "诊断与修复", note: "诊断结果与处理" },
  { to: "/logs", icon: <FileTextOutlined />, label: "系统日志", note: "错误证据与修复建议" },
  { to: "/assets", icon: <DatabaseOutlined />, label: "技能资产", note: "使用情况与来源" },
];

const SETTINGS_ITEM = {
  to: "/settings",
  icon: <SettingOutlined />,
  label: "设置",
  note: "本机安全、备份与偏好",
};

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          管
        </span>
        <span className="brand-copy">
          Agent Butler
          <small>本地运维控制台</small>
        </span>
      </div>
      <nav className="nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
          >
            <span className="nav-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="nav-copy">
              <strong>{item.label}</strong>
              <small>{item.note}</small>
            </span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <NavLink
          to={SETTINGS_ITEM.to}
          onClick={onNavigate}
          className={({ isActive }) => `nav-link nav-link-preferences${isActive ? " active" : ""}`}
        >
          <span className="nav-icon" aria-hidden="true">
            {SETTINGS_ITEM.icon}
          </span>
          <span className="nav-copy">
            <strong>{SETTINGS_ITEM.label}</strong>
            <small>{SETTINGS_ITEM.note}</small>
          </span>
        </NavLink>
        <div className="sidebar-meta">
          <SafetyCertificateOutlined aria-hidden="true" />
          <span>
            仅本机访问
            <small>数据只保存在你的电脑上</small>
          </span>
        </div>
      </div>
    </>
  );
}

export function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { mode, toggleMode } = useTheme();
  const location = useLocation();
  const currentPage = location.pathname.startsWith(SETTINGS_ITEM.to) ||
      location.pathname.startsWith("/preferences")
    ? SETTINGS_ITEM
    : NAV_ITEMS.find((item) => location.pathname.startsWith(item.to)) ?? NAV_ITEMS[0];
  const themeLabel = mode === "dark" ? "切换到亮色主题" : "切换到暗色主题";

  return (
    <NotificationsProvider>
      <a className="skip-link" href="#main-content">
        跳到主内容
      </a>
      <div className="app">
        <aside className="sidebar sidebar-desktop">
          <SidebarContent />
        </aside>
        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          placement="left"
          width={280}
          title="Agent Butler"
          className="mobile-nav-drawer"
        >
          <div className="sidebar sidebar-mobile">
            <SidebarContent onNavigate={() => setDrawerOpen(false)} />
          </div>
        </Drawer>
        <div className="main">
          <header className="app-topbar">
            <div className="topbar-leading">
              <Button
                className="mobile-menu-button"
                type="text"
                icon={<MenuOutlined />}
                aria-label="打开导航"
                onClick={() => setDrawerOpen(true)}
              />
              <strong className="topbar-title">{currentPage.label}</strong>
              <span className="topbar-brand">Agent Butler · 本地运维控制台</span>
            </div>
            <div className="topbar-actions">
              <span className="topbar-note">只在你的电脑上运行</span>
              <NotificationCenter />
              <Button
                type="text"
                className="theme-toggle"
                aria-label={themeLabel}
                title={themeLabel}
                icon={mode === "dark" ? <SunOutlined /> : <MoonOutlined />}
                onClick={toggleMode}
              />
            </div>
          </header>
          <main className="content" id="main-content">
            <Outlet />
          </main>
        </div>
      </div>
    </NotificationsProvider>
  );
}
