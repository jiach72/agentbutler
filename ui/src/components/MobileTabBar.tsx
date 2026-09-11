/**
 * 移动端底部 Tab（M4.1）。
 *
 * 只在 ≤600px 显示；把「在地铁上真正会点的四件事」放到拇指可达区：
 * 周报 / 事件 / 成本 + 急停。急停在最右侧并被视觉强化——它是唯一「出事了要马上按」
 * 的动作，不该藏在二级页面里。
 *
 * 为什么是这四个：周报＝本周发生了什么（结论层）；事件＝现在有没有事（告警层）；
 * 成本＝花了多少钱（钱的事最敏感）；急停＝立刻停手（逃生口）。
 */
import { DollarOutlined, AlertOutlined, FileTextOutlined } from "@ant-design/icons";
import { Link, useLocation } from "react-router-dom";
import { KillSwitchButton } from "./KillSwitchButton.js";

const TABS = [
  { to: "/report", icon: <FileTextOutlined />, label: "周报" },
  { to: "/events", icon: <AlertOutlined />, label: "事件" },
  { to: "/cost", icon: <DollarOutlined />, label: "成本" },
];

export function MobileTabBar() {
  const location = useLocation();
  return (
    <nav className="mobile-tabbar" aria-label="移动端主导航">
      {TABS.map((tab) => {
        const active = location.pathname.startsWith(tab.to);
        return (
          <Link
            key={tab.to}
            to={tab.to}
            className={`mobile-tab${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span className="mobile-tab-icon" aria-hidden="true">
              {tab.icon}
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
