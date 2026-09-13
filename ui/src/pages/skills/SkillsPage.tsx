/**
 * 技能与记忆页主编排：顶部结论条 + 管理标签页（技能库 / 插件 / 记忆）提前暴露，
 * 下方单一紧凑计数摘要。市场浏览与安装由 SkillsMarketplace 承载；
 * 插件管理由 PluginLibrary 承载（独立标签页，不再作为首屏折叠的只读盘点）。
 * 记忆检索独立于技能库。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Empty, Flex, Spin, Tabs, Typography } from "antd";
import { ConclusionBar } from "../../components/ConclusionBar.js";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { PageHeader } from "../../components/PageHeader.js";
import { StatStrip } from "../../components/StatStrip.js";
import { useUrlState } from "../../hooks/useUrlState.js";
import { loadJson, postJson } from "../../lib/api.js";
import type { FetchState } from "../../lib/api.js";
import {
  buildSkillsUrl,
  type MemoryPreview,
  type MemorySelfCheckView,
  type SkillsPayload,
} from "./helpers.js";
import { MemoryPanel } from "./MemoryPanel.js";
import { PluginLibrary } from "./PluginLibrary.js";
import { SkillsMarketplace } from "./SkillsMarketplace.js";
import { buildSkillsConclusion, buildSkillsOverview } from "./summary.js";

const { Text } = Typography;

export function SkillsPage() {
  const { message } = App.useApp();
  // 页签同步到 URL（规范 03 §3.12）：刷新、返回、贴链接都能还原同一个视图（评审 P1-7）。
  // 显式给 string 而不是让它推断成字面量 "manager"，否则 setActiveTab 只能收 "manager"。
  const [activeTab, setActiveTab] = useUrlState<string>("tab", "manager");
  const [mainState, setMainState] = useState<FetchState<SkillsPayload>>({ status: "loading" });
  // 最近一次完整数据：检索期间/失败时记忆面板仍显示它，不再伪装成空态。
  const [lastGood, setLastGood] = useState<SkillsPayload | null>(null);
  const [activeKeyword, setActiveKeyword] = useState("");
  const [memoryPreview, setMemoryPreview] = useState<MemoryPreview>({ status: "default" });
  const [backupBusy, setBackupBusy] = useState(false);
  const [memoryWritesEnabled, setMemoryWritesEnabled] = useState<boolean | null>(null);
  const [selfCheck, setSelfCheck] = useState<{
    busy: boolean;
    result: MemorySelfCheckView | null;
  }>({ busy: false, result: null });
  const requestSeq = useRef(0);

  /** 完整加载：成功后同时作为「最近一次完整数据」兜底。 */
  const loadLibrary = useCallback(async (options?: { silent?: boolean }) => {
    const seq = ++requestSeq.current;
    if (options?.silent !== true) setMainState({ status: "loading" });
    const result = await loadJson<SkillsPayload>(buildSkillsUrl(""), 10_000);
    if (seq !== requestSeq.current) return;
    if (!result.ok) {
      setMainState({ status: "failed", reason: result.reason });
      return;
    }
    setMainState({ status: "ready", data: result.data });
    setLastGood(result.data);
  }, []);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    let active = true;
    void loadJson<{ memoryWritesEnabled?: boolean }>("/api/security", 8_000).then((result) => {
      if (!active) return;
      setMemoryWritesEnabled(result.ok && typeof result.data.memoryWritesEnabled === "boolean" ? result.data.memoryWritesEnabled : null);
    });
    return () => {
      active = false;
    };
  }, []);

  /** 记忆检索：只写 memoryPreview，技能/插件保持上次数据不动。 */
  const runMemorySearch = useCallback(
    async (rawKeyword: string) => {
      const keyword = rawKeyword.trim();
      setActiveKeyword(keyword);
      if (keyword === "") {
        setMemoryPreview({ status: "default" });
        void loadLibrary();
        return;
      }
      const seq = ++requestSeq.current;
      setMemoryPreview({ status: "searching", keyword });
      const result = await loadJson<SkillsPayload>(buildSkillsUrl(keyword), 10_000);
      if (seq !== requestSeq.current) return;
      if (!result.ok) {
        setMemoryPreview({ status: "failed", keyword, reason: result.reason });
        return;
      }
      setLastGood(result.data);
      setMemoryPreview({ status: "ready", keyword });
    },
    [loadLibrary],
  );

  const searching = memoryPreview.status === "searching";
  const searchError = memoryPreview.status === "failed" ? memoryPreview.reason : null;

  const refreshMemoryView = useCallback(() => {
    if (activeKeyword === "") {
      void loadLibrary();
      return;
    }
    void runMemorySearch(activeKeyword);
  }, [activeKeyword, loadLibrary, runMemorySearch]);

  const runMemoryBackup = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    const result = await postJson(
      "/api/backups",
      { kind: "memory", label: "记忆页手动备份" },
      15_000,
    );
    setBackupBusy(false);
    if (result.ok && result.data !== null && typeof result.data === "object") {
      message.success("记忆库备份完成，已保存在本地备份目录。");
    } else {
      message.error("记忆备份失败；请稍后重试或查看管家日志。");
    }
  };

  // 一键修复：重试外部记忆后端（如 hindsight）失败的后台操作（限额批次）。
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const runRebuildIndex = async () => {
    if (rebuildBusy) return;
    setRebuildBusy(true);
    const result = await postJson("/api/memory/rebuild-index", {}, 95_000);
    setRebuildBusy(false);
    if (result.ok && result.data !== null && typeof result.data === "object") {
      const report = (
        result.data as {
          report?: { rebuilt?: boolean; rowsBefore?: number; rowsAfter?: number; errors?: string[] };
        }
      ).report;
      const fixed = Math.max(0, (report?.rowsBefore ?? 0) - (report?.rowsAfter ?? 0));
      if (fixed > 0) {
        message.success(
          `已重新排队 ${fixed} 条失败操作，hindsight 将异步处理；剩余失败约 ${report?.rowsAfter ?? 0} 条。`,
        );
      } else if ((report?.errors?.length ?? 0) > 0) {
        message.warning("没有操作被重新排队；请稍后重试或查看管家日志。");
      } else {
        message.info("当前没有失败的后台操作，无需修复。");
      }
      refreshMemoryView();
    } else {
      message.error("修复请求失败；请确认管家服务在线后重试。");
    }
  };

  const runSelfCheck = async () => {
    if (selfCheck.busy) return;
    setSelfCheck({ busy: true, result: null });
    const result = await postJson("/api/memory/self-check", {}, 15_000);
    if (result.ok && result.data !== null && typeof result.data === "object") {
      const data = result.data as { result?: MemorySelfCheckView };
      if (data.result !== undefined) {
        setSelfCheck({ busy: false, result: data.result });
        message.info(
          data.result.status === "pass"
            ? "记忆自检完成，写入和召回都正常。"
            : data.result.status === "skipped"
              ? "本次自检跳过（详见结果）。"
              : "记忆自检完成，有需要注意的地方（详见结果）。",
        );
        refreshMemoryView();
        return;
      }
    }
    setSelfCheck({ busy: false, result: null });
    message.error("记忆自检失败；请稍后重试或查看管家日志。");
  };

  const libraryData = mainState.status === "ready" ? mainState.data : null;
  const refreshing = mainState.status === "loading" || searching;
  const enabledPluginCount = libraryData === null ? 0 : libraryData.plugins.items.filter((item) => item.enabled).length;
  const disabledPluginCount = libraryData === null ? 0 : libraryData.plugins.total - enabledPluginCount;
  /** 记忆写入被关掉时，页面必须说出来——否则用户会以为写进去了（P3 真实即边界）。 */
  const memoryWritesOff = memoryWritesEnabled === false;

  /**
   * 页面结论条（规范 03 §2.3 ②「必须有」）。
   * 结论只来自真实数据；读不到就说读不到，不猜、不填充（评审 P0-2）。
   */
  const conclusion = buildSkillsConclusion(mainState, libraryData, memoryWritesOff);
  const conclusionView =
    mainState.status === "failed"
      ? { ...conclusion, action: <Button onClick={() => void loadLibrary()}>重试</Button> }
      : conclusion;

  // 全局概览带：技能、插件、记忆三库的当前规模，收敛为「一个」紧凑计数摘要
  // （库存计数只在这里说一次，不再与结论条、插件盘点卡重复）。
  const overview = buildSkillsOverview(libraryData, {
    enabledPluginCount,
    disabledPluginCount,
    memoryWritesOff,
  });

  return (
    <section className="skills-page">
      <PageHeader
        title="智能体与记忆"
        extra={
          <Flex vertical align="flex-end" gap={4}>
            <ConnectionChip
              reachable={libraryData?.watchReachable}
              connectingText="正在连接管家"
              offlineText="管家服务暂时连不上"
            />
            <Text type="secondary">
              {libraryData === null || libraryData.instance === null
                ? "尚未发现实例"
                : `实例版本：${libraryData.instance.version ?? "版本未知"}`}
            </Text>
          </Flex>
        }
      />

      {/* §2.3 ② 结论条：进来先说「技能和记忆现在好不好」。 */}
      <ConclusionBar tone={conclusionView.tone} title={conclusionView.title} copy={conclusionView.copy} action={conclusionView.action} />

      {/* 管理标签页提前暴露：用户第一屏即可进管理操作，而不是先看汇总。
          技能库（含「我安装的」管理入口）/ 插件 / 记忆。 */}
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        aria-busy={mainState.status === "loading"}
        items={[
          {
            key: "manager",
            label: "技能库",
            children: (
              <div id="skills-marketplace">
                <SkillsMarketplace onInstalled={() => void loadLibrary({ silent: true })} />
              </div>
            ),
          },
          {
            key: "plugins",
            label: "插件",
            forceRender: true,
            children: (
              <div id="plugins-panel">
                {libraryData !== null ? (
                  <PluginLibrary plugins={libraryData.plugins} />
                ) : mainState.status === "failed" ? (
                  <Empty description="插件清单暂时读不到；管家服务恢复后可重试。" />
                ) : (
                  <Flex justify="center" align="center" gap={8} style={{ padding: "48px 0" }}>
                    <Spin />
                    <Text type="secondary">正在读取插件清单…</Text>
                  </Flex>
                )}
              </div>
            ),
          },
          {
            key: "memory",
            label: "记忆",
            children: (
              <div id="memory-panel">
                <MemoryPanel
                  data={lastGood}
                  searching={searching}
                  searchError={searchError}
                  activeKeyword={activeKeyword}
                  refreshing={refreshing}
                  selfCheck={selfCheck}
                  backupBusy={backupBusy}
                  onSearch={(keyword) => void runMemorySearch(keyword)}
                  onRefresh={refreshMemoryView}
                  onSelfCheck={() => void runSelfCheck()}
                  onBackup={() => void runMemoryBackup()}
                  onRebuildIndex={() => void runRebuildIndex()}
                  rebuildBusy={rebuildBusy}
                  memoryWritesEnabled={memoryWritesEnabled}
                />
              </div>
            ),
          },
        ]}
      />

      {/* 单一紧凑计数摘要：库存计数只在这里说一次。 */}
      <StatStrip items={overview} />
    </section>
  );
}
