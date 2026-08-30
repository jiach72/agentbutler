import { Descriptions, Progress, Tag } from "antd";
import type { EvolutionOverviewPayload } from "./types.js";

export function EvolutionDatasetPanel({ dataset }: { dataset: EvolutionOverviewPayload["datasets"] }) {
  const percent = Math.min(100, Math.round((dataset.realSamples / Math.max(1, dataset.realSamples + dataset.gap)) * 100));
  return <section className="evolution-panel"><header className="evolution-panel-head"><div><span className="evolution-kicker">数据资产</span><h2>{dataset.dataset} · {dataset.version}</h2></div><Tag color={dataset.formalReady ? "green" : "orange"}>{dataset.formalReady ? "可正式评估" : "样本不足"}</Tag></header><Progress percent={percent} format={() => `${dataset.realSamples} / ${dataset.realSamples + dataset.gap} 条真实样本`} /><Descriptions size="small" column={2}><Descriptions.Item label="正样本">{dataset.positiveSamples}</Descriptions.Item><Descriptions.Item label="负样本">{dataset.negativeSamples}</Descriptions.Item><Descriptions.Item label="Holdout">{dataset.holdoutCount} / {dataset.requiredHoldout}</Descriptions.Item><Descriptions.Item label="数据完整度">{dataset.completeness}</Descriptions.Item><Descriptions.Item label="最近采集">{dataset.lastCollectedAt ?? "未知"}</Descriptions.Item><Descriptions.Item label="重复率">{dataset.duplicateRate === null ? "未知" : `${Math.round(dataset.duplicateRate * 100)}%`}</Descriptions.Item></Descriptions></section>;
}
