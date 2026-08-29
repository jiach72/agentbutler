import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Empty, Modal, Progress, Select, Steps, Table, Tag } from "antd";
import { ReloadOutlined, InboxOutlined, DownloadOutlined } from "@ant-design/icons";
import { loadJson, postJson } from "../../lib/api.js";
import { formatTime } from "../../lib/format.js";
import type { SkillsPayload } from "./helpers.js";
import { fillUsageSeries } from "./usageTrend.js";

type UsageItem = { name: string; calls: number; lastUsedAt: string | null; successRate: number | null; avgDurationMs: number | null; status: "known" | "unknown" };
type UsageGranularity = "day" | "week" | "month";
type UsageView = { rangeDays: number; granularity: UsageGranularity; coverage: { from: string | null; to: string | null; days: number; source: string; complete: boolean }; series: Array<{ date: string; calls: number }>; skills: UsageItem[]; notice: string };
type TrendView = { items: Array<{ name: string; url: string; stars: number; forks: number; updatedAt: string; description?: string }>; syncedAt: string | null; notice: string; error?: string };
type Recommendation = { id: string; name: string; reason: string; description?: string; sourceUrl: string };
type InstallPhase = "confirm" | "download" | "install" | "done" | "failed";

function postError(result: { data: unknown }, fallback: string): string {
  if (result.data !== null && typeof result.data === "object") {
    const data = result.data as Record<string, unknown>;
    for (const key of ["detail", "fix", "error"] as const) if (typeof data[key] === "string" && data[key].trim()) return data[key] as string;
  }
  return fallback;
}

export function AssetCenter({ skills, onSkillsChanged }: { skills: SkillsPayload["skills"]; onSkillsChanged?: () => void | Promise<void> }) {
  const { message, modal } = App.useApp();
  const [range, setRange] = useState("30");
  const [granularity, setGranularity] = useState<UsageGranularity>("day");
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [trends, setTrends] = useState<TrendView | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [installTarget, setInstallTarget] = useState<Recommendation | null>(null);
  const [installJob, setInstallJob] = useState<{ phase: InstallPhase; detail: string }>({ phase: "confirm", detail: "" });

  const refresh = useCallback(async () => {
    setBusy("refresh");
    const [u, t, r] = await Promise.all([
      loadJson<UsageView>("/api/skills/usage?range=" + range + "d&granularity=" + granularity, 15_000),
      loadJson<TrendView>("/api/skills/github-trends", 10_000),
      loadJson<{ items: Recommendation[] }>("/api/skills/recommendations", 10_000),
    ]);
    if (u.ok) setUsage(u.data);
    let nextTrend = t.ok ? t.data : null;
    let nextRecommendations = r.ok ? r.data.items ?? [] : [];
    if (nextTrend?.items.length === 0 && nextTrend.syncedAt === null) {
      const sync = await postJson("/api/skills/github-trends/refresh", {}, 30_000);
      if (sync.ok) {
        const [trendAgain, recommendationsAgain] = await Promise.all([
          loadJson<TrendView>("/api/skills/github-trends", 10_000),
          loadJson<{ items: Recommendation[] }>("/api/skills/recommendations", 10_000),
        ]);
        if (trendAgain.ok) nextTrend = trendAgain.data;
        if (recommendationsAgain.ok) nextRecommendations = recommendationsAgain.data.items ?? [];
      }
    }
    if (nextTrend) setTrends(nextTrend);
    setRecommendations(nextRecommendations);
    setBusy(null);
  }, [range, granularity]);
  const syncTrends = async () => {
    setBusy("sync");
    const result = await postJson("/api/skills/github-trends/refresh", {}, 30_000);
    setBusy(null);
    if (!result.ok) { message.error("公开趋势同步失败，请检查网络或稍后重试"); return; }
    message.success("公开趋势已刷新");
    await refresh();
  };
  useEffect(() => { void refresh(); }, [refresh]);

  const usageSeries = useMemo(
    () => (usage === null ? [] : fillUsageSeries(usage.series, usage.rangeDays, usage.granularity)),
    [usage],
  );
  const maxCalls = Math.max(1, ...(usageSeries.map((item) => item.calls) ?? [0]));
  const known = useMemo(() => new Set(skills.items.map((item) => item.name)), [skills.items]);
  const archive = (name: string) => {
    modal.confirm({ title: "归档技能 " + name + "？", content: "归档前会自动备份；内置技能不可归档。", okText: "归档", cancelText: "取消", onOk: async () => {
      const result = await postJson("/api/skills/" + encodeURIComponent(name) + "/archive", { thresholdDays: 90 }, 20_000);
      if (result.ok) { message.success("技能已归档"); await refresh(); } else message.error("归档被阻止：请查看返回的原因和解决方案");
    } });
  };
  const startInstall = async () => {
    if (installTarget === null) return;
    const target = installTarget;
    setBusy("install");
    setInstallJob({ phase: "download", detail: "正在下载并检查技能文件" });
    const staged = await postJson("/api/skills/recommendations/" + encodeURIComponent(target.id) + "/stage", {}, 30_000);
    if (!staged.ok) {
      setInstallJob({ phase: "failed", detail: postError(staged, "下载或检查未完成") });
      setBusy(null);
      return;
    }
    const stageId = staged.data && typeof staged.data === "object" && "id" in staged.data ? String((staged.data as { id: unknown }).id) : "";
    if (stageId === "") {
      setInstallJob({ phase: "failed", detail: "服务未返回安装标识" });
      setBusy(null);
      return;
    }
    setInstallJob({ phase: "install", detail: "正在备份并安装到 Hermes" });
    const installed = await postJson("/api/skills/staged/" + encodeURIComponent(stageId) + "/install", { confirmed: true }, 30_000);
    setBusy(null);
    if (!installed.ok) {
      setInstallJob({ phase: "failed", detail: postError(installed, "安装未完成") });
      return;
    }
    setInstallJob({ phase: "done", detail: "技能已安装，技能清单已更新" });
    message.success("技能已安装");
    await refresh();
    await onSkillsChanged?.();
  };

  const columns = [
    { title: "技能", dataIndex: "name", render: (name: string, item: UsageItem) => <><strong>{name}</strong>{item.status === "unknown" && <Tag color="default">未知技能</Tag>}</> },
    { title: "调用次数", dataIndex: "calls", sorter: (a: UsageItem, b: UsageItem) => b.calls - a.calls },
    { title: "成功率", render: (_: unknown, item: UsageItem) => item.successRate === null ? "未知" : (item.successRate * 100).toFixed(1) + "%" },
    { title: "平均耗时", render: (_: unknown, item: UsageItem) => item.avgDurationMs === null ? "未知" : Math.round(item.avgDurationMs) + " ms" },
    { title: "最近使用", render: (_: unknown, item: UsageItem) => item.lastUsedAt ? formatTime(item.lastUsedAt) : "未知" },
    { title: "操作", render: (_: unknown, item: UsageItem) => known.has(item.name) ? <Button size="small" icon={<InboxOutlined />} disabled={skills.items.find((skill) => skill.name === item.name)?.source === "builtin"} onClick={() => archive(item.name)}>归档</Button> : null },
  ];

  return <div className="asset-center">
    <div className="skills-section-head"><div><span className="skills-kicker">使用统计</span><h2>技能使用情况</h2></div><div className="asset-selects"><Select value={granularity} onChange={setGranularity} options={[{ value: "day", label: "按日" }, { value: "week", label: "按周" }, { value: "month", label: "按月" }]} /><Select value={range} onChange={setRange} options={[{ value: "30", label: "近 30 天" }, { value: "90", label: "近 90 天" }, { value: "180", label: "近 180 天" }]} /></div></div>
    {usage && <>
      <Alert type={usage.coverage.complete ? "info" : "warning"} showIcon message={"数据覆盖：" + (usage.coverage.from ? formatTime(usage.coverage.from) + " 至 " + formatTime(usage.coverage.to ?? usage.coverage.from) : "未知")} description={usage.coverage.source + "；实际覆盖 " + usage.coverage.days + " 天。" + usage.notice} />
      <div className="asset-trend" aria-label="技能调用次数趋势">
        {usage.series.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前范围没有可证明的调用记录" />
        ) : (
          <div className="asset-trend-scroll">
            <div className="asset-trend-bars">
              {usageSeries.map((item, index) => (
                <div className="asset-bar" key={item.date} title={`${item.date}: ${item.calls} 次`}>
                  <span style={{ height: `${item.calls === 0 ? 0 : Math.max(6, (item.calls / maxCalls) * 100)}%` }} />
                  {(usage.granularity !== "day" || usage.rangeDays <= 30 || index % 7 === 0 || index === usageSeries.length - 1) && (
                    <small>{usage.granularity === "month" ? item.date.slice(0, 7) : item.date.slice(5)}</small>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <Table rowKey="name" size="small" pagination={{ pageSize: 8, hideOnSinglePage: true }} dataSource={usage.skills} columns={columns} />
    </>}
    <div className="asset-center-section"><div className="skills-section-head"><div><span className="skills-kicker">公开来源</span><h2>GitHub 技能项目</h2></div><Button icon={<ReloadOutlined />} loading={busy === "sync" || busy === "refresh"} onClick={() => void syncTrends()}>同步公开数据</Button></div><p className="asset-note">数据来自公开仓库，仅供参考。{trends?.syncedAt ? "同步于 " + formatTime(trends.syncedAt) : "尚未同步"}{trends?.error ? "；上次同步失败，当前显示缓存。" : ""}</p><div className="asset-trends-list">{(trends?.items ?? []).length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未同步公开项目" /> : (trends?.items ?? []).slice(0, 8).map((item) => <div className="asset-trend-row" key={item.name}><div className="asset-trend-main"><a href={item.url} target="_blank" rel="noreferrer">{item.name}</a><p>{item.description ?? "公开技能项目，具体用途以仓库说明为准。"}</p></div><span>{item.stars.toLocaleString()} stars · {item.forks.toLocaleString()} forks</span><small>更新于 {item.updatedAt ? formatTime(item.updatedAt) : "未知"}</small></div>)}</div></div>
    <div className="asset-center-section"><div className="skills-section-head"><div><span className="skills-kicker">推荐项目</span><h2>推荐技能</h2></div><Button icon={<ReloadOutlined />} loading={busy === "refresh"} onClick={() => void refresh()}>重新获取</Button></div>{recommendations.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={trends?.items?.length ? "当前没有匹配的未安装技能" : "同步公开项目后，可结合本机使用情况生成推荐"} /> : recommendations.slice(0, 6).map((item) => <div className="asset-recommendation" key={item.id}><div><strong>{item.name}</strong><p>{item.description ?? item.reason}</p></div><Button icon={<DownloadOutlined />} loading={busy === "install" && installTarget?.id === item.id} onClick={() => { setInstallTarget(item); setInstallJob({ phase: "confirm", detail: "" }); }}>直接安装</Button></div>)}</div>
    <Modal open={installTarget !== null} title={installJob.phase === "confirm" ? "确认安装" : installTarget ? "安装 " + installTarget.name : "安装技能"} onCancel={() => { if (installJob.phase === "confirm" || installJob.phase === "done" || installJob.phase === "failed") setInstallTarget(null); }} closable={installJob.phase === "confirm" || installJob.phase === "done" || installJob.phase === "failed"} maskClosable={false} footer={installJob.phase === "confirm" ? [<Button key="cancel" onClick={() => setInstallTarget(null)}>取消</Button>, <Button key="ok" type="primary" onClick={() => void startInstall()}>直接安装</Button>] : installJob.phase === "done" || installJob.phase === "failed" ? [<Button key="close" type="primary" onClick={() => setInstallTarget(null)}>关闭</Button>] : null}>
      {installJob.phase === "confirm" ? <p>将下载项目并检查技能文件，备份后安装到当前 Hermes 实例。</p> : <><Progress percent={installJob.phase === "download" ? 35 : installJob.phase === "install" ? 75 : 100} status={installJob.phase === "failed" ? "exception" : installJob.phase === "done" ? "success" : "active"} /><Steps size="small" current={installJob.phase === "download" ? 0 : installJob.phase === "install" ? 2 : installJob.phase === "done" ? 4 : 2} status={installJob.phase === "failed" ? "error" : undefined} items={[{ title: "下载" }, { title: "检查" }, { title: "备份" }, { title: "安装" }]} /><p className="asset-install-detail">{installJob.detail}</p></>}
    </Modal>
  </div>;
}
