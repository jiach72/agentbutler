/**
 * 常规偏好：主题外观与重要通知展示方式。
 * useTheme / usePreferences 逻辑原样；展示层迁到 antd Card + Segmented + List。
 */
import { CheckOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import { Button, Card, Col, Flex, List, Row, Segmented, Space, Switch, Typography } from "antd";
import { PageHeader } from "../../components/PageHeader.js";
import { useTheme } from "../../theme/ThemeProvider.js";
import { usePreferences } from "../../lib/preferences.js";

const { Text } = Typography;

export function PreferencesPanel() {
  const { mode, setMode } = useTheme();
  const [preferences, setPreferences] = usePreferences();

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
          extra={<Text type="secondary">默认显示提醒和紧急通知</Text>}
        >
          <List size="small">
            <List.Item
              actions={[
                <Switch
                  key="badge"
                  checked={preferences.notificationBadgeEnabled}
                  onChange={(checked) =>
                    setPreferences({ ...preferences, notificationBadgeEnabled: checked })
                  }
                  checkedChildren={<CheckOutlined />}
                />,
              ]}
            >
              <List.Item.Meta
                title="右上角未读徽标"
                description="有未读重要通知时，在铃铛上显示数量。"
              />
            </List.Item>
            <List.Item
              actions={[
                <Segmented
                  key="scope"
                  size="small"
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
                />,
              ]}
            >
              <List.Item.Meta
                title="通知范围"
                description={
                  preferences.notificationMinSeverity === "critical"
                    ? "只显示紧急通知"
                    : "显示提醒和紧急通知"
                }
              />
            </List.Item>
          </List>
          <Text type="secondary">
            未送达的紧急通知仍会继续显示在页面横幅中，标记已读不会隐藏故障。
          </Text>
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
          eyebrow="常规偏好"
          title="设置"
          description="调整界面外观和重要通知的显示方式。"
        />
        <PreferencesPanel />
        <Flex justify="flex-end">
          <Button type="link" href="#top" icon={<CheckOutlined />}>
            偏好会自动保存
          </Button>
        </Flex>
      </Flex>
    </section>
  );
}
