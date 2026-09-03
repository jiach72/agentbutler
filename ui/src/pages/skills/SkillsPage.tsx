/**
 * 技能与记忆页主编排（单页连续仪表盘）：顶部全局概览带 + 技能库 / 本机盘点 / 插件库 / 记忆库 分区。
 * 技能库（skills-manager 中央库）是主管理视图：安装 / 更新 / 删除 / 部署到 Hermes；
 * 本机盘点与插件只读展示。记忆检索独立于技能/插件列表——搜索只更新记忆分区，失败不回滚列表。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Card, Col, Flex, Row, Spin, Statistic, Tabs, Typography } from "antd";
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
  modeLabel,
  type SkillsPayload,
} from "./helpers.js";
import { MemoryPanel } from "./MemoryPanel.js";
import { PluginLibrary } from "./PluginLibrary.js";
import { SkillLibrary } from "./SkillLibrary.js";
import { SkillsManagerPanel } from "./SkillsManagerPanel.js";

const { Text } = Typography;

export function SkillsPage() {
  const { message } = App.useApp();
  const [mainState, setMainState] = useState<FetchState<SkillsPayload>>({ status: "loading" });
  // 最近一次完整数据：检索期间/失败时记忆面板仍显示它，不再伪装成空态。
  const [lastGood, setLastGood] = useState<SkillsPayload | null>(null);
  const [activeKeyword, setActiveKeyword] = useState("");
  const [memoryPreview, setMemoryPreview] = useState<MemoryPreview>({ status: "default" });
  const [backupBusy, setBackupBusy] = useState(false);
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
    const result = await postJson("/api/backups", { kind: "memory", label: "记忆页手动备份" }, 15_000);
    setBackupBusy(false);
    if (result.ok && result.data !== null && typeof result.data === "object") {
      message.success("记忆库备份完成，已保存在本地备份目录。");
    } else {
      message.error("记忆备份失败；请稍后重试或查看管家日志。");
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

  // 全局概览带：把技能 / 插件 / 记忆三库的核心指标汇成一排。
  const overview = [
    {
      key: "skills",
      label: "技能",
      value: libraryData === null ? "…" : formatNumber(libraryData.skills.total),
      sub: libraryData === null ? "读取中" : `共 ${libraryData.skills.items.filter((item) => item.enabled).length} 启用`,
    },
    {
      key: "plugins",
      label: "插件",
      value: libraryData === null ? "…" : formatNumber(libraryData.plugins.total),
      sub: libraryData === null ? "读取中" : `共 ${libraryData.plugins.items.filter((item) => item.enabled).length} 启用`,
    },
    {
      key: "memory-entries",
      label: "记忆条目",
      value: memoryStats === null ? "…" : formatNumber(memoryStats.totalEntries),
      sub: "累计入库",
    },
    {
      key: "memory-cold",
      label: "长期未用",
      value: memoryStats === null ? "…" : formatNumber(memoryStats.coldCandidates),
      sub: "可考虑归档",
    },
    {
      key: "memory-recalls",
      label: "累计召回",
      value: memoryStats === null ? "…" : formatNumber(memoryStats.cumulativeRecalls),
      sub: "检索命中",
    },
  ];

  return (
    <section className="skills-page">
      <PageHeader
        eyebrow="技能资产管理"
        title="技能与记忆"
        description="「技能库」支持安装、更新、删除技能并部署到 Hermes；本机盘点与插件为只读查看，记忆支持检索与维护。"
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

      <Tabs
        defaultActiveKey="manager"
        aria-busy={mainState.status === "loading"}
        items={[
          {
            key: "manager",
            label: "技能库",
            children: (
              <div id="skills-manager-panel">
                <SkillsManagerPanel />
              </div>
            ),
          },
          {
            key: "skills",
            label: "本机盘点（只读）",
            children: (
              <div id="skills-panel">
                {mainState.status === "loading" && (
                  <Flex vertical gap={16}>
                    <Alert
                      type="info"
                      showIcon
                      message={modeLabel("unavailable")}
                      description="正在读取技能状态"
                    />
                    <Flex justify="center" align="center" gap={8}>
                      <Spin />
                      <Text type="secondary">正在读取技能清单…</Text>
                    </Flex>
                  </Flex>
                )}
                {mainState.status === "ready" && <SkillLibrary skills={mainState.data.skills} />}
              </div>
            ),
          },
          {
            key: "plugins",
            label: "插件",
            children: (
              <div id="plugins-panel">
                {mainState.status === "loading" && (
                  <Flex vertical gap={16}>
                    <Alert
                      type="info"
                      showIcon
                      message={modeLabel("unavailable")}
                      description="正在读取插件状态"
                    />
                    <Flex justify="center" align="center" gap={8}>
                      <Spin />
                      <Text type="secondary">正在读取插件清单…</Text>
                    </Flex>
                  </Flex>
                )}
                {mainState.status === "ready" && <PluginLibrary plugins={mainState.data.plugins} />}
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
                />
              </div>
            ),
          },
        ]}
      />
    </section>
  );
}
