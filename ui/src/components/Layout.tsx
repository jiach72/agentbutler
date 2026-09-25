/**
 * Ethereal Precision 应用外壳 (Stitch Design)
 * 采用 Apple-grade visionOS 空间毛玻璃、铝镁合金质感、精工微动效与 4 组 23 路由全量架构。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Button, Drawer, Tooltip } from "antd";
import { MoonOutlined, SunOutlined } from "@ant-design/icons";
import { EtherealIcon } from "./EtherealIcon.js";
import { KillSwitchButton } from "./KillSwitchButton.js";
import { MobileTabBar } from "./MobileTabBar.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { PageProgress } from "./PageProgress.js";
import { PendingApprovalsBanner } from "./PendingApprovalsBanner.js";
import { PendingApprovalsCard } from "./PendingApprovalsCard.js";
import { NotificationsProvider } from "../hooks/useNotifications.js";
import { usePolling } from "../hooks/usePolling.js";
import { useTheme } from "../theme/ThemeProvider.js";
import { loadJson } from "../lib/api.js";
import {
  ROUTES,
  STITCH_SIDEBAR_NAV,
  isStitchNavActive,
  routeMetaFor,
  type StitchNavItem,
} from "../lib/routeMeta.js";

interface ApprovalsSummary {
  summary?: { pending?: number };
}

interface HealthSummary {
  gateway?: boolean;
  instances?: Array<{ state: string }>;
}

interface SecurityBaseline {
  loopback?: boolean;
  publishHost?: string;
  auth?: boolean;
}

/** 访问安全态口径（Jev 安全审计规范）：默认仅本地访问，去焦虑化 */
export function baselineTitle(baseline: SecurityBaseline | null): string {
  if (baseline === null) return "正在读取访问方式";
  if (baseline.loopback || baseline.publishHost === "0.0.0.0") return "仅本地访问";
  return baseline.auth ? "同一网络可访问" : "局域网访问";
}

interface SidebarNavProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onNavigate?: () => void;
}

function SidebarNav({ collapsed = false, onToggleCollapse, onNavigate }: SidebarNavProps) {
  const location = useLocation();
  const currentPath = location.pathname;
  const [pendingApprovals, setPendingApprovals] = useState(0);

  const fetchApprovals = useCallback(() => {
    void loadJson<ApprovalsSummary>("/api/approvals?status=pending&limit=1", 8_000).then((res) => {
      if (res.ok && typeof res.data.summary?.pending === "number") {
        setPendingApprovals(res.data.summary.pending);
      }
    });
  }, []);

  const [versionBadge, setVersionBadge] = useState<string>("Beta");
  const [fullVersion, setFullVersion] = useState<string>("0.1.0-beta");

  const fetchVersion = useCallback(() => {
    void loadJson<{ version?: string | null }>("/api/butler/version", 8_000).then((res) => {
      if (res.ok && res.data?.version) {
        setFullVersion(res.data.version);
        const v = res.data.version;
        if (v.includes("beta")) {
          setVersionBadge("Beta");
        } else {
          setVersionBadge(v.startsWith("v") ? v : `v${v}`);
        }
      }
    });
  }, []);

  useEffect(() => {
    fetchApprovals();
    fetchVersion();
  }, [fetchApprovals, fetchVersion]);
  usePolling(fetchApprovals, 30_000);

  const renderItem = (item: StitchNavItem) => {
    const active = isStitchNavActive(item.path, currentPath);
    const isSettings = item.path === "/settings";
    const settingsActive = isSettings && (active || currentPath.startsWith("/preferences"));

    if (isSettings) {
      const linkContent = (
        <div
          className={`nav-item group flex items-center ${
            collapsed ? "justify-center w-10 h-10 p-0 mx-auto relative" : "justify-between px-3.5 py-2.5 w-full"
          } rounded-xl transition-all duration-200 ${settingsActive ? "is-active" : ""}`}
        >
          <div className={`flex items-center ${collapsed ? "" : "gap-3"}`}>
            <EtherealIcon
              name={item.materialIcon}
              size={19}
              className="nav-icon transition-transform duration-200 group-hover:scale-105 shrink-0"
            />
            {!collapsed && <span className="nav-label text-sm font-medium text-on-surface">{item.title}</span>}
          </div>
        </div>
      );

      return (
        <Link
          key={item.path}
          to={item.path}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={`sidebar-settings${settingsActive ? " active" : ""}`}
          data-path="settings"
        >
          {collapsed ? (
            <Tooltip title={item.title} placement="right">
              <div>{linkContent}</div>
            </Tooltip>
          ) : (
            linkContent
          )}
        </Link>
      );
    }

    const baseClass = `nav-item group flex items-center ${
      collapsed ? "justify-center w-10 h-10 p-0 mx-auto relative" : "justify-between px-3.5 py-2.5"
    } rounded-xl transition-all duration-200 ${active ? "is-active" : ""}`;

    const linkContent = (
      <Link
        key={item.path}
        to={item.path}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={baseClass}
        data-path={item.path.slice(1)}
      >
        <div className={`flex items-center ${collapsed ? "" : "gap-3"}`}>
          <EtherealIcon
            name={item.materialIcon}
            size={19}
            className="nav-icon transition-transform duration-200 group-hover:scale-105 shrink-0"
          />
          {!collapsed && <span className="nav-label text-sm font-medium text-on-surface">{item.title}</span>}
        </div>
        {item.badgeKey === "approvals" && pendingApprovals > 0 && (
          collapsed ? (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-secondary ring-2 ring-surface-container" />
          ) : (
            <span
              id="nav-approval-badge"
              className="w-5 h-5 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center text-xs font-semibold transition-transform group-hover:scale-105"
            >
              {pendingApprovals}
            </span>
          )
        )}
      </Link>
    );

    return collapsed ? (
      <Tooltip key={item.path} title={item.title} placement="right">
        <div>{linkContent}</div>
      </Tooltip>
    ) : (
      linkContent
    );
  };

  const mainGroups = STITCH_SIDEBAR_NAV.filter((g) => g.key !== "settings");
  const settingsGroup = STITCH_SIDEBAR_NAV.find((g) => g.key === "settings");

  return (
    <aside
      className={`${
        collapsed ? "w-16" : "w-60"
      } h-full bg-surface-container-low/85 backdrop-blur-2xl flex flex-col justify-between border-r border-outline-variant/15 select-none transition-all duration-300`}
    >
      <div className="flex flex-col flex-1 min-h-0">
        {/* Brand Header */}
        <div className="h-14 px-3 flex items-center justify-between border-b border-surface-container/60 shrink-0">
          {!collapsed ? (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-6 h-6 rounded-lg bg-primary-container flex items-center justify-center text-white shadow-xs shrink-0">
                  <EtherealIcon name="smart_toy" size={14} className="text-white" />
                </div>
                <span className="text-sm text-on-surface font-semibold tracking-tight truncate">Agent Butler</span>
                <Link
                  to="/settings?tab=about"
                  onClick={onNavigate}
                  className="px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 text-[11px] font-mono font-medium hover:bg-primary/20 transition-colors shrink-0 cursor-pointer"
                  title={`版本: ${fullVersion}（点击查看版本与升级）`}
                >
                  {versionBadge}
                </Link>
              </div>
              {onToggleCollapse && (
                <button
                  type="button"
                  onClick={onToggleCollapse}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-all active:scale-95 cursor-pointer"
                  title="收起侧边栏 (Ctrl+B)"
                  aria-label="收起侧边栏"
                >
                  <EtherealIcon name="chevron_left" size={16} />
                </button>
              )}
            </>
          ) : (
            <div className="w-full flex items-center justify-center">
              {onToggleCollapse ? (
                <Tooltip title="展开侧边栏 (Ctrl+B)" placement="right">
                  <button
                    type="button"
                    onClick={onToggleCollapse}
                    className="w-8 h-8 rounded-lg bg-primary-container flex items-center justify-center text-white shadow-xs hover:scale-105 active:scale-95 transition-transform cursor-pointer"
                    aria-label="展开侧边栏"
                  >
                    <EtherealIcon name="smart_toy" size={16} className="text-white" />
                  </button>
                </Tooltip>
              ) : (
                <div className="w-8 h-8 rounded-lg bg-primary-container flex items-center justify-center text-white shadow-xs">
                  <EtherealIcon name="smart_toy" size={16} className="text-white" />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Scrollable Nav Items */}
        <div className={`flex-1 overflow-y-auto ${collapsed ? "px-1.5 py-3 space-y-3" : "px-2.5 py-3 space-y-3"}`}>
          {mainGroups.map((group) => (
            <div key={group.key} className={collapsed ? "space-y-1" : "space-y-1"}>
              {!collapsed ? (
                <div className="sidebar-group-title px-3 pt-2.5 pb-1 text-xs font-semibold text-on-surface-variant/80 uppercase tracking-wider">
                  {group.label}
                </div>
              ) : (
                <div className="my-1 border-t border-surface-container/60 mx-2" />
              )}
              <nav className="space-y-0.5">
                {group.items.map(renderItem)}
              </nav>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom Pinned Area */}
      <div className={`${collapsed ? "px-1.5" : "px-2.5"} py-2 space-y-2 bg-surface-container/40 border-t border-outline-variant/15 shrink-0 ${collapsed ? "flex flex-col items-center" : ""}`}>
        {settingsGroup && (
          <div className={`space-y-1 ${collapsed ? "w-full" : ""}`}>
            {!collapsed && (
              <div className="sidebar-group-title px-3 pt-1 pb-1 text-xs font-semibold text-on-surface-variant/80 uppercase tracking-wider">
                {settingsGroup.label}
              </div>
            )}
            <nav className="space-y-0.5">
              {settingsGroup.items.map(renderItem)}
            </nav>
          </div>
        )}

        {/* Pending approvals quick card if active (only when expanded) */}
        {!collapsed && (
          <div className="sidebar-approvals-slot">
            <PendingApprovalsCard />
          </div>
        )}

        {/* Local Status Badge */}
        {!collapsed ? (
          <div className="px-3 py-1.5 rounded-xl bg-surface-container-lowest/80 shadow-[0_1px_4px_rgba(0,0,0,0.03)] inline-flex items-center gap-2 border border-transparent hover:border-outline-variant/30 transition-all duration-200 w-fit">
            <span className="relative flex h-2 w-2">
              <span className="ping-ring absolute inline-flex h-full w-full rounded-full bg-tertiary" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-tertiary" />
            </span>
            <span className="font-label-md text-label-md text-on-surface-variant font-mono">127.0.0.1:7531</span>
          </div>
        ) : (
          <Tooltip title="本机服务在线: 127.0.0.1:7531" placement="right">
            <div className="p-2 rounded-xl bg-surface-container-lowest/80 flex items-center justify-center cursor-default">
              <span className="relative flex h-2 w-2">
                <span className="ping-ring absolute inline-flex h-full w-full rounded-full bg-tertiary" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-tertiary" />
              </span>
            </div>
          </Tooltip>
        )}
      </div>
    </aside>
  );
}

export function Layout() {
  const [bridgeLatency, setBridgeLatency] = useState<number | null>(null);
  const [bridgeConnected, setBridgeConnected] = useState<boolean | null>(null);
  const [commandText, setCommandText] = useState("");
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const commandInputRef = useRef<HTMLInputElement>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("butler.sidebar.collapsed") === "1";
    } catch {
      return false;
    }
  });

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("butler.sidebar.collapsed", next ? "1" : "0");
      } catch {
        /* 忽略 localStorage 不可用异常 */
      }
      return next;
    });
  };

  const { mode, toggleMode } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();

  const currentPage = routeMetaFor(location.pathname);
  const themeLabel = mode === "dark" ? "切换到亮色主题" : "切换到暗色主题";

  const pingBridge = useCallback(async () => {
    const start = performance.now();
    try {
      const res = await loadJson<HealthSummary>("/api/health", 4_000);
      const elapsed = Math.round(performance.now() - start);
      setBridgeLatency(elapsed > 0 ? elapsed : 1);
      setBridgeConnected(res.ok && res.data?.gateway !== false);
    } catch {
      setBridgeLatency(null);
      setBridgeConnected(false);
    }
  }, []);

  useEffect(() => {
    void pingBridge();
  }, [pingBridge]);
  usePolling(pingBridge, 20_000);

  const [commandOpen, setCommandOpen] = useState(false);

  const filteredRoutes = useMemo(() => {
    const q = commandText.trim().toLowerCase();
    if (!q) {
      return [
        { title: "总览大盘", path: "/dashboard", icon: "dashboard", description: "系统运行结论与关键介入卡片" },
        { title: "定时任务与巡检", path: "/tasks", icon: "calendar_today", description: "Cron 表达式调度与健康体检" },
        { title: "操作审批中心", path: "/approvals", icon: "verified_user", description: "HITL 拦截决策与事后审计" },
        { title: "消息通知网关", path: "/gateway", icon: "notifications", description: "Hermes Bridge 消息状态与策略" },
        { title: "专家排障与自检", path: "/troubleshoot", icon: "healing", description: "网络、端口与进程一键体检" },
        { title: "智能体技能与插件", path: "/skills", icon: "extension", description: "技能管理与三方扩展" },
        { title: "成本与 Token", path: "/cost", icon: "payments", description: "模型用量消耗与成本核算" },
        { title: "系统全局设置", path: "/settings", icon: "settings", description: "网络基线与凭据配置" },
      ];
    }
    return ROUTES.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q) ||
        (r.note && r.note.toLowerCase().includes(q))
    ).map((r) => ({
      title: r.title,
      path: r.path,
      icon: "arrow_forward",
      description: r.note || r.path,
    })).slice(0, 8);
  }, [commandText]);

  const openCommandPalette = () => {
    setCommandOpen(true);
    setTimeout(() => {
      commandInputRef.current?.focus();
      commandInputRef.current?.select();
    }, 50);
  };

  const handleCommandSubmit = () => {
    if (filteredRoutes.length > 0) {
      navigate(filteredRoutes[0].path);
      setCommandOpen(false);
      setCommandText("");
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openCommandPalette();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "Escape" && commandOpen) {
        setCommandOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [commandOpen]);

  return (
    <NotificationsProvider>
      <a className="skip-link sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-primary focus:text-on-primary focus:rounded-lg" href="#main-content">
        跳到主内容
      </a>

      <div className="min-h-screen bg-surface font-body-md text-body-md text-on-surface antialiased selection:bg-primary-container selection:text-on-primary-container flex">
        {/* Desktop Fixed Sidebar */}
        <div
          className={`hidden lg:block fixed left-0 top-0 h-full ${
            sidebarCollapsed ? "w-16" : "w-60"
          } z-50 shadow-[0_1px_8px_rgba(0,0,0,0.04)] transition-all duration-300`}
        >
          <SidebarNav collapsed={sidebarCollapsed} onToggleCollapse={toggleSidebar} />
        </div>

        {/* Main Application Shell */}
        <div className={`flex-1 flex flex-col min-w-0 ${sidebarCollapsed ? "lg:pl-16" : "lg:pl-60"} transition-all duration-300`}>
          {/* VisionOS Floating Header */}
          <header
            className={`fixed top-0 left-0 ${
              sidebarCollapsed ? "lg:left-16" : "lg:left-60"
            } right-0 h-14 bg-surface-container-lowest/70 backdrop-blur-xl z-40 flex items-center justify-between px-4 sm:px-6 shadow-[0_1px_8px_rgba(0,0,0,0.03)] border-b border-surface-container-high/40 transition-all duration-300`}
          >
            {/* Left Telemetry Pills */}
            <div className="flex items-center gap-2 sm:gap-2.5">
              <button
                type="button"
                onClick={toggleSidebar}
                className="hidden lg:flex w-8 h-8 rounded-full items-center justify-center text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-all duration-200 active:scale-95 cursor-pointer"
                title={sidebarCollapsed ? "展开侧边栏 (Ctrl+B)" : "收起侧边栏 (Ctrl+B)"}
                aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
              >
                <EtherealIcon name={sidebarCollapsed ? "chevron_right" : "chevron_left"} size={17} />
              </button>

              <button
                type="button"
                onClick={() => setMobileDrawerOpen(true)}
                className="lg:hidden flex w-8 h-8 rounded-full items-center justify-center text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-all duration-200 active:scale-95 cursor-pointer"
                title="打开主导航抽屉"
                aria-label="打开主导航抽屉"
              >
                <EtherealIcon name="menu" size={18} />
              </button>

              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface-container-low border border-outline-variant/15 shadow-[0_1px_2px_rgba(0,0,0,0.02)] transition-all hover:bg-surface-container">
                <span className="relative flex h-2 w-2">
                  <span className={`ping-ring absolute inline-flex h-full w-full rounded-full ${bridgeConnected === false ? "bg-error" : "bg-tertiary"}`} />
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${bridgeConnected === false ? "bg-error" : "bg-tertiary"}`} />
                </span>
                <span className="text-xs text-on-surface font-medium">Hermes Engine</span>
                <span className={`text-xs font-semibold uppercase ${bridgeConnected === false ? "text-error" : "text-tertiary"}`}>
                  {bridgeConnected === false ? "离线" : "在线"}
                </span>
              </div>

              <div
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-container-low border border-outline-variant/15 shadow-[0_1px_2px_rgba(0,0,0,0.02)] transition-all hover:bg-surface-container group cursor-pointer"
                onClick={pingBridge}
                title="点击刷新 Bridge 延迟"
              >
                <EtherealIcon name="bolt" size={13} className={`transition-colors ${bridgeLatency !== null ? "text-on-surface-variant group-hover:text-primary" : "text-error"}`} />
                <span className="text-xs text-on-surface-variant">
                  Bridge <span className="font-mono text-on-surface font-medium" id="header-bridge-ms">{bridgeLatency !== null ? `${bridgeLatency}ms` : "检测中"}</span>
                </span>
              </div>

              <div className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-container-low/80 border border-outline-variant/15 text-on-surface-variant text-xs font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-tertiary" />
                <span>管家巡检就绪</span>
              </div>

              {/* Title preserved for SSR & unit tests */}
              <strong className="topbar-title">{currentPage?.title ?? "当前页面"}</strong>
            </div>

            {/* Right Action Tools */}
            <div className="flex items-center gap-2 sm:gap-3">
              <Link
                to="/learn"
                className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-all text-label-md font-label-md"
                title="智能体技术全景与通识速查"
              >
                <EtherealIcon name="school" size={15} />
                <span>通识百科</span>
              </Link>

              <Link
                to="/wall"
                className="hidden lg:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-all text-label-md font-label-md"
              >
                <EtherealIcon name="tv" size={15} />
                <span>大屏模式</span>
              </Link>

              <Button
                type="text"
                size="small"
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-all text-label-md font-label-md border-0 h-auto"
                aria-label="开始排查问题"
                onClick={() => navigate("/troubleshoot")}
              >
                <EtherealIcon name="build" size={15} />
                <span>排查问题</span>
              </Button>

              {/* Global Emergency Stop KillSwitch Button */}
              <div className="stitch-killswitch-wrapper">
                <KillSwitchButton />
              </div>

              <div className="h-4 w-px bg-surface-container-high" />

              <div className="flex items-center gap-1">
                <button
                  className="w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-all duration-200 active:scale-90"
                  onClick={openCommandPalette}
                  title="全局指令与搜索 (⌘K)"
                  type="button"
                >
                  <EtherealIcon name="search" size={17} />
                </button>

                <NotificationCenter />

                <button
                  className="w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-all duration-200 active:scale-90"
                  aria-label={themeLabel}
                  title={themeLabel}
                  onClick={toggleMode}
                  type="button"
                >
                  {mode === "dark" ? <SunOutlined /> : <MoonOutlined />}
                </button>
              </div>

              <div
                className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shadow-xs cursor-pointer transition-transform hover:scale-105 active:scale-95"
                onClick={() => navigate("/settings")}
                title="账户设置"
              >
                <EtherealIcon name="person" size={17} className="text-on-primary" />
              </div>
            </div>
          </header>

          {/* Main Scrollable Canvas (Clean pb-12 without bottom obstruction, unified 1440px rhythm) */}
          <main className="relative pt-14 w-full px-4 sm:px-8 lg:px-10 pb-12 min-h-screen bg-surface" id="main-content">
            <div className="max-w-[1440px] mx-auto w-full">
              <PendingApprovalsBanner />
              <Suspense fallback={<PageProgress title="正在打开页面" detail="本机资源正在加载。" compact indeterminate />}>
                <div key={location.pathname} className="animate-page-entrance">
                  <Outlet />
                </div>
              </Suspense>
            </div>
          </main>

          {/* Modal Spotlight Command Palette (Triggered by ⌘K or Search Icon) */}
          {commandOpen && (
            <div
              className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-start justify-center pt-20 px-4 animate-entrance"
              id="command-bar-wrapper"
              onClick={() => setCommandOpen(false)}
            >
              <div
                className="w-full max-w-xl bg-surface-container-lowest/95 backdrop-blur-2xl rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.18)] border border-outline-variant/30 overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Search Bar Input */}
                <div className="flex items-center gap-3 px-4 py-3.5 border-b border-surface-container">
                  <EtherealIcon name="search" size={18} className="text-primary shrink-0" />
                  <input
                    ref={commandInputRef}
                    value={commandText}
                    onChange={(e) => setCommandText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCommandSubmit();
                      else if (e.key === "Escape") setCommandOpen(false);
                    }}
                    className="bg-transparent border-0 outline-none p-0 text-sm text-on-surface placeholder:text-on-surface-variant w-full font-body"
                    id="command-input"
                    placeholder="搜索页面或输入关键字快速前往 (如: 审批, 任务, 成本)..."
                    type="text"
                  />
                  <kbd
                    className="px-1.5 py-0.5 rounded text-xs font-mono bg-surface-container text-on-surface-variant cursor-pointer select-none"
                    onClick={() => setCommandOpen(false)}
                  >
                    ESC
                  </kbd>
                </div>

                {/* Filtered Route Items */}
                <div className="p-2 space-y-0.5 text-xs max-h-80 overflow-y-auto">
                  <div className="px-2.5 py-1 text-xs font-semibold uppercase text-on-surface-variant tracking-wider">
                    {commandText ? "搜索结果" : "常用页面"}
                  </div>
                  {filteredRoutes.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-on-surface-variant">
                      未找到与 "{commandText}" 相关的控制台页面
                    </div>
                  ) : (
                    filteredRoutes.map((item) => (
                      <div
                        key={item.path}
                        onClick={() => {
                          navigate(item.path);
                          setCommandOpen(false);
                          setCommandText("");
                        }}
                        className="flex items-center justify-between px-3 py-2 rounded-xl hover:bg-surface-container cursor-pointer transition-colors text-on-surface group"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <EtherealIcon name={item.icon} size={16} className="text-on-surface-variant group-hover:text-primary transition-colors shrink-0" />
                          <div className="truncate">
                            <span className="font-medium text-sm block">{item.title}</span>
                            {item.description && (
                              <span className="text-xs text-on-surface-variant truncate block">{item.description}</span>
                            )}
                          </div>
                        </div>
                        <span className="font-mono text-xs text-on-surface-variant/70 shrink-0 ml-2">{item.path}</span>
                      </div>
                    ))
                  )}
                </div>

                {/* Footer hints */}
                <div className="px-4 py-2 bg-surface-container/40 border-t border-surface-container text-xs text-on-surface-variant flex items-center justify-between font-mono">
                  <span>↵ 进入页面</span>
                  <span>ESC 关闭 · ⌘K 随时唤起</span>
                </div>
              </div>
            </div>
          )}

          {/* Mobile Navigation Drawer */}
          <Drawer
            open={mobileDrawerOpen}
            onClose={() => setMobileDrawerOpen(false)}
            placement="left"
            styles={{ wrapper: { width: 260 }, body: { padding: 0 } }}
            closable={false}
          >
            <div className="h-full">
              <SidebarNav
                collapsed={false}
                onNavigate={() => setMobileDrawerOpen(false)}
                onToggleCollapse={() => setMobileDrawerOpen(false)}
              />
            </div>
          </Drawer>

          {/* Mobile Bottom Tab Bar */}
          <MobileTabBar onOpenMore={() => setMobileDrawerOpen(true)} />
        </div>
      </div>
    </NotificationsProvider>
  );
}
