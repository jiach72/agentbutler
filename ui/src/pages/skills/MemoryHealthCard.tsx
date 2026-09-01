/**
 * 记忆健康卡片：健康分、信号明细、管家建议与自检/备份操作。
 */
import { Alert, Button, Card, Flex, List, Progress, Typography } from "antd";
import { theme } from "antd";
import type { MemoryHealthView, MemorySelfCheckView } from "./helpers.js";
import { healthTone, signalLabel } from "./helpers.js";

interface MemoryHealthCardProps {
  health: MemoryHealthView | null;
  selfCheck: { busy: boolean; result: MemorySelfCheckView | null };
  onSelfCheck: () => void;
  onBackup: () => void;
  backupBusy: boolean;
}

/** 信号状态 → 语义 token 色（避免散落硬编码颜色）。 */
function signalColor(
  status: string,
  token: { colorSuccess: string; colorWarning: string; colorError: string; colorTextQuaternary: string },
): string {
  if (status === "ok") return token.colorSuccess;
  if (status === "warn") return token.colorWarning;
  if (status === "error") return token.colorError;
  return token.colorTextQuaternary;
}

export function MemoryHealthCard({
  health,
  selfCheck,
  onSelfCheck,
  onBackup,
  backupBusy,
}: MemoryHealthCardProps) {
  const { token } = theme.useToken();
  if (health === null) {
    return (
      <Card size="small" title="记忆健康">
        <Typography.Text type="secondary">管家还没返回健康分析</Typography.Text>
      </Card>
    );
  }
  const tone = healthTone(health.score);
  const score = Math.round(health.score);
  const toneColor =
    tone === "good"
      ? token.colorSuccess
      : tone === "ok"
        ? token.colorPrimary
        : tone === "warn"
          ? token.colorWarning
          : token.colorError;
  return (
    <Card size="small" title="记忆健康">
      <Flex vertical gap={16}>
        <Flex gap={16} align="center" wrap="wrap">
          <Progress
            type="circle"
            size={72}
            percent={score}
            strokeColor={toneColor}
            format={() => String(score)}
          />
          <Typography.Text type="secondary">
            {tone === "good"
              ? "状态很好，不需要动手"
              : tone === "ok"
                ? "基本正常，可留意建议"
                : tone === "warn"
                  ? "有需要注意的地方"
                  : "建议尽快处理"}
          </Typography.Text>
        </Flex>

        {health.suggestions.length > 0 && (
          <Flex vertical gap={4}>
            <Typography.Text strong>管家建议</Typography.Text>
            <List
              size="small"
              dataSource={health.suggestions}
              renderItem={(suggestion) => (
                <List.Item style={{ padding: "6px 0" }}>
                  <List.Item.Meta title={suggestion.title} description={suggestion.detail} />
                </List.Item>
              )}
            />
          </Flex>
        )}

        <Flex gap={8} wrap="wrap">
          <Button
            disabled={backupBusy}
            onClick={onBackup}
            title="把记忆库备份到本地，升级或恢复前更安心"
          >
            {backupBusy ? "备份中…" : "记忆备份"}
          </Button>
          <Button
            disabled={selfCheck.busy}
            onClick={onSelfCheck}
            title="写入并召回一条管家测试记忆后自动清理，不会改动你的记忆"
          >
            {selfCheck.busy ? "自检中…" : "立即自检记忆"}
          </Button>
        </Flex>

        <List
          size="small"
          dataSource={health.signals}
          renderItem={(signal) => (
            <List.Item style={{ padding: "6px 0" }}>
              <List.Item.Meta
                avatar={undefined}
                title={
                  <Flex align="center" gap={8}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        flexShrink: 0,
                        background: signalColor(signal.status, token),
                      }}
                    />
                    {signalLabel(signal.id, signal.label)}
                  </Flex>
                }
                description={signal.detail}
              />
            </List.Item>
          )}
        />

        {selfCheck.result !== null && (
          <Alert
            role="status"
            type={
              selfCheck.result.status === "pass"
                ? "success"
                : selfCheck.result.status === "warn"
                  ? "warning"
                  : selfCheck.result.status === "skipped"
                    ? "info"
                    : "error"
            }
            showIcon
            message={
              selfCheck.result.status === "pass"
                ? "记忆读写正常"
                : selfCheck.result.status === "warn"
                  ? "记忆读写基本正常，需要留意"
                  : selfCheck.result.status === "skipped"
                    ? "本次自检跳过"
                    : "记忆读写有问题"
            }
            description={selfCheck.result.detail}
          />
        )}
      </Flex>
    </Card>
  );
}
