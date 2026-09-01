/**
 * 应用外壳（antd v6 原生）：Layout/Sider/Menu/Header/Content 承担骨架，
 * 导航是 inline Menu（组内嵌 react-router Link，保留真实 <a href> 语义），
 * 移动端侧栏收进 Drawer。顶栏保留页题、通知与主题切换。
 */
import {
  DashboardOutlined,
  DatabaseOutlined,
  MenuOutlined,
  MoonOutlined,
  NotificationOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  SunOutlined,
  ApiOutlined,
  ThunderboltOutlined,
  FileMarkdownOutlined,
} from "@ant-design/icons";
import { Button, Drawer, Layout as AntLayout, Menu } from "antd";
import type { MenuProps } from "antd";
import { Suspense, useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { NotificationCenter } from "./NotificationCenter.js";
import { PageProgress } from "./PageProgress.js";
import { NotificationsProvider } from "../hooks/useNotifications.js";
import { useTheme } from "../theme/ThemeProvider.js";
import { loadJson } from "../lib/api.js";
import type { SecurityBaselinePayload } from "../pages/settings/helpers.js";

const NAV_ITEMS = [
  { to: "/dashboard", icon: <DashboardOutlined />, label: "首页", note: "运行总览与一键检查" },
  { to: "/skills", icon: <ApiOutlined />, label: "智能体与记忆", note: "技能、插件与记忆" },
  { to: "/core-files", icon: <FileMarkdownOutlined />, label: "核心文件", note: "查看、编辑与回滚 Markdown" },
  { to: "/gateway", icon: <NotificationOutlined />, label: "消息通知", note: "频率控制与送达记录" },
];

const MANAGEMENT_ITEMS = [
  { to: "/evolution", icon: <ThunderboltOutlined />, label: "自进化", note: "分析日志与优化方案" },
  { to: "/assets", icon: <DatabaseOutlined />, label: "GitHub 技能管理", note: "发现与安装公开技能" },
];

const ALL_NAV_ITEMS = [...NAV_ITEMS, ...MANAGEMENT_ITEMS];

const SETTINGS_ITEM = {
  to: "/settings",
  icon: <SettingOutlined />,
  label: "设置",
  note: "本机安全、备份与偏好",
};

interface NavItem {
  to: string;
  icon: React.ReactNode;
  label: string;
  note: string;
}

function navEntry(item: NavItem, onNavigate?: () => void): NonNullable<MenuProps["items"]>[number] {
  return {
    key: item.to,
    icon: item.icon,
    title: item.label,
    label: (
      <Link to={item.to} onClick={onNavigate} className="menu-link">
        <span className="menu-copy">
          <strong>{item.label}</strong>
          <small>{item.note}</small>
        </span>
      </Link>
    ),
  };
}

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
    ? "已设访问口令"
    : "未设访问口令，请尽快处理";
}

function SidebarContent({
  onNavigate,
  baseline,
}: {
  onNavigate?: () => void;
  baseline: SecurityBaselinePayload | null;
}) {
  const location = useLocation();
  const settingsActive =
    location.pathname.startsWith(SETTINGS_ITEM.to) || location.pathname.startsWith("/preferences");
  const currentEntry = ALL_NAV_ITEMS.find((item) => location.pathname.startsWith(item.to));
  const selectedKey = settingsActive ? SETTINGS_ITEM.to : (currentEntry?.to ?? "");

  const menuItems: MenuProps["items"] = [
    {
      key: "group-console",
      type: "group",
      label: "控制台",
      children: NAV_ITEMS.map((item) => navEntry(item, onNavigate)),
    },
    {
      key: "group-management",
      type: "group",
      label: "维护与升级",
      children: MANAGEMENT_ITEMS.map((item) => navEntry(item, onNavigate)),
    },
  ];

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
      <Menu mode="inline" className="app-nav" items={menuItems} selectedKeys={[selectedKey]} />
      <div className="sidebar-bottom">
        <Link
          to={SETTINGS_ITEM.to}
          onClick={onNavigate}
          className={`sidebar-settings${settingsActive ? " active" : ""}`}
        >
          <span className="sidebar-settings-icon" aria-hidden="true">
            {SETTINGS_ITEM.icon}
          </span>
          <span className="menu-copy">
            <strong>{SETTINGS_ITEM.label}</strong>
            <small>{SETTINGS_ITEM.note}</small>
          </span>
        </Link>
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
      <AntLayout className="app">
        <AntLayout.Sider className="app-sider" width={232} theme="light">
          <SidebarContent baseline={baseline} />
        </AntLayout.Sider>
        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          placement="left"
          size={280}
          title="Agent Butler"
          className="mobile-nav-drawer"
        >
          <div className="sidebar-mobile">
            <SidebarContent onNavigate={() => setDrawerOpen(false)} baseline={baseline} />
          </div>
        </Drawer>
        <AntLayout className="app-main">
          <AntLayout.Header className="app-topbar">
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
          </AntLayout.Header>
          <AntLayout.Content className="content" id="main-content">
            <Suspense fallback={<PageProgress title="正在打开页面" detail="本机资源正在加载。" compact indeterminate />}>
              <Outlet />
            </Suspense>
          </AntLayout.Content>
        </AntLayout>
      </AntLayout>
    </NotificationsProvider>
  );
}
