import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Alert, Button, Descriptions, Empty, Input, Select, Space, Table, Tag } from "antd";
import { ReloadOutlined, SafetyCertificateOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { loadJson, postJson } from "../../lib/api.js";
import { formatTime, isRecord } from "../../lib/format.js";

type Target = { targetRef: string; name: string; source: string; version: string; category: string; description: string; canApply: boolean };
type Validation = { status: "unknown" | "pass" | "fail"; reason: string; fix: string; actions: string[] };
type Proposal = {
  id: string; targetRef: string; target: Target; problem: string; evidence: string[]; profileId: string | null;
  generation: "manual" | "model"; status: "draft" | "validating" | "ready-to-apply" | "applied" | "failed";
  createdAt: string; updatedAt: string; baselineHash: string; candidateHash: string; diff: string; candidatePath: string;
  validation: Validation; apply: { appliedAt?: string; backupId?: number };
};

const statusLabel: Record<Proposal["status"], string> = { draft: "草稿", validating: "验证中", "ready-to-apply": "可应用", applied: "已应用", failed: "验证失败" };
const sourceLabel: Record<string, string> = { builtin: "内置", market: "市场", "self-evolved": "自动改进", user: "用户" };

export function EvolutionPage() {
  const { message } = App.useApp();
  const [targets, setTargets] = useState<Target[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetRef, setTargetRef] = useState("");
  const [problem, setProblem] = useState("");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [targetResult, proposalResult] = await Promise.all([
      loadJson<{ targets: Target[] }>("/api/evolution/targets", 10_000),
      loadJson<{ proposals: Proposal[] }>("/api/evolution/proposals", 10_000),
    ]);
    if (!targetResult.ok || !proposalResult.ok) { setError("无法读取 Hermes 技能或改进提案，请确认 Watch 服务已启动"); return; }
    setTargets(targetResult.data.targets ?? []);
    setProposals(proposalResult.data.proposals ?? []);
    if (selectedId === null && proposalResult.data.proposals?.[0]) setSelectedId(proposalResult.data.proposals[0].id);
  }, [selectedId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const selected = proposals.find((item) => item.id === selectedId) ?? null;
  const createProposal = async () => {
    if (!targetRef || !problem.trim()) { message.warning("请选择真实技能并描述要改进的问题"); return; }
    setBusy("create");
    const result = await postJson("/api/evolution/proposals", { targetRef, problem, evidence: evidence.split(/\r?\n/).map((v) => v.trim()).filter(Boolean) }, 20_000);
    setBusy(null);
    if (!result.ok || !isRecord(result.data) || typeof result.data["id"] !== "string") { const detail = isRecord(result.data) ? [result.data["detail"], result.data["fix"], Array.isArray(result.data["actions"]) ? result.data["actions"].join("、") : ""].filter((item): item is string => typeof item === "string" && item !== "").join("；") : ""; message.error("提案创建失败" + (detail ? "：" + detail : "，请确认技能仍在当前清单中")); return; }
    const proposal = result.data as unknown as Proposal;
    setProblem(""); setEvidence(""); setSelectedId(proposal.id); await refresh(); message.success("改进提案已创建，可在右侧查看差异");
  };
  const validate = async (id: string) => {
    setBusy(`validate:${id}`);
    const result = await postJson(`/api/evolution/proposals/${encodeURIComponent(id)}/validate`, {}, 30_000);
    setBusy(null);
    if (!result.ok) { const detail = isRecord(result.data) ? [result.data["detail"], result.data["fix"]].filter((item): item is string => typeof item === "string" && item !== "").join("；") : ""; message.error("隔离验证失败" + (detail ? "：" + detail : "")); return; }
    await refresh(); message.info("隔离验证已完成");
  };
  const apply = async (id: string) => {
    setBusy(`apply:${id}`);
    const result = await postJson(`/api/evolution/proposals/${encodeURIComponent(id)}/apply`, { confirmed: true }, 30_000);
    setBusy(null);
    if (!result.ok) { const detail = isRecord(result.data) ? [result.data["detail"], result.data["fix"], Array.isArray(result.data["actions"]) ? result.data["actions"].join("、") : ""].filter((item): item is string => typeof item === "string" && item !== "").join("；") : ""; message.error("应用失败" + (detail ? "：" + detail : "：baseline 可能已变化，或备份未成功")); return; }
    await refresh(); message.success("改进已应用到 Hermes，并已写入审计记录");
  };

  const columns = useMemo(() => [
    { title: "技能", render: (_: unknown, item: Proposal) => <div><strong>{item.target.name}</strong><div className="evolution-muted-action">{sourceLabel[item.target.source] ?? item.target.source} · {item.target.category}</div></div> },
    { title: "状态", width: 110, render: (_: unknown, item: Proposal) => <Tag color={item.status === "ready-to-apply" ? "green" : item.status === "failed" ? "red" : "blue"}>{statusLabel[item.status]}</Tag> },
    { title: "更新时间", width: 150, render: (_: unknown, item: Proposal) => formatTime(item.updatedAt) },
  ], []);

  return <section className="page evolution-page">
    <header className="evolution-header">
      <div><span className="evolution-eyebrow">外部改进工作台</span><h1>协助 Hermes 改进</h1><p>选择当前 Hermes 已安装的真实技能，提出问题，先在 Butler 隔离验证，再由你确认应用。</p></div>
      <ConnectionChip reachable={error === null} connectingText="正在读取 Hermes 技能清单" offlineText="改进工作台暂时不可用" />
    </header>
    {error && <Alert type="error" showIcon message="无法读取改进工作台" description={error} action={<Button icon={<ReloadOutlined />} onClick={() => { setError(null); void refresh(); }}>重试</Button>} />}
    <section className="evolution-health">
      <div className="evolution-section-head"><div><span className="evolution-kicker">主流程</span><h2>从问题到可控改进</h2></div><Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>刷新技能清单</Button></div>
      <Descriptions size="small" column={{ xs: 1, sm: 3 }}>
        <Descriptions.Item label="1 · 选择技能">只显示当前 Hermes 清单中的技能</Descriptions.Item>
        <Descriptions.Item label="2 · 描述问题">支持补充日志片段或复现证据</Descriptions.Item>
        <Descriptions.Item label="3 · 隔离验证">通过后才允许应用到 Hermes</Descriptions.Item>
      </Descriptions>
    </section>
    <div className="evolution-workspace">
      <section className="evolution-diagnosis">
        <div className="evolution-section-head"><div><span className="evolution-kicker">新建提案</span><h2>描述要改进的问题</h2></div><ThunderboltOutlined /></div>
        <label className="skills-filter"><span>目标技能</span><Select showSearch value={targetRef || undefined} placeholder="选择真实存在的技能" optionFilterProp="label" options={targets.map((item) => ({ value: item.targetRef, label: `${item.name} · ${item.category}` }))} onChange={setTargetRef} /></label>
        {targetRef && <p className="evolution-health-detail">{targets.find((item) => item.targetRef === targetRef)?.description ?? "暂无简介"}</p>}
        <label className="skills-filter"><span>问题描述</span><Input.TextArea rows={6} value={problem} onChange={(event) => setProblem(event.target.value)} placeholder="例如：该技能在会议纪要中经常遗漏负责人和截止时间。" /></label>
        <label className="skills-filter"><span>可选证据（每行一条）</span><Input.TextArea rows={4} value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="粘贴脱敏日志、失败样例或期望输出" /></label>
        <Button type="primary" loading={busy === "create"} onClick={() => void createProposal()}>生成改进提案</Button>
      </section>
      <section className="evolution-tasks">
        <div className="evolution-section-head"><div><span className="evolution-kicker">改进提案</span><h2>{proposals.length} 项</h2></div></div>
        <Table rowKey="id" size="small" pagination={{ pageSize: 8, hideOnSinglePage: true }} dataSource={proposals} columns={columns} onRow={(item) => ({ onClick: () => setSelectedId(item.id), className: item.id === selectedId ? "is-selected" : "" })} locale={{ emptyText: <Empty description="还没有提案" /> }} />
      </section>
    </div>
    <section className="evolution-inspector">
      <div className="evolution-section-head"><div><span className="evolution-kicker">提案详情</span><h2>{selected?.target.name ?? "选择一个提案"}</h2></div>{selected && <Tag color={selected.status === "ready-to-apply" ? "green" : "blue"}>{statusLabel[selected.status]}</Tag>}</div>
      {!selected ? <div className="evolution-empty">提案详情会显示问题、baseline hash、差异和验证结果。</div> : <>
        <p className="evolution-run-detail">{selected.problem}</p>
        <Descriptions size="small" column={{ xs: 1, sm: 2 }} className="evolution-run-facts">
          <Descriptions.Item label="来源">{sourceLabel[selected.target.source] ?? selected.target.source}</Descriptions.Item><Descriptions.Item label="版本">{selected.target.version}</Descriptions.Item>
          <Descriptions.Item label="baseline hash"><code>{selected.baselineHash}</code></Descriptions.Item><Descriptions.Item label="候选 hash"><code>{selected.candidateHash}</code></Descriptions.Item>
          <Descriptions.Item label="验证结果">{selected.validation.reason}</Descriptions.Item><Descriptions.Item label="解决方案">{selected.validation.fix}</Descriptions.Item>
        </Descriptions>
        <Space wrap className="evolution-run-actions">
          <Button icon={<SafetyCertificateOutlined />} loading={busy === `validate:${selected.id}`} onClick={() => void validate(selected.id)} disabled={selected.status === "applied"}>隔离验证</Button>
          <Button type="primary" danger loading={busy === `apply:${selected.id}`} onClick={() => void apply(selected.id)} disabled={selected.status !== "ready-to-apply" || !selected.target.canApply}>应用到 Hermes</Button>
        </Space>
        <CollapseDetails title="查看差异" content={selected.diff} />
        {selected.validation.status === "fail" && <Alert type="warning" showIcon message="当前操作被阻断" description={<>{selected.validation.reason}。建议：{selected.validation.fix}。下一步：{selected.validation.actions.join("、")}</>} />}
      </>}
    </section>
  </section>;
}

function CollapseDetails({ title, content }: { title: string; content: string }) {
  const [open, setOpen] = useState(false);
  return <div className="evolution-expander"><Button type="link" onClick={() => setOpen(!open)}>{open ? "收起差异" : title}</Button>{open && <pre className="evolution-code">{content}</pre>}</div>;
}
