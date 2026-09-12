/**
 * 应用外壳（antd v6 原生）：Layout/Sider/Menu/Header/Content 承担骨架。
 *
 * 【导航结构】全部由 lib/routeMeta.ts 派生，本文件不再维护第二份导航事实：
 *   · 控制台 / 维护与升级：常显分组；
 *   · 信任层：可折叠分组（9 项），展开后按「花了什么 / 管得住吗」分簇。
 *     折叠是为了把侧栏内容压进 768px 首屏——此前 18 项平铺约 1030px，
 *     底部的「设置」与访问安全态在短屏上默认掉出视野（评审 P0-1）。
 *   · 设置：底部钉住，不随导航滚动。
 *
 * 【状态只在一处说】访问安全态在侧栏底部展示；顶栏只在「不是仅本机访问」时
 * 才补一句警示，避免同一事实在一屏出现两次（评审 P0-3）。
 */
import { MenuOutlined, MoonOutlined, SafetyCertificateOutlined, SunOutlined, ToolOutlined } from "@ant-design/icons";
import { Button, Drawer, Layout as AntLayout, Menu } from "antd";
import type { MenuProps } from "antd";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { KillSwitchButton } from "./KillSwitchButton.js";
import { MobileTabBar } from "./MobileTabBar.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { PageProgress } from "./PageProgress.js";
import { NotificationsProvider } from "../hooks/useNotifications.js";
import { useTheme } from "../theme/ThemeProvider.js";
import { loadJson } from "../lib/api.js";
import {
  NAV_GROUPS,
  PINNED_ROUTE,
  TRUST_CLUSTERS,
  navRoutesFor,
  routeMetaFor,
  type NavGroup,
  type RouteMeta,
} from "../lib/routeMeta.js";
import type { SecurityBaselinePayload } from "../pages/settings/helpers.js";

interface NavItem {
  to: string;
  icon: RouteMeta["icon"];
  title: string;
  note: string;
}

/** 把一个路由元信息渲染成菜单项（组内嵌 react-router Link，保留真实 <a href> 语义）。 */
function navEntry(item: NavItem, onNavigate?: () => void): NonNullable<MenuProps["items"]>[number] {
  const Icon = item.icon;
  return {
    key: item.to,
    icon: <Icon />,
    title: item.title,
    label: (
      <Link to={item.to} onClick={onNavigate} className="menu-link">
        <span className="menu-copy">
          <strong>{item.title}</strong>
          <small>{item.note}</small>
        </span>
      </Link>
    ),
  };
}

function toNavItem(route: RouteMeta): NavItem {
  return { to: route.path, icon: route.icon, title: route.title, note: route.note };
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
  return baseline.auth ? "已设访问口令" : "未设访问口令，请尽快处理";
}

/** 常显分组：标题 + 直接列出子项。 */
function groupItem(group: NavGroup, onNavigate?: () => void): NonNullable<MenuProps["items"]>[number] {
  return {
    key: `group-${group.key}`,
    type: "group",
    label: group.label,
    children: navRoutesFor(group.key).map((route) => navEntry(toNavItem(route), onNavigate)),
  };
}

/** 可折叠分组：SubMenu + 内部按 cluster 再分簇。 */
function collapsibleGroupItem(
  group: NavGroup,
  onNavigate?: () => void,
): NonNullable<MenuProps["items"]>[number] {
  const routes = navRoutesFor(group.key);
  const clusters = TRUST_CLUSTERS.filter((cluster) => routes.some((route) => route.cluster === cluster));
  const children: NonNullable<MenuProps["items"]> =
    clusters.length === 0
      ? routes.map((route) => navEntry(toNavItem(route), onNavigate))
      : clusters.map((cluster) => ({
          key: `cluster-${cluster}`,
          type: "group",
          label: cluster,
          children: routes
            .filter((route) => route.cluster === cluster)
            .map((route) => navEntry(toNavItem(route), onNavigate)),
        }));

  return {
    key: group.key,
    icon: <SafetyCertificateOutlined />,
    title: group.label,
    label: (
      <span className="menu-copy">
        <strong>{group.label}</strong>
        {group.note !== undefined && <small>{group.note}</small>}
      </span>
    ),
    children,
  };
}

function SidebarContent({
  onNavigate,
  baseline,
}: {
  onNavigate?: () => void;
  baseline: SecurityBaselinePayload | null;
}) {
  const location = useLocation();
  const currentMeta = routeMetaFor(location.pathname);
  const settingsActive = currentMeta?.group === "settings" || location.pathname.startsWith("/preferences");
  const selectedKey = settingsActive ? PINNED_ROUTE.path : (currentMeta?.path ?? "");

  // 折叠分组默认收起；当前页在组内时自动展开（从移动 Tab 直接进 /cost 也能看到自己在哪）。
  const trustActive = currentMeta?.group === "trust";
  const [openKeys, setOpenKeys] = useState<string[]>(() => (trustActive ? ["trust"] : []));
  useEffect(() => {
    if (!trustActive) return;
    setOpenKeys((keys) => (keys.includes("trust") ? keys : [...keys, "trust"]));
  }, [trustActive]);

  const menuItems: MenuProps["items"] = useMemo(
    () =>
      NAV_GROUPS.filter((group) => group.key !== "settings").map((group) =>
        group.collapsible ? collapsibleGroupItem(group, onNavigate) : groupItem(group, onNavigate),
      ),
    [onNavigate],
  );

  const PinnedIcon = PINNED_ROUTE.icon;

  return (
    <>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          {/* 品牌标志（docs/brand/02 §2.3）：侧栏 28×28 用小尺寸加粗版（线宽 2.6，
              标准版 2.0 在 24px 级会糊）；深色底用反白版——墨线在 #0F2133 上对比度不足。 */}
          <img className="brand-logo is-light" src="/brand/ab-mark-sm.svg" alt="" />
          <img className="brand-logo is-dark" src="/brand/ab-mark-inverse.svg" alt="" />
        </span>
        <span className="brand-copy">
          Agent Butler
          <small>本地运维控制台</small>
        </span>
      </div>
      <Menu
        mode="inline"
        className="app-nav"
        items={menuItems}
        selectedKeys={[selectedKey]}
        openKeys={openKeys}
        onOpenChange={(keys) => setOpenKeys(keys as string[])}
      />
      <div className="sidebar-bottom">
        <Link
          to={PINNED_ROUTE.path}
          onClick={onNavigate}
          className={`sidebar-settings${settingsActive ? " active" : ""}`}
        >
          <span className="sidebar-settings-icon" aria-hidden="true">
            <PinnedIcon />
          </span>
          <span className="menu-copy">
            <strong>{PINNED_ROUTE.title}</strong>
            <small>{PINNED_ROUTE.note}</small>
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
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    void loadJson<SecurityBaselinePayload>("/api/security-baseline", 6_000).then((result) => {
      if (alive && result.ok) setBaseline(result.data);
    });
    return () => {
      alive = false;
    };
  }, []);
  const currentPage = routeMetaFor(location.pathname);
  const themeLabel = mode === "dark" ? "切换到亮色主题" : "切换到暗色主题";
  // 访问安全态在侧栏底部已说明；顶栏只在「不是仅本机访问」时补一句警示（评审 P0-3）。
  const topbarWarn = baselineTone(baseline) !== "ok";

  return (
    <NotificationsProvider>
      <a className="skip-link" href="#main-content">
        跳到主内容
      </a>
      <AntLayout className="app">
        <AntLayout.Sider className="app-sider" width={240} theme="light">
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
              <strong className="topbar-title">{currentPage?.title ?? "当前页面"}</strong>
              <span className="topbar-brand">Agent Butler · 本地运维控制台</span>
            </div>
            <div className="topbar-actions">
              {topbarWarn && (
                <span className={`topbar-note is-${baselineTone(baseline)}`}>{baselineTitle(baseline)}</span>
              )}
              <NotificationCenter />
              <KillSwitchButton />
              <Button
                type="text"
                size="small"
                className="topbar-tool"
                icon={<ToolOutlined />}
                aria-label="开始排查问题"
                onClick={() => navigate("/troubleshoot")}
              >
                排查问题
              </Button>
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
        {/* 移动端底部 Tab（M4.1）：≤600px 才渲染显示，桌面端被 CSS 隐藏。 */}
        <MobileTabBar />
      </AntLayout>
    </NotificationsProvider>
  );
}
