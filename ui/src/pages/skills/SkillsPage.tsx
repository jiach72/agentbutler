/**
 * 技能与记忆页主编排：顶部全局概览带 + 技能市场（WorkBuddy 风格：SkillHub 目录 /
 * 推荐精选 / 本机已安装）/ 记忆库 分区。市场浏览与安装由 SkillsMarketplace 承载；
 * 插件为只读盘点，降级为折叠区。记忆检索独立于技能库。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Card, Col, Flex, Row, Statistic, Tabs, Typography } from "antd";
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { DegradedBanner } from "../../components/DegradedBanner.js";
import { PageHeader } from "../../components/PageHeader.js";
import { loadJson, postJson } from "../../lib/api.js";
import type { FetchState } from "../../lib/api.js";
import {
  buildSkillsUrl,
  formatNumber,
  type MemoryPreview,
  type MemorySelfCheckView,
  type SkillsPayload,
} from "./helpers.js";
import { MemoryPanel } from "./MemoryPanel.js";
import { PluginLibrary } from "./PluginLibrary.js";
import { SkillsMarketplace } from "./SkillsMarketplace.js";

const { Text } = Typography;

export function SkillsPage() {
  const { message } = App.useApp();
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
    const result = await postJson("/api/memory/rebuild-index", {}, 60_000);
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
  const memoryStats = libraryData?.memory.stats ?? null;

  // 全局概览带：只保留技能、插件和记忆三库的当前规模。
  const overview = [
    {
      key: "skills",
      label: "技能（Hermes 全量）",
      value: libraryData === null ? "…" : formatNumber(libraryData.skills.total),
      sub: libraryData === null ? "读取中" : "含内置/系统技能",
    },
    {
      key: "plugins",
      label: "插件",
      value: libraryData === null ? "…" : formatNumber(libraryData.plugins.total),
      sub:
        libraryData === null
          ? "读取中"
          : `共 ${libraryData.plugins.items.filter((item) => item.enabled).length} 启用`,
    },
    {
      key: "memory-entries",
      label: "记忆条目",
      value: memoryStats === null ? "…" : formatNumber(memoryStats.totalEntries),
      sub: "累计入库",
    },
  ];

  return (
    <section className="skills-page">
      <PageHeader
        title="智能体与记忆"
        description="管理智能体技能的安装、更新与部署；查看插件状态，并检索、维护本机记忆。"
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

      <Row gutter={[16, 16]} aria-label="全局概览">
        {overview.map((item) => (
          <Col flex="1 1 160px" key={item.key}>
            <Card size="small">
              <Statistic title={item.label} value={item.value} />
              <Text type="secondary">{item.sub}</Text>
            </Card>
          </Col>
        ))}
      </Row>

      {mainState.status === "failed" && (
        <DegradedBanner
          severity="warn"
          message="这一部分暂时读不到"
          description={mainState.reason}
          action={<Button onClick={() => void loadLibrary()}>重试</Button>}
        />
      )}

      {mainState.status === "ready" && libraryData !== null && (
        <AdvancedDetails
          summary={`插件（只读盘点 · ${libraryData.plugins.items.filter((item) => item.enabled).length} 启用 / 共 ${libraryData.plugins.total}）`}
        >
          <PluginLibrary plugins={libraryData.plugins} />
        </AdvancedDetails>
      )}

      <Tabs
        defaultActiveKey="manager"
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
    </section>
  );
}
