import { useCallback, useEffect, useState } from "react";

import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { App, Button, Card, Flex, Form, InputNumber, Select, Switch, Table, Typography } from "antd";

import { deleteJson, fetchJson, postJson } from "../../lib/api.js";

interface DndRuleRow {
  ruleId: string;
  scope: string;
  scopeKey: string | null;
  timeZone: string;
  startMinute: number | null;
  endMinute: number | null;
  pausedUntil: string | null;
  enabled: boolean;
  updatedAt: string;
}

const SCOPE_OPTIONS = [
  { value: "global", label: "全局" },
  { value: "channel", label: "按通道" },
  { value: "session", label: "按会话" },
];

function minutesToLabel(minutes: number | null): string {
  if (minutes === null) return "—";
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function DndRulesCard() {
  const { message } = App.useApp();
  const [rules, setRules] = useState<DndRuleRow[]>([]);
  const [reachable, setReachable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    const result = await fetchJson<{ items: DndRuleRow[] }>("/api/messages/dnd");
    if (result !== null) {
      setReachable(true);
      setRules(result.items ?? []);
    } else {
      setReachable(false);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upsert = useCallback(
    async (payload: Record<string, unknown>, path: string) => {
      setSubmitting(true);
      const result = await postJson(path, payload, 10_000);
      setSubmitting(false);
      if (result.status === 200) {
        message.success("免打扰规则已保存");
        form.resetFields(["scopeKey"]);
        await refresh();
      } else {
        const detail =
          typeof (result.data as { detail?: unknown } | null)?.detail === "string"
            ? (result.data as { detail: string }).detail
            : null;
        message.error(detail !== null ? `保存失败：${detail}` : "保存失败，请稍后重试");
      }
    },
    [form, message, refresh],
  );

  const remove = useCallback(
    async (ruleId: string) => {
      const result = await deleteJson(`/api/messages/dnd/${encodeURIComponent(ruleId)}`);
      if (result !== null) {
        message.success("规则已删除");
        await refresh();
      } else {
        message.error("删除失败，请稍后重试");
      }
    },
    [message, refresh],
  );

  const toggle = useCallback(
    async (rule: DndRuleRow) => {
      await upsert(
        {
          timeZone: rule.timeZone,
          startMinute: rule.startMinute,
          endMinute: rule.endMinute,
          pausedUntil: rule.pausedUntil,
          enabled: !rule.enabled,
        },
        `/api/messages/dnd/${rule.scope}/${encodeURIComponent(rule.scopeKey ?? "global")}`,
      );
    },
    [upsert],
  );

  const onSubmit = useCallback(
    (values: { scope: string; scopeKey: string | null; startMinute: number | null; endMinute: number | null; timeZone: string }) => {
      const scopeKey = values.scope === "global" ? "global" : values.scopeKey;
      if (values.scope !== "global" && (scopeKey === null || scopeKey.trim() === "")) {
        message.error("请填写通道或会话标识");
        return;
      }
      void upsert(
        {
          timeZone: values.timeZone || "Asia/Shanghai",
          startMinute: values.startMinute ?? null,
          endMinute: values.endMinute ?? null,
          pausedUntil: null,
          enabled: true,
        },
        `/api/messages/dnd/${values.scope}/${encodeURIComponent(scopeKey ?? "global")}`,
      );
    },
    [message, upsert],
  );

  const columns = [
    { title: "范围", key: "scope", render: (_: unknown, r: DndRuleRow) => (r.scope === "global" ? "全局" : `${r.scope}:${r.scopeKey ?? ""}`) },
    { title: "时段", key: "window", render: (_: unknown, r: DndRuleRow) => `${minutesToLabel(r.startMinute)} – ${minutesToLabel(r.endMinute)}` },
    { title: "时区", key: "tz", render: (_: unknown, r: DndRuleRow) => r.timeZone },
    {
      title: "启用",
      key: "enabled",
      render: (_: unknown, r: DndRuleRow) => <Switch size="small" checked={r.enabled} onChange={() => void toggle(r)} />,
    },
    {
      title: "",
      key: "actions",
      render: (_: unknown, r: DndRuleRow) => (
        <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => void remove(r.ruleId)} />
      ),
    },
  ];

  return (
    <Card title={<Typography.Text strong>免打扰规则</Typography.Text>} extra={<Typography.Text type="secondary">{reachable ? "" : "gateway 不可达"}</Typography.Text>}>
      <Flex vertical gap={12}>
        <Form form={form} layout="inline" onFinish={onSubmit} initialValues={{ scope: "global", timeZone: "Asia/Shanghai" }}>
          <Form.Item name="scope" rules={[{ required: true }]}>
            <Select options={SCOPE_OPTIONS} style={{ width: 100 }} />
          </Form.Item>
          <Form.Item name="scopeKey" dependencies={["scope"]} noStyle>
            {({ getFieldValue }) =>
              getFieldValue("scope") !== "global" ? (
                <Form.Item name="scopeKey" rules={[{ required: true, message: "请填写标识" }]}>
                  <InputNumber placeholder="通道或会话标识" style={{ width: 160 }} />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item name="startMinute" rules={[{ required: true, message: "开始" }]}>
            <InputNumber min={0} max={1439} placeholder="开始（分钟）" style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="endMinute" rules={[{ required: true, message: "结束" }]}>
            <InputNumber min={0} max={1439} placeholder="结束（分钟）" style={{ width: 120 }} />
          </Form.Item>
          <Form.Item name="timeZone" rules={[{ required: true }]}>
            <InputNumber placeholder="Asia/Shanghai" style={{ width: 140 }} hidden />
          </Form.Item>
          <Button htmlType="submit" icon={<PlusOutlined />} loading={submitting}>
            添加规则
          </Button>
        </Form>
        <Table
          rowKey="ruleId"
          size="small"
          columns={columns}
          dataSource={rules}
          loading={loading}
          pagination={false}
          locale={{ emptyText: "暂无规则" }}
        />
      </Flex>
    </Card>
  );
}
