/**
 * 技能与记忆页主编排：主加载三态（loading/ready/failed，失败可重试），
 * 记忆检索独立于技能/插件列表——搜索只更新右侧预览区，失败不回滚列表。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { App, Spin, Tabs } from "antd";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { DegradedBanner } from "../../components/DegradedBanner.js";
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
import { DirectoryFallback } from "./DirectoryFallback.js";
import { MemoryPanel } from "./MemoryPanel.js";
import { PluginLibrary } from "./PluginLibrary.js";
import { SkillLibrary } from "./SkillLibrary.js";

export function SkillsPage() {
  const { message } = App.useApp();
  const [mainState, setMainState] = useState<FetchState<SkillsPayload>>({ status: "loading" });
  // 最近一次完整数据：检索期间/失败时记忆面板仍显示它，不再伪装成空态。
  const [lastGood, setLastGood] = useState<SkillsPayload | null>(null);
  const [libraryTab, setLibraryTab] = useState<"skills" | "plugins">("skills");
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

  return (
    <section className="page skills-page">
      <header className="skills-header">
        <div>
          <span className="skills-eyebrow">只读查看</span>
          <h1>技能与记忆</h1>
          <p>查看 AI 学会的东西和记住的事；当前版本只读，不会改动技能或删除记忆。</p>
        </div>
        <div className="skills-header-status">
          <ConnectionChip
            reachable={libraryData?.watchReachable}
            connectingText="正在连接管家"
            offlineText="管家服务暂时连不上"
          />
          <span className="skills-instance">
            {libraryData === null || libraryData.instance === null
              ? "尚未发现 AI 助手"
              : `AI 助手版本：${libraryData.instance.version ?? "版本未知"}`}
          </span>
        </div>
      </header>

      <div className="skills-workspace">
        <section className="skills-pane skills-library">
          <Tabs
            className="skills-library-tabs"
            activeKey={libraryTab}
            onChange={(key) => setLibraryTab(key === "plugins" ? "plugins" : "skills")}
            items={[
              { key: "skills", label: `技能库 ${formatNumber(libraryData?.skills.total ?? 0)}` },
              { key: "plugins", label: `插件库 ${formatNumber(libraryData?.plugins.total ?? 0)}` },
            ]}
          />

          {mainState.status === "loading" && (
            <>
              <div className="skills-driver-note">
                <strong>{modeLabel("unavailable")}</strong>
                <span>{libraryTab === "skills" ? "正在读取技能状态" : "正在读取插件状态"}</span>
              </div>
              <div className="skills-list" aria-busy>
                <div className="skills-empty">
                  <Spin />
                  <p>正在读取技能清单…</p>
                </div>
              </div>
            </>
          )}

          {mainState.status === "failed" && (
            <DegradedBanner
              severity="warn"
              message="这一项暂时读不到"
              description={mainState.reason}
              action={
                <button type="button" className="btn btn-small" onClick={() => void loadLibrary()}>
                  重试
                </button>
              }
            />
          )}

          {libraryTab === "skills" && mainState.status === "ready" && (
            <SkillLibrary skills={mainState.data.skills} />
          )}

          {libraryTab === "plugins" && mainState.status === "ready" && (
            <div className="plugin-section">
              <div className="skills-section-head plugin-section-head">
                <div>
                  <span className="skills-kicker">插件库</span>
                  <h2>{formatNumber(mainState.data.plugins.total)} 个插件</h2>
                </div>
                <span className={`skills-mode is-${mainState.data.plugins.mode}`}>
                  {modeLabel(mainState.data.plugins.mode)}
                </span>
              </div>
              <div className="skills-driver-note">
                <strong>{modeLabel(mainState.data.plugins.mode)}</strong>
                <span>{mainState.data.plugins.notice}</span>
              </div>
              {mainState.data.plugins.mode === "directory-fallback" && (
                <DirectoryFallback directory={mainState.data.plugins.directory} />
              )}
              <PluginLibrary plugins={mainState.data.plugins} />
            </div>
          )}
        </section>

        <section className="skills-pane memory-library">
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
        </section>
      </div>
    </section>
  );
}
