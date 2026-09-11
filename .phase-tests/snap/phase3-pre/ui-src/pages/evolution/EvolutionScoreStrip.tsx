import { Card, Col, Flex, Progress, Row, Statistic, Typography } from "antd";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatDecimal, formatNumber, formatPercent } from "../../lib/format.js";
import type { EvolutionOverviewPayload } from "./types.js";

function percent(value: number | null): string {
  return formatPercent(value, 0, "未知");
}
function number(value: number | null): string {
  return value === null ? "未知" : formatNumber(value);
}

/** 健康分状态 → Progress 主色（全部走 antd token 变量）。 */
const SCORE_STROKE: Record<string, string> = {
  ok: "var(--ant-color-success)",
  warn: "var(--ant-color-warning)",
  error: "var(--ant-color-error)",
};

const suffixText = { fontSize: 12 } as const;

export function EvolutionScoreStrip({ overview }: { overview: EvolutionOverviewPayload }) {
  const score = overview.totals.healthScore;
  const statusTone =
    overview.status === "healthy"
      ? "ok"
      : overview.status === "offline" || overview.status === "blocked"
        ? "error"
        : "warn";
  const latest = overview.evolution.latest;
  return (
    <Row gutter={[16, 16]} aria-label="自进化核心指标">
      <Col xs={24} md={8}>
        <Card size="small" style={{ height: "100%" }}>
          <Flex vertical gap={8} aria-label="整体健康分">
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em" }}
            >
              整体健康分
            </Typography.Text>
            <Typography.Text strong style={{ fontSize: 20 }}>
              {score === null ? "样本不足" : `${formatDecimal(score, 1)} / 100`}
            </Typography.Text>
            <Progress
              percent={score ?? 0}
              showInfo={false}
              strokeColor={SCORE_STROKE[statusTone]}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {overview.statusDetail}
            </Typography.Text>
          </Flex>
        </Card>
      </Col>
      <Col xs={12} md={8}>
        <Card size="small" style={{ height: "100%" }}>
          <Statistic title="工具成功率" value={percent(overview.totals.successRate)} />
        </Card>
      </Col>
      <Col xs={12} md={8}>
        <Card size="small" style={{ height: "100%" }}>
          <Statistic
            title="会话"
            value={number(overview.totals.sessions)}
            suffix={
              <Typography.Text type="secondary" style={suffixText}>
                已完成 {overview.totals.completedSessions}
              </Typography.Text>
            }
          />
        </Card>
      </Col>
      <Col xs={12} md={8}>
        <Card size="small" style={{ height: "100%" }}>
          <Statistic
            title="工具调用"
            value={number(overview.totals.toolCalls)}
            suffix={
              <Typography.Text type="secondary" style={suffixText}>
                未知 {overview.totals.unknownToolCalls}
              </Typography.Text>
            }
          />
        </Card>
      </Col>
      <Col xs={12} md={8}>
        <Card size="small" style={{ height: "100%" }}>
          <Statistic
            title="真实样本"
            value={overview.datasets.realSamples}
            suffix={
              <Typography.Text type="secondary" style={suffixText}>
                / {overview.datasets.realSamples + overview.datasets.gap}
              </Typography.Text>
            }
          />
        </Card>
      </Col>
      <Col xs={12} md={8}>
        <Card size="small" style={{ height: "100%" }}>
          <Statistic
            title="最近 improvement"
            value={
              latest?.improvement === null || latest === null
                ? "未知"
                : formatDecimal(latest.improvement, 3)
            }
            suffix={
              latest?.gainScore === null || latest?.gainScore === undefined ? undefined : (
                <StatusBadge
                  tone={latest.gainScore >= 100 ? "ok" : latest.gainScore === 0 ? "error" : "warn"}
                  label={`${formatNumber(latest.gainScore)} 分`}
                />
              )
            }
          />
        </Card>
      </Col>
    </Row>
  );
}
