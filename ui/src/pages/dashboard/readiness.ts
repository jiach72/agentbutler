import type { ConnectionsPayload, DiscoveredLlmConfigView, LlmStatusView } from "./types.js";

export type ReadinessTone = "ok" | "warn" | "error" | "idle";

export interface ReadinessAction {
  label: string;
  to: string;
}

export interface ReadinessItem {
  id: "connection" | "native-model" | "managed-model";
  title: string;
  tone: ReadinessTone;
  status: string;
  detail: string;
  action?: ReadinessAction;
}

export interface LocalReadiness {
  ready: boolean;
  summary: string;
  detail: string;
  items: ReadinessItem[];
  nextAction?: ReadinessAction;
}

function connectedCount(connections: ConnectionsPayload | null): number {
  return connections?.connections?.filter((connection) => connection.connected).length ?? 0;
}

function connectionReadiness(connections: ConnectionsPayload | null): ReadinessItem {
  if (connections === null) {
    return {
      id: "connection",
      title: "本机智能体连接",
      tone: "idle",
      status: "正在确认",
      detail: "正在读取本机服务和智能体的连接状态。",
    };
  }
  if (!connections.reachable) {
    return {
      id: "connection",
      title: "本机智能体连接",
      tone: "error",
      status: "暂时不可读取",
      detail: "管家控制通道暂时连不上，无法确认智能体是否在线。",
      action: { label: "开始排查", to: "/troubleshoot?symptom=error" },
    };
  }
  const total = connections.connections?.length ?? 0;
  const connected = connectedCount(connections);
  if (connected > 0) {
    return {
      id: "connection",
      title: "本机智能体连接",
      tone: "ok",
      status: `已连接 ${connected} 个`,
      detail: total > connected ? `另有 ${total - connected} 个实例尚未连接。` : "可继续检查运行和消息状态。",
    };
  }
  return {
    id: "connection",
    title: "本机智能体连接",
    tone: total > 0 ? "warn" : "error",
    status: total > 0 ? "尚未连接" : "未发现实例",
    detail: total > 0 ? "已发现本机实例，但尚未建立可管理的连接。" : "尚未发现可管理的 Hermes 或 OpenClaw 实例。",
    action: { label: "继续设置", to: "/setup" },
  };
}

function nativeModelReadiness(models: DiscoveredLlmConfigView[] | null): ReadinessItem {
  if (models === null) {
    return {
      id: "native-model",
      title: "Hermes 原生模型",
      tone: "idle",
      status: "正在确认",
      detail: "正在只读检查 Hermes 的 config.yaml 和 .env。",
    };
  }
  const configured = models.filter((model) => !model.runtimeObserved);
  const observed = models.filter((model) => model.runtimeObserved);
  if (configured.length > 0) {
    return {
      id: "native-model",
      title: "Hermes 原生模型",
      tone: "ok",
      status: `已发现 ${configured.length} 项配置`,
      detail: "用于 Hermes 自己的对话或原生运行；管家不会覆盖它。",
    };
  }
  if (observed.length > 0) {
    return {
      id: "native-model",
      title: "Hermes 原生模型",
      tone: "ok",
      status: `已观察到 ${observed.length} 个运行模型`,
      detail: "从 Hermes 运行日志观测到模型标识；不会读取、导入或覆盖凭据配置。",
    };
  }
  return {
    id: "native-model",
    title: "Hermes 原生模型",
    tone: "warn",
    status: "尚未发现配置",
    detail: "这不影响连接检查；但 Hermes 自己对话前仍需在 config.yaml 或 .env 中配置模型。",
    action: { label: "查看说明", to: "/setup" },
  };
}

function managedModelReadiness(status: LlmStatusView | null): ReadinessItem {
  if (status === null) {
    return {
      id: "managed-model",
      title: "管家受管任务模型",
      tone: "idle",
      status: "正在确认",
      detail: "正在读取加密凭据、探针和绑定状态。",
    };
  }
  if (!status.vault.available) {
    return {
      id: "managed-model",
      title: "管家受管任务模型",
      tone: "error",
      status: "凭据库未配置",
      detail: "管家不会保存或注入 API Key，诊断和受管任务无法使用模型。",
      action: { label: "打开安全设置", to: "/settings" },
    };
  }
  if (status.ready) {
    return {
      id: "managed-model",
      title: "管家受管任务模型",
      tone: "ok",
      status: "已通过探针并绑定",
      detail: `已有 ${status.activeBindings} 个有效绑定，可用于受管的诊断和进化任务。`,
    };
  }
  if (status.activeProfiles === 0) {
    return {
      id: "managed-model",
      title: "管家受管任务模型",
      tone: "warn",
      status: "还没有通过探针的模型",
      detail: "这不会覆盖 Hermes 原生模型；添加并验证一个模型后，管家才能执行受管任务。",
      action: { label: "添加受管模型", to: "/setup" },
    };
  }
  return {
    id: "managed-model",
    title: "管家受管任务模型",
    tone: "warn",
    status: "模型尚未绑定",
    detail: "已有通过探针的模型，但还没有绑定到实例、框架或具体任务。",
    action: { label: "完成绑定", to: "/setup" },
  };
}

export function buildLocalReadiness(
  connections: ConnectionsPayload | null,
  llmStatus: LlmStatusView | null,
  discoveredModels: DiscoveredLlmConfigView[] | null,
): LocalReadiness {
  const items = [
    connectionReadiness(connections),
    nativeModelReadiness(discoveredModels),
    managedModelReadiness(llmStatus),
  ];
  const blockingItem = items.find((item) => item.tone === "error") ?? items.find((item) => item.tone === "warn");
  const pending = items.some((item) => item.tone === "idle");

  if (blockingItem !== undefined) {
    return {
      ready: false,
      summary: blockingItem.id === "connection" ? "先完成本机智能体连接" : "还有一项运行准备待完成",
      detail: `下一步：${blockingItem.title}${blockingItem.status ? `（${blockingItem.status}）` : ""}。`,
      items,
      nextAction: blockingItem.action,
    };
  }
  if (pending) {
    return {
      ready: false,
      summary: "正在确认本机运行条件",
      detail: "连接与两类模型会分别显示，避免把一项配置误判为全部就绪。",
      items,
    };
  }
  return {
    ready: true,
    summary: "本机已具备运行条件",
    detail: "智能体已连接；Hermes 原生模型与管家受管任务模型均已确认。",
    items,
  };
}
