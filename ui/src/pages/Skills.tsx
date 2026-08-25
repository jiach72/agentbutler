import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { fetchJson, postJson } from "../lib/api.js";

type InventoryMode = "driver" | "directory-fallback" | "unavailable";
type AssetRiskStatus = "unscanned" | "clear" | "blocked";

interface DirectoryInventory {
  roots: string[];
  fileCount: number;
  directoryCount: number;
  sizeBytes: number;
  truncated: boolean;
}

interface SkillItem {
  ref: { name: string; version?: string; source?: string };
  name: string;
  version: string;
  source: string;
  enabled: boolean;
  category?: string;
  riskStatus?: AssetRiskStatus;
  riskDetail?: string;
}

interface PluginItem {
  ref: { name: string; version?: string; source?: string };
  name: string;
  version: string;
  source: string;
  enabled: boolean;
  category?: string;
  description?: string;
  riskStatus?: AssetRiskStatus;
  riskDetail?: string;
}

interface MemorySignalView {
  id: string;
  label: string;
  status: "ok" | "warn" | "error" | "unknown";
  detail: string;
}

interface MemorySuggestionView {
  id: string;
  kind: string;
  title: string;
  detail: string;
  action?: string;
}

interface MemoryHealthView {
  score: number;
  checkedAt: string;
  signals: MemorySignalView[];
  suggestions: MemorySuggestionView[];
}

interface MemoryEntry {
  entryId: string;
  writtenAt: string;
  content: string;
  channel?: string;
  sessionId?: string;
  sizeBytes?: number;
  cold?: boolean;
}

interface SkillsPayload {
  watchReachable: boolean;
  instance: null | {
    instanceId: string;
    frameworkId: string;
    state: string;
    version: string | null;
  };
  skills: {
    mode: InventoryMode;
    driverId: string | null;
    total: number;
    items: SkillItem[];
    directory: DirectoryInventory;
    notice: string;
  };
  plugins: {
    mode: InventoryMode;
    driverId: string | null;
    total: number;
    items: PluginItem[];
    directory: DirectoryInventory;
    notice: string;
  };
  memory: {
    mode: InventoryMode;
    driverId: string | null;
    stats: null | {
      totalEntries: number;
      byMonth: Array<{ month: string; count: number }>;
      coldCandidates: number;
      lastWriteAt: string | null;
      archivedEntries: number;
      probeEntries: number;
      recalledEntries: number;
      cumulativeRecalls: number;
      probeWriteAttempts: number;
      probeWriteFailures: number;
      probeRecallAttempts: number;
      probeRecallHits: number;
    };
    health: MemoryHealthView | null;
    preview: MemoryEntry[];
    previewLimit: number;
    writeActivity: { status: "active" | "stalled" | "empty" | "unknown"; detail: string };
    directory: DirectoryInventory;
    notice: string;
  };
}

const SOURCE_LABELS: Record<string, string> = {
  builtin: "内置",
  market: "市场",
  "self-evolved": "自动改进",
  user: "用户",
};

function channelLabel(channel: string | undefined): string {
  if (channel === undefined || channel === "") return "";
  const labels: Record<string, string> = {
    telegram: "Telegram",
    whatsapp: "WhatsApp",
    discord: "Discord",
    wechat: "微信",
    email: "邮件",
    sms: "短信",
    cli: "终端",
  };
  return labels[channel.toLowerCase()] ?? channel;
}

function modeLabel(mode: InventoryMode): string {
  if (mode === "driver") return "正常查看";
  if (mode === "directory-fallback") return "按文件查看";
  return "无法查看";
}

function riskLabel(status: AssetRiskStatus | undefined): string {
  if (status === "blocked") return "受限";
  if (status === "clear") return "已扫描";
  return "未扫描";
}

function riskDetail(item: { riskStatus?: AssetRiskStatus; riskDetail?: string }): string {
  if (item.riskDetail !== undefined && item.riskDetail.trim() !== "") return item.riskDetail;
  if (item.riskStatus === "blocked") return "清单解析失败，暂不把它当作可信资产";
  if (item.riskStatus === "clear") return "已完成风险扫描";
  return "尚未执行风险扫描";
}

function skillsNotice(mode: InventoryMode): string {
  if (mode === "driver") return "管家正在正常读取本机技能；现在只能查看，不能开启、停用或删除。";
  if (mode === "directory-fallback")
    return "技能服务暂时没连上，先按文件统计；现在只能查看，不能开启、停用或删除。";
  return "暂时读不到技能列表；等管家服务恢复后再试。";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: string | null): string {
  if (value === null) return "尚无写入";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function DirectoryFallback({ directory }: { directory: DirectoryInventory }) {
  return (
    <div className="skills-fallback">
      <div>
        <strong>{formatNumber(directory.fileCount)}</strong>
        <span>文件</span>
      </div>
      <div>
        <strong>{formatNumber(directory.directoryCount)}</strong>
        <span>文件夹</span>
      </div>
      <div>
        <strong>{formatBytes(directory.sizeBytes)}</strong>
        <span>占用空间</span>
      </div>
      <p title={directory.roots.join(" · ")}>
        {directory.truncated
          ? "只显示了部分文件，详细位置见提示。"
          : "已按本机文件统计，未修改任何内容。"}
      </p>
    </div>
  );
}

function healthTone(score: number): string {
  if (score >= 85) return "good";
  if (score >= 65) return "ok";
  if (score >= 40) return "warn";
  return "bad";
}

const SIGNAL_LABELS: Record<string, string> = {
  integrity: "数据库完整性",
  "fts-index": "全文索引",
  "write-activity": "写入活跃度",
  "write-reliability": "写入失败率",
  "recall-hit-rate": "召回命中率",
  "recall-coverage": "召回覆盖",
  cold: "冷数据占比",
  "probe-hygiene": "探针残留",
};

interface MemorySelfCheckView {
  status: "pass" | "warn" | "fail" | "skipped";
  detail: string;
}

interface MemoryHealthCardProps {
  health: MemoryHealthView | null;
  selfCheck: { busy: boolean; result: MemorySelfCheckView | null };
  onSelfCheck: () => void;
  onBackup: () => void;
  backupBusy: boolean;
}

function MemoryHealthCard({
  health,
  selfCheck,
  onSelfCheck,
  onBackup,
  backupBusy,
}: MemoryHealthCardProps) {
  if (health === null) {
    return (
      <div className="memory-health is-unknown">
        <div className="memory-health-head">
          <strong>记忆健康</strong>
          <span>管家还没返回健康分析</span>
        </div>
      </div>
    );
  }
  const tone = healthTone(health.score);
  return (
    <div className={`memory-health is-${tone}`}>
      <div className="memory-health-head">
        <div className="memory-health-score">
          <strong>{Math.round(health.score)}</strong>
          <span>/100</span>
        </div>
        <div>
          <strong>记忆健康</strong>
          <span>
            {tone === "good"
              ? "状态很好，不需要动手"
              : tone === "ok"
                ? "基本正常，可留意建议"
                : tone === "warn"
                  ? "有需要注意的地方"
                  : "建议尽快处理"}
          </span>
        </div>
      </div>

      <ul className="memory-signals">
        {health.signals.map((signal) => (
          <li key={signal.id} className={`is-${signal.status}`}>
            <i />
            <div>
              <strong>{SIGNAL_LABELS[signal.id] ?? signal.label}</strong>
              <span>{signal.detail}</span>
            </div>
          </li>
        ))}
      </ul>

      {health.suggestions.length > 0 && (
        <div className="memory-suggestions">
          <strong>管家建议</strong>
          {health.suggestions.map((suggestion) => (
            <div className="memory-suggestion" key={suggestion.id}>
              <div>
                <strong>{suggestion.title}</strong>
                <span>{suggestion.detail}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="memory-health-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={backupBusy}
          onClick={onBackup}
          title="把记忆库备份到本地，升级或恢复前更安心"
        >
          {backupBusy ? "备份中…" : "记忆备份"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={selfCheck.busy}
          onClick={onSelfCheck}
          title="写入并召回一条管家测试记忆后自动清理，不会改动你的记忆"
        >
          {selfCheck.busy ? "自检中…" : "立即自检记忆"}
        </button>
      </div>

      {selfCheck.result !== null && (
        <div className={`memory-selfcheck is-${selfCheck.result.status}`} role="status">
          <strong>
            {selfCheck.result.status === "pass"
              ? "记忆读写正常"
              : selfCheck.result.status === "warn"
                ? "记忆读写基本正常，需要留意"
                : selfCheck.result.status === "skipped"
                  ? "本次自检跳过"
                  : "记忆读写有问题"}
          </strong>
          <span>{selfCheck.result.detail}</span>
        </div>
      )}
    </div>
  );
}

function groupByCategory<T extends { category?: string; name: string }>(items: T[]): Array<{
  category: string;
  items: T[];
}> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.category?.trim() || "未分类";
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([category, list]) => ({ category, items: list }))
    .sort((a, b) => a.category.localeCompare(b.category, "zh-CN"));
}

function PluginLibrary({
  plugins,
  category,
  source,
  onCategory,
  onSource,
}: {
  plugins: SkillsPayload["plugins"];
  category: string;
  source: string;
  onCategory: (value: string) => void;
  onSource: (value: string) => void;
}) {
  if (plugins.mode === "unavailable") {
    return (
      <div className="skills-empty">
        暂时读不到插件清单；管家服务恢复后可重试。
      </div>
    );
  }
  if (plugins.items.length === 0) {
    return <div className="skills-empty">没有发现插件；插件会按分类显示在这里。</div>;
  }
  const categories = [
    ...new Set(plugins.items.map((item) => item.category?.trim() || "未分类")),
  ].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const sources = [...new Set(plugins.items.map((item) => item.source))].sort((a, b) =>
    a.localeCompare(b, "zh-CN"),
  );
  const filtered =
    plugins.items.filter(
      (item) =>
        (category === "" || (item.category?.trim() || "未分类") === category) &&
        (source === "" || item.source === source),
    );
  const groups = groupByCategory(filtered);
  return (
    <>
      <div className="skills-filter-row">
        <label className="skills-filter">
          <span>按分类筛选</span>
          <select value={category} onChange={(event) => onCategory(event.target.value)}>
            <option value="">全部分类</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="skills-filter">
          <span>按来源筛选</span>
          <select value={source} onChange={(event) => onSource(event.target.value)}>
            <option value="">全部来源</option>
            {sources.map((item) => (
              <option key={item} value={item}>
                {SOURCE_LABELS[item] ?? item}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="plugin-groups">
        {groups.map((group) => (
          <div className="plugin-group" key={group.category}>
            <div className="plugin-group-head">
              <strong>{group.category}</strong>
              <span>{group.items.length} 个</span>
            </div>
            <div className="plugin-grid">
              {group.items.map((plugin, index) => (
                <article className="plugin-card" key={`${plugin.name}:${plugin.version}:${index}`}>
                  <div className="plugin-card-main">
                    <strong>{plugin.name}</strong>
                    <span>{SOURCE_LABELS[plugin.source] ?? plugin.source}</span>
                  </div>
                  <div
                    className={"asset-risk is-" + (plugin.riskStatus ?? "unscanned")}
                    title={riskDetail(plugin)}
                  >
                    <span>{riskLabel(plugin.riskStatus)}</span>
                    <small>{riskDetail(plugin)}</small>
                  </div>
                  {plugin.description !== undefined && <p>{plugin.description}</p>}
                  <div className="plugin-card-meta">
                    <code>{plugin.version}</code>
                    <span className={plugin.enabled ? "is-enabled" : "is-disabled"}>
                      {plugin.enabled ? "已启用" : "已停用"}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}
      </div>
      {filtered.length === 0 && <div className="skills-empty">没有匹配当前分类的插件。</div>}
    </>
  );
}

export function SkillsPage() {
  const [data, setData] = useState<SkillsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [skillFilter, setSkillFilter] = useState("");
  const [skillCategory, setSkillCategory] = useState("");
  const [skillSource, setSkillSource] = useState("");
  const [pluginCategory, setPluginCategory] = useState("");
  const [pluginSource, setPluginSource] = useState("");
  const [memoryInput, setMemoryInput] = useState("");
  const [activeKeyword, setActiveKeyword] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(
    null,
  );
  const [selfCheck, setSelfCheck] = useState<{
    busy: boolean;
    result: MemorySelfCheckView | null;
  }>({ busy: false, result: null });

  const load = useCallback(async (keyword: string) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (keyword.trim() !== "") params.set("keyword", keyword.trim());
    params.set("limit", "20");
    const payload = await fetchJson<SkillsPayload>(`/api/skills?${params.toString()}`, 10_000);
    if (payload !== null) setData(payload);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load("");
  }, [load]);

  const visibleSkills = useMemo(() => {
    const needle = skillFilter.trim().toLocaleLowerCase();
    const items = data?.skills.items ?? [];
    const categoryMatched =
      skillCategory === ""
        ? items
        : items.filter((skill) => (skill.category?.trim() || "未分类") === skillCategory);
    const sourceMatched =
      skillSource === "" ? categoryMatched : categoryMatched.filter((skill) => skill.source === skillSource);
    if (needle === "") return sourceMatched;
    return sourceMatched.filter((skill) =>
      `${skill.name} ${skill.version} ${skill.source}`.toLocaleLowerCase().includes(needle),
    );
  }, [data?.skills.items, skillFilter, skillCategory, skillSource]);

  const skillCategories = useMemo(
    () =>
      [...new Set((data?.skills.items ?? []).map((item) => item.category?.trim() || "未分类"))].sort(
        (a, b) => a.localeCompare(b, "zh-CN"),
      ),
    [data?.skills.items],
  );
  const skillSources = useMemo(
    () =>
      [...new Set((data?.skills.items ?? []).map((item) => item.source))].sort((a, b) =>
        a.localeCompare(b, "zh-CN"),
      ),
    [data?.skills.items],
  );

  const months = useMemo(() => {
    const source = data?.memory.stats?.byMonth ?? [];
    return source.slice(-8).reverse();
  }, [data?.memory.stats?.byMonth]);
  const maxMonthCount = Math.max(1, ...months.map((item) => item.count));

  const submitMemorySearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const keyword = memoryInput.trim();
    setActiveKeyword(keyword);
    void load(keyword);
  };

  const runMemoryBackup = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setActionNotice(null);
    const result = await postJson("/api/backups", { kind: "memory", label: "记忆页手动备份" }, 15_000);
    setBackupBusy(false);
    if (result.ok && result.data !== null && typeof result.data === "object") {
      setActionNotice({
        tone: "ok",
        text: "记忆库备份完成，已保存在本地备份目录。",
      });
    } else {
      setActionNotice({
        tone: "error",
        text: "记忆备份失败；请稍后重试或查看管家日志。",
      });
    }
  };

  const runSelfCheck = async () => {
    if (selfCheck.busy) return;
    setSelfCheck({ busy: true, result: null });
    setActionNotice(null);
    const result = await postJson("/api/memory/self-check", {}, 15_000);
    if (result.ok && result.data !== null && typeof result.data === "object") {
      const data = result.data as { result?: MemorySelfCheckView };
      if (data.result !== undefined) {
        setSelfCheck({ busy: false, result: data.result });
        setActionNotice({
          tone: data.result.status === "fail" ? "error" : "ok",
          text:
            data.result.status === "pass"
              ? "记忆自检完成，写入和召回都正常。"
              : data.result.status === "skipped"
                ? "本次自检跳过（详见结果）。"
                : "记忆自检完成，有需要注意的地方（详见结果）。",
        });
        void load(activeKeyword);
        return;
      }
    }
    setSelfCheck({ busy: false, result: null });
    setActionNotice({
      tone: "error",
      text: "记忆自检失败；请稍后重试或查看管家日志。",
    });
  };

  const skillGroups = useMemo(() => groupByCategory(visibleSkills), [visibleSkills]);

  return (
    <section className="page skills-page">
      <header className="skills-header">
        <div>
          <span className="skills-eyebrow">只读查看</span>
          <h1>技能与记忆</h1>
          <p>查看 AI 学会的东西和记住的事；当前版本只读，不会改动技能或删除记忆。</p>
        </div>
        <div className="skills-header-status">
          <span className={`skills-live ${data?.watchReachable ? "is-online" : "is-offline"}`}>
            <i />
            {data === null
              ? "正在连接管家"
              : data.watchReachable
                ? "管家服务已连接"
                : "管家服务暂时连不上"}
          </span>
          <span className="skills-instance">
            {data?.instance === null || data?.instance === undefined
              ? "尚未发现 AI 助手"
              : `AI 助手版本：${data.instance.version ?? "版本未知"}`}
          </span>
        </div>
      </header>

      <div className="skills-workspace">
        <section className="skills-pane skills-library">
          <div className="skills-section-head">
            <div>
              <span className="skills-kicker">技能库</span>
              <h2>{formatNumber(data?.skills.total ?? 0)} 个技能</h2>
            </div>
            <span className={`skills-mode is-${data?.skills.mode ?? "unavailable"}`}>
              {modeLabel(data?.skills.mode ?? "unavailable")}
            </span>
          </div>

          <div className="skills-filter-row">
            <label className="skills-filter">
              <span>筛选技能</span>
              <input
                type="search"
                placeholder="名称或版本"
                value={skillFilter}
                onChange={(event) => setSkillFilter(event.target.value)}
              />
            </label>
            <label className="skills-filter">
              <span>按分类筛选</span>
              <select
                value={skillCategory}
                onChange={(event) => setSkillCategory(event.target.value)}
              >
                <option value="">全部分类</option>
                {skillCategories.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label className="skills-filter">
              <span>按来源筛选</span>
              <select value={skillSource} onChange={(event) => setSkillSource(event.target.value)}>
                <option value="">全部来源</option>
                {skillSources.map((item) => (
                  <option key={item} value={item}>
                    {SOURCE_LABELS[item] ?? item}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="skills-driver-note">
            <strong>{modeLabel(data?.skills.mode ?? "unavailable")}</strong>
            <span>{data === null ? "正在读取技能状态" : skillsNotice(data.skills.mode)}</span>
          </div>

          {data?.skills.mode === "directory-fallback" && (
            <DirectoryFallback directory={data.skills.directory} />
          )}

          <div className="skills-list" aria-busy={loading}>
            {skillGroups.map((group) => (
              <div className="skill-group" key={group.category}>
                <div className="skill-group-head">
                  <strong>{group.category}</strong>
                  <span>{group.items.length} 个</span>
                </div>
                {group.items.map((skill, index) => (
                  <article
                    className="skills-row"
                    key={`${skill.name}:${skill.version}:${index}`}
                    style={{ animationDelay: `${Math.min(index, 12) * 28}ms` }}
                  >
                    <div className="skills-row-main">
                      <strong>{skill.name}</strong>
                      <span>{SOURCE_LABELS[skill.source] ?? skill.source}</span>
                    </div>
                    <div className="skills-row-meta">
                      <code>{skill.version}</code>
                      <span className={skill.enabled ? "is-enabled" : "is-disabled"}>
                        {skill.enabled ? "已启用" : "已停用"}
                      </span>
                      <span
                        className={"asset-risk-dot is-" + (skill.riskStatus ?? "unscanned")}
                        title={riskDetail(skill)}
                      >
                        {riskLabel(skill.riskStatus)}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            ))}
            {!loading && visibleSkills.length === 0 && data?.skills.mode === "driver" && (
              <div className="skills-empty">没有匹配当前筛选条件的技能。</div>
            )}
            {loading && data === null && <div className="skills-empty">正在读取技能清单…</div>}
          </div>

          <div className="plugin-section">
            <div className="skills-section-head plugin-section-head">
              <div>
                <span className="skills-kicker">插件库</span>
                <h2>{formatNumber(data?.plugins.total ?? 0)} 个插件</h2>
              </div>
              <span className={`skills-mode is-${data?.plugins.mode ?? "unavailable"}`}>
                {modeLabel(data?.plugins.mode ?? "unavailable")}
              </span>
            </div>
            <div className="skills-driver-note">
              <strong>{modeLabel(data?.plugins.mode ?? "unavailable")}</strong>
              <span>{data === null ? "正在读取插件状态" : data.plugins.notice}</span>
            </div>
            {data?.plugins.mode === "directory-fallback" && (
              <DirectoryFallback directory={data.plugins.directory} />
            )}
            {data !== null && (
              <PluginLibrary
                plugins={data.plugins}
                category={pluginCategory}
                source={pluginSource}
                onCategory={setPluginCategory}
                onSource={setPluginSource}
              />
            )}
          </div>
        </section>

        <section className="skills-pane memory-library">
          <div className="skills-section-head">
            <div>
              <span className="skills-kicker">记忆库</span>
              <h2>统计与检索预览</h2>
            </div>
            <button
              type="button"
              className="skills-refresh"
              onClick={() => void load(activeKeyword)}
              disabled={loading}
            >
              {loading ? "刷新中" : "刷新"}
            </button>
          </div>

          <div className="memory-stats">
            <div>
              <strong>{formatNumber(data?.memory.stats?.totalEntries ?? 0)}</strong>
              <span>记忆条目</span>
            </div>
            <div>
              <strong>{formatNumber(data?.memory.stats?.coldCandidates ?? 0)}</strong>
              <span>长期未使用</span>
            </div>
            <div>
              <strong>{formatTime(data?.memory.stats?.lastWriteAt ?? null)}</strong>
              <span>最近写入</span>
            </div>
            <div>
              <strong>{formatNumber(data?.memory.stats?.cumulativeRecalls ?? 0)}</strong>
              <span>累计召回</span>
            </div>
            <div>
              <strong>
                {data?.memory.stats?.probeRecallAttempts !== undefined &&
                data?.memory.stats?.probeRecallAttempts > 0
                  ? `${Math.round(
                      ((data.memory.stats.probeRecallHits ?? 0) / data.memory.stats.probeRecallAttempts) *
                        100,
                    )}%`
                  : "—"}
              </strong>
              <span>探针召回命中</span>
            </div>
          </div>

          {actionNotice !== null && (
            <div className={`memory-action-notice is-${actionNotice.tone}`} role="status">
              {actionNotice.text}
            </div>
          )}

          <div className="memory-health-wrap">
            <MemoryHealthCard
              health={data?.memory.health ?? null}
              selfCheck={selfCheck}
              onSelfCheck={() => void runSelfCheck()}
              onBackup={() => void runMemoryBackup()}
              backupBusy={backupBusy}
            />
          </div>

          <div className={`memory-activity is-${data?.memory.writeActivity.status ?? "unknown"}`}>
            <i />
            <div>
              <strong>
                {data?.memory.writeActivity.status === "active"
                  ? "写入活跃"
                  : data?.memory.writeActivity.status === "stalled"
                    ? "可能停写"
                    : data?.memory.writeActivity.status === "empty"
                      ? "尚无记忆"
                      : "状态未知"}
              </strong>
              <span>{data?.memory.writeActivity.detail ?? "等待管家返回最近写入时间"}</span>
            </div>
          </div>

          {data?.memory.mode === "directory-fallback" && (
            <DirectoryFallback directory={data.memory.directory} />
          )}

          {months.length > 0 && (
            <div className="memory-months">
              <div className="memory-subhead">
                <strong>按月分布</strong>
                <span>最近 {months.length} 个月</span>
              </div>
              <div className="memory-bars">
                {months.map((item) => (
                  <div className="memory-bar-row" key={item.month}>
                    <span>{item.month}</span>
                    <div>
                      <i style={{ width: `${Math.max(4, (item.count / maxMonthCount) * 100)}%` }} />
                    </div>
                    <strong>{formatNumber(item.count)}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}

          <form className="memory-search" onSubmit={submitMemorySearch}>
            <label>
              <span>全文检索记忆</span>
              <input
                type="search"
                placeholder="输入至少 3 个字"
                value={memoryInput}
                onChange={(event) => setMemoryInput(event.target.value)}
              />
            </label>
            <button type="submit" disabled={loading || data?.memory.mode !== "driver"}>
              浏览
            </button>
          </form>

          <div className="memory-preview-head">
            <div>
              <strong>{activeKeyword === "" ? "最近记忆" : `“${activeKeyword}” 的结果`}</strong>
              <span>
                当前显示 {data?.memory.preview.length ?? 0} 条 · 最多显示{" "}
                {data?.memory.previewLimit ?? 50} 条
              </span>
            </div>
            <strong>读取状态已就绪</strong>
          </div>

          <div className="memory-preview" aria-live="polite">
            {(data?.memory.preview ?? []).map((entry, index) => (
              <article
                className="memory-entry"
                key={entry.entryId}
                style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
              >
                <div>
                  <span>{formatTime(entry.writtenAt)}</span>
                  {entry.channel !== undefined && (
                    <span className="memory-channel">{channelLabel(entry.channel)}</span>
                  )}
                  {entry.cold === true && <em>较久未用</em>}
                </div>
                <p>{entry.content}</p>
              </article>
            ))}
            {!loading && (data?.memory.preview.length ?? 0) === 0 && (
              <div className="skills-empty">
                {data?.memory.mode === "driver"
                  ? "没有可预览的记忆。"
                  : "没有可预览的记忆；管家服务恢复后可重试。"}
              </div>
            )}
          </div>

          <div className="skills-scope-note">
            <span>当前能做到</span>
            <p>
              这里仅查看技能、插件、记忆与健康状态；可以运行临时记忆自检，并创建本地记忆备份。
            </p>
          </div>
        </section>
      </div>
    </section>
  );
}
