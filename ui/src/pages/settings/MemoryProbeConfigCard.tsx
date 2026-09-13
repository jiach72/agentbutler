/**
 * 记忆探针频率设置卡片（成本治理）：
 * 完整写入探针会触发 hindsight 的 LLM 事实抽取（deepseek 调用，有 API 成本）。
 * 此卡片让用户看到当前频率并自行调整，同时明示成本含义。
 */
import { useCallback, useEffect, useState } from "react";
import { App, Card, Flex, Select, Typography } from "antd";
import { loadJson, postJson } from "../../lib/api.js";

const { Text } = Typography;

const OPTIONS = [
  { value: 5, label: "5 分钟（高频，抽取成本最高）" },
  { value: 15, label: "15 分钟" },
  { value: 30, label: "30 分钟（推荐）" },
  { value: 60, label: "1 小时" },
  { value: 120, label: "2 小时（最省，写入验证延迟较大）" },
];

export function MemoryProbeConfigCard() {
  const { message } = App.useApp();
  const [intervalMin, setIntervalMin] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    void loadJson<{ intervalMin: number }>("/api/memory-probe/config", 6_000).then((result) => {
      if (result.ok) setIntervalMin(result.data.intervalMin);
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const save = useCallback(async (min: number) => {
    setSaving(true);
    const result = await postJson("/api/memory-probe/config", { intervalMin: min }, 15_000);
    setSaving(false);
    if (result.ok) {
      setIntervalMin(min);
      message.success(`记忆探针写入验证频率已改为每 ${min} 分钟`);
    } else {
      message.error("保存失败，请确认管家服务在线");
    }
  }, [message]);

  const costHint = intervalMin === null
    ? ""
    : intervalMin <= 5
      ? "每次写入探针会触发 hindsight 的 LLM 事实抽取（deepseek 调用）。当前频率较高，API 成本相应增加。"
      : intervalMin <= 30
        ? "当前频率在成本与健康检测之间取得平衡。"
        : "当前频率很省，但写入链路故障的发现延迟会增大。";

  return (
    <Card size="small" title="记忆探针频率">
      <Flex vertical gap={8}>
        <Text type="secondary">
          完整写入探针每轮会触发记忆服务的 LLM 事实抽取（deepseek 调用），产生 API 成本。
          两次完整探针之间，系统以只读召回探针（零 LLM 成本）持续监控记忆服务健康。
        </Text>
        <Flex justify="space-between" align="center" gap={16} wrap="wrap">
          <Select
            value={intervalMin ?? undefined}
            onChange={(value) => void save(value)}
            loading={saving}
            style={{ minWidth: 260 }}
            options={OPTIONS}
            placeholder="读取中…"
          />
          {costHint !== "" && (
            <Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 200 }}>
              {costHint}
            </Text>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}
