/**
 * 设置页左侧分类导航：分类数组驱动的白卡导航（图标 + 名称），
 * 选中态蓝底 + 左蓝条；窄屏（<900px）由 settings.css 收为顶部横向 chips。
 * 参照技能页 CategoryRail 的模式独立实现，不与其共享代码。
 */
import { AppstoreOutlined } from "@ant-design/icons";
import { SETTINGS_CATEGORIES } from "./categories.js";
export { SETTINGS_CATEGORIES, resolveCategoryKey } from "./categories.js";
import "./settings.css";

interface SettingsCategoryNavProps {
  /** 当前选中的分类 key。 */
  active: string;
  /** 切换分类（写回 ?tab=，与 URL 双向同步）。 */
  onSelect: (key: string) => void;
}

export function SettingsCategoryNav({ active, onSelect }: SettingsCategoryNavProps) {
  return (
    <aside className="settings-category-rail" aria-label="设置分类导航">
      <div className="settings-rail-card">
        <nav className="settings-rail-list">
          {SETTINGS_CATEGORIES.map((category) => {
            const Icon = category.icon;
            const isActive = active === category.key;
            return (
              <button
                key={category.key}
                type="button"
                className={`settings-rail-item${isActive ? " active" : ""}`}
                aria-current={isActive ? "true" : undefined}
                onClick={() => onSelect(category.key)}
              >
                <Icon aria-hidden="true" />
                <span>{category.label}</span>
              </button>
            );
          })}
        </nav>
        <div style={{ marginTop: 12, padding: "10px 12px", borderTop: "1px solid var(--ant-color-border-secondary)", display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: "var(--ant-color-text-tertiary)" }}>
            排障与体检请前往
          </span>
          <a href="/tools" style={{ fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6, color: "var(--ant-color-primary)" }}>
            <AppstoreOutlined />
            <span>专家工具箱 →</span>
          </a>
        </div>
      </div>
    </aside>
  );
}
