/**
 * 技能市场面板（WorkBuddy 风格重构）：
 * 顶部工具行 = 内容 Tab（推荐 | SkillHub）+ 搜索 + 「我安装的」胶囊 + 「添加技能」下拉；
 * 市场态顶部为「精选技能」横滑行（SkillHub 高分技能，可换一换），
 * Tab 下是分类 chips + 自适应卡片网格；已安装态保留完整管理能力
 * （部署/取消部署/更新/删除/详情/标签/Git 源绑定），危险操作保持两段式。
 *
 * 数据：SkillHub = skillhub.cn Open API（分类/列表/搜索/暂存安装）；
 * 推荐 = 使用推荐（recommendations）+ 公开趋势（github-trends）；
 * 已安装 = skills-manager 中央库（status + updates）。
 * SkillHub 安装走「暂存 → 风险扫描 → 确认」隔离链路，与推荐安装共用确认弹窗。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  CheckOutlined,
  CloudDownloadOutlined,
  FolderOpenOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import type { FetchState } from "../../lib/api.js";
import { loadJson, postJson } from "../../lib/api.js";
import { formatTime } from "./helpers.js";
import { SkillMarketCard } from "./SkillMarketCard.js";
import { StagedRiskDetails } from "./StagedRiskDetails.js";
import { buildSkillHubListUrl, SKILLHUB_SORT_OPTIONS, formatHubCount } from "./skillhub.js";
import type {
  SkillHubCategoriesResult,
  SkillHubListResult,
  SkillHubSkill,
  SkillHubSortBy,
} from "./skillhub.js";
import {
  ACTION_TIMEOUT_MS,
  ALL_CATEGORY_LABEL,
  categorize,
  deployedToTarget,
  extractError,
  hasAvailableUpdate,
  parseStagedRisk,
  previewEntries,
  SKILL_CATEGORIES,
  stringArray,
  updateStatusLabel,
} from "./marketplace.js";
import type {
  Recommendation,
  SkillsManagerSkill,
  SkillsManagerStatus,
  StagedSkillRisk,
  TrendItem,
  UpdateCheckItem,
} from "./marketplace.js";
import "./marketplace.css";

const { Text } = Typography;

type ContentTab = "recommended" | "skillhub";
type MarketMode = "market" | "installed";

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

interface StagedRecommendation {
  item: Recommendation;
  stageId: string;
  risk: StagedSkillRisk | null;
  installError: string | null;
}

interface HubListState {
  items: SkillHubSkill[];
  total: number;
  page: number;
  loading: boolean;
  appending: boolean;
  error?: string;
  detail?: string;
  fix?: string;
}

const HUB_PAGE_SIZE = 24;
const FEATURED_PAGE_SIZE = 8;
const HUB_SEARCH_DEBOUNCE_MS = 500;

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

/** 安装「+」圆钮：已安装显示对勾，暂存中转圈。 */
function InstallPlus(props: { installed: boolean; busy: boolean; label: string; onClick: () => void }) {
  if (props.installed) {
    return (
      <span className="wb-plus installed" role="img" aria-label={`${props.label} 已安装`}>
        <CheckOutlined />
      </span>
    );
  }
  return (
    <button
      type="button"
      className="wb-plus"
      aria-label={`安装 ${props.label}`}
      disabled={props.busy}
      onClick={props.onClick}
    >
      {props.busy ? <Spin size="small" /> : <PlusOutlined />}
    </button>
  );
}

/** 分类 chips 行（含「全部」）。 */
function CategoryChips(props: {
  items: Array<{ key: string; label: string; count?: number }>;
  active: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="wb-chips" role="tablist" aria-label="技能分类筛选">
      <button
        type="button"
        role="tab"
        aria-selected={props.active === ""}
        className={`wb-chip${props.active === "" ? " active" : ""}`}
        onClick={() => props.onSelect("")}
      >
        全部
      </button>
      {props.items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={props.active === item.key}
          className={`wb-chip${props.active === item.key ? " active" : ""}`}
          onClick={() => props.onSelect(item.key)}
        >
          {item.label}
          {item.count !== undefined && <span className="count">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SkillsMarketplace() {
  const { message } = App.useApp();
  const [state, setState] = useState<FetchState<SkillsManagerStatus>>({ status: "loading" });
  const [updates, setUpdates] = useState<Record<string, UpdateCheckItem>>({});

  const [mode, setMode] = useState<MarketMode>("market");
  const [tab, setTab] = useState<ContentTab>("skillhub");
  const [keyword, setKeyword] = useState("");

  // ---- SkillHub 目录 ----
  const [hubCategories, setHubCategories] = useState<SkillHubCategoriesResult | null>(null);
  const [hubCategory, setHubCategory] = useState("");
  const [hubSort, setHubSort] = useState<SkillHubSortBy>("downloads");
  const [hubSearchInput, setHubSearchInput] = useState("");
  const [hubSearch, setHubSearch] = useState("");
  const [hub, setHub] = useState<HubListState>({ items: [], total: 0, page: 1, loading: true, appending: false });
  const [featured, setFeatured] = useState<{ items: SkillHubSkill[]; page: number; loading: boolean }>({
    items: [],
    page: 1,
    loading: true,
  });
  const [hubBusySlug, setHubBusySlug] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- 推荐与趋势 ----
  const [trends, setTrends] = useState<TrendItem[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [marketSyncedAt, setMarketSyncedAt] = useState<string | null>(null);
  const [marketNotice, setMarketNotice] = useState("");
  const [marketLoading, setMarketLoading] = useState(false);
  const [recommendBusy, setRecommendBusy] = useState<string | null>(null);
  const [stagedRecommendation, setStagedRecommendation] = useState<StagedRecommendation | null>(null);
  const [stagedInstallBusy, setStagedInstallBusy] = useState(false);

  // ---- 安装与管理 ----
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

  /** 推荐市场数据：公开趋势 + 使用推荐；趋势为空且从未同步时自动触发一次同步。 */
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

  const loadHubCategories = useCallback(async () => {
    const result = await loadJson<SkillHubCategoriesResult>("/api/skillhub/categories", 15_000);
    if (result.ok) setHubCategories(result.data);
    else setHubCategories({ items: [], syncedAt: null, error: result.reason });
  }, []);

  /** SkillHub 列表：reset 替换第一页，否则追加下一页。 */
  const loadHubList = useCallback(
    async (next: { category?: string; sortBy?: SkillHubSortBy; search?: string; page: number; reset: boolean }) => {
      const category = next.category ?? hubCategory;
      const sortBy = next.sortBy ?? hubSort;
      const search = next.search ?? hubSearch;
      const page = Math.max(1, next.page);
      setHub((current) => ({
        ...current,
        loading: next.reset,
        appending: !next.reset,
        error: next.reset ? undefined : current.error,
        detail: next.reset ? undefined : current.detail,
        fix: next.reset ? undefined : current.fix,
      }));
      const result = await loadJson<SkillHubListResult>(
        buildSkillHubListUrl({ category, sortBy, keyword: search, page, pageSize: HUB_PAGE_SIZE }),
        20_000,
      );
      if (!result.ok || !Array.isArray(result.data.items)) {
        setHub((current) => ({
          ...current,
          loading: false,
          appending: false,
          ...(next.reset ? { items: [], total: 0 } : {}),
          error: result.ok ? "skillhub-bad-payload" : result.reason,
        }));
        return;
      }
      if (result.data.error !== undefined) {
        // watch 端把网络失败归一为 200 + error 字段：这里转成面板可重试的错误态。
        setHub((current) => ({
          ...current,
          loading: false,
          appending: false,
          error: result.data.error,
          detail: result.data.detail,
          fix: result.data.fix,
        }));
        return;
      }
      setHub((current) => ({
        items: next.reset ? result.data.items : [...current.items, ...result.data.items],
        total: typeof result.data.total === "number" ? result.data.total : 0,
        page,
        loading: false,
        appending: false,
      }));
    },
    [hubCategory, hubSort, hubSearch],
  );

  const loadFeatured = useCallback(async (page: number) => {
    setFeatured((current) => ({ ...current, loading: true }));
    const result = await loadJson<{ items: SkillHubSkill[]; total: number }>(
      buildSkillHubListUrl({ sortBy: "score", page, pageSize: FEATURED_PAGE_SIZE }),
      20_000,
    );
    const items = result.ok && Array.isArray(result.data.items) ? result.data.items : [];
    // 翻到没有数据的页码就回到第 1 页（换一换的循环语义）。
    if (page > 1 && items.length === 0) {
      const first = await loadJson<{ items: SkillHubSkill[] }>(
        buildSkillHubListUrl({ sortBy: "score", page: 1, pageSize: FEATURED_PAGE_SIZE }),
        20_000,
      );
      const firstItems = first.ok && Array.isArray(first.data.items) ? first.data.items : [];
      setFeatured({ items: firstItems, page: 1, loading: false });
      return;
    }
    setFeatured({ items, page, loading: false });
  }, []);

  useEffect(() => {
    void loadAll();
    void loadMarket();
    void loadHubCategories();
    void loadFeatured(1);
  }, [loadAll, loadMarket, loadHubCategories, loadFeatured]);

  useEffect(() => {
    void loadHubList({ page: 1, reset: true });
    // hubCategory/hubSort/hubSearch 变化都回到第一页。
  }, [hubCategory, hubSort, hubSearch, loadHubList]);

  useEffect(() => () => {
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
  }, []);

  const status = state.status === "ready" ? state.data : null;
  const managerAvailable = status?.available === true;
  const skills = useMemo(() => (managerAvailable ? status.skills ?? [] : []), [status, managerAvailable]);
  const hermesSkillsDir = managerAvailable ? status.hermesSkillsDir : undefined;
  const cliVersion = managerAvailable ? status.cli?.version : undefined;
  const installedNames = useMemo(() => new Set(skills.map((item) => item.name)), [skills]);

  /** 已安装视图的卡片数据：名称/描述/标签 + 启发式中文分类 + 更新状态。 */
  const installedCards = useMemo(
    () =>
      skills.map((item) => {
        const tags = stringArray(item.tags);
        const category = categorize({ name: item.name, description: item.description, tags });
        const updatable = hasAvailableUpdate(updates[item.name]);
        const localRunning = isLocalAdopted(item, hermesSkillsDir);
        return { item, tags, category, updatable, localRunning };
      }),
    [skills, updates, hermesSkillsDir],
  );

  const isInstalledHub = (item: SkillHubSkill) =>
    installedNames.has(item.slug) || installedNames.has(item.name);

  /** 分类 key → 中文名（SkillHub 分类 chips 与卡片色调映射）。 */
  const hubCategoryName = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of hubCategories?.items ?? []) map.set(item.key, item.name);
    return map;
  }, [hubCategories]);

  const hubTagOf = (item: SkillHubSkill): string[] => {
    const tags: string[] = [];
    if (item.source === "official") tags.push("官方");
    if (item.requiresApiKey) tags.push("需 API Key");
    const sub = item.subCategories[0]?.name;
    if (sub !== undefined && sub !== "") tags.push(sub);
    return tags.slice(0, 3);
  };

  const hubMeta = (item: SkillHubSkill) => (
    <Text type="secondary" className="wb-card-meta">
      {`${formatHubCount(item.downloads)} 下载 · ⭐ ${formatHubCount(item.stars)}`}
      {item.ownerName !== "" ? ` · ${item.ownerName}` : ""}
    </Text>
  );

  // ---- 分类计数（推荐/已安装的启发式分类） ----
  const heuristicSource = useMemo(() => {
    if (mode === "installed") {
      return installedCards.map((card) => ({ name: card.item.name, description: card.item.description, tags: card.tags }));
    }
    const needle = keyword.trim().toLowerCase();
    const filtered = (items: Array<{ name: string; description?: string }>) =>
      needle === ""
        ? items
        : items.filter((item) => `${item.name} ${item.description ?? ""}`.toLowerCase().includes(needle));
    return [
      ...filtered(recommendations.map((item) => ({ name: item.name, description: item.description ?? item.reason }))),
      ...filtered(trends.map((item) => ({ name: item.name, description: item.description }))),
    ];
  }, [mode, installedCards, recommendations, trends, keyword]);

  const heuristicCounts = useMemo(() => {
    const counts: Record<string, number> = { [ALL_CATEGORY_LABEL]: heuristicSource.length };
    for (const item of heuristicSource) {
      const category = categorize(item);
      counts[category] = (counts[category] ?? 0) + 1;
    }
    return counts;
  }, [heuristicSource]);

  const heuristicChips = useMemo(
    () =>
      SKILL_CATEGORIES.filter((category) => (heuristicCounts[category.label] ?? 0) > 0).map((category) => ({
        key: category.label,
        label: category.label,
        count: heuristicCounts[category.label] ?? 0,
      })),
    [heuristicCounts],
  );

  const [activeHeuristic, setActiveHeuristic] = useState(ALL_CATEGORY_LABEL);
  // 视图切换时启发式分类回到「全部」，避免残留筛选。
  useEffect(() => setActiveHeuristic(ALL_CATEGORY_LABEL), [mode, tab]);

  const categoryMatches = (category: string) =>
    activeHeuristic === ALL_CATEGORY_LABEL || category === activeHeuristic;

  const visibleInstalled = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return installedCards.filter((card) => {
      if (!categoryMatches(card.category)) return false;
      if (needle === "") return true;
      const text = `${card.item.name} ${card.item.description ?? ""} ${card.tags.join(" ")}`;
      return text.toLowerCase().includes(needle);
    });
  }, [installedCards, keyword, activeHeuristic]);

  /** 推荐视图卡片（本地筛选 + 启发式分类过滤）。 */
  const recommendedCards = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    const matchNeedle = (text: string) => needle === "" || text.toLowerCase().includes(needle);
    const recs = recommendations
      .map((item) => {
        const description = item.description ?? item.reason;
        return {
          key: `rec-${item.id}`,
          name: item.name,
          subtitle: "管家推荐",
          description,
          category: categorize({ name: item.name, description }),
          avatarUrl: null as string | null,
          tags: ["推荐"] as string[],
          kind: "recommendation" as const,
          recommendation: item,
          installed: installedNames.has(item.name),
        };
      })
      .filter((card) => categoryMatches(card.category) && matchNeedle(`${card.name} ${card.description}`));
    const trendCards = trends
      .map((item) => ({
        key: `trend-${item.name}`,
        name: item.name,
        subtitle: "GitHub 公开项目",
        description: item.description ?? "公开技能项目，具体用途以仓库说明为准。",
        category: categorize({ name: item.name, description: item.description }),
        avatarUrl: `https://avatars.githubusercontent.com/${encodeURIComponent(ownerOf(item.name))}?s=80`,
        tags: ["GitHub"] as string[],
        kind: "trend" as const,
        trend: item,
        installed: installedNames.has(item.name),
      }))
      .filter((card) => categoryMatches(card.category) && matchNeedle(`${card.name} ${card.description}`));
    return [...recs, ...trendCards];
  }, [recommendations, trends, installedNames, keyword, activeHeuristic]);

  const deployedCount = installedCards.filter((card) => deployedToTarget(card.item)).length;
  const updatableCount = installedCards.filter((card) => card.updatable).length;

  // ---- 操作流（保持既有能力） ----

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
    const risk = staged.data !== null && typeof staged.data === "object"
      ? parseStagedRisk((staged.data as Record<string, unknown>)["risk"])
      : null;
    setRecommendBusy(null);
    setStagedRecommendation({ item, stageId, risk, installError: null });
  };

  /** SkillHub 技能：下载 zip → 隔离暂存 + 风险扫描；确认安装共用 staged 链路。 */
  const stageSkillHub = async (item: SkillHubSkill) => {
    if (hubBusySlug !== null) return;
    setHubBusySlug(item.slug);
    const staged = await postJson(
      `/api/skillhub/skills/${encodeURIComponent(item.slug)}/stage`,
      {},
      60_000,
    );
    setHubBusySlug(null);
    const stageId =
      staged.ok && staged.data !== null && typeof staged.data === "object" && "id" in staged.data
        ? String((staged.data as { id: unknown }).id)
        : "";
    if (!staged.ok || stageId === "") {
      message.error(staged.ok ? "服务未返回安装标识。" : friendlyError(staged.data, "SkillHub 下载或检查未完成。"));
      return;
    }
    const risk = staged.data !== null && typeof staged.data === "object"
      ? parseStagedRisk((staged.data as Record<string, unknown>)["risk"])
      : null;
    setStagedRecommendation({
      item: {
        id: `skillhub:${item.slug}`,
        name: item.name,
        reason: item.description,
        description: item.description,
        sourceUrl: item.homepage !== "" ? item.homepage : `https://skillhub.cn/skills/${item.slug}`,
      },
      stageId,
      risk,
      installError: null,
    });
  };

  const confirmStagedRecommendation = async () => {
    if (stagedRecommendation === null || stagedInstallBusy) return;
    setStagedInstallBusy(true);
    const installed = await postJson(
      `/api/skills/staged/${encodeURIComponent(stagedRecommendation.stageId)}/install`,
      { confirmed: true },
      30_000,
    );
    setStagedInstallBusy(false);
    if (!installed.ok) {
      const record = installed.data !== null && typeof installed.data === "object"
        ? installed.data as Record<string, unknown>
        : null;
      const failure = friendlyError(installed.data, "备份或安装未完成；高风险内容会被后端拒绝。");
      if (record?.["error"] === "skill-risk-blocked") {
        const risk = parseStagedRisk(record["risk"]);
        setStagedRecommendation((current) => current === null ? null : {
          ...current,
          risk: risk ?? current.risk,
          installError: failure,
        });
        message.warning("安装已被安全检查阻止，请查看风险项。");
        return;
      }
      if (record?.["error"] === "invalid-stage") {
        setStagedRecommendation(null);
        message.warning("安装已过期，请重新点击安装再确认。");
        return;
      }
      message.error(failure);
      return;
    }
    message.success("技能已安装。");
    setStagedRecommendation(null);
    void loadAll({ silent: true });
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

  /** 搜索框统一入口：安装态=本地筛选；SkillHub=防抖关键词；推荐=本地筛选。 */
  const onSearchChange = (value: string) => {
    if (mode === "installed" || tab === "recommended") {
      setKeyword(value);
      return;
    }
    setHubSearchInput(value);
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setHubSearch(value.trim()), HUB_SEARCH_DEBOUNCE_MS);
  };

  const searchValue = mode === "installed" || tab === "recommended" ? keyword : hubSearchInput;
  const searchPlaceholder =
    mode === "installed"
      ? "筛选已安装技能"
      : tab === "skillhub"
        ? "搜索 SkillHub 技能"
        : "筛选推荐与公开趋势";

  const hubSearching = hubSearch.trim() !== "";
  const hubCategoryChips = useMemo(
    () =>
      (hubCategories?.items ?? []).map((item) => ({ key: item.key, label: item.name })),
    [hubCategories],
  );

  const hasMore = hub.items.length > 0 && hub.items.length < hub.total;

  const renderMarketCard = (
    card:
      | { kind: "recommendation"; key: string; name: string; subtitle: string; description: string; category: string; avatarUrl: string | null; tags: string[]; recommendation: Recommendation; installed: boolean }
      | { kind: "trend"; key: string; name: string; subtitle: string; description: string; category: string; avatarUrl: string | null; tags: string[]; trend: TrendItem; installed: boolean },
  ) => (
    <SkillMarketCard
      key={card.key}
      name={card.name}
      subtitle={card.subtitle}
      description={card.description}
      category={card.category}
      tags={card.tags}
      avatarUrl={card.avatarUrl}
      statusTag={card.installed ? { text: "已安装", color: "success" } : undefined}
      footerLeft={
        card.kind === "trend" ? (
          <Flex align="center" gap={6}>
            <Avatar size={18} src={`https://avatars.githubusercontent.com/${encodeURIComponent(ownerOf(card.trend.name))}?s=40`}>
              {ownerOf(card.trend.name).charAt(0).toUpperCase()}
            </Avatar>
            <Text type="secondary" className="wb-card-meta">
              {`⭐ ${card.trend.stars.toLocaleString()}`}
            </Text>
          </Flex>
        ) : (
          <Text type="secondary" className="wb-card-meta">
            结合本机使用情况推荐
          </Text>
        )
      }
      footerRight={
        card.installed ? undefined : card.kind === "recommendation" ? (
          <Button
            size="small"
            type="primary"
            loading={recommendBusy === card.recommendation.id}
            onClick={() => void installRecommendation(card.recommendation)}
          >
            安装
          </Button>
        ) : (
          <Button
            size="small"
            type="primary"
            loading={installBusy}
            onClick={() => void beginInstall(card.trend.name)}
          >
            安装
          </Button>
        )
      }
    />
  );

  const renderHubCard = (item: SkillHubSkill) => {
    const installed = isInstalledHub(item);
    const categoryLabel = hubCategoryName.get(item.category) ?? "实用小工具";
    return (
      <SkillMarketCard
        key={item.slug}
        name={item.name}
        subtitle={item.version !== "" ? `${item.ownerName} · v${item.version}` : item.ownerName}
        description={item.description !== "" ? item.description : "暂无描述，安装前请到 SkillHub 查看说明。"}
        category={categoryLabel}
        tags={hubTagOf(item)}
        avatarUrl={item.iconUrl}
        action={
          <InstallPlus
            installed={installed}
            busy={hubBusySlug === item.slug}
            label={item.name}
            onClick={() => void stageSkillHub(item)}
          />
        }
        footerLeft={hubMeta(item)}
      />
    );
  };

  const renderFeaturedCard = (item: SkillHubSkill) => {
    const installed = isInstalledHub(item);
    const categoryLabel = hubCategoryName.get(item.category) ?? "实用小工具";
    return (
      <SkillMarketCard
        key={`featured-${item.slug}`}
        name={item.name}
        description={item.description !== "" ? item.description : "暂无描述。"}
        category={categoryLabel}
        avatarUrl={item.iconUrl}
        action={
          <InstallPlus
            installed={installed}
            busy={hubBusySlug === item.slug}
            label={item.name}
            onClick={() => void stageSkillHub(item)}
          />
        }
        footerLeft={
          <Text type="secondary" className="wb-card-meta">
            {`${formatHubCount(item.downloads)} 下载`}
          </Text>
        }
      />
    );
  };

  const renderInstalledCard = (card: (typeof installedCards)[number]) => {
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
          <Text type="secondary" className="wb-card-meta">
            {updateStatusLabel(updates[card.item.name]?.update_status).text}
          </Text>
        }
        footerRight={
          <>
            {card.updatable && (
              <Button size="small" type="primary" onClick={() => void updateOne(card.item)}>
                升级
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
  };

  const stagedBlocked = stagedRecommendation?.risk?.status === "blocked" || stagedRecommendation?.installError != null;

  /** 网格骨架：加载中转圈 + 空态 + 卡片。 */
  const gridBody = (nodes: React.ReactNode[], emptyText: string) => {
    if (nodes.length === 0)
      return (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} style={{ padding: "32px 0" }} />
      );
    return (
      <div className="wb-grid">
        {nodes}
      </div>
    );
  };

  // ---- 各视图主体 ----

  const skillHubBody = (
    <>
      {hubCategories !== null && hubCategories.error !== undefined && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="SkillHub 分类暂时读不到"
          description={hubCategories.detail ?? hubCategories.error}
          action={<Button size="small" onClick={() => void loadHubCategories()}>重试</Button>}
        />
      )}
      {hubSearching ? (
        <Flex align="center" gap={8} style={{ marginBottom: 12 }}>
          <Tag closable onClose={() => { setHubSearchInput(""); setHubSearch(""); }}>
            搜索：{hubSearch.trim()}
          </Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {`共 ${hub.total} 项结果；清除后回到分类浏览。`}
          </Text>
        </Flex>
      ) : (
        <CategoryChips items={hubCategoryChips} active={hubCategory} onSelect={setHubCategory} />
      )}
      {hub.error !== undefined && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="SkillHub 目录暂时读不到"
          description={[hub.detail, hub.fix].filter((item) => item !== undefined).join(" ") || hub.error}
          action={<Button size="small" onClick={() => void loadHubList({ page: 1, reset: true })}>重试</Button>}
        />
      )}
      {hub.loading ? (
        <Flex justify="center" align="center" gap={8} style={{ padding: "48px 0" }}>
          <Spin />
          <Text type="secondary">正在读取 SkillHub 目录…</Text>
        </Flex>
      ) : gridBody(
          hub.items.map(renderHubCard),
          hubSearching
            ? "SkillHub 里没有匹配的技能，换个关键词试试"
            : "该分类下暂时没有技能，换个分类或搜索试试",
        )}
      {hasMore && (
        <div className="wb-load-more">
          <Button
            loading={hub.appending}
            onClick={() => void loadHubList({ page: hub.page + 1, reset: false })}
          >
            加载更多（已展示 {hub.items.length}/{hub.total}）
          </Button>
        </div>
      )}
    </>
  );

  const recommendedBody = marketLoading ? (
    <Flex justify="center" align="center" gap={8} style={{ padding: "48px 0" }}>
      <Spin />
      <Text type="secondary">正在读取推荐与公开趋势…</Text>
    </Flex>
  ) : gridBody(
      recommendedCards.map(renderMarketCard),
      "暂无推荐项目；点击右上角搜索或直接从 Git 安装",
    );

  const installedBody = (
    <>
      <Flex justify="space-between" align="center" gap={12} wrap="wrap" style={{ marginBottom: 12 }}>
        <Flex gap={24} wrap="wrap">
          <Statistic title="本机已安装" value={skills.length} />
          <Statistic title="已部署到智能体" value={deployedCount} />
          <Statistic title="有可用更新" value={updatableCount} />
        </Flex>
        <Button type="primary" loading={updateAllBusy} onClick={() => void updateAll()}>
          一键更新全部
        </Button>
      </Flex>
      {!managerAvailable ? (
        <Card>
          <Empty description="技能库管理器未安装" style={{ padding: "24px 0" }} />
          <Typography.Paragraph type="secondary" style={{ textAlign: "center" }}>
            {status !== null && "installHint" in status
              ? status.installHint ?? "当前 watch 镜像未包含 skills-manager CLI。"
              : "当前 watch 镜像未包含 skills-manager CLI。"}
          </Typography.Paragraph>
        </Card>
      ) : (
        <>
          <CategoryChips
            items={heuristicChips}
            active={activeHeuristic}
            onSelect={setActiveHeuristic}
          />
          {state.status === "loading" ? (
            <Flex justify="center" align="center" gap={8} style={{ padding: "48px 0" }}>
              <Spin />
              <Text type="secondary">正在读取本机技能…</Text>
            </Flex>
          ) : gridBody(
              visibleInstalled.map(renderInstalledCard),
              skills.length === 0
                ? "中央库还是空的；去市场安装或从 Git 导入第一个技能"
                : "没有匹配当前分类和筛选的技能",
            )}
          {cliVersion !== undefined && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {`共 ${skills.length} 个技能 · 管理器 ${cliVersion}`}
            </Text>
          )}
        </>
      )}
    </>
  );

  return (
    <Flex vertical gap={14} className="skills-marketplace-panel">
      {/* 工具行：内容 Tab + 搜索 + 我安装的 + 添加技能 */}
      <div className="wb-toolbar">
        <nav className="wb-tabs" role="tablist" aria-label="市场内容切换">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "market" && tab === "skillhub"}
            className={`wb-tab${mode === "market" && tab === "skillhub" ? " active" : ""}`}
            onClick={() => { setMode("market"); setTab("skillhub"); }}
          >
            SkillHub
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "market" && tab === "recommended"}
            className={`wb-tab${mode === "market" && tab === "recommended" ? " active" : ""}`}
            onClick={() => { setMode("market"); setTab("recommended"); }}
          >
            推荐
          </button>
        </nav>
        <Flex gap={8} wrap="wrap" align="center">
          <Input
            allowClear
            style={{ width: 260 }}
            prefix={<SearchOutlined />}
            placeholder={searchPlaceholder}
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
          />
          <button
            type="button"
            className={`wb-installed-chip${mode === "installed" ? " active" : ""}`}
            aria-pressed={mode === "installed"}
            onClick={() => setMode(mode === "installed" ? "market" : "installed")}
          >
            我安装的
            <span className="count">{skills.length}</span>
          </button>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "git", icon: <CloudDownloadOutlined />, label: "从 Git 安装", onClick: () => setGitInstallOpen(true) },
                {
                  key: "adopt",
                  icon: <FolderOpenOutlined />,
                  label: "收编本机技能",
                  disabled: !managerAvailable || hermesSkillsDir === undefined,
                  onClick: () => void adoptLocalSkills(),
                },
              ],
            }}
            placement="bottomRight"
          >
            <Button type="primary" icon={<PlusOutlined />}>
              添加技能
            </Button>
          </Dropdown>
        </Flex>
      </div>

      {state.status === "failed" && (
        <Alert
          type="warning"
          showIcon
          message="本机技能库状态暂时读不到（已安装数量与安装管理暂不可用）"
          description={state.reason}
          action={<Button onClick={() => void loadAll()}>重试</Button>}
        />
      )}

      {mode === "market" && (
        <>
          {/* 精选技能：SkillHub 高分技能横滑行；搜索时隐藏聚焦结果。 */}
          {!hubSearching && tab === "skillhub" && (
            <section className="wb-featured" aria-label="精选技能">
              <div className="wb-section-head">
                <Text strong style={{ fontSize: 15 }}>
                  精选技能
                </Text>
                <Button
                  size="small"
                  type="text"
                  icon={<ReloadOutlined />}
                  loading={featured.loading}
                  onClick={() => void loadFeatured(featured.page + 1)}
                >
                  换一换
                </Button>
              </div>
              {featured.loading && featured.items.length === 0 ? (
                <Flex justify="center" align="center" gap={8} style={{ padding: "24px 0" }}>
                  <Spin size="small" />
                  <Text type="secondary">正在获取精选技能…</Text>
                </Flex>
              ) : (
                <div className="wb-featured-row">
                  {featured.items.map(renderFeaturedCard)}
                </div>
              )}
            </section>
          )}

          {/* 分类排序行（SkillHub） */}
          {tab === "skillhub" && !hubSearching && (
            <Flex justify="space-between" align="center" gap={12} wrap="wrap">
              <Text type="secondary" style={{ fontSize: 12 }}>
                {hubCategories === null
                  ? "分类读取中…"
                  : `数据来自 SkillHub（skillhub.cn）${hubCategories.syncedAt === null ? "" : ` · 同步于 ${formatTime(hubCategories.syncedAt)}`}`}
              </Text>
              <Segmented<SkillHubSortBy>
                size="small"
                value={hubSort}
                onChange={setHubSort}
                options={SKILLHUB_SORT_OPTIONS}
              />
            </Flex>
          )}

          {tab === "skillhub" ? skillHubBody : recommendedBody}

          {tab === "recommended" && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {[
                marketNotice,
                marketSyncedAt === null ? "" : `公开趋势同步于 ${formatTime(marketSyncedAt)}`,
              ].filter((item) => item !== "").join(" · ")}
            </Text>
          )}
        </>
      )}

      {mode === "installed" && installedBody}

      {/* 安装确认弹窗（推荐 + SkillHub 共用）：安全检查通过 → 一键确认；被阻止 → 只给原因和关闭 */}
      <Modal
        open={stagedRecommendation !== null}
        title={
          stagedRecommendation === null
            ? null
            : stagedBlocked
              ? `无法安装「${stagedRecommendation.item.name}」`
              : `安装「${stagedRecommendation.item.name}」`
        }
        okText={stagedInstallBusy ? "安装中…" : "安装"}
        cancelText="取消"
        confirmLoading={stagedInstallBusy}
        footer={
          stagedBlocked ? (
            <Button type="primary" onClick={() => setStagedRecommendation(null)}>
              知道了
            </Button>
          ) : undefined
        }
        onCancel={() => {
          if (!stagedInstallBusy) setStagedRecommendation(null);
        }}
        onOk={() => void confirmStagedRecommendation()}
      >
        {stagedRecommendation !== null && (
          <Flex vertical gap={12}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {`来源：${stagedRecommendation.item.sourceUrl}`}
            </Typography.Paragraph>
            <StagedRiskDetails
              risk={stagedRecommendation.risk}
              installError={stagedRecommendation.installError}
            />
          </Flex>
        )}
      </Modal>

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

      {/* 详情抽屉：基础信息 + 标签管理 */}
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
            <Card size="small" title="标签" style={{ marginTop: 16 }}>
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
    </Flex>
  );
}
