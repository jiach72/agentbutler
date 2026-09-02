/**
 * 消息链路一键接管：开=Butler 策略接管，关=Hermes 原通道直发（记录保留）。
 */
import { useState } from "react";
import { App, Button, Card, Flex, Switch, Typography } from "antd";
import { postJson } from "../../lib/api.js";
import { channelActionError, relayModeCopy } from "./helpers.js";
import type { RelayControlView } from "./helpers.js";

interface RelayControlCardProps {
  relay: RelayControlView;
  onChanged: () => void;
}

export function RelayControlCard({ relay, onChanged }: RelayControlCardProps) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const copy = relayModeCopy(relay);
  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const result = await postJson("/api/messages/relay", { enabled: next }, 10_000);
      if (!result.ok) {
        message.error(channelActionError(result.status, result.data));
        return; // 切换失败不回调刷新，开关状态以上一次成功数据为准
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <Flex align="center" justify="space-between" gap={16} wrap="wrap">
        <Flex vertical gap={4}>
          <Flex align="center" gap={12}>
            <Typography.Text strong>{copy.title}</Typography.Text>
            <Switch
              checked={relay.enabled}
              loading={busy}
              onChange={(next) => void toggle(next)}
              checkedChildren="接管"
              unCheckedChildren="原通道"
            />
          </Flex>
          <Typography.Text type="secondary">{copy.detail}</Typography.Text>
        </Flex>
        <Button type="text" onClick={onChanged}>
          刷新状态
        </Button>
      </Flex>
    </Card>
  );
}
