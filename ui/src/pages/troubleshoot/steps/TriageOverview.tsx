/**
 * 体检总览（排查页新首屏）：进入页面即静默体检，先给结论再给人操作。
 *
 * 三种形态：
 * - 全绿：0 操作，告诉用户「没事」，附检查明细（收起）；
 * - 有提醒（warn）：结论 + 推荐动作（1 键执行，无需进向导）；
 * - 有问题（error）：最可能的原因 + 推荐动作 1 键执行 + 全部动作进阶入口。
 *
 * 产品原则：用户带着焦虑来，第一屏必须是答案而不是选择题。
 * 现象选择不删除——降级为「按我的感受重新聚焦」，只影响排序不隐藏信息。
 */
import { CaretRightOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Card, Flex, Progress, Skeleton, Space, Typography } from "antd";
import { IssueCard } from "../../../components/IssueCard.js";
import { AdvancedEvidence } from "../../../components/AdvancedEvidence.js";
import { StatusBadge } from "../../../components/StatusBadge.js";
import { formatRelative } from "../../../lib/format.js";
import type { RecoveryActionView, RecoveryDiagnosisView } from "../../dashboard/types.js";
import type { TriageSummary } from "../useTroubleshoot.js";
import { useExportReport } from "../exportReport.js";
import { guidanceForDiagnosis } from "../guidance.js";

const { Text, Paragraph } = Typography;

const PROBE_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "error" | "unknown" }> = {
  pass: { label: "正常", tone: "ok" },
  warn: { label: "需留意", tone: "warn" },
  fail: { label: "不正常", tone: "error" },
};

/** 推荐动作卡：风险用后果说（会中断服务），不用等级说（high risk）。 */
const RISK_LABEL: Record<
  RecoveryActionView["risk"],
  { text: string; tone: "ok" | "warn" | "error" }
> = {
  low: { text: "不影响使用", tone: "ok" },
  medium: { text: "会有短暂影响", tone: "warn" },
  high: { text: "会中断服务", tone: "error" },
};

interface TriageOverviewProps {
  triage: TriageSummary | null;
  triageBusy: boolean;
  diagnosis: RecoveryDiagnosisView | null;
  recommended: RecoveryActionView | null;
  alternatives: RecoveryActionView[];
  jobRunning: boolean;
  jobDetail: string;
  jobProgress: number;
  busy: boolean;
  onRerun: () => void;
  onRunAction: (action: RecoveryActionView) => void;
  onOpenWizard: () => void;
}

export function TriageOverview({
  triage,
  triageBusy,
  diagnosis,
  recommended,
  alternatives,
  jobRunning,
  jobDetail,
  jobProgress,
  busy,
  onRerun,
  onRunAction,
  onOpenWizard,
}: TriageOverviewProps) {
  const { exportReport } = useExportReport();

  if (triage === null) {
    return (
      <Card size="small">
        <Flex vertical gap={12} align="flex-start">
          {triageBusy ? (
            <>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                正在做一轮完整体检（进程、接口、记忆、消息通道、模型连接），完成后自动出结论，不用刷新页面。
              </Paragraph>
              <Skeleton active paragraph={{ rows: 2 }} title={false} />
            </>
          ) : (
            <>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                刚才这轮体检没有读到结果，可能是管家服务暂时不可用。
              </Paragraph>
              <Button type="primary" icon={<ReloadOutlined />} onClick={onRerun}>
                再试一次
              </Button>
            </>
          )}
        </Flex>
      </Card>
    );
  }

  const tone = triage.tone;
  const guidance = guidanceForDiagnosis(diagnosis);

  return (
    <Flex vertical gap={16}>
      <IssueCard
        title={
          tone === "ok"
            ? "本次检查未发现需要处理的问题"
            : tone === "warn"
              ? "本次检查发现需要核实的提醒"
              : "本次检查发现影响使用的问题"
        }
        impact={tone === "ok" ? "当前检查范围内未发现使用受阻。" : guidance.detail}
        suggestion={
          tone === "ok"
            ? "无需处理；使用仍有异常时可以按现象继续排查。"
            : (recommended?.label ?? "没有可自动执行的修复建议，请按现象排查或导出报告核实。")
        }
        risk={
          tone === "ok" || recommended === null
            ? "查看与复查不会修改运行配置。"
            : `${RISK_LABEL[recommended.risk].text}；${recommended.impact}`
        }
        verification="完成操作后重新体检，并在原来的会话或通道确认功能恢复。"
        action={
          <Space wrap>
            {tone !== "ok" && recommended !== null && !jobRunning && (
              <Button
                type="primary"
                icon={<CaretRightOutlined />}
                loading={busy}
                onClick={() => onRunAction(recommended)}
              >
                执行「{recommended.label}」
              </Button>
            )}
            <Button icon={<ReloadOutlined />} onClick={onRerun} loading={triageBusy || busy}>
              重新体检
            </Button>
            {alternatives.length > 0 && <Button onClick={onOpenWizard}>其他处理方式</Button>}
          </Space>
        }
        evidence={
          <>
            <Paragraph>
              {triage.title} · {triage.rootCause} · {triage.detail}
            </Paragraph>
            {diagnosis !== null && (
              <Text>
                检查时间：{formatRelative(diagnosis.checkedAt)} · 共 {diagnosis.probes.length}{" "}
                项检查
              </Text>
            )}
            {(diagnosis?.probes ?? []).map((probe) => {
              const status = PROBE_STATUS[probe.status] ?? {
                label: "未知",
                tone: "unknown" as const,
              };
              return (
                <Flex key={probe.id} vertical gap={4}>
                  <StatusBadge {...status} />
                  <Text strong>{probe.label}</Text>
                  <Text>{probe.detail}</Text>
                </Flex>
              );
            })}
          </>
        }
      />

      {/* 动作执行中：进度条 + 实时说明 */}
      {jobRunning && (
        <Card size="small">
          <Flex vertical gap={8}>
            <Text strong>正在执行处理动作…</Text>
            <AdvancedEvidence>
              <Text>{jobDetail}</Text>
            </AdvancedEvidence>
            <Progress percent={jobProgress} status="active" />
            <Text type="secondary" style={{ fontSize: 12 }}>
              完成后会自动复查。请以复查结果判断是否恢复，不要重复发起操作。
            </Text>
          </Flex>
        </Card>
      )}

      {/* 底部出口：主次分明，向导入口弱化为文字链 */}
      <div className="ts-footer-links">
        <Button type="primary" ghost onClick={onOpenWizard}>
          按现象仔细查（完整向导）
        </Button>
        {tone !== "ok" && (
          <Button onClick={() => window.location.assign(guidance.to)}>{guidance.label}</Button>
        )}
        <Button type="text" onClick={() => void exportReport()}>
          下载诊断报告
        </Button>
      </div>
    </Flex>
  );
}
