/**
 * 应用外壳：左侧固定导航（图标 + 双行文案，底部安全区说明）+ 顶栏（页题、通知、主题切换）
 * + 右侧内容路由出口。移动端侧栏收进 Drawer。
 */
import {
  DashboardOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  MenuOutlined,
  MoonOutlined,
  NotificationOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  SunOutlined,
  ApiOutlined,
  QuestionCircleOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { Button, Drawer } from "antd";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { NotificationCenter } from "./NotificationCenter.js";
import { NotificationsProvider } from "../hooks/useNotifications.js";
import { useTheme } from "../theme/ThemeProvider.js";
import { loadJson } from "../lib/api.js";
import type { SecurityBaselinePayload } from "../pages/settings/helpers.js";

const NAV_ITEMS = [
  { to: "/dashboard", icon: <DashboardOutlined />, label: "首页", note: "运行总览与一键检查" },
  { to: "/skills", icon: <ApiOutlined />, label: "智能体与知识", note: "技能、插件与记忆" },
  { to: "/gateway", icon: <NotificationOutlined />, label: "消息通知", note: "频率控制与送达记录" },
  { to: "/troubleshoot", icon: <QuestionCircleOutlined />, label: "排查问题", note: "查原因并安全修复" },
];

const MANAGEMENT_ITEMS = [
  { to: "/versions", icon: <CloudUploadOutlined />, label: "版本升级", note: "更新、备份与回滚" },
  { to: "/evolution", icon: <ThunderboltOutlined />, label: "自进化", note: "分析日志与优化方案" },
  { to: "/assets", icon: <DatabaseOutlined />, label: "GitHub 技能管理", note: "发现、安装与使用统计" },
];

const ALL_NAV_ITEMS = [...NAV_ITEMS, ...MANAGEMENT_ITEMS];

const SETTINGS_ITEM = {
  to: "/settings",
  icon: <SettingOutlined />,
  label: "设置",
  note: "本机安全、备份与偏好",
};

/**
 * 侧栏底部那句「仅本机访问」必须来自真实监听地址。
 * 读不到数据时显示"读取中"而不是默认宣称安全 —— 不确定的时候不能装作确定。
 */
function baselineTone(baseline: SecurityBaselinePayload | null): "ok" | "warn" | "error" {
  if (baseline === null) return "warn";
  if (baseline.loopback) return "ok";
  return baseline.auth ? "warn" : "error";
}

function baselineTitle(baseline: SecurityBaselinePayload | null): string {
  if (baseline === null) return "正在读取访问方式";
  if (baseline.loopback) return "仅本机访问";
  return baseline.auth ? "同一网络可访问" : "任何人都可以访问";
}

function baselineNote(baseline: SecurityBaselinePayload | null): string {
  if (baseline === null) return "稍等一下";
  if (baseline.loopback) {
    return baseline.auth ? "数据只保存在你的电脑上，已设置访问口令" : "数据只保存在你的电脑上";
  }
  return baseline.auth
    ? "已用访问口令保护，请确认你信任当前网络"
    : "没有访问口令，同一网络的人都能操作你的 AI，请尽快处理";
}

function SidebarContent({
  onNavigate,
  baseline,
}: {
  onNavigate?: () => void;
  baseline: SecurityBaselinePayload | null;
}) {
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
        {MANAGEMENT_ITEMS.map((item) => (
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
        <div className={`sidebar-meta${baselineTone(baseline) !== "ok" ? ` is-${baselineTone(baseline)}` : ""}`}>
          <SafetyCertificateOutlined aria-hidden="true" />
          <span>
            {baselineTitle(baseline)}
            <small>{baselineNote(baseline)}</small>
          </span>
        </div>
      </div>
    </>
  );
}

export function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [baseline, setBaseline] = useState<SecurityBaselinePayload | null>(null);
  const { mode, toggleMode } = useTheme();
  const location = useLocation();

  useEffect(() => {
    let alive = true;
    void loadJson<SecurityBaselinePayload>("/api/security-baseline", 6_000).then((result) => {
      if (alive && result.ok) setBaseline(result.data);
    });
    return () => {
      alive = false;
    };
  }, []);
  const currentPage = location.pathname.startsWith(SETTINGS_ITEM.to) ||
      location.pathname.startsWith("/preferences")
    ? SETTINGS_ITEM
    : ALL_NAV_ITEMS.find((item) => location.pathname.startsWith(item.to)) ?? NAV_ITEMS[0];
  const themeLabel = mode === "dark" ? "切换到亮色主题" : "切换到暗色主题";

  return (
    <NotificationsProvider>
      <a className="skip-link" href="#main-content">
        跳到主内容
      </a>
      <div className="app">
        <aside className="sidebar sidebar-desktop">
          <SidebarContent baseline={baseline} />
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
            <SidebarContent onNavigate={() => setDrawerOpen(false)} baseline={baseline} />
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
