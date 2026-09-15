import { useCallback, useEffect, useState } from "react";
import { ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { App, Button, Flex, Form, Switch, Typography } from "antd";
import { loadJson } from "../../lib/api.js";
import {
  TASK_DEFAULTS_KEY,
  readScheduledTaskDefaults,
  type ScheduledTaskDefaults,
} from "./taskDefaults.js";

export function TaskDefaultsPanel() {
  const { message } = App.useApp();
  const [form] = Form.useForm<ScheduledTaskDefaults>();
  const [timezone, setTimezone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await loadJson<{ timezone?: string | null; supported?: boolean }>(
      "/api/scheduled-tasks/status",
    );
    setTimezone(
      result.ok && result.data.supported !== false ? (result.data.timezone ?? null) : null,
    );
    setLoading(false);
  }, []);
  useEffect(() => {
    form.setFieldsValue(readScheduledTaskDefaults());
  }, [form]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <>
      <Typography.Title level={4} style={{ margin: 0 }}>
        定时任务默认值
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        仅用于此浏览器中新建的任务，不修改已有任务或 Hermes 的调度配置。
      </Typography.Paragraph>
      <Flex wrap gap={12} align="center">
        <Typography.Text>
          调度时区：{loading ? "读取中" : (timezone ?? "暂时无法读取")}
        </Typography.Text>
        <Button
          icon={<ReloadOutlined />}
          aria-label="刷新调度时区"
          loading={loading}
          onClick={() => void refresh()}
        />
      </Flex>
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => {
          try {
            localStorage.setItem(TASK_DEFAULTS_KEY, JSON.stringify(values));
            message.success("默认值已保存。");
          } catch {
            message.error("浏览器无法保存默认值，请允许本地存储后重试。");
          }
        }}
      >
        <Form.Item name="deliveryEnabled" label="完成后通知" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Button type="primary" htmlType="submit" icon={<SaveOutlined />}>
          保存默认值
        </Button>
      </Form>
    </>
  );
}
