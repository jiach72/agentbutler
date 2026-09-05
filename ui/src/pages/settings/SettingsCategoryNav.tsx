/**
 * 设置页左侧分类导航：分类数组驱动的白卡导航（图标 + 名称），
 * 选中态蓝底 + 左蓝条；窄屏（<900px）由 settings.css 收为顶部横向 chips。
 * 参照技能页 CategoryRail 的模式独立实现，不与其共享代码。
 */
import {
  ControlOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  KeyOutlined,
  ReconciliationOutlined,
  SafetyOutlined,
} from "@ant-design/icons";
import type { StatStripIcon } from "../../components/StatStrip.js";
import "./settings.css";

interface SettingsCategory {
  /** 分类 key，同时是 ?tab= 深链值。 */
  key: string;
  /** 分类名（中文）。 */
  label: string;
  /** @ant-design/icons Outlined 图标组件。 */
  icon: StatStripIcon;
}

/** 设置页六个分类（数组顺序即导航顺序；key 沿用旧六签深链值）。 */
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  { key: "security", label: "本机安全", icon: SafetyOutlined },
  { key: "backups", label: "备份与还原", icon: HistoryOutlined },
  { key: "llm", label: "模型与密钥", icon: KeyOutlined },
  { key: "diagnostics", label: "诊断报告", icon: ReconciliationOutlined },
  { key: "preferences", label: "常规偏好", icon: ControlOutlined },
  { key: "about", label: "关于", icon: InfoCircleOutlined },
];

/** 旧 ?tab= 值 → 分类 key 映射（历史六签 key 与分类 key 一致；成表保证未来重命名不破坏旧链接）。 */
const LEGACY_TAB_TO_CATEGORY: Record<string, string> = Object.fromEntries(
  SETTINGS_CATEGORIES.map((category) => [category.key, category.key]),
);

/** ?tab= 深链解析：旧 tab 值映射到分类 key，未知或缺失回落第一个分类。 */
export function resolveCategoryKey(raw: string | null): string {
  const mapped = raw === null ? undefined : LEGACY_TAB_TO_CATEGORY[raw];
  return mapped ?? SETTINGS_CATEGORIES[0].key;
}

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
      </div>
    </aside>
  );
}
