import { CheckOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import { Button, Segmented, Switch } from "antd";
import { useTheme } from "../../theme/ThemeProvider.js";
import { usePreferences } from "../../lib/preferences.js";

export function PreferencesPanel() {
  const { mode, setMode } = useTheme();
  const [preferences, setPreferences] = usePreferences();

  return (
    <div className="preferences-grid">
      <section className="preferences-section">
        <div className="preferences-section-head">
          <div><span className="preferences-kicker">外观</span><h2>界面主题</h2></div>
          <span className="preferences-current">当前：{mode === "dark" ? "暗色" : "亮色"}</span>
        </div>
        <Segmented
          block
          value={mode}
          onChange={(value) => setMode(value === "dark" ? "dark" : "light")}
          options={[
            { value: "light", label: <span className="preferences-option"><SunOutlined />亮色</span> },
            { value: "dark", label: <span className="preferences-option"><MoonOutlined />暗色</span> },
          ]}
        />
        <p className="preferences-help">主题会保存在当前浏览器，下次打开仍会保持你的选择。</p>
      </section>

      <section className="preferences-section">
        <div className="preferences-section-head">
          <div><span className="preferences-kicker">通知</span><h2>重要通知</h2></div>
          <span className="preferences-current">默认显示提醒和紧急通知</span>
        </div>
        <div className="preferences-row">
          <div><strong>右上角未读徽标</strong><span>有未读重要通知时，在铃铛上显示数量。</span></div>
          <Switch
            checked={preferences.notificationBadgeEnabled}
            onChange={(checked) => setPreferences({ ...preferences, notificationBadgeEnabled: checked })}
            checkedChildren={<CheckOutlined />}
          />
        </div>
        <div className="preferences-row">
          <div><strong>通知范围</strong><span>{preferences.notificationMinSeverity === "critical" ? "只显示紧急通知" : "显示提醒和紧急通知"}</span></div>
          <Segmented
            size="small"
            value={preferences.notificationMinSeverity}
            onChange={(value) => setPreferences({ ...preferences, notificationMinSeverity: value === "critical" ? "critical" : "warn" })}
            options={[{ value: "warn", label: "提醒 + 紧急" }, { value: "critical", label: "仅紧急" }]}
          />
        </div>
        <p className="preferences-help">未送达的紧急通知仍会继续显示在页面横幅中，标记已读不会隐藏故障。</p>
      </section>
    </div>
  );
}

export function PreferencesPage() {
  return (
    <section className="page product-page preferences-page">
      <header className="page-heading product-heading">
        <div>
          <span className="product-eyebrow">常规偏好</span>
          <h1>设置</h1>
          <p className="hint">调整界面外观和重要通知的显示方式。</p>
        </div>
      </header>
      <PreferencesPanel />
      <section className="preferences-note">
        <Button type="link" href="#top" icon={<CheckOutlined />}>偏好会自动保存</Button>
      </section>
    </section>
  );
}
