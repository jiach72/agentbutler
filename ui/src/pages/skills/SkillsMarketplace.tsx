/**
 * 技能市场面板（WorkBuddy 风格，纯原生链路）：
 * 顶部工具行 = 内容 Tab（推荐 | SkillHub）+ 搜索 + 「我安装的」胶囊 + 「从 Git 安装」；
 * 已安装视图以 Hermes 技能目录为唯一事实来源（/api/skills/local），
 * 支持：更新检查（SkillHub 比版本 / Git 比 commit）、单个更新、一键更新全部、删除（移入备份区）、详情。
 * 安装统一走「下载 → 安全检查 → 确认」两段式，落位 Hermes 技能目录。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Avatar,
  Button,
  Descriptions,
  Drawer,
  Dropdown,
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
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { loadJson, postJson } from "../../lib/api.js";
import { formatTime } from "./helpers.js";
import { SkillMarketCard } from "./SkillMarketCard.js";
import { StagedRiskDetails } from "./StagedRiskDetails.js";
import { buildSkillHubListUrl, SKILLHUB_SORT_OPTIONS, formatHubCount, isSkillHubInstalled } from "./skillhub.js";
import type {
  LocalSkillItem,
  LocalUpdateItem,
  SkillHubCategoriesResult,
  SkillHubListResult,
  SkillHubSkill,
  SkillHubSortBy,
} from "./skillhub.js";
import {
  ALL_CATEGORY_LABEL,
  categorize,
  extractError,
  parseStagedRisk,
  SKILL_CATEGORIES,
} from "./marketplace.js";
import { ConclusionBar, type ConclusionTone } from "../../components/ConclusionBar.js";
import { SectionHeader } from "../../components/SectionHeader.js";
import type {
  Recommendation,
  StagedSkillRisk,
  TrendItem,
} from "./marketplace.js";
import "./marketplace.css";
import { Empty } from "../../components/Empty.js";

const { Text } = Typography;

type ContentTab = "recommended" | "skillhub";
type MarketMode = "market" | "installed";

interface StagedInstall {
  title: string;
  stageId: string;
  /** SkillHub 来源的 slug（用于安装后立即标记已安装）。 */
  slug: string | null;
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

/** 后端失败载荷转人话：优先中文 detail/fix，否则走通用提取。 */
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

const ORIGIN_LABELS: Record<LocalSkillItem["origin"], string> = {
  skillhub: "SkillHub",
  git: "Git",
  local: "本机",
};

/** 安装「+」圆钮：已安装显示对勾，处理中转圈。 */
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

export function SkillsMarketplace(props: { onInstalled?: () => void } = {}) {
  const { onInstalled } = props;
  const { message } = App.useApp();

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

  // ---- 推荐（GitHub 趋势 + 使用推荐）----
  const [trends, setTrends] = useState<TrendItem[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [marketSyncedAt, setMarketSyncedAt] = useState<string | null>(null);
  const [marketNotice, setMarketNotice] = useState("");
  const [marketLoading, setMarketLoading] = useState(false);
  const [recommendBusy, setRecommendBusy] = useState<string | null>(null);

  // ---- 安装确认（SkillHub / Git / 推荐共用）----
  const [staged, setStaged] = useState<StagedInstall | null>(null);
  const [stagedInstallBusy, setStagedInstallBusy] = useState(false);

  // ---- 本机已装（原生）----
  const [localItems, setLocalItems] = useState<LocalSkillItem[]>([]);
  const [localLoading, setLocalLoading] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [updateMap, setUpdateMap] = useState<Record<string, LocalUpdateItem>>({});
  const [updatesChecking, setUpdatesChecking] = useState(false);
  const [updateBusyName, setUpdateBusyName] = useState<string | null>(null);
  const [updateAllBusy, setUpdateAllBusy] = useState(false);
  const [detailItem, setDetailItem] = useState<LocalSkillItem | null>(null);
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(() => new Set());

  // ---- 从 Git 安装 ----
  const [gitModalOpen, setGitModalOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [gitStaging, setGitStaging] = useState(false);

  const markInstalled = useCallback((...keys: string[]) => {
    setInstalledSlugs((current) => {
      const next = new Set(current);
      for (const key of keys) if (key !== "") next.add(key);
      return next;
    });
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

  /** 本机已装清单与更新检查（Hermes 技能目录为唯一事实来源）。 */
  const loadLocal = useCallback(async (silent = false) => {
    if (!silent) setLocalLoading(true);
    const result = await loadJson<{ items: LocalSkillItem[] }>("/api/skills/local", 15_000);
    if (result.ok && Array.isArray(result.data.items)) {
      setLocalItems(result.data.items);
      setLocalError(null);
    } else {
      setLocalError(result.ok ? "返回数据不完整" : result.reason);
    }
    if (!silent) setLocalLoading(false);
  }, []);

  const loadUpdates = useCallback(async () => {
    setUpdatesChecking(true);
    const result = await loadJson<{ items: LocalUpdateItem[] }>("/api/skills/local/updates", 30_000);
    if (result.ok && Array.isArray(result.data.items)) {
      const map: Record<string, LocalUpdateItem> = {};
      for (const item of result.data.items) map[item.name] = item;
      setUpdateMap(map);
    }
    setUpdatesChecking(false);
  }, []);

  useEffect(() => {
    void loadMarket();
    void loadHubCategories();
    void loadFeatured(1);
    void loadLocal();
    void loadUpdates();
  }, [loadMarket, loadHubCategories, loadFeatured, loadLocal, loadUpdates]);

  useEffect(() => {
    void loadHubList({ page: 1, reset: true });
    // hubCategory/hubSort/hubSearch 变化都回到第一页。
  }, [hubCategory, hubSort, hubSearch, loadHubList]);

  useEffect(() => () => {
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
  }, []);

  const installedNames = useMemo(() => new Set(localItems.map((item) => item.name)), [localItems]);
  const installedSlugsFromItems = useMemo(
    () => new Set(localItems.flatMap((item) => (item.slug === null ? [] : [item.slug]))),
    [localItems],
  );
  const isInstalledHub = useCallback(
    (item: SkillHubSkill) =>
      installedSlugs.has(item.slug) ||
      installedSlugs.has(item.name) ||
      isSkillHubInstalled(item, [installedNames, installedSlugsFromItems]),
    [installedSlugs, installedNames, installedSlugsFromItems],
  );

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

  // ---- 已安装视图：启发式分类 chips + 本地筛选 ----
  const installedCards = useMemo(
    () =>
      localItems.map((item) => ({
        item,
        category: categorize({ name: item.displayName, description: item.description, tags: [] }),
      })),
    [localItems],
  );

  const installedCounts = useMemo(() => {
    const counts: Record<string, number> = { [ALL_CATEGORY_LABEL]: installedCards.length };
    for (const card of installedCards) counts[card.category] = (counts[card.category] ?? 0) + 1;
    return counts;
  }, [installedCards]);

  const installedChips = useMemo(
    () =>
      SKILL_CATEGORIES.filter((category) => (installedCounts[category.label] ?? 0) > 0).map((category) => ({
        key: category.label,
        label: category.label,
        count: installedCounts[category.label] ?? 0,
      })),
    [installedCounts],
  );

  const [activeInstalledCategory, setActiveInstalledCategory] = useState(ALL_CATEGORY_LABEL);
  useEffect(() => setActiveInstalledCategory(ALL_CATEGORY_LABEL), [mode, tab]);

  const visibleInstalled = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return installedCards.filter((card) => {
      if (activeInstalledCategory !== ALL_CATEGORY_LABEL && card.category !== activeInstalledCategory) return false;
      if (needle === "") return true;
      const text = `${card.item.displayName} ${card.item.name} ${card.item.description}`;
      return text.toLowerCase().includes(needle);
    });
  }, [installedCards, keyword, activeInstalledCategory]);

  const availableUpdates = useMemo(
    () => localItems.filter((item) => updateMap[item.name]?.status === "available"),
    [localItems, updateMap],
  );

  // ---- 推荐视图卡片 ----
  const recommendedCards = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    const matchNeedle = (text: string) => needle === "" || text.toLowerCase().includes(needle);
    const recs = recommendations
      .map((item) => ({
        key: `rec-${item.id}`,
        name: item.name,
        subtitle: "管家推荐",
        description: item.description ?? item.reason,
        category: categorize({ name: item.name, description: item.description ?? item.reason }),
        avatarUrl: null as string | null,
        tags: ["推荐"] as string[],
        kind: "recommendation" as const,
        recommendation: item,
      }))
      .filter((card) => matchNeedle(`${card.name} ${card.description}`));
    const trendCards = trends
      .map((item) => ({
        key: `trend-${item.name}`,
        name: item.name,
        subtitle: "GitHub 公开项目",
        description: item.description ?? "公开技能项目，具体用途以仓库说明为准。",
        category: categorize({ name: item.name, description: item.description }),
        // 审计 F-15：不再外联 avatars.githubusercontent.com（离线硬需求 + 不向
        // GitHub 泄露浏览行为），头像一律走首字母占位。
        avatarUrl: null as string | null,
        tags: ["GitHub"] as string[],
        kind: "trend" as const,
        trend: item,
      }))
      .filter((card) => matchNeedle(`${card.name} ${card.description}`));
    return [...recs, ...trendCards];
  }, [recommendations, trends, keyword]);

  // ---- 操作流 ----

  const afterInstallChanged = useCallback(() => {
    void loadLocal(true);
    void loadUpdates();
    onInstalled?.();
  }, [loadLocal, loadUpdates, onInstalled]);

  const confirmStaged = async () => {
    if (staged === null || stagedInstallBusy) return;
    setStagedInstallBusy(true);
    const installed = await postJson(
      `/api/skills/staged/${encodeURIComponent(staged.stageId)}/install`,
      { confirmed: true },
      60_000,
    );
    setStagedInstallBusy(false);
    if (!installed.ok) {
      const record = installed.data !== null && typeof installed.data === "object"
        ? installed.data as Record<string, unknown>
        : null;
      const failure = friendlyError(installed.data, "安装没有完成；高风险内容会被安全检查拒绝。");
      if (record?.["error"] === "skill-risk-blocked") {
        const risk = parseStagedRisk(record["risk"]);
        setStaged((current) => current === null ? null : {
          ...current,
          risk: risk ?? current.risk,
          installError: failure,
        });
        message.warning("安全检查未通过，已停止安装。");
        return;
      }
      if (record?.["error"] === "invalid-stage") {
        setStaged(null);
        message.warning("安装已过期，请重新点击安装再确认。");
        return;
      }
      if (record?.["error"] === "target-exists") {
        markInstalled(staged.slug ?? "", staged.title);
        setStaged(null);
        message.info("本机已有同名技能，无需重复安装。");
        afterInstallChanged();
        return;
      }
      message.error(failure);
      return;
    }
    markInstalled(staged.slug ?? "", staged.title);
    message.success("技能已安装。");
    setStaged(null);
    afterInstallChanged();
  };

  /** SkillHub 卡片「+」：下载 → 安全检查 → 确认安装。 */
  const stageSkillHub = async (item: SkillHubSkill) => {
    if (hubBusySlug !== null) return;
    setHubBusySlug(item.slug);
    const stagedResult = await postJson(
      `/api/skillhub/skills/${encodeURIComponent(item.slug)}/stage`,
      {},
      60_000,
    );
    setHubBusySlug(null);
    const stageId =
      stagedResult.ok && stagedResult.data !== null && typeof stagedResult.data === "object" && "id" in stagedResult.data
        ? String((stagedResult.data as { id: unknown }).id)
        : "";
    if (!stagedResult.ok || stageId === "") {
      message.error(stagedResult.ok ? "服务未返回安装标识。" : friendlyError(stagedResult.data, "SkillHub 下载或检查未完成。"));
      return;
    }
    const risk = stagedResult.data !== null && typeof stagedResult.data === "object"
      ? parseStagedRisk((stagedResult.data as Record<string, unknown>)["risk"])
      : null;
    setStaged({ title: item.name, stageId, slug: item.slug, risk, installError: null });
  };

  /** 推荐 Tab 的 GitHub 仓库卡片：暂存整仓 → 确认安装。 */
  const stageGitFromName = async (name: string) => {
    const stagedResult = await postJson("/api/skills/git/stage", { url: name }, 90_000);
    const stageId =
      stagedResult.ok && stagedResult.data !== null && typeof stagedResult.data === "object" && "id" in stagedResult.data
        ? String((stagedResult.data as { id: unknown }).id)
        : "";
    if (!stagedResult.ok || stageId === "") {
      message.error(stagedResult.ok ? "服务未返回安装标识。" : friendlyError(stagedResult.data, "仓库下载或检查未完成。"));
      return;
    }
    const risk = stagedResult.data !== null && typeof stagedResult.data === "object"
      ? parseStagedRisk((stagedResult.data as Record<string, unknown>)["risk"])
      : null;
    const displayName = stagedResult.data !== null && typeof stagedResult.data === "object" && "name" in stagedResult.data
      ? String((stagedResult.data as { name: unknown }).name)
      : name;
    setStaged({ title: displayName, stageId, slug: null, risk, installError: null });
  };

  /** 推荐 Tab 的管家推荐（单文件下载链路）。 */
  const installRecommendation = async (item: Recommendation) => {
    if (recommendBusy !== null) return;
    setRecommendBusy(item.id);
    const stagedResult = await postJson(
      `/api/skills/recommendations/${encodeURIComponent(item.id)}/stage`,
      {},
      30_000,
    );
    setRecommendBusy(null);
    const stageId =
      stagedResult.ok && stagedResult.data !== null && typeof stagedResult.data === "object" && "id" in stagedResult.data
        ? String((stagedResult.data as { id: unknown }).id)
        : "";
    if (!stagedResult.ok || stageId === "") {
      message.error(stagedResult.ok ? "服务未返回安装标识。" : friendlyError(stagedResult.data, "技能下载或检查未完成。"));
      return;
    }
    const risk = stagedResult.data !== null && typeof stagedResult.data === "object"
      ? parseStagedRisk((stagedResult.data as Record<string, unknown>)["risk"])
      : null;
    setStaged({ title: item.name, stageId, slug: null, risk, installError: null });
  };

  /** 「从 Git 安装」弹窗：输入地址 → 下载 + 安全检查 → 确认安装。 */
  const stageGitFromInput = async () => {
    const url = gitUrl.trim();
    if (url === "") {
      message.warning("请填写 Git 仓库地址或 owner/repo。");
      return;
    }
    setGitStaging(true);
    const stagedResult = await postJson("/api/skills/git/stage", { url }, 90_000);
    setGitStaging(false);
    const stageId =
      stagedResult.ok && stagedResult.data !== null && typeof stagedResult.data === "object" && "id" in stagedResult.data
        ? String((stagedResult.data as { id: unknown }).id)
        : "";
    if (!stagedResult.ok || stageId === "") {
      message.error(stagedResult.ok ? "服务未返回安装标识。" : friendlyError(stagedResult.data, "仓库下载或检查未完成。"));
      return;
    }
    const risk = stagedResult.data !== null && typeof stagedResult.data === "object"
      ? parseStagedRisk((stagedResult.data as Record<string, unknown>)["risk"])
      : null;
    const displayName = stagedResult.data !== null && typeof stagedResult.data === "object" && "name" in stagedResult.data
      ? String((stagedResult.data as { name: unknown }).name)
      : url;
    setStaged({ title: displayName, stageId, slug: null, risk, installError: null });
    setGitModalOpen(false);
    setGitUrl("");
  };

  const removeOne = (item: LocalSkillItem) => {
    Modal.confirm({
      title: `删除「${item.displayName}」？`,
      content: "整个技能目录会先移入 Butler 备份区，不会直接销毁；需要时可以在备份目录手动恢复。",
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        const result = await postJson(
          `/api/skills/local/${encodeURIComponent(item.name)}/remove`,
          { confirmed: true },
          30_000,
        );
        if (!result.ok) {
          message.error(friendlyError(result.data, "删除未完成，请稍后重试。"));
          return;
        }
        message.success("技能已删除（备份区保留副本）。");
        void loadLocal(true);
        onInstalled?.();
      },
    });
  };

  const updateOne = async (item: LocalSkillItem, silent = false) => {
    if (updateBusyName !== null) return;
    setUpdateBusyName(item.name);
    const result = await postJson(
      "/api/skills/local/update",
      { name: item.name, confirmed: true },
      120_000,
    );
    setUpdateBusyName(null);
    if (!result.ok) {
      message.error(friendlyError(result.data, "更新未完成，请稍后重试。"));
      return;
    }
    if (!silent) message.success("已更新到最新版。");
    void loadLocal(true);
    void loadUpdates();
    onInstalled?.();
  };

  const updateAllAvailable = async () => {
    if (updateAllBusy || availableUpdates.length === 0) return;
    setUpdateAllBusy(true);
    let succeeded = 0;
    let failed = 0;
    for (const item of availableUpdates) {
      const result = await postJson(
        "/api/skills/local/update",
        { name: item.name, confirmed: true },
        120_000,
      );
      if (result.ok) succeeded += 1;
      else failed += 1;
    }
    setUpdateAllBusy(false);
    if (failed > 0) message.warning(`更新完成：${succeeded} 成功，${failed} 失败。`);
    else message.success(`已更新 ${succeeded} 个技能。`);
    void loadLocal(true);
    void loadUpdates();
    onInstalled?.();
  };

  /** 搜索框统一入口：安装态/推荐=本地筛选；SkillHub=防抖关键词。 */
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
    () => (hubCategories?.items ?? []).map((item) => ({ key: item.key, label: item.name })),
    [hubCategories],
  );

  const hasMore = hub.items.length > 0 && hub.items.length < hub.total;

  const renderMarketCard = (
    card:
      | { kind: "recommendation"; key: string; name: string; subtitle: string; description: string; category: string; avatarUrl: string | null; tags: string[]; recommendation: Recommendation }
      | { kind: "trend"; key: string; name: string; subtitle: string; description: string; category: string; avatarUrl: string | null; tags: string[]; trend: TrendItem },
  ) => (
    <SkillMarketCard
      key={card.key}
      name={card.name}
      subtitle={card.subtitle}
      description={card.description}
      category={card.category}
      tags={card.tags}
      avatarUrl={card.avatarUrl}
      footerLeft={
        card.kind === "trend" ? (
          <Flex align="center" gap={6}>
            <Avatar size={18}>{ownerOf(card.trend.name).charAt(0).toUpperCase()}</Avatar>
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
        card.kind === "recommendation" ? (
          <Button
            size="small"
            loading={recommendBusy === card.recommendation.id}
            onClick={() => void installRecommendation(card.recommendation)}
          >
            安装
          </Button>
        ) : (
          <Button size="small" onClick={() => void stageGitFromName(card.trend.name)}>
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
        footerLeft={
          <Text type="secondary" className="wb-card-meta">
            {`${formatHubCount(item.downloads)} 下载 · ⭐ ${formatHubCount(item.stars)}`}
            {item.ownerName !== "" ? ` · ${item.ownerName}` : ""}
          </Text>
        }
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
    const { item } = card;
    const update = updateMap[item.name];
    return (
      <SkillMarketCard
        key={item.name}
        name={item.displayName}
        subtitle={`${ORIGIN_LABELS[item.origin]}${item.version === null ? "" : ` · v${item.version}`}`}
        description={item.description !== "" ? item.description : "本机技能，详情见技能文件。"}
        category={card.category}
        tags={[]}
        statusTag={update?.status === "available" ? { text: "有可用更新", color: "warning" } : undefined}
        footerLeft={
          <Text type="secondary" className="wb-card-meta">
            {[
              item.version === null ? "版本未知" : `v${item.version}`,
              item.installedAt === null ? null : `装于 ${formatTime(item.installedAt)}`,
              update?.status === "unknown" ? update.reason ?? "更新检查失败" : null,
            ].filter((part) => part !== null).join(" · ")}
          </Text>
        }
        footerRight={
          <>
            {update?.status === "available" && (
              <Button
                size="small"
                loading={updateBusyName === item.name || updateAllBusy}
                onClick={() => void updateOne(item)}
              >
                更新
              </Button>
            )}
            <Button size="small" onClick={() => setDetailItem(item)}>
              详情
            </Button>
            <Button size="small" danger onClick={() => removeOne(item)}>
              删除
            </Button>
            <Dropdown
              key="more"
              trigger={["click"]}
              placement="bottomRight"
              menu={{
                items: [
                  {
                    key: "dir",
                    label: `目录：${item.name}`,
                    disabled: true,
                  },
                ],
              }}
            >
              <Button size="small" aria-label={`更多信息：${item.displayName}`} icon={<MoreOutlined />} />
            </Dropdown>
          </>
        }
      />
    );
  };

  const stagedBlocked = staged?.risk?.status === "blocked" || staged?.installError != null;

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
      ) : (
        <>
          {(hub.items.length === 0 ? (
            <Empty
              mascot={false}
              title={hubSearching ? "SkillHub 里没有匹配的技能，换个关键词试试" : "该分类下暂时没有技能，换个分类或搜索试试"}
            />
          ) : (
            <div className="wb-grid">
              {hub.items.map(renderHubCard)}
            </div>
          ))}
          {hasMore && (
            <div className="wb-load-more">
              <Button loading={hub.appending} onClick={() => void loadHubList({ page: hub.page + 1, reset: false })}>
                加载更多（已展示 {hub.items.length}/{hub.total}）
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );

  const recommendedBody = marketLoading ? (
    <Flex justify="center" align="center" gap={8} style={{ padding: "48px 0" }}>
      <Spin />
      <Text type="secondary">正在读取推荐与公开趋势…</Text>
    </Flex>
  ) : recommendedCards.length === 0 ? (
    <Empty
      mascot={false}
      title="还没有推荐项目"
      hint="点击右上角搜索，或从 Git 安装技能。"
    />
  ) : (
    <div className="wb-grid">
      {recommendedCards.map(renderMarketCard)}
    </div>
  );

  const installedBody = (
    <>
      <Flex justify="space-between" align="center" gap={12} wrap="wrap" style={{ marginBottom: 12 }}>
        <Flex gap={24} wrap="wrap">
          <Statistic title="本机已安装" value={localItems.length} />
          <Statistic title="有可用更新" value={availableUpdates.length} />
        </Flex>
        <Button
          loading={updateAllBusy}
          disabled={availableUpdates.length === 0}
          onClick={() => void updateAllAvailable()}
        >
          一键更新全部
        </Button>
      </Flex>
      {localError !== null && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="本机技能清单暂时读不到"
          description={localError}
          action={<Button size="small" onClick={() => void loadLocal()}>重试</Button>}
        />
      )}
      {updatesChecking && (
        <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
          正在检查更新…
        </Text>
      )}
      <CategoryChips items={installedChips} active={activeInstalledCategory} onSelect={setActiveInstalledCategory} />
      {localLoading ? (
        <Flex justify="center" align="center" gap={8} style={{ padding: "48px 0" }}>
          <Spin />
          <Text type="secondary">正在读取本机技能…</Text>
        </Flex>
      ) : localItems.length === 0 && localError === null ? (
        <Empty
          mascot={false}
          title="还没有安装任何技能"
          hint="去 SkillHub 市场逛逛，或从 Git 安装。"
        />
      ) : visibleInstalled.length === 0 && localError === null ? (
        <Empty
          mascot={false}
          title="没有匹配当前分类和筛选的技能"
          hint="试试切换分类，或清空搜索关键词。"
        />
      ) : (
        <div className="wb-grid">
          {visibleInstalled.map(renderInstalledCard)}
        </div>
      )}
    </>
  );

  // ---- 模板 §2.3 ② 结论条 ----
  // 一屏只一个 primary：page-level 的「+ 添加技能」下拉由此结论条的 action 槽承载。
  const conclusionTone: ConclusionTone =
    mode === "installed"
      ? availableUpdates.length > 0
        ? "warn"
        : "ok"
      : "info";
  const conclusionTitle =
    mode === "installed"
      ? `本机已安装 ${localItems.length} 个技能`
      : tab === "skillhub"
        ? `SkillHub 公共库（首次同步约 10–20 秒）`
        : `推荐 ${recommendations.length} 个技能待你挑选`;
  const conclusionCopy =
    mode === "installed"
      ? availableUpdates.length > 0
        ? `共 ${availableUpdates.length} 个有新版本可更新；批量更新前会自动备份配置。`
        : "全部为最新版本，无需操作。"
      : tab === "skillhub"
        ? "按下载量排序；若本机遇到兼容问题，可先看右侧「推荐」里管家已稳定使用的。"
        : "管家按本机已装技能的协同价值排序，每周一回填。";

  return (
    <Flex vertical gap={14} className="skills-marketplace-panel">
      {/* 模板 §2.3 ① 标题 + 一句话说明 */}
      <SectionHeader
        kicker="智能体与记忆"
        title="技能市场"
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            公开技能由社区维护，管家安装前会跑安全检查
          </Text>
        }
      />
      {/* 模板 §2.3 ② 结论条（唯一 primary：+ 添加技能） */}
      <ConclusionBar
        tone={conclusionTone}
        title={conclusionTitle}
        copy={conclusionCopy}
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            SkillHub 库 {hub.total} 个 · 推荐 {recommendations.length} 个 · 已装 {localItems.length} 个 · 待更新 {availableUpdates.length} 个
          </Text>
        }
        action={
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                {
                  key: "git",
                  icon: <CloudDownloadOutlined />,
                  label: "从 Git 安装",
                  onClick: () => setGitModalOpen(true),
                },
              ],
            }}
            placement="bottomRight"
          >
            <Button type="primary" icon={<PlusOutlined />}>
              添加技能
            </Button>
          </Dropdown>
        }
      />
      {/* 工具行：内容 Tab + 搜索 + 我安装的（不再含 primary） */}
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
            <span className="count">{localItems.length}</span>
          </button>
          {/* + 添加技能的主按钮已上移到 ConclusionBar 的 action 槽位，保持一屏 1 个 primary。 */}
        </Flex>
      </div>

      {mode === "market" && (
        <>
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

      {/* 安装确认弹窗（SkillHub / Git / 推荐共用）：安全检查通过 → 一键确认；被阻止 → 只给原因和关闭 */}
      <Modal
        open={staged !== null}
        title={
          staged === null
            ? null
            : stagedBlocked
              ? `无法安装「${staged.title}」`
              : `安装「${staged.title}」`
        }
        okText={stagedInstallBusy ? "安装中…" : "安装"}
        cancelText="取消"
        confirmLoading={stagedInstallBusy}
        footer={
          stagedBlocked ? (
            <Button onClick={() => setStaged(null)}>
              知道了
            </Button>
          ) : undefined
        }
        onCancel={() => {
          if (!stagedInstallBusy) setStaged(null);
        }}
        onOk={() => void confirmStaged()}
      >
        {staged !== null && (
          <Flex vertical gap={12}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              确认后写入本机技能目录；安装前会自动备份现有技能。
            </Typography.Paragraph>
            <StagedRiskDetails risk={staged.risk} installError={staged.installError} />
          </Flex>
        )}
      </Modal>

      {/* 从 Git 安装：输入 → 下载 + 安全检查 → 确认 */}
      <Modal
        open={gitModalOpen}
        title="从 Git 安装"
        okText={gitStaging ? "正在获取…" : "获取并检查"}
        cancelText="取消"
        confirmLoading={gitStaging}
        onCancel={() => {
          if (!gitStaging) setGitModalOpen(false);
        }}
        onOk={() => void stageGitFromInput()}
      >
        <Flex vertical gap={10}>
          <Input
            placeholder="owner/repo 或 https://github.com/owner/repo"
            value={gitUrl}
            onChange={(event) => setGitUrl(event.target.value)}
            onPressEnter={() => void stageGitFromInput()}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            支持 GitHub 仓库（可带 /tree/分支）。获取后先做安全检查，确认才会写入本机技能目录；仓库根目录需包含 SKILL.md。
          </Text>
        </Flex>
      </Modal>

      {/* 已安装技能详情 */}
      <Drawer
        title={detailItem !== null ? `技能详情：${detailItem.displayName}` : "技能详情"}
        width={520}
        open={detailItem !== null}
        onClose={() => setDetailItem(null)}
      >
        {detailItem !== null && (
          <Flex vertical gap={16}>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="名称">{detailItem.displayName}</Descriptions.Item>
              <Descriptions.Item label="目录名">{detailItem.name}</Descriptions.Item>
              <Descriptions.Item label="描述">
                {detailItem.description !== "" ? detailItem.description : "—"}
              </Descriptions.Item>
              <Descriptions.Item label="版本">
                {detailItem.version === null ? "未知" : `v${detailItem.version}`}
              </Descriptions.Item>
              <Descriptions.Item label="来源">
                {ORIGIN_LABELS[detailItem.origin]}
                {detailItem.gitUrl !== null ? ` · ${detailItem.gitUrl}` : detailItem.slug !== null ? ` · skillhub.cn/skills/${detailItem.slug}` : ""}
              </Descriptions.Item>
              <Descriptions.Item label="安装时间">
                {detailItem.installedAt === null ? "未知" : formatTime(detailItem.installedAt)}
              </Descriptions.Item>
              <Descriptions.Item label="更新状态">
                {(() => {
                  const update = updateMap[detailItem.name];
                  if (update === undefined) return "未检查";
                  if (update.status === "up_to_date") return "已是最新";
                  if (update.status === "available") return `有可用更新${update.latestVersion === null ? "" : `（最新 ${update.latestVersion}）`}`;
                  return update.reason ?? "检查失败";
                })()}
              </Descriptions.Item>
            </Descriptions>
            {(detailItem.slug !== null || detailItem.gitUrl !== null) && (
              <Button
                style={{ alignSelf: "flex-start" }}
                onClick={() => {
                  const url = detailItem.gitUrl ?? `https://skillhub.cn/skills/${detailItem.slug}`;
                  window.open(url, "_blank", "noopener");
                }}
              >
                打开来路页面
              </Button>
            )}
          </Flex>
        )}
      </Drawer>
    </Flex>
  );
}
