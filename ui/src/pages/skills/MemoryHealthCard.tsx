/**
 * 记忆健康卡片：健康分、信号明细、管家建议与自检/备份操作。
 * 建议项携带 action（如 rebuild-index）时渲染一键修复按钮。
 */
import { Alert, Button, Card, Flex, Progress, Typography } from "antd";
import { theme } from "antd";
import type { MemoryHealthView, MemorySelfCheckView } from "./helpers.js";
import { healthTone, signalLabel } from "./helpers.js";

interface MemoryHealthCardProps {
  health: MemoryHealthView | null;
  selfCheck: { busy: boolean; result: MemorySelfCheckView | null };
  onSelfCheck: () => void;
  onBackup: () => void;
  /** 一键修复（重试外部记忆后端失败的后台操作）。 */
  onRebuildIndex?: () => void;
  rebuildBusy?: boolean;
  backupBusy: boolean;
  memoryWritesEnabled?: boolean | null;
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
  onRebuildIndex,
  rebuildBusy = false,
  backupBusy,
  memoryWritesEnabled = null,
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
            <Flex vertical gap={6} className="divide-y divide-outline-variant/10">
              {health.suggestions.map((suggestion, idx) => (
                <Flex
                  key={suggestion.title || idx}
                  justify="space-between"
                  align="center"
                  className={idx > 0 ? "pt-2" : undefined}
                >
                  <Flex vertical gap={2}>
                    <Typography.Text strong style={{ fontSize: 13 }}>{suggestion.title}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{suggestion.detail}</Typography.Text>
                  </Flex>
                  {suggestion.action === "rebuild-index" && onRebuildIndex !== undefined && (
                    <Button
                      size="small"
                      type="primary"
                      disabled={rebuildBusy}
                      onClick={onRebuildIndex}
                    >
                      {rebuildBusy ? "修复中…" : "一键修复"}
                    </Button>
                  )}
                </Flex>
              ))}
            </Flex>
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

        <Alert
          type={memoryWritesEnabled === null ? "warning" : memoryWritesEnabled ? "warning" : "info"}
          showIcon
          title={
            memoryWritesEnabled === null
              ? "记忆写操作状态暂不可知"
              : memoryWritesEnabled
                ? "记忆写操作已开启"
                : "记忆写操作默认关闭"
          }
          description={
            memoryWritesEnabled === null
              ? "无法确认当前部署是否允许记忆写操作；在状态明确前，按只读处理。"
              : memoryWritesEnabled
                ? "归档、恢复、清理和重建索引入口已可用；每次写操作前会先备份并写入本机审计记录。"
                : "当前只提供查看、检索、自检和备份。需要归档、恢复、清理或重建索引时，请在本机部署配置中设置 BUTLER_MEMORY_WRITES_ENABLED=true 后重启 Watch；网页不会代你修改 .env 或执行宿主命令（外部记忆服务如 hindsight 的日常读写不受此门禁限制）。"
          }
        />

        <Flex vertical gap={6} className="divide-y divide-outline-variant/10">
          {health.signals.map((signal, idx) => (
            <Flex
              key={signal.id || idx}
              vertical
              gap={2}
              className={idx > 0 ? "pt-2" : undefined}
            >
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
                <Typography.Text strong style={{ fontSize: 13 }}>
                  {signalLabel(signal.id, signal.label)}
                </Typography.Text>
              </Flex>
              <Typography.Text type="secondary" style={{ fontSize: 12, paddingLeft: 15 }}>
                {signal.detail}
              </Typography.Text>
            </Flex>
          ))}
        </Flex>

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
            title={
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
