/**
 * 技能市场面板（技能库 Tab 的市场式重构）：
 * 顶部「技能市场 / 本机已安装」分段切换 + 搜索/收编/Git 安装工具带；
 * 左侧粘性中文分类导航（完整分类 + 计数），右侧瀑布流技能卡。
 *
 * 数据：市场 = skills.sh 搜索 + 公开趋势（github-trends）+ 使用推荐（recommendations）；
 * 已安装 = skills-manager 中央库（status + updates）。
 * 操作：安装 / 部署 / 取消部署 / 更新（单个与全部）/ 删除 / 收编 / 标签 / Git 源绑定，
 * 危险操作保持「先试运行、后确认」两段式；能力与旧表格面板一一对应（批量多选除外）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Input,
  Modal,
  Segmented,
  Spin,
  Statistic,
  Tag,
  Typography,
} from "antd";
import {
  CloudDownloadOutlined,
  FolderOpenOutlined,
  MoreOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import type { FetchState } from "../../lib/api.js";
import { loadJson, postJson } from "../../lib/api.js";
import { formatTime } from "./helpers.js";
import { CategoryRail } from "./CategoryRail.js";
import { SkillMarketCard } from "./SkillMarketCard.js";
import {
  ACTION_TIMEOUT_MS,
  ALL_CATEGORY_LABEL,
  categorize,
  deployedToTarget,
  extractError,
  formatInstalls,
  hasAvailableUpdate,
  previewEntries,
  stringArray,
  updateStatusLabel,
} from "./marketplace.js";
import type {
  MarketSearchResult,
  Recommendation,
  SkillsManagerSkill,
  SkillsManagerStatus,
  TrendItem,
  UpdateCheckItem,
} from "./marketplace.js";

const { Text } = Typography;

type MarketView = "market" | "installed";

interface PendingAction {
  title: string;
  op: "deploy" | "undeploy" | "remove";
  payload: Record<string, unknown>;
  preview: unknown;
}

interface SourceDraft {
  name: string;
  gitUrl: string;
  subpath: string;
  branch: string;
  force: boolean;
}

const MARKET_SEARCH_TIMEOUT_MS = 120_000;

/** 后端失败载荷转人话：优先中文 detail/fix（stage/安装失败的真实原因），否则走通用提取。 */
function friendlyError(data: unknown, fallback: string): string {
  if (data !== null && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const detail = typeof record["detail"] === "string" ? record["detail"].trim() : "";
    const fix = typeof record["fix"] === "string" ? record["fix"].trim() : "";
    const parts = [detail, fix].filter((item) => item !== "");
    if (parts.length > 0) return parts.join("；");
  }
  return extractError(data, fallback);
}

function ownerOf(repoName: string): string {
  return repoName.includes("/") ? repoName.split("/")[0] : repoName;
}

function isLocalAdopted(item: SkillsManagerSkill, hermesSkillsDir?: string): boolean {
  return (
    item.source_type === "local" &&
    typeof item.source_ref === "string" &&
    typeof hermesSkillsDir === "string" &&
    item.source_ref.startsWith(hermesSkillsDir)
  );
}

/** 卡片头部状态标签：可更新 > 本机运行中 > 已部署 > 未部署。 */
function installedStatusTag(
  item: SkillsManagerSkill,
  options: { updatable: boolean; localRunning: boolean },
): { text: string; color: "success" | "processing" | "warning" | "default" } {
  if (options.updatable) return { text: "有可用更新", color: "warning" };
  if (options.localRunning) return { text: "本机运行中", color: "processing" };
  if (deployedToTarget(item)) return { text: "已部署", color: "success" };
  return { text: "未部署", color: "default" };
}

export function SkillsMarketplace() {
  const { message } = App.useApp();
  const [state, setState] = useState<FetchState<SkillsManagerStatus>>({ status: "loading" });
  const [updates, setUpdates] = useState<Record<string, UpdateCheckItem>>({});

  const [view, setView] = useState<MarketView>("market");
  const [activeCategory, setActiveCategory] = useState(ALL_CATEGORY_LABEL);
  const [keyword, setKeyword] = useState("");

  const [trends, setTrends] = useState<TrendItem[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [marketSyncedAt, setMarketSyncedAt] = useState<string | null>(null);
  const [marketNotice, setMarketNotice] = useState("");
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketQuery, setMarketQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MarketSearchResult[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [recommendBusy, setRecommendBusy] = useState<string | null>(null);

  const [gitInstallOpen, setGitInstallOpen] = useState(false);
  const [gitSource, setGitSource] = useState("");
  const [gitName, setGitName] = useState("");
  const [installBusy, setInstallBusy] = useState(false);
  const [adoptBusy, setAdoptBusy] = useState(false);
  const [updateAllBusy, setUpdateAllBusy] = useState(false);

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [detailName, setDetailName] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ show: unknown; status: unknown } | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [sourceDraft, setSourceDraft] = useState<SourceDraft | null>(null);
  const [sourcePreview, setSourcePreview] = useState<unknown>(null);
  const [sourceConfirming, setSourceConfirming] = useState(false);

  /** 中央库状态 + 更新检查，一次刷新。 */
  const loadAll = useCallback(async (options?: { silent?: boolean }) => {
    if (options?.silent !== true) setState({ status: "loading" });
    const [statusResult, updatesResult] = await Promise.all([
      loadJson<SkillsManagerStatus>("/api/skills-manager/status", 15_000),
      loadJson<UpdateCheckItem[]>("/api/skills-manager/updates", 15_000),
    ]);
    if (!statusResult.ok) {
      setState({ status: "failed", reason: statusResult.reason });
      return;
    }
    setState({ status: "ready", data: statusResult.data });
    const map: Record<string, UpdateCheckItem> = {};
    if (updatesResult.ok && Array.isArray(updatesResult.data))
      for (const item of updatesResult.data) {
        const key = item.name ?? item.skill_id;
        if (typeof key === "string" && key !== "") map[key] = item;
      }
    setUpdates(map);
  }, []);

  /** 市场数据：公开趋势 + 使用推荐；趋势为空且从未同步时自动触发一次同步。 */
  const loadMarket = useCallback(async () => {
    setMarketLoading(true);
    const [trendResult, recommendResult] = await Promise.all([
      loadJson<{ items: TrendItem[]; syncedAt: string | null; notice: string; error?: string }>(
        "/api/skills/github-trends",
        10_000,
      ),
      loadJson<{ items: Recommendation[] }>("/api/skills/recommendations", 10_000),
    ]);
    let nextTrends = trendResult.ok ? trendResult.data.items : [];
    if (trendResult.ok && nextTrends.length === 0 && trendResult.data.syncedAt === null) {
      const sync = await postJson("/api/skills/github-trends/refresh", {}, 30_000);
      if (sync.ok) {
        const again = await loadJson<{
          items: TrendItem[];
          syncedAt: string | null;
          notice: string;
          error?: string;
        }>("/api/skills/github-trends", 10_000);
        if (again.ok) {
          nextTrends = again.data.items;
          setMarketSyncedAt(again.data.syncedAt);
          setMarketNotice(again.data.notice ?? "");
        }
      }
    } else if (trendResult.ok) {
      setMarketSyncedAt(trendResult.data.syncedAt);
      setMarketNotice(trendResult.data.notice ?? "");
    }
    setTrends(nextTrends);
    setRecommendations(recommendResult.ok ? recommendResult.data.items ?? [] : []);
    setMarketLoading(false);
  }, []);

  useEffect(() => {
    void loadAll();
    void loadMarket();
  }, [loadAll, loadMarket]);

  const status = state.status === "ready" ? state.data : null;
  const skills = useMemo(
    () => (status?.available === true ? status.skills ?? [] : []),
    [status],
  );
  const hermesSkillsDir = status?.available === true ? status.hermesSkillsDir : undefined;
  const cliVersion = status?.available === true ? status.cli?.version : undefined;
  const installedNames = useMemo(() => new Set(skills.map((item) => item.name)), [skills]);

  /** 已安装视图的卡片数据：名称/描述/标签 + 启发式中文分类 + 更新状态。 */
  const installedCards = useMemo(
    () =>
      skills.map((item) => {
        const tags = stringArray(item.tags);
        const category = categorize({
          name: item.name,
          description: item.description,
          tags,
        });
        const updatable = hasAvailableUpdate(updates[item.name]);
        const localRunning = isLocalAdopted(item, hermesSkillsDir);
        return { item, tags, category, updatable, localRunning };
      }),
    [skills, updates, hermesSkillsDir],
  );

  /** 分类计数（含「全部技能」）；按当前视图的数据源统计。 */
  const countByCategory = useMemo(() => {
    const source =
      view === "installed"
        ? installedCards.map((card) => ({ name: card.item.name, description: card.item.description, tags: card.tags }))
        : searchResults !== null
          ? searchResults.map((item) => ({
              name: item.name ?? item.skill_id ?? "",
              description: item.source ?? "",
              tags: [] as string[],
            }))
          : [
              ...recommendations.map((item) => ({
                name: item.name,
                description: item.description ?? item.reason,
                tags: [] as string[],
              })),
              ...trends.map((item) => ({
                name: item.name,
                description: item.description,
                tags: [] as string[],
              })),
            ];
    const counts: Record<string, number> = { [ALL_CATEGORY_LABEL]: source.length };
    for (const item of source) {
      const category = categorize(item);
      counts[category] = (counts[category] ?? 0) + 1;
    }
    return counts;
  }, [view, installedCards, recommendations, trends, searchResults]);

  const categoryMatches = (category: string) =>
    activeCategory === ALL_CATEGORY_LABEL || category === activeCategory;

  const visibleInstalled = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return installedCards.filter((card) => {
      if (!categoryMatches(card.category)) return false;
      if (needle === "") return true;
      const text = `${card.item.name} ${card.item.description ?? ""} ${card.tags.join(" ")}`;
      return text.toLowerCase().includes(needle);
    });
  }, [installedCards, keyword, activeCategory]);

  const marketCards = useMemo(() => {
    if (searchResults !== null) {
      return searchResults.map((item, index) => {
        const name = item.name ?? item.skill_id ?? "未命名技能";
        const installRef = item.install_ref ?? item.source ?? "";
        const category = categorize({ name, description: item.source });
        return {
          key: `search-${installRef}-${index}`,
          name,
          subtitle: `${item.skill_id ?? item.source ?? "skills"} · skills 市场`,
          description: item.source ?? "skills.sh 市场技能",
          category,
          tags: ["skills 市场"],
          installRef,
          installName: name,
          installed: installedNames.has(name),
          installs: item.installs,
        };
      });
    }
    return [
      ...recommendations.map((item) => {
        const description = item.description ?? item.reason;
        return {
          key: `rec-${item.id}`,
          name: item.name,
          subtitle: `${item.id} · 管家推荐`,
          description,
          category: categorize({ name: item.name, description }),
          tags: ["推荐"],
          recommendation: item,
          installed: installedNames.has(item.name),
        };
      }),
      ...trends.map((item) => ({
        key: `trend-${item.name}`,
        name: item.name,
        subtitle: `${item.name} · 公开项目`,
        description: item.description ?? "公开技能项目，具体用途以仓库说明为准。",
        category: categorize({ name: item.name, description: item.description }),
        tags: ["GitHub 公开项目"],
        trend: item,
        installed: installedNames.has(item.name),
      })),
    ];
  }, [searchResults, recommendations, trends, installedNames]);

  const visibleMarket = useMemo(
    () => marketCards.filter((card) => categoryMatches(card.category)),
    [marketCards, activeCategory],
  );

  const deployedCount = installedCards.filter((card) => deployedToTarget(card.item)).length;
  const updatableCount = installedCards.filter((card) => card.updatable).length;

  // ---- 操作流（与旧面板一一对应） ----

  const beginAction = async (
    op: PendingAction["op"],
    title: string,
    payload: Record<string, unknown>,
  ) => {
    const result = await postJson(`/api/skills-manager/${op}`, payload, ACTION_TIMEOUT_MS);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    setPending({ title, op, payload, preview: result.data });
  };

  const confirmPending = async () => {
    if (pending === null || confirming) return;
    setConfirming(true);
    const result = await postJson(
      `/api/skills-manager/${pending.op}`,
      { ...pending.payload, confirmed: true },
      ACTION_TIMEOUT_MS,
    );
    setConfirming(false);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    message.success("操作已完成。");
    setPending(null);
    void loadAll({ silent: true });
  };

  const beginInstall = async (source: string, name = "", sourceType?: "skills" | "git" | "local") => {
    const cleanSource = source.trim();
    if (cleanSource === "") {
      message.warning("请填写技能来源。");
      return;
    }
    setInstallBusy(true);
    const result = await postJson(
      "/api/skills-manager/install",
      {
        source: cleanSource,
        confirmed: true,
        ...(name.trim() === "" ? {} : { name: name.trim() }),
        ...(sourceType === undefined ? {} : { sourceType }),
      },
      ACTION_TIMEOUT_MS,
    );
    setInstallBusy(false);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    message.success("技能已安装到中央库。");
    setGitInstallOpen(false);
    setGitSource("");
    setGitName("");
    void loadAll({ silent: true });
  };

  /** 推荐技能走「暂存 → 安装」两段接口（备份后落库）。 */
  const installRecommendation = async (item: Recommendation) => {
    if (recommendBusy !== null) return;
    setRecommendBusy(item.id);
    const staged = await postJson(
      `/api/skills/recommendations/${encodeURIComponent(item.id)}/stage`,
      {},
      30_000,
    );
    const stageId =
      staged.ok && staged.data !== null && typeof staged.data === "object" && "id" in staged.data
        ? String((staged.data as { id: unknown }).id)
        : "";
    if (!staged.ok || stageId === "") {
      setRecommendBusy(null);
      message.error(staged.ok ? "服务未返回安装标识。" : friendlyError(staged.data, "技能下载或检查未完成。"));
      return;
    }
    const installed = await postJson(
      `/api/skills/staged/${encodeURIComponent(stageId)}/install`,
      { confirmed: true },
      30_000,
    );
    setRecommendBusy(null);
    if (!installed.ok) {
      message.error(friendlyError(installed.data, "备份或安装未完成。"));
      return;
    }
    message.success("技能已安装到中央库。");
    void loadAll({ silent: true });
    void loadMarket();
  };

  const searchMarket = async () => {
    const query = marketQuery.trim();
    if (query === "") {
      message.warning("请输入市场搜索关键词。");
      return;
    }
    setSearchBusy(true);
    const result = await loadJson<MarketSearchResult[]>(
      `/api/skills-manager/search?query=${encodeURIComponent(query)}`,
      MARKET_SEARCH_TIMEOUT_MS,
    );
    setSearchBusy(false);
    if (!result.ok) {
      message.error(
        `${result.reason}。市场数据来自 skills.sh 在线源，网络波动可能导致失败；可稍后重试，或改用「从 Git 安装」。`,
      );
      return;
    }
    setActiveCategory(ALL_CATEGORY_LABEL);
    setSearchResults(Array.isArray(result.data) ? result.data : []);
  };

  const updateOne = async (item: SkillsManagerSkill) => {
    const result = await postJson(
      "/api/skills-manager/update",
      { name: item.name, confirmed: true },
      ACTION_TIMEOUT_MS,
    );
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    if (deployedToTarget(item)) {
      const redeploy = await postJson(
        "/api/skills-manager/deploy",
        { name: item.name, confirmed: true },
        ACTION_TIMEOUT_MS,
      );
      if (!redeploy.ok) message.warning("技能已更新，但重新部署失败；请稍后手动部署。");
    }
    message.success("技能已更新");
    void loadAll({ silent: true });
  };

  const updateAll = async () => {
    if (updateAllBusy) return;
    setUpdateAllBusy(true);
    const deployed = skills.filter(deployedToTarget).map((item) => item.name);
    const result = await postJson("/api/skills-manager/update", { all: true }, ACTION_TIMEOUT_MS);
    if (!result.ok) {
      setUpdateAllBusy(false);
      message.error(extractError(result.data));
      return;
    }
    let failed = 0;
    for (const name of deployed) {
      const redeploy = await postJson(
        "/api/skills-manager/deploy",
        { name, confirmed: true },
        ACTION_TIMEOUT_MS,
      );
      if (!redeploy.ok) failed += 1;
    }
    setUpdateAllBusy(false);
    if (failed > 0) message.warning(`全部更新完成，但 ${failed} 个已部署技能重新部署失败。`);
    else message.success("已更新全部技能，并同步重新部署原有部署项。");
    void loadAll({ silent: true });
  };

  const adoptLocalSkills = async () => {
    if (adoptBusy || hermesSkillsDir === undefined) return;
    setAdoptBusy(true);
    const preview = await postJson(
      "/api/skills-manager/adopt",
      { dir: hermesSkillsDir },
      ACTION_TIMEOUT_MS,
    );
    if (!preview.ok) {
      setAdoptBusy(false);
      message.error(extractError(preview.data));
      return;
    }
    Modal.confirm({
      title: "确认收编本机技能？",
      content: (
        <pre style={{ maxHeight: 220, overflow: "auto", fontSize: 12 }}>
          {JSON.stringify(preview.data, null, 2)}
        </pre>
      ),
      okText: "确认收编",
      cancelText: "取消",
      onOk: async () => {
        const result = await postJson(
          "/api/skills-manager/adopt",
          { dir: hermesSkillsDir, confirmed: true },
          ACTION_TIMEOUT_MS,
        );
        if (!result.ok) {
          message.error(extractError(result.data));
          return;
        }
        message.success("本机技能已收编到中央库。");
        void loadAll({ silent: true });
      },
    });
    setAdoptBusy(false);
  };

  const openDetail = async (name: string) => {
    setDetailName(name);
    setDetail(null);
    setDetailBusy(true);
    const result = await loadJson<{ show: unknown; status: unknown }>(
      `/api/skills-manager/skills/${encodeURIComponent(name)}`,
      30_000,
    );
    setDetailBusy(false);
    if (!result.ok) {
      message.error(result.reason);
      return;
    }
    setDetail(result.data);
  };

  const updateTags = async (action: "add" | "remove" | "set") => {
    if (detailName === null) return;
    const next = tagDraft
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (next.length === 0) {
      message.warning("请填写至少一个标签，多个标签用逗号分隔。");
      return;
    }
    setTagBusy(true);
    const result = await postJson(
      "/api/skills-manager/tags",
      { action, name: detailName, tags: next },
      30_000,
    );
    setTagBusy(false);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    message.success("标签已更新。");
    setTagDraft("");
    const refreshed = await loadJson<{ show: unknown; status: unknown }>(
      `/api/skills-manager/skills/${encodeURIComponent(detailName)}`,
      30_000,
    );
    if (refreshed.ok) setDetail(refreshed.data);
    void loadAll({ silent: true });
  };

  const previewSource = async () => {
    if (sourceDraft === null) return;
    if (sourceDraft.gitUrl.trim() === "") {
      message.warning("Git 地址不能为空。");
      return;
    }
    const payload = {
      name: sourceDraft.name,
      gitUrl: sourceDraft.gitUrl.trim(),
      ...(sourceDraft.subpath.trim() === "" ? {} : { subpath: sourceDraft.subpath.trim() }),
      ...(sourceDraft.branch.trim() === "" ? {} : { branch: sourceDraft.branch.trim() }),
      ...(sourceDraft.force ? { force: true } : {}),
    };
    const result = await postJson("/api/skills-manager/set-source", payload, ACTION_TIMEOUT_MS);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    setSourcePreview(result.data);
  };

  const confirmSource = async () => {
    if (sourceDraft === null) return;
    setSourceConfirming(true);
    const result = await postJson(
      "/api/skills-manager/set-source",
      {
        name: sourceDraft.name,
        gitUrl: sourceDraft.gitUrl.trim(),
        ...(sourceDraft.subpath.trim() === "" ? {} : { subpath: sourceDraft.subpath.trim() }),
        ...(sourceDraft.branch.trim() === "" ? {} : { branch: sourceDraft.branch.trim() }),
        ...(sourceDraft.force ? { force: true } : {}),
        confirmed: true,
      },
      ACTION_TIMEOUT_MS,
    );
    setSourceConfirming(false);
    if (!result.ok) {
      message.error(extractError(result.data));
      return;
    }
    message.success("Git 源绑定完成。");
    setSourceDraft(null);
    setSourcePreview(null);
    void loadAll({ silent: true });
  };

  // ---- 渲染 ----

  if (state.status === "failed")
    return (
      <Alert
        type="warning"
        showIcon
        message="技能库管理器暂时连不上"
        description={state.reason}
        action={<Button onClick={() => void loadAll()}>重试</Button>}
      />
    );
  if (state.status === "loading")
    return (
      <Flex justify="center" align="center" style={{ padding: "48px 0" }}>
        <Spin />
        <Text type="secondary" style={{ marginLeft: 12 }}>
          正在读取技能库状态…
        </Text>
      </Flex>
    );
  if (status === null || status.available !== true)
    return (
      <Card>
        <Empty description="技能库管理器未安装" style={{ padding: "24px 0" }} />
        <Typography.Paragraph type="secondary" style={{ textAlign: "center" }}>
          {status !== null && "installHint" in status
            ? status.installHint ?? "当前 watch 镜像未包含 skills-manager CLI。"
            : "当前 watch 镜像未包含 skills-manager CLI。"}
        </Typography.Paragraph>
      </Card>
    );

  const railFooterNote =
    view === "installed"
      ? `共 ${skills.length} 个技能${cliVersion === undefined ? "" : ` · 管理器 ${cliVersion}`}`
      : `共 ${countByCategory[ALL_CATEGORY_LABEL] ?? 0} 个市场项目${
          marketSyncedAt === null ? "" : ` · 同步于 ${formatTime(marketSyncedAt)}`
        }`;

  const marketBody = (
    <>
      {searchResults !== null && (
        <Flex align="center" gap={8} style={{ marginBottom: 12 }}>
          <Tag closable onClose={() => { setSearchResults(null); setMarketQuery(""); }}>
            搜索结果：{searchResults.length} 项
          </Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            关键词「{marketQuery.trim()}」；清除后回到推荐与公开趋势。
          </Text>
        </Flex>
      )}
      {marketLoading ? (
        <Flex justify="center" align="center" gap={8} style={{ padding: "48px 0" }}>
          <Spin />
          <Text type="secondary">正在读取市场数据…</Text>
        </Flex>
      ) : visibleMarket.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            searchResults !== null
              ? "市场里没有匹配的技能，换个关键词试试"
              : "暂无市场项目；点击右上角「同步公开数据」或直接从 Git 安装"
          }
        />
      ) : (
        <div className="skills-waterfall">
          {visibleMarket.map((card) => (
            <SkillMarketCard
              key={card.key}
              name={card.name}
              subtitle={card.subtitle}
              description={card.description}
              category={card.category}
              tags={card.tags}
              statusTag={card.installed ? { text: "已安装", color: "success" } : undefined}
              footerLeft={
                "installs" in card && card.installs !== undefined ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {formatInstalls(card.installs)}
                  </Text>
                ) : "trend" in card ? (
                  <Flex align="center" gap={8}>
                    <Avatar
                      size={20}
                      src={`https://avatars.githubusercontent.com/${encodeURIComponent(ownerOf(card.name))}?s=40`}
                      alt={ownerOf(card.name)}
                    >
                      {ownerOf(card.name).charAt(0).toUpperCase()}
                    </Avatar>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {`⭐ ${card.trend.stars.toLocaleString()}`}
                    </Text>
                  </Flex>
                ) : (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    结合本机使用情况推荐
                  </Text>
                )
              }
              footerRight={
                card.installed ? undefined : "recommendation" in card ? (
                  <Button
                    key="install"
                    type="primary"
                    size="small"
                    loading={recommendBusy === card.recommendation.id}
                    onClick={() => void installRecommendation(card.recommendation)}
                  >
                    立即安装
                  </Button>
                ) : "installRef" in card ? (
                  <Button
                    key="install"
                    type="primary"
                    size="small"
                    loading={installBusy}
                    onClick={() => void beginInstall(card.installRef, card.installName, "skills")}
                  >
                    立即安装
                  </Button>
                ) : (
                  <Button
                    key="install"
                    type="primary"
                    size="small"
                    loading={installBusy}
                    onClick={() => void beginInstall(card.trend.name)}
                  >
                    立即安装
                  </Button>
                )
              }
            />
          ))}
        </div>
      )}
    </>
  );

  const installedBody = (
    <>
      <Flex gap={24} wrap="wrap" style={{ marginBottom: 12 }}>
        <Statistic title="本机已安装" value={skills.length} />
        <Statistic title="已部署到智能体" value={deployedCount} />
        <Statistic title="有可用更新" value={updatableCount} />
      </Flex>
      {visibleInstalled.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            skills.length === 0
              ? "中央库还是空的；去市场安装或从 Git 导入第一个技能"
              : "没有匹配当前分类和筛选的技能"
          }
        />
      ) : (
        <div className="skills-waterfall">
          {visibleInstalled.map((card) => {
            const primaryAction = card.localRunning ? (
              <Button
                key="bind"
                size="small"
                onClick={() =>
                  setSourceDraft({
                    name: card.item.name,
                    gitUrl: "",
                    subpath: "",
                    branch: "",
                    force: false,
                  })
                }
              >
                绑定源
              </Button>
            ) : deployedToTarget(card.item) ? (
              <Button
                key="undeploy"
                size="small"
                danger
                onClick={() =>
                  void beginAction("undeploy", `取消部署 ${card.item.name}`, { name: card.item.name })
                }
              >
                取消部署
              </Button>
            ) : (
              <Button
                key="deploy"
                size="small"
                type="primary"
                ghost
                onClick={() =>
                  void beginAction("deploy", `部署 ${card.item.name}`, { name: card.item.name })
                }
              >
                部署
              </Button>
            );
            const menuItems = [
              ...(card.updatable
                ? [
                    {
                      key: "update",
                      label: "更新技能",
                      onClick: () => void updateOne(card.item),
                    },
                  ]
                : []),
              {
                key: "remove",
                label: "删除技能",
                danger: true,
                onClick: () =>
                  void beginAction("remove", `删除 ${card.item.name}`, { name: card.item.name }),
              },
            ];
            return (
              <SkillMarketCard
                key={card.item.name}
                name={card.item.name}
                subtitle={`${card.item.skill_id ?? "中央库技能"} · ${card.item.source_type ?? "local"}`}
                description={card.item.description ?? "中央库技能，详情见技能文件。"}
                category={card.category}
                tags={card.tags}
                statusTag={installedStatusTag(card.item, {
                  updatable: card.updatable,
                  localRunning: card.localRunning,
                })}
                footerLeft={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {updateStatusLabel(updates[card.item.name]?.update_status).text}
                  </Text>
                }
                footerRight={
                  <>
                    {card.updatable && (
                      <Button size="small" type="primary" onClick={() => void updateOne(card.item)}>
                        立即升级
                      </Button>
                    )}
                    <Button size="small" onClick={() => void openDetail(card.item.name)}>
                      详情
                    </Button>
                    {primaryAction}
                    <Dropdown
                      key="more"
                      menu={{ items: menuItems }}
                      trigger={["click"]}
                      placement="bottomRight"
                    >
                      <Button
                        size="small"
                        aria-label={`更多操作：${card.item.name}`}
                        icon={<MoreOutlined />}
                      />
                    </Dropdown>
                  </>
                }
              />
            );
          })}
        </div>
      )}
    </>
  );

  return (
    <Flex vertical gap={16} className="skills-marketplace-panel">
      {/* 工具带：视图切换 + 搜索 + 安装入口 */}
      <Flex justify="space-between" align="center" gap={12} wrap="wrap">
        <Segmented<MarketView>
          value={view}
          onChange={(value) => {
            setView(value);
            setActiveCategory(ALL_CATEGORY_LABEL);
          }}
          options={[
            { label: "技能市场", value: "market" },
            { label: "本机已安装", value: "installed" },
          ]}
        />
        <Flex gap={8} wrap="wrap" align="center">
          <Input
            allowClear
            style={{ width: 260 }}
            prefix={<SearchOutlined />}
            placeholder={view === "market" ? "搜索 skills 市场技能" : "按名称、描述或标签筛选"}
            value={view === "market" ? marketQuery : keyword}
            onChange={(event) =>
              view === "market" ? setMarketQuery(event.target.value) : setKeyword(event.target.value)
            }
            onPressEnter={() => {
              if (view === "market") void searchMarket();
            }}
          />
          {view === "market" && (
            <Button loading={searchBusy} onClick={() => void searchMarket()}>
              搜索市场
            </Button>
          )}
          <Button icon={<FolderOpenOutlined />} loading={adoptBusy} onClick={() => void adoptLocalSkills()}>
            收编本机技能
          </Button>
          <Button
            icon={<CloudDownloadOutlined />}
            type={view === "market" ? "primary" : "default"}
            loading={installBusy}
            onClick={() => setGitInstallOpen(true)}
          >
            从 Git 安装
          </Button>
          {view === "installed" && (
            <Button type="primary" loading={updateAllBusy} onClick={() => void updateAll()}>
              一键更新全部
            </Button>
          )}
        </Flex>
      </Flex>

      {/* 主体：左侧分类导航 + 右侧瀑布流 */}
      <Flex gap={16} align="flex-start">
        <CategoryRail
          counts={countByCategory}
          active={activeCategory}
          onSelect={setActiveCategory}
          footerNote={railFooterNote}
        />
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          {view === "market" ? marketBody : installedBody}
        </div>
      </Flex>

      {/* Git 安装弹窗 */}
      <Modal
        open={gitInstallOpen}
        title="从 Git 安装技能"
        okText="安装"
        cancelText="取消"
        confirmLoading={installBusy}
        onCancel={() => setGitInstallOpen(false)}
        onOk={() => void beginInstall(gitSource, gitName)}
      >
        <Flex vertical gap={10}>
          <Input
            placeholder="Git 地址或 owner/repo"
            value={gitSource}
            onChange={(event) => setGitSource(event.target.value)}
            onPressEnter={() => void beginInstall(gitSource, gitName)}
          />
          <Input
            placeholder="技能名称（可选）"
            value={gitName}
            onChange={(event) => setGitName(event.target.value)}
            onPressEnter={() => void beginInstall(gitSource, gitName)}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            支持 Git 地址或 owner/repo；安装前会自动备份，确认后技能进入中央库。
          </Text>
        </Flex>
      </Modal>

      {/* 试运行确认弹窗（部署/取消部署/删除共用） */}
      <Modal
        open={pending !== null}
        title={pending !== null ? `${pending.title}（先试运行）` : null}
        okText={pending?.op === "remove" ? "确认删除" : "确认执行"}
        okButtonProps={pending?.op === "remove" ? { danger: true } : undefined}
        cancelText="取消"
        confirmLoading={confirming}
        onOk={() => void confirmPending()}
        onCancel={() => {
          if (!confirming) setPending(null);
        }}
      >
        {pending !== null && (
          <>
            <Typography.Paragraph type="secondary">
              以下是试运行预览；确认后才会真正执行。
            </Typography.Paragraph>
            {previewEntries(pending.preview).length > 0 && (
              <Descriptions size="small" column={1} bordered>
                {previewEntries(pending.preview).map(([label, value]) => (
                  <Descriptions.Item key={label} label={label}>
                    {value}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            )}
            <pre style={{ maxHeight: 220, overflow: "auto", fontSize: 12 }}>
              {JSON.stringify(pending.preview, null, 2)}
            </pre>
          </>
        )}
      </Modal>

      {/* 详情抽屉：基础信息 + 标签管理 + Git 源绑定 */}
      <Drawer
        title={detailName !== null ? `技能详情：${detailName}` : "技能详情"}
        width={560}
        open={detailName !== null}
        onClose={() => setDetailName(null)}
      >
        {detailBusy && <Text type="secondary">正在读取详情…</Text>}
        {detail !== null && (
          <>
            <Descriptions bordered size="small" column={1}>
              {(() => {
                const show =
                  detail.show !== null && typeof detail.show === "object"
                    ? (detail.show as Record<string, unknown>)
                    : {};
                return (
                  <>
                    <Descriptions.Item label="名称">
                      {String(show["name"] ?? detailName)}
                    </Descriptions.Item>
                    <Descriptions.Item label="描述">
                      {String(show["description"] ?? "")}
                    </Descriptions.Item>
                    <Descriptions.Item label="来源">
                      {String(show["source_type"] ?? "")} {String(show["source_ref"] ?? "")}
                    </Descriptions.Item>
                    <Descriptions.Item label="部署目标">
                      {stringArray(show["deployed_to"]).join(", ") || "未部署"}
                    </Descriptions.Item>
                    <Descriptions.Item label="文件">
                      {stringArray(show["files"]).join(", ") || "-"}
                    </Descriptions.Item>
                  </>
                );
              })()}
            </Descriptions>
            <Card
              size="small"
              title="标签"
              style={{ marginTop: 16 }}
            >
              <Flex gap={8} wrap="wrap">
                <Input
                  placeholder="标签，多个用逗号分隔"
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                />
                <Button loading={tagBusy} onClick={() => void updateTags("add")}>
                  添加
                </Button>
                <Button loading={tagBusy} onClick={() => void updateTags("remove")}>
                  移除
                </Button>
                <Button loading={tagBusy} onClick={() => void updateTags("set")}>
                  覆盖
                </Button>
              </Flex>
              <Flex gap={6} wrap="wrap" style={{ marginTop: 10 }}>
                {(() => {
                  const show =
                    detail.show !== null && typeof detail.show === "object"
                      ? (detail.show as Record<string, unknown>)
                      : {};
                  return stringArray(show["tags"]).map((tag) => <Tag key={tag}>{tag}</Tag>);
                })()}
              </Flex>
            </Card>
          </>
        )}
      </Drawer>

      {/* 绑定 Git 源：输入 → 预览 → 确认 */}
      <Modal
        open={sourceDraft !== null && sourcePreview === null}
        title="绑定 Git 源"
        okText="预览变更"
        cancelText="取消"
        onCancel={() => setSourceDraft(null)}
        onOk={() => void previewSource()}
      >
        {sourceDraft !== null && (
          <Flex vertical gap={10}>
            <Input
              placeholder="Git 地址"
              value={sourceDraft.gitUrl}
              onChange={(event) => setSourceDraft({ ...sourceDraft, gitUrl: event.target.value })}
            />
            <Input
              placeholder="子目录（可选）"
              value={sourceDraft.subpath}
              onChange={(event) => setSourceDraft({ ...sourceDraft, subpath: event.target.value })}
            />
            <Input
              placeholder="分支（可选）"
              value={sourceDraft.branch}
              onChange={(event) => setSourceDraft({ ...sourceDraft, branch: event.target.value })}
            />
            <Checkbox
              checked={sourceDraft.force}
              onChange={(event) => setSourceDraft({ ...sourceDraft, force: event.target.checked })}
            >
              内容不同时覆盖
            </Checkbox>
          </Flex>
        )}
      </Modal>
      <Modal
        open={sourcePreview !== null}
        title="确认绑定 Git 源"
        okText="确认绑定"
        cancelText="返回修改"
        confirmLoading={sourceConfirming}
        onCancel={() => setSourcePreview(null)}
        onOk={() => void confirmSource()}
      >
        <Typography.Paragraph type="secondary">
          以下为试运行结果，确认后才会改变技能来源。
        </Typography.Paragraph>
        <pre style={{ maxHeight: 260, overflow: "auto", fontSize: 12 }}>
          {JSON.stringify(sourcePreview, null, 2)}
        </pre>
      </Modal>

      {marketNotice !== "" && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {marketNotice}
        </Text>
      )}
    </Flex>
  );
}
