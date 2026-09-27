/**
 * 常规偏好：主题外观与重要通知展示方式。
 * useTheme / usePreferences 逻辑原样；展示层迁到 antd Card + Segmented + List。
 */
import {
  BellOutlined,
  CheckOutlined,
  MoonOutlined,
  ReloadOutlined,
  SunOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import {
  App,
  Button,
  Card,
  Col,
  Flex,
  Popconfirm,
  Row,
  Segmented,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import { PageHeader } from "../../components/PageHeader.js";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import { useTheme } from "../../theme/ThemeProvider.js";
import { DEFAULT_PREFERENCES, usePreferences } from "../../lib/preferences.js";

const { Text } = Typography;

export function PreferencesPanel() {
  const { mode, setMode } = useTheme();
  const [preferences, setPreferences] = usePreferences();
  const { notification, message } = App.useApp();

  const handleTestNotification = () => {
    notification.info({
      message: "通知演示 · 智能体管家",
      description: "这是一条测试通知。当前通知配置正常生效，重要告警与状态将在右侧即时弹出。",
      placement: "topRight",
      duration: 3,
    });
  };

  const handleResetDefaults = () => {
    setMode("light");
    setPreferences(DEFAULT_PREFERENCES);
    message.success("已恢复为默认偏好设置（亮色主题、提醒+紧急通知、启用未读徽标）");
  };

  return (
    <Row gutter={[24, 24]}>
      <Col xs={24} lg={12}>
        <Card
          size="small"
          title="外观 · 界面主题"
          extra={<Text type="secondary">当前：{mode === "dark" ? "暗色" : "亮色"}</Text>}
        >
          <Flex vertical gap={12}>
            <Segmented
              block
              aria-label="界面主题切换"
              value={mode}
              onChange={(value) => setMode(value === "dark" ? "dark" : "light")}
              options={[
                {
                  value: "light",
                  label: (
                    <Space size={6}>
                      <SunOutlined />
                      亮色
                    </Space>
                  ),
                },
                {
                  value: "dark",
                  label: (
                    <Space size={6}>
                      <MoonOutlined />
                      暗色
                    </Space>
                  ),
                },
              ]}
            />
            <Text type="secondary">主题会保存在当前浏览器，下次打开仍会保持你的选择。</Text>
          </Flex>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card
          size="small"
          title="通知 · 重要通知"
          extra={
            <Button
              size="small"
              type="link"
              icon={<BellOutlined />}
              onClick={handleTestNotification}
              style={{ paddingInline: 0 }}
            >
              测试通知
            </Button>
          }
        >
          <Flex vertical gap={14} style={{ padding: "8px 0" }}>
            <Flex justify="space-between" align="center" gap={16}>
              <Flex vertical gap={2}>
                <Text strong>右上角未读徽标</Text>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  有未读重要通知时，在铃铛上显示数量。
                </Text>
              </Flex>
              <Switch
                key="badge"
                aria-label="右上角未读徽标开关"
                checked={preferences.notificationBadgeEnabled}
                onChange={(checked) =>
                  setPreferences({ ...preferences, notificationBadgeEnabled: checked })
                }
                checkedChildren={<CheckOutlined />}
              />
            </Flex>

            <Flex
              justify="space-between"
              align="center"
              gap={16}
              style={{
                borderTop: "1px solid var(--ant-color-border-secondary, rgba(0, 0, 0, 0.06))",
                paddingTop: 14,
              }}
            >
              <Flex vertical gap={2}>
                <Text strong>通知范围</Text>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  {preferences.notificationMinSeverity === "critical"
                    ? "只显示紧急通知"
                    : "显示提醒和紧急通知"}
                </Text>
              </Flex>
              <Segmented
                key="scope"
                size="small"
                aria-label="通知范围分级筛选"
                value={preferences.notificationMinSeverity}
                onChange={(value) =>
                  setPreferences({
                    ...preferences,
                    notificationMinSeverity: value === "critical" ? "critical" : "warn",
                  })
                }
                options={[
                  { value: "warn", label: "提醒 + 紧急" },
                  { value: "critical", label: "仅紧急" },
                ]}
              />
            </Flex>
          </Flex>
          <Text type="secondary">
            未送达的紧急通知仍会继续显示在页面横幅中，标记已读不会隐藏故障。
          </Text>
        </Card>
      </Col>
      <Col xs={24}>
        <Card
          size="small"
          title="辅助与效率 · 快捷按键速查"
          extra={
            <Popconfirm
              title="确认恢复默认偏好？"
              description="将重置主题为亮色、开启未读徽标并将通知范围重置为“提醒 + 紧急”。"
              okText="确认重置"
              cancelText="取消"
              onConfirm={handleResetDefaults}
            >
              <Button size="small" type="default" icon={<ReloadOutlined />}>
                恢复默认偏好
              </Button>
            </Popconfirm>
          }
        >
          <Row gutter={[16, 12]}>
            <Col xs={24} sm={12} md={6}>
              <Flex align="center" gap={8}>
                <Tag color="default" style={{ fontFamily: "monospace" }}>Esc</Tag>
                <Text type="secondary" style={{ fontSize: 13 }}>快速关闭抽屉、弹窗与日志遮罩</Text>
              </Flex>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Flex align="center" gap={8}>
                <Tag color="default" style={{ fontFamily: "monospace" }}>Enter</Tag>
                <Text type="secondary" style={{ fontSize: 13 }}>在搜索框与确认框中即时提交</Text>
              </Flex>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Flex align="center" gap={8}>
                <Tag color="default" style={{ fontFamily: "monospace" }}>Tab / Shift+Tab</Tag>
                <Text type="secondary" style={{ fontSize: 13 }}>全键盘焦点穿梭无障碍巡检</Text>
              </Flex>
            </Col>
            <Col xs={24} sm={12} md={6}>
              <Flex align="center" gap={8}>
                <Tag color="blue" style={{ fontFamily: "monospace" }}>单击复制图标</Tag>
                <Text type="secondary" style={{ fontSize: 13 }}>一键复制会话 ID、Hash 与配置</Text>
              </Flex>
            </Col>
          </Row>
        </Card>
      </Col>
    </Row>
  );
}

export function PreferencesPage() {
  return (
    <section className="preferences-page">
      <Flex vertical gap={24}>
        <PageHeader
          title="偏好设置"
        />
        <ConclusionBar
          tone="ok"
          title="偏好即改即存"
          copy="外观与通知设置自动保存，无需手动确认。可随时测试通知反馈或恢复出厂偏好。"
        />
        <PreferencesPanel />
        <Flex justify="flex-end">
          <Button type="link" href="#top" icon={<ThunderboltOutlined />}>
            偏好已即改即存
          </Button>
        </Flex>
      </Flex>
    </section>
  );
}

