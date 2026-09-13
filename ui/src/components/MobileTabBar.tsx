/**
 * 移动端底部 Tab（M4.1）。
 *
 * 只在 ≤600px 显示。拇指可达区放四个最高频目的地：首页 / 智能体与记忆 /
 * 消息通知 / 设置；尾部的「更多」按钮唤起完整导航抽屉（含记录与审批、
 * 维护工具等低频入口）。
 *
 * 【与桌面同源（评审 P0-1）】Tab 的路径、图标、短标签全部取自 lib/routeMeta.ts，
 * 不在这里另维护一份一级信息架构。
 *
 * 【急停唯一挂载】急停只保留在顶栏（KillSwitchButton），底部 Tab 不再重复挂载——
 * 同屏出现两个急停会让「唯一逃生口」变成两个需要分辨的按钮（shell-ux 测试守卫）。
 */
import { MoreOutlined } from "@ant-design/icons";
import { Link, useLocation } from "react-router-dom";
import { MOBILE_TAB_PATHS, ROUTES, shortTitleOf } from "../lib/routeMeta.js";

const TABS = MOBILE_TAB_PATHS.map((path) => {
  const meta = ROUTES.find((route) => route.path === path);
  if (meta === undefined) throw new Error(`MOBILE_TAB_PATHS 引用了未登记的路由：${path}`);
  return { to: meta.path, icon: meta.icon, label: shortTitleOf(meta) };
});

/** 活跃判定按路径段匹配：/skills/details 选中 /skills；/skills-other 不误选。 */
function isActive(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function MobileTabBar({ onOpenNavigation }: { onOpenNavigation?: () => void }) {
  const location = useLocation();
  return (
    <nav className="mobile-tabbar" aria-label="移动端主导航">
      {TABS.map((tab) => {
        const active = isActive(location.pathname, tab.to);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            className={`mobile-tab${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span className="mobile-tab-icon" aria-hidden="true">
              <Icon />
            </span>
            <span className="mobile-tab-label">{tab.label}</span>
          </Link>
        );
      })}
      {/* 更多：唤起完整导航抽屉（记录与审批、维护工具等低频入口都在抽屉里）。 */}
      <button
        type="button"
        className="mobile-tab"
        aria-label="更多导航"
        onClick={onOpenNavigation}
      >
        <span className="mobile-tab-icon" aria-hidden="true">
          <MoreOutlined />
        </span>
        <span className="mobile-tab-label">更多</span>
      </button>
    </nav>
  );
}
