/**
 * 技能与记忆页的首屏派生逻辑（与 dashboard/conclusions.ts 同构）：
 * 将「结论条说什么」「概览统计条说什么」从渲染层拆出来，便于单测且不伪造状态。
 *
 * 去重原则：库存计数只在「概览统计条」出现一次；结论条只给状态结论，
 * 不复述「X 个技能与 Y 个插件」这类计数（避免和概览条重复说同一件事）。
 */
import { ApiOutlined, AppstoreOutlined, DatabaseOutlined } from "@ant-design/icons";
import type { PageConclusionView } from "../../components/ConclusionBar.js";
import type { StatStripItem } from "../../components/StatStrip.js";
import type { FetchState } from "../../lib/api.js";
import { formatNumber, type SkillsPayload } from "./helpers.js";

export interface SkillsOverviewOptions {
  enabledPluginCount: number;
  disabledPluginCount: number;
  memoryWritesOff: boolean;
}

/**
 * 全站唯一的紧凑计数摘要：技能 / 插件 / 记忆条目三项。
 * 首屏不再有第二处插件盘点卡，库存计数只在这里说一次。
 */
export function buildSkillsOverview(
  libraryData: SkillsPayload | null,
  options: SkillsOverviewOptions,
): StatStripItem[] {
  const { enabledPluginCount, disabledPluginCount, memoryWritesOff } = options;
  const memoryStats = libraryData?.memory.stats ?? null;
  return [
    {
      key: "skills",
      icon: ApiOutlined,
      label: "技能（Hermes 全量）",
      value: libraryData === null ? "…" : formatNumber(libraryData.skills.total),
      sub: libraryData === null ? "读取中" : "含内置/系统技能",
    },
    {
      key: "plugins",
      icon: AppstoreOutlined,
      label: "插件",
      value: libraryData === null ? "…" : formatNumber(libraryData.plugins.total),
      tone: disabledPluginCount > 0 ? "warn" : undefined,
      sub:
        libraryData === null
          ? "读取中"
          : disabledPluginCount > 0
            ? `共 ${enabledPluginCount} 启用 · ${disabledPluginCount} 未启用`
            : "全部已启用",
    },
    {
      key: "memory-entries",
      icon: DatabaseOutlined,
      label: "记忆条目",
      value: memoryStats === null ? "…" : formatNumber(memoryStats.totalEntries),
      tone: memoryWritesOff ? "warn" : undefined,
      sub: memoryWritesOff ? "写入已关闭" : "累计入库",
    },
  ];
}

/** 结论条：只描述「现在技能与记忆好不好」，不重复库存计数。 */
export function buildSkillsConclusion(
  mainState: FetchState<SkillsPayload>,
  libraryData: SkillsPayload | null,
  memoryWritesOff: boolean,
): PageConclusionView {
  if (mainState.status === "loading") {
    return {
      tone: "unknown",
      title: "正在读取技能与记忆",
      copy: "读取完成后这里会直接告诉你技能和记忆是否正常。",
    };
  }
  if (mainState.status === "failed") {
    return {
      tone: "offline",
      title: "技能与记忆暂时读不到",
      copy: mainState.reason,
    };
  }
  if (libraryData?.watchReachable === false) {
    return {
      tone: "offline",
      title: "管家服务暂时连不上",
      copy: "技能安装与记忆维护需要管家在线；恢复后页面会自动更新。",
    };
  }
  if (memoryWritesOff) {
    return {
      tone: "warn",
      title: "记忆写入当前是关闭的",
      copy: "技能与插件可以正常加载，但新的记忆不会被写回本机。",
    };
  }
  return {
    tone: "ok",
    title: "技能与记忆正常",
    copy: "可安装、可维护；管理入口在上方标签页，各库当前计数见下方概览。",
  };
}
