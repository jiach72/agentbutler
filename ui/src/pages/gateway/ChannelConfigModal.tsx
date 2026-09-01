/**
 * 通道首次接入/配置弹窗：按 Bridge schema 动态渲染；secret 字段掩码、留空不修改。
 * 保存 → 启用 → Bridge 触发优雅重启 → 轮询目录直至通道上线或超时提示。
 */
import { Alert, Form, Input, Modal, Typography } from "antd";
import { useEffect, useState } from "react";
import { fetchJson, postJson } from "../../lib/api.js";
import { responseError } from "./helpers.js";

interface ChannelConfigModalProps {
  channel: string;
  label: string;
  onClose: () => void;
  onApplied: () => void;
}

interface FieldSchema {
  name: string;
  label: string;
  required: boolean;
  secret: boolean;
}

interface SchemaView {
  channel: string;
  kind: string;
  label: string;
  fields: FieldSchema[];
}

export function ChannelConfigModal({ channel, label, onClose, onApplied }: ChannelConfigModalProps) {
  const [schema, setSchema] = useState<SchemaView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    let active = true;
    void fetchJson<SchemaView>(`/api/messages/channels/${encodeURIComponent(channel)}/schema`).then((data) => {
      if (!active) return;
      if (data === null) {
        setError("无法读取配置要求，请确认消息服务可达后关闭重试");
        return;
      }
      setSchema(data);
    });
    return () => {
      active = false;
    };
  }, [channel]);

  const apply = async (): Promise<void> => {
    setError(null);
    const values = form.getFieldsValue() as Record<string, string | undefined>;
    const payload = Object.fromEntries(
      Object.entries(values).filter(([, value]) => typeof value === "string" && value.trim() !== ""),
    ) as Record<string, string>;
    setApplying(true);
    try {
      const saved = await postJson(`/api/messages/channels/${encodeURIComponent(channel)}/config`, payload, 10_000);
      if (!saved.ok) {
        const detail = responseError(saved.data);
        setError(detail !== "" ? `保存失败：${detail}` : `保存失败（HTTP ${saved.status}）`);
        return;
      }
      await postJson(`/api/messages/channels/${encodeURIComponent(channel)}/enable`, {}, 10_000);
      onApplied();
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal
      open
      title={`配置 ${label}`}
      confirmLoading={applying}
      onOk={() => void apply()}
      onCancel={onClose}
      okText="保存并启用"
    >
      {error !== null && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Typography.Paragraph type="secondary">
        保存后管家会重启消息通道使其生效，期间通道状态会短暂显示「应用中」。
      </Typography.Paragraph>
      {schema === null ? (
        error === null ? (
          <Typography.Text type="secondary">正在读取配置要求…</Typography.Text>
        ) : null
      ) : (
        <Form form={form} layout="vertical">
          {schema.fields.map((field) => (
            <Form.Item
              key={field.name}
              name={field.name}
              label={field.label}
              rules={field.required ? [{ required: true, message: `${field.label} 为必填` }] : undefined}
              extra={field.secret ? "留空表示不修改已保存的值" : undefined}
            >
              <Input type={field.secret ? "password" : "text"} autoComplete="off" />
            </Form.Item>
          ))}
        </Form>
      )}
    </Modal>
  );
}
