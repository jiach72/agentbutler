/**
 * 面板布局：左侧固定导航栏（品牌标识 + 6 页链接，当前页高亮）
 * + 右侧内容区（告警横幅 / 安全黄条 / 路由出口 / 事件 ticker）。
 */
import { NavLink, Outlet } from "react-router-dom";
import { AlertBanner } from "./AlertBanner.js";
import { EventTicker } from "./EventTicker.js";
import { SecurityNotice } from "./SecurityNotice.js";

const NAV_ITEMS = [
  { to: "/dashboard", index: "首", label: "首页", note: "你的本地 AI 管家" },
  { to: "/versions", index: "版", label: "版本管理", note: "升级前会自动备份，失败会还原" },
  { to: "/gateway", index: "信", label: "消息通知", note: "帮你管住消息频率，重要消息不丢" },
  { to: "/evolution", index: "进", label: "进化与优化", note: "给 AI 的自我改进装上安全锁" },
  { to: "/skills", index: "识", label: "技能与记忆", note: "查看 AI 学会的东西和记住的事" },
  { to: "/settings", index: "安", label: "安全与设置", note: "本机安全、告警和备份" },
];

export function Layout() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            管
          </span>
          <span className="brand-copy">
            Agent Butler
            <small>你的本地 AI 管家</small>
          </span>
        </div>
        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
            >
              <span className="nav-index" aria-hidden="true">
                {item.index}
              </span>
              <span className="nav-copy">
                <strong>{item.label}</strong>
                <small>{item.note}</small>
              </span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-meta">
          <span>
            <i />
            仅本机访问
          </span>
          <code>数据只保存在你的电脑上</code>
        </div>
      </aside>
      <div className="main">
        <header className="app-topbar">
          <div>
            <i />
            Agent Butler · 你的本地 AI 管家
          </div>
          <span>只在你的电脑上运行，不会上传数据</span>
        </header>
        <AlertBanner />
        <SecurityNotice />
        <main className="content">
          <Outlet />
        </main>
        <EventTicker />
      </div>
    </div>
  );
}
