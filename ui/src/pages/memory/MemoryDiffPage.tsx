/**
 * 记忆变更流（Trust Layer M4.3）。
 *
 * 解决的问题是「重启失忆」的焦虑——用户看不见记忆在被维护，就会怀疑它哪天把重要的事忘了。
 * 这里把已采到的动作流翻译成人能读的「它记住了什么 / 改了什么 / 忘了什么」。
 *
 * 诚实呈现：页面显式声明观测口径与边界（只覆盖被 agent 动作过的记忆文件，不做内容级 diff），
 * 不冒称「完整记忆快照」。「不在受管清单内」也不写成「已删除」——那是两件事。
 *
 * 展示层遵循规范 03 §2.3（页头 → 结论条 → 主内容）；颜色全部走品牌语义 tone
 * ——「遗忘」用 warn 而不是 error：这一页存在的意义正是安抚「它是不是把事忘了」的焦虑，
 * 用错误红会和页面文案自相矛盾（评审 P1-1）。
 */
import { Alert, Button, Card, Flex, Segmented, Table, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, InfoCircleOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useState } from "react";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import type { PageConclusionView } from "../../components/ConclusionBar.js";
import { Empty } from "../../components/Empty.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatStrip } from "../../components/StatStrip.js";
import type { StatStripItem } from "../../components/StatStrip.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import type { SemanticTone } from "../../components/StatusBadge.js";
import { useUrlState } from "../../hooks/useUrlState.js";
import { loadJson } from "../../lib/api.js";
import { usePolling } from "../../hooks/usePolling.js";

type Change = "added" | "modified" | "forgotten";

interface MemoryEntry {
  path: string;
  change: Change;
  firstAt: string;
  lastAt: string;
  writes: number;
  deletes: number;
  sessionIds: string[];
  stillPresent: boolean | null;
}

interface MemoryDiffPayload {
  windowDays: number;
  entries: MemoryEntry[];
  top: MemoryEntry[];
  summary: { added: number; modified: number; forgotten: number; total: number };
  basis: string;
  basisLimits: string[];
  lastActionAt: string | null;
}

/**
 * 变化类型 → 品牌语义 tone。
 * 「修改」走 brand（标记色，不是状态色）：蓝是交互色，按 02 §1.1 不进徽标语义。
 */
const CHANGE_TONE: Record<Change, SemanticTone> = {
  added: "ok",
  modified: "brand",
  forgotten: "warn",
};

const CHANGE_LABEL: Record<Change, string> = {
  added: "新增",
  modified: "修改",
  forgotten: "遗忘",
};

/** 长路径只显示尾部（面包屑式），完整值放 tooltip，避免表格被撑爆。 */
const shortPath = (path: string): string => {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
};

export function MemoryDiffPage() {
  const [data, setData] = useState<MemoryDiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 筛选同步到 URL（规范 03 §3.12）：刷新/分享能还原同一视图（评审 P1-7）。
  const [filter, setFilter] = useUrlState<string>("change", "all");

  const refresh = useCallback(() => {
    void loadJson<MemoryDiffPayload>("/api/memory-diff?windowDays=7", 20_000).then((result) => {
      if (result.ok) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.reason);
      }
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 60_000);

  const columns: ColumnsType<MemoryEntry> = [
    {
      title: "变化",
      dataIndex: "change",
      key: "change",
      width: 110,
      render: (change: Change) => <StatusBadge tone={CHANGE_TONE[change]} label={CHANGE_LABEL[change]} />,
    },
    {
      title: "记忆文件",
      dataIndex: "path",
      key: "path",
      ellipsis: true,
      render: (path: string) => (
        <Tooltip title={path}>
          <Typography.Text className="is-mono">{shortPath(path)}</Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: "写入 / 删除",
      key: "counts",
      width: 120,
      render: (_: unknown, row) => (
        <span>
          {row.writes}
          {row.deletes > 0 && <Typography.Text type="danger"> / {row.deletes}</Typography.Text>}
        </span>
      ),
    },
    {
      title: "在受管清单内",
      dataIndex: "stillPresent",
      key: "stillPresent",
      width: 140,
      render: (value: boolean | null) =>
        value === true ? (
          <StatusBadge tone="ok" label="在清单内" />
        ) : (
          <Tooltip title="不在受管清单内，或该目录未被清单覆盖——这不等于文件已被删除">
            <span>
              <StatusBadge tone="unknown" label="未知" />
            </span>
          </Tooltip>
        ),
    },
    {
      title: "最近变化",
      dataIndex: "lastAt",
      key: "lastAt",
      width: 165,
      render: (value: string) => new Date(value).toLocaleString(),
    },
    {
      title: "相关会话",
      key: "sessions",
      width: 200,
      ellipsis: true,
      render: (_: unknown, row) =>
        row.sessionIds.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Tooltip title={row.sessionIds.join(" / ")}>
            <span>{row.sessionIds.length} 个会话</span>
          </Tooltip>
        ),
    },
  ];

  const summary = data?.summary;
  const entries = (data?.entries ?? []).filter((entry) => filter === "all" || entry.change === filter);
  const windowDays = data?.windowDays ?? 7;

  /**
   * 页面结论条（规范 03 §2.3 ②「必须有」）。
   * 结论文案刻意区分「遗忘」与「删除」——口径边界写在 basisLimits 里，这里不夸大（评审 P0-2）。
   */
  const conclusion: PageConclusionView =
    error !== null
      ? {
          tone: "offline",
          title: "记忆变更视图暂时读不到",
          copy: error,
          action: <Button onClick={refresh}>重试</Button>,
        }
      : data === null
        ? { tone: "unknown", title: "正在整理记忆变更", copy: `正在统计最近 ${windowDays} 天记忆类文件的改动。` }
        : summary === undefined || summary.total === 0
          ? {
              tone: "ok",
              title: `最近 ${windowDays} 天没有观测到记忆改动`,
              copy: "没有改动不代表记忆丢了，只是这段时间没动过记忆类文件。",
            }
          : summary.forgotten > 0
            ? {
                tone: "warn",
                title: `最近 ${windowDays} 天它记住了 ${summary.added} 个文件，另有 ${summary.forgotten} 个疑似遗忘`,
                copy: `共涉及 ${summary.total} 个记忆文件（修改 ${summary.modified} 个）。「不在受管清单内」不等于文件被删除，判断口径见页尾说明。`,
              }
            : {
                tone: "ok",
                title: `最近 ${windowDays} 天它记住了 ${summary.added} 个文件、修改了 ${summary.modified} 个`,
                copy: `共涉及 ${summary.total} 个记忆文件，没有观测到遗忘。`,
              };

  const stats: StatStripItem[] =
    summary === undefined
      ? []
      : [
          { key: "added", label: "新增", value: summary.added, unit: "个", tone: "ok", sub: "新写入的记忆文件" },
          { key: "modified", label: "修改", value: summary.modified, unit: "个", tone: "brand", sub: "被再次写入" },
          {
            key: "forgotten",
            label: "遗忘",
            value: summary.forgotten,
            unit: "个",
            tone: summary.forgotten > 0 ? "warn" : undefined,
            sub: "被删除或移出受管清单",
          },
          { key: "total", label: "涉及文件", value: summary.total, unit: "个", sub: `统计窗口 ${windowDays} 天` },
        ];

  return (
    <section className="memory-diff-page">
      <Flex vertical gap={16}>
        <PageHeader
          title="记忆变更"
          extra={
            <Button icon={<ReloadOutlined />} onClick={refresh}>
              刷新
            </Button>
          }
        />

        {/* §2.3 ② 结论条。 */}
        <ConclusionBar tone={conclusion.tone} title={conclusion.title} copy={conclusion.copy} action={conclusion.action} />

        <StatStrip items={stats} />

        {data !== null && data.top.length > 0 && (
          <Card size="small" title="本周它记住的重点（TOP5）">
            <Flex gap={8} wrap="wrap">
              {data.top.map((entry) => (
                <Tooltip key={entry.path} title={entry.path}>
                  <span>
                    <StatusBadge
                      tone={CHANGE_TONE[entry.change]}
                      label={`${CHANGE_LABEL[entry.change]} ${shortPath(entry.path)}`}
                    />
                  </span>
                </Tooltip>
              ))}
            </Flex>
          </Card>
        )}

        <Card
          title="记忆变更明细"
          extra={
            <Segmented
              options={[
                { label: "全部", value: "all" },
                { label: "新增", value: "added" },
                { label: "修改", value: "modified" },
                { label: "遗忘", value: "forgotten" },
              ]}
              value={filter}
              onChange={(value) => setFilter(value as string)}
            />
          }
        >
          {data !== null && entries.length === 0 ? (
            <Empty
              title={
                filter === "all"
                  ? "本周没有观察到记忆改动"
                  : `本周没有「${CHANGE_LABEL[filter as Change]}」的记忆文件`
              }
              hint="换一个筛选看看；也可以等 agent 动过记忆类文件后再回到这里。"
              mascotWidth={72}
            />
          ) : (
            <Table<MemoryEntry>
              rowKey="path"
              columns={columns}
              dataSource={entries}
              loading={data === null}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              scroll={{ x: 1000 }}
            />
          )}
        </Card>

        {data !== null && (
          <Alert
            type="info"
            showIcon
            icon={<InfoCircleOutlined />}
            message="这份数据是什么、不是什么"
            description={
              <Flex vertical gap={4}>
                <span>口径：{data.basis}。</span>
                {data.basisLimits.map((limit) => (
                  <span key={limit}>· {limit}</span>
                ))}
                <span>隐私：只读取动作元数据与路径，不展示记忆正文内容。</span>
              </Flex>
            }
          />
        )}
      </Flex>
    </section>
  );
}
