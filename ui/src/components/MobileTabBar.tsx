/**
 * 移动端底部 Tab（M4.1）。
 *
 * 只在 ≤600px 显示；把「在地铁上真正会点的四件事」放到拇指可达区：
 * 周报 / 事件 / 成本 + 急停。急停在最右侧并被视觉强化——它是唯一「出事了要马上按」
 * 的动作，不该藏在二级页面里。
 *
 * 为什么是这四个：周报＝本周发生了什么（结论层）；事件＝现在有没有事（告警层）；
 * 成本＝花了多少钱（钱的事最敏感）；急停＝立刻停手（逃生口）。
 *
 * 【与桌面同源（评审 P0-1）】三个 Tab 的路径、图标、短标签全部取自 lib/routeMeta.ts，
 * 不再在这里另维护一份一级信息架构——此前桌面首层是「首页/智能体/消息」，
 * 移动却是「周报/事件/成本」，同一产品两套心智。
 */
import { Link, useLocation } from "react-router-dom";
import { KillSwitchButton } from "./KillSwitchButton.js";
import { MOBILE_TAB_PATHS, ROUTES, shortTitleOf } from "../lib/routeMeta.js";

const TABS = MOBILE_TAB_PATHS.map((path) => {
  const meta = ROUTES.find((route) => route.path === path);
  if (meta === undefined) throw new Error(`MOBILE_TAB_PATHS 引用了未登记的路由：${path}`);
  return { to: meta.path, icon: meta.icon, label: shortTitleOf(meta) };
});

export function MobileTabBar() {
  const location = useLocation();
  return (
    <nav className="mobile-tabbar" aria-label="移动端主导航">
      {TABS.map((tab) => {
        const active = location.pathname.startsWith(tab.to);
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
      {/* 急停：复用顶栏同一个按钮组件，状态与两段确认逻辑完全一致（不另做一套）。 */}
      <div className="mobile-tab is-emergency">
        <KillSwitchButton variant="tab" />
      </div>
    </nav>
  );
}
