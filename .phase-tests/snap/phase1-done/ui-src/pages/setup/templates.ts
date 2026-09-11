export type ScenarioTemplateId = "daily" | "notify" | "knowledge" | "coding" | "watch";

export interface ScenarioTemplate {
  id: ScenarioTemplateId;
  label: string;
  description: string;
  nextLabel: string;
  destination: string;
}

export const SCENARIO_TEMPLATES: readonly ScenarioTemplate[] = [
  { id: "daily", label: "日常问答", description: "先看运行状态，随时从首页确认它是否在线。", nextLabel: "打开首页", destination: "/dashboard" },
  { id: "notify", label: "消息提醒", description: "把智能体接到常用消息通道，并查看送达记录。", nextLabel: "配置消息通知", destination: "/gateway" },
  { id: "knowledge", label: "知识库问答", description: "先确认已有技能和记忆，再按需要补充内容。", nextLabel: "查看技能与记忆", destination: "/skills" },
  { id: "coding", label: "代码协作", description: "从技能库选择可信工具；安装前会经过隔离检查。", nextLabel: "查看技能库", destination: "/skills" },
  { id: "watch", label: "定时巡检", description: "管家会持续检查运行状态，有问题时从排查入口处理。", nextLabel: "查看巡检首页", destination: "/dashboard" },
];

export function getScenarioTemplate(value: string | null | undefined): ScenarioTemplate | null {
  return SCENARIO_TEMPLATES.find((template) => template.id === value) ?? null;
}
