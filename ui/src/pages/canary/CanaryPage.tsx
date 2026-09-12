/**
 * 升级策略页（Trust Layer M3.2）：版本策略 + 金丝雀验证记录 + 准入判据差异报告。
 *
 * 三件事必须在页面上说清楚：
 * 1. 当前策略决定「要不要跑金丝雀、观察窗多长」；
 * 2. 三指标准入判据逐条给出了实测值与是否通过——数据缺失时明确标注「按不通过处理」；
 * 3. 影子执行器是否可用：不可用时**绝不算通过**，标准策略记为「未验证」、保守策略直接拦截。
 */
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Flex,
  Modal,
  Radio,
  Space,
  Table,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ExperimentOutlined, ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import type { PageConclusionView } from "../../components/ConclusionBar.js";
import { Empty } from "../../components/Empty.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatStrip } from "../../components/StatStrip.js";
import type { StatStripItem } from "../../components/StatStrip.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import type { SemanticTone } from "../../components/StatusBadge.js";
import { loadJson, postJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";

type Policy = "aggressive" | "standard" | "conservative";

interface CanaryCheck {
  id: string;
  label: string;
  baseline: number | null;
  shadow: number | null;
  tolerance: string;
  pass: boolean;
  detail: string;
}

interface CanaryMetrics {
  successRate: number | null;
  avgTokens: number | null;
  avgDurationMs: number | null;
  sampleSize: number;
  errorFingerprints: string[];
  outputSimilarity: number | null;
  source: string;
}

interface CanaryRun {
  id: string;
  instance: string;
  fromVersion: string | null;
  targetVersion: string;
  policy: Policy;
  status: string;
  sampleRegular: number;
  sampleFailed: number;
  tasks: Array<{ sessionId: string; outcome: string; bucket: string }>;
  baseline: CanaryMetrics | null;
  shadow: CanaryMetrics | null;
  verdict: { pass: boolean; checks: CanaryCheck[]; notEvaluated: string[] } | null;
  observationUntil: string | null;
  observationRemainingMs: number;
  switchedAt: string | null;
  rollbackSnapshotId: number | null;
  reason: string | null;
  createdAt: string;
  observationWindowMs: number;
}

interface CanaryPayload {
  items: CanaryRun[];
  summary: {
    total: number;
    observing: number;
    passed: number;
    blocked: number;
    unverified: number;
    skipped: number;
    rolledBack: number;
    completed: number;
    lastAt: string | null;
    policy: Policy;
  };
}

/** 验证记录状态 → 语义徽标（不走 antd 预设色名）。 */
const STATUS_TONE: Record<string, SemanticTone> = {
  planned: "brand",
  running: "unknown",
  passed: "ok",
  blocked: "error",
  skipped: "brand",
  unverified: "warn",
  observing: "unknown",
  completed: "ok",
  "rolled-back": "warn",
};
const STATUS_LABEL: Record<string, string> = {
  planned: "已计划",
  running: "验证中",
  passed: "通过",
  blocked: "已拦截",
  skipped: "已跳过",
  unverified: "未验证",
  observing: "观察中",
  completed: "已完成",
  "rolled-back": "已回滚",
};

const POLICY_META: Record<Policy, { label: string; note: string }> = {
  aggressive: { label: "激进", note: "跳过金丝雀，直接切换（最快，风险自担）" },
  standard: { label: "标准（默认）", note: "跑金丝雀验证 + 24 小时观察窗" },
  conservative: { label: "保守", note: "跑金丝雀验证 + 48 小时观察窗；验证不可用则拦截升级" },
};

const fmtPct = (value: number | null): string => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
const fmtNum = (value: number | null, digits = 0): string =>
  value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: digits });

const observationText = (run: CanaryRun): string => {
  if (run.status !== "observing") return "—";
  if (run.observationRemainingMs <= 0) return "即将收敛";
  const hours = Math.floor(run.observationRemainingMs / 3_600_000);
  const minutes = Math.round((run.observationRemainingMs % 3_600_000) / 60_000);
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`;
};

export function CanaryPage() {
  const [data, setData] = useState<CanaryPayload | null>(null);
  const [policy, setPolicy] = useState<Policy>("standard");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<CanaryRun | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void loadJson<CanaryPayload>("/api/canary?limit=50", 20_000).then((result) => {
      if (result.ok) {
        setData(result.data);
        setPolicy(result.data.summary.policy);
        setError(null);
      } else {
        setError(result.reason);
      }
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 30_000);

  const changePolicy = useCallback(
    async (next: Policy) => {
      setBusy(true);
      setNotice(null);
      const result = await postJson("/api/canary/policy", { policy: next }, 30_000);
      setBusy(false);
      if (result.ok) {
        setPolicy(next);
        setNotice(`升级策略已切换为「${POLICY_META[next].label}」`);
      } else {
        setNotice(`策略切换失败（HTTP ${result.status}）`);
      }
      refresh();
    },
    [refresh],
  );

  const tick = useCallback(async () => {
    setBusy(true);
    const result = await postJson("/api/canary/tick", {}, 60_000);
    setBusy(false);
    if (result.ok) {
      const handled = (result.data as { handled?: number } | null)?.handled ?? 0;
      setNotice(handled === 0 ? "观察窗巡检完成：无需处置" : `观察窗巡检完成：处置 ${handled} 条`);
    }
    refresh();
  }, [refresh]);

  const columns: ColumnsType<CanaryRun> = [
    {
      title: "目标版本",
      dataIndex: "targetVersion",
      key: "targetVersion",
      width: 190,
      render: (version: string, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{version}</Typography.Text>
          {row.fromVersion !== null && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              来自 {row.fromVersion}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (status: string) => (
        <StatusBadge tone={STATUS_TONE[status] ?? "unknown"} label={STATUS_LABEL[status] ?? status} />
      ),
    },
    {
      title: "策略",
      dataIndex: "policy",
      key: "policy",
      width: 90,
      render: (value: Policy) => <StatusBadge tone="brand" label={POLICY_META[value]?.label ?? value} />,
    },
    {
      title: "样本",
      key: "samples",
      width: 120,
      render: (_: unknown, row) =>
        row.sampleRegular + row.sampleFailed === 0 ? (
          <Tooltip title="近 7 天没有可抽样的会话记录——先让会话索引跑一轮">
            <Typography.Text type="secondary">无样本</Typography.Text>
          </Tooltip>
        ) : (
          <span>
            {row.sampleRegular} 常规
            {row.sampleFailed > 0 && (
              <>
                {" "}
                <StatusBadge tone="warn" label={`+${row.sampleFailed} 失败`} />
              </>
            )}
          </span>
        ),
    },
    {
      title: "三指标",
      key: "verdict",
      width: 110,
      render: (_: unknown, row) =>
        row.verdict === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : row.verdict.pass ? (
          <StatusBadge tone="ok" label="全部通过" />
        ) : (
          <StatusBadge tone="error" label={`${row.verdict.checks.filter((check) => !check.pass).length} 项未过`} />
        ),
    },
    { title: "观察窗剩余", key: "observation", width: 130, render: (_: unknown, row) => observationText(row) },
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 165,
      render: (value: string) => new Date(value).toLocaleString(),
    },
    {
      title: "",
      key: "action",
      width: 80,
      render: (_: unknown, row) => (
        <Button size="small" type="link" onClick={() => setDetail(row)}>
          详情
        </Button>
      ),
    },
  ];

  const summary = data?.summary;

  /**
   * 页面结论条（规范 03 §2.3 ②「必须有」）。
   * 原「升级策略服务不可用」Alert 并入 offline 档；notice 是操作瞬时反馈，单独保留。
   * 结论穷举各异常档，没异常才下「正常」结论，读不到就不猜。
   */
  const conclusion: PageConclusionView =
    error !== null
      ? {
          tone: "offline",
          title: "升级策略服务暂时读不到",
          copy: error,
          action: <Button onClick={refresh}>重试</Button>,
        }
      : data === null
        ? { tone: "unknown", title: "正在读取升级策略", copy: "正在拉取验证记录与汇总。" }
        : summary !== undefined && summary.blocked > 0
          ? {
              tone: "error",
              title: `有 ${summary.blocked} 次升级被拦截`,
              copy: "保守或验证未过时管家会拦下升级。点开下方记录看原因，或调整策略后重试。",
            }
          : summary !== undefined && summary.rolledBack > 0
            ? {
                tone: "warn",
                title: `有 ${summary.rolledBack} 次升级自动回滚`,
                copy: "观察窗内检出回归，管家已自动回滚——这正是金丝雀要拦的事。",
              }
            : summary !== undefined && summary.unverified > 0
              ? {
                  tone: "warn",
                  title: `有 ${summary.unverified} 次未验证放行`,
                  copy: "标准策略下验证不可用时会记为「未验证」放行；保守策略会直接拦截。详见每条记录。",
                }
              : summary !== undefined && summary.observing > 0
                ? {
                    tone: "unknown",
                    title: `正在观察 ${summary.observing} 次升级`,
                    copy: "观察窗内不切换；到点自动确认，或检出回归自动回滚。",
                  }
                : summary !== undefined
                  ? {
                      tone: "ok",
                      title: "升级策略当前没有待处理的异常",
                      copy: `当前策略：${POLICY_META[summary.policy].label}。最近一次升级：${
                        summary.lastAt !== null ? new Date(summary.lastAt).toLocaleString() : "暂无"
                      }。`,
                    }
                  : {
                      tone: "unknown",
                      title: "升级策略已加载，但汇总未算出",
                      copy: "验证记录照常展示；刷新可补上合计。",
                    };

  const canaryStats: StatStripItem[] =
    summary === undefined
      ? []
      : [
          {
            key: "observing",
            label: "观察中",
            value: summary.observing,
            unit: summary.observing === 0 ? undefined : "次",
            tone: summary.observing > 0 ? "unknown" : undefined,
          },
          {
            key: "blocked",
            label: "已拦截",
            value: summary.blocked,
            unit: summary.blocked === 0 ? undefined : "次",
            tone: summary.blocked > 0 ? "error" : undefined,
          },
          {
            key: "unverified",
            label: "未验证放行",
            value: summary.unverified,
            unit: summary.unverified === 0 ? undefined : "次",
            tone: summary.unverified > 0 ? "warn" : undefined,
          },
          {
            key: "rolledBack",
            label: "已自动回滚",
            value: summary.rolledBack,
            unit: summary.rolledBack === 0 ? undefined : "次",
            tone: summary.rolledBack > 0 ? "warn" : undefined,
          },
          { key: "completed", label: "已验证完成", value: summary.completed ?? 0, unit: "次" },
        ];

  return (
    <section className="canary-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="升级策略"
          description="新版本先在影子环境跑一轮真实任务，确认没问题再切换。"
          extra={
            <Space>
              <Button icon={<ReloadOutlined />} onClick={refresh}>
                刷新
              </Button>
              <Tooltip title="立即执行观察窗巡检：检出回归自动回滚，窗口到期则确认升级">
                <Button type="primary" icon={<ThunderboltOutlined />} loading={busy} onClick={() => void tick()}>
                  巡检观察窗
                </Button>
              </Tooltip>
            </Space>
          }
        />

        {/* §2.3 ② 结论条。 */}
        <ConclusionBar tone={conclusion.tone} title={conclusion.title} copy={conclusion.copy} action={conclusion.action} />

        {notice !== null && <Alert type="info" showIcon title={notice} />}

        <Card title="版本策略">
          <Flex vertical gap={12}>
            <Radio.Group value={policy} onChange={(event) => void changePolicy(event.target.value as Policy)} disabled={busy}>
              <Flex gap={16} wrap="wrap">
                {(Object.keys(POLICY_META) as Policy[]).map((key) => (
                  <Radio key={key} value={key}>
                    <Space direction="vertical" size={0}>
                      <span>{POLICY_META[key].label}</span>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {POLICY_META[key].note}
                      </Typography.Text>
                    </Space>
                  </Radio>
                ))}
              </Flex>
            </Radio.Group>
            <Alert
              type="info"
              showIcon
              icon={<ExperimentOutlined />}
              message="准入判据（三条全过才自动切换）"
              description={
                <Flex vertical gap={2}>
                  <span>① 成功率降幅 ≤ 5 个百分点；② 平均 token 增幅 ≤ 15%；③ 无新增 error 级指纹。</span>
                  <span>
                    任一指标数据缺失时按「不通过」处理——宁可拦下，也不给「没验证却声称验证过」开口子。
                  </span>
                </Flex>
              }
            />
          </Flex>
        </Card>

        <StatStrip items={canaryStats} />

        <Card title="金丝雀验证记录">
          {data !== null && data.items.length === 0 ? (
            <Empty
              title="还没有升级验证记录"
              hint="发起一次升级时，管家会自动按当前策略执行金丝雀验证。"
              mascot={false}
            />
          ) : (
            <Table<CanaryRun>
              rowKey="id"
              columns={columns}
              dataSource={data?.items ?? []}
              loading={data === null}
              pagination={{ pageSize: 10, showSizeChanger: false }}
              scroll={{ x: 1050 }}
            />
          )}
        </Card>
      </Flex>

      <Modal
        open={detail !== null}
        onCancel={() => setDetail(null)}
        footer={null}
        width={860}
        title={detail === null ? "" : `升级验证详情：${detail.targetVersion}`}
      >
        {detail !== null && <CanaryRunDetail run={detail} />}
      </Modal>
    </section>
  );
}

function CanaryRunDetail({ run }: { run: CanaryRun }) {
  const verdict = run.verdict;
  return (
    <Flex vertical gap={16}>
      <Descriptions column={2} size="small" bordered>
        <Descriptions.Item label="状态">
          <StatusBadge tone={STATUS_TONE[run.status] ?? "unknown"} label={STATUS_LABEL[run.status] ?? run.status} />
        </Descriptions.Item>
        <Descriptions.Item label="策略">{POLICY_META[run.policy]?.label ?? run.policy}</Descriptions.Item>
        <Descriptions.Item label="实例">{run.instance === "" ? "—" : run.instance}</Descriptions.Item>
        <Descriptions.Item label="观察窗时长">
          {run.observationWindowMs === 0 ? "无（跳过金丝雀）" : `${Math.round(run.observationWindowMs / 3_600_000)} 小时`}
        </Descriptions.Item>
        <Descriptions.Item label="抽样">{`${run.sampleRegular} 常规 + ${run.sampleFailed} 失败`}</Descriptions.Item>
        <Descriptions.Item label="回滚快照">
          {run.rollbackSnapshotId === null ? "未登记" : `登记行 ${run.rollbackSnapshotId}`}
        </Descriptions.Item>
        {run.switchedAt !== null && (
          <Descriptions.Item label="切换时刻">{new Date(run.switchedAt).toLocaleString()}</Descriptions.Item>
        )}
        {run.observationUntil !== null && (
          <Descriptions.Item label="观察窗截止">{new Date(run.observationUntil).toLocaleString()}</Descriptions.Item>
        )}
      </Descriptions>

      {run.reason !== null && (
        <Alert
          type={run.status === "blocked" ? "error" : run.status === "unverified" ? "warning" : "info"}
          showIcon
          message="处置说明"
          description={run.reason}
        />
      )}

      {verdict !== null && (
        <Card size="small" title="准入判据差异报告">
          <Flex vertical gap={8}>
            {verdict.checks.map((check) => (
              <Flex key={check.id} gap={8} align="center" wrap="wrap">
                <StatusBadge tone={check.pass ? "ok" : "error"} label={check.pass ? "通过" : "未过"} />
                <Typography.Text strong>{check.label}</Typography.Text>
                <Typography.Text type="secondary">
                  基线 {check.id === "success-rate" ? fmtPct(check.baseline) : fmtNum(check.baseline, 1)} → 影子{" "}
                  {check.id === "success-rate" ? fmtPct(check.shadow) : fmtNum(check.shadow, 1)}
                </Typography.Text>
                <Typography.Text type={check.pass ? "secondary" : "danger"}>{check.detail}</Typography.Text>
              </Flex>
            ))}
            {verdict.notEvaluated.length > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {verdict.notEvaluated.join("；")}
              </Typography.Text>
            )}
          </Flex>
        </Card>
      )}

      {run.baseline !== null && (
        <Card size="small" title="基线指标（当前版本实测）">
          <Descriptions column={2} size="small">
            <Descriptions.Item label="成功率">{fmtPct(run.baseline.successRate)}</Descriptions.Item>
            <Descriptions.Item label="平均 token">{fmtNum(run.baseline.avgTokens, 1)}</Descriptions.Item>
            <Descriptions.Item label="平均耗时（ms）">{fmtNum(run.baseline.avgDurationMs)}</Descriptions.Item>
            <Descriptions.Item label="样本量">{run.baseline.sampleSize}</Descriptions.Item>
            <Descriptions.Item label="error 级指纹数">{run.baseline.errorFingerprints.length}</Descriptions.Item>
            <Descriptions.Item label="口径">{run.baseline.source}</Descriptions.Item>
          </Descriptions>
        </Card>
      )}

      {run.shadow === null && (
        <Alert
          type="warning"
          showIcon
          message="没有影子侧指标"
          description="影子执行器未配置或没有产出指标，本次验证不算通过；标准策略会记为「未验证」放行，保守策略直接拦截升级。"
        />
      )}

      {run.tasks.length > 0 && (
        <Card size="small" title={`抽样任务（${run.tasks.length}）`}>
          <Flex gap={4} wrap="wrap">
            {run.tasks.slice(0, 60).map((task) =>
              task.bucket === "failed" ? (
                <StatusBadge key={`${task.bucket}:${task.sessionId}`} tone="error" label={task.sessionId} />
              ) : (
                <Typography.Text
                  key={`${task.bucket}:${task.sessionId}`}
                  className="is-mono"
                  type="secondary"
                  style={{ fontSize: 12 }}
                >
                  {task.sessionId}
                </Typography.Text>
              ),
            )}
            {run.tasks.length > 60 && <Typography.Text type="secondary">等 {run.tasks.length} 条</Typography.Text>}
          </Flex>
        </Card>
      )}
    </Flex>
  );
}
