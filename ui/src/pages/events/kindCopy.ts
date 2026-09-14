/**
 * 事件类型（kind）的人话文案表：中文标签 + 一句话解释 + 处理建议。
 *
 * 来源：apps/watch/src/ 各产出点（log-analyzer.ts 的 RULES、action-audit.ts、
 * approvals.ts、budget.ts、canary.ts、killswitch.ts、trust-events.ts、watch.ts、
 * evolution.ts、progress-integrity.ts、weekly-report.ts、session-index.ts）。
 * `what` 描述这个事件在本系统里的真实语义，`action` 说清通常要不要处理、怎么处理。
 * 未命中的 kind 回退到原始 kind + 通用说明，绝不渲染空白。
 */

export interface EventKindCopy {
  /** 中文标签（列表行与详情区展示用）。 */
  label: string;
  /** 一句话解释：这是什么。 */
  what: string;
  /** 处理建议：通常要不要处理、怎么处理。 */
  action: string;
}

export const EVENT_KIND_COPY: Record<string, EventKindCopy> = {
  // ── 动作审计（action-audit.ts）───────────────────────────────
  "file-delete": {
    label: "删除文件",
    what: "智能体删除了文件，或请求删除文件。",
    action: "如果不是你让删的，先确认删了什么；误删可以从备份恢复。",
  },
  "file-write": {
    label: "写入文件",
    what: "智能体创建或修改了文件。",
    action: "一般是正常工作记录，除非改了不该改的文件才需要处理。",
  },
  "message-send": {
    label: "外发消息",
    what: "有消息要发到智能体之外（微信、Telegram 等渠道）。",
    action: "涉及数据离开本机。不确定内容时先看证据链里的收件方。",
  },
  "shell-exec": {
    label: "执行命令",
    what: "智能体在本机执行了 shell 命令。",
    action: "高危动作。看看执行的是什么命令，不明来路的先拒绝。",
  },
  "web-fetch": {
    label: "抓取网页",
    what: "智能体访问了外部网页。",
    action: "一般是查资料，正常记录；陌生地址频繁出现再留意。",
  },
  "api-call": {
    label: "调用接口",
    what: "智能体调用了外部服务的接口。",
    action: "正常记录；若不是你配置过的服务，检查一下配置有没有被动过。",
  },

  // ── 操作审批（approvals.ts）──────────────────────────────────
  "action-approval": {
    label: "操作审批",
    what: "高危动作等你批准或拒绝，15 分钟不处理按拒绝算。",
    action: "去「记录与审批」处理；确认没问题就批准，可疑就拒绝。",
  },
  "action-blocked": {
    label: "动作已拦截",
    what: "高危动作被拒绝了（你拒绝的，或超时自动拦截）。",
    action: "拦截是保护行为。如果其实是误拦，重新发起并批准即可。",
  },

  // ── 指纹与升级（trust-events.ts / alert-forward.ts）──────────
  fingerprint: {
    label: "重复错误指纹",
    what: "同一类错误反复出现，被指纹系统归成了一条。",
    action: "建议处理：同类错误反复出现说明问题没根治。",
  },
  "version-change": {
    label: "版本变化",
    what: "Hermes 网关的版本号发生了变化（升级或回滚）。",
    action: "升级后 48 小时内多留意事件中心；异常变多可考虑回滚。",
  },
  "upgrade-regression-suspect": {
    label: "疑似升级回归",
    what: "升级之后，之前已经解决的问题又出现了。",
    action: "建议处理：优先排查，必要时回滚到上一个版本。",
  },

  // ── 日志分析（log-analyzer.ts RULES，detail 即官方处理建议）──
  "llm-billing": {
    label: "模型账户余额不足",
    what: "模型服务返回余额不足（HTTP 402）。",
    action: "建议处理：充值或切换备用模型。重启服务解决不了余额问题。",
  },
  "llm-auth": {
    label: "模型凭据失效",
    what: "模型端点拒绝鉴权（401/403 或 Key 无效）。",
    action: "建议处理：检查 API Key 是否过期，设置页可轮换 Key。",
  },
  "llm-route": {
    label: "模型端点配置错误",
    what: "模型接口返回 404，多为端点地址或模型名写错。",
    action: "建议处理：核对 Base URL、接口路径和模型名。",
  },
  "config-error": {
    label: "配置解析失败",
    what: "Hermes 的配置文件或环境变量无法解析。",
    action: "建议处理：修复 YAML 或变量写法。管家不会自动改你的配置。",
  },
  "tool-failure": {
    label: "技能工具调用失败",
    what: "某个技能的工具调用报错了。",
    action: "看证据链里的日志示例定位是哪个技能，再决定修或禁用。",
  },
  "trajectory-interrupted": {
    label: "执行轨迹中断",
    what: "智能体的任务执行到一半被中断了。",
    action: "偶发一次可以忽略；反复出现需要排查。",
  },
  "quality-loop": {
    label: "输出质量反复修正",
    what: "智能体的输出质量不达标，反复返工。",
    action: "建议去提示词优化页生成改进候选，做成对评估。",
  },
  "rate-limit": {
    label: "消息限流",
    what: "微信 / iLink 等消息通道发送太快被平台限流。",
    action: "重连消息通道可恢复；反复出现说明节流配置要调。",
  },
  "network-timeout": {
    label: "网络超时",
    what: "连接外部服务超时（消息通道、API 或模型端点）。",
    action: "多为瞬时故障，重连即可；频繁出现检查网络。",
  },
  "connection-reset": {
    label: "连接被重置",
    what: "对方主动断开了连接，常见于双开抢占账号或网络抖动。",
    action: "清理残留进程并重连可恢复。",
  },
  "port-conflict": {
    label: "端口被占用",
    what: "服务启动失败，端口已被别的进程占着。",
    action: "建议处理：管家会先清理残留进程再重启。",
  },
  "gateway-crash": {
    label: "消息网关启动失败",
    what: "消息网关多次拒绝启动或反复崩溃。",
    action: "建议处理：管家会清理并重启，之后自动复验通道。",
  },
  oom: {
    label: "内存不足",
    what: "进程内存耗尽，被系统杀掉了。",
    action: "重启可临时恢复；反复出现检查模型端点的并发设置。",
  },
  dependency: {
    label: "依赖缺失",
    what: "代码依赖没有安装或导入失败。",
    action: "建议处理：按提示手动补装依赖。管家不会自动装。",
  },
  "disk-space": {
    label: "磁盘空间不足",
    what: "磁盘满了，写文件失败。",
    action: "建议处理：清理磁盘。管家不会自动删你的数据。",
  },
  "generic-error": {
    label: "系统错误",
    what: "日志里出现了没归类的错误。",
    action: "管家可尝试重启恢复；反复出现要看原始日志。",
  },

  // ── 进度可信（progress-integrity.ts）─────────────────────────
  "progress-untrusted": {
    label: "进度汇报不可信",
    what: "智能体自称的完成度跟实际证据对不上。",
    action: "建议处理：以事件里的证据为准，不要采信口头汇报。",
  },
  "progress-integrity": {
    label: "进度完整性异常",
    what: "进度数据的完整性校验没通过。",
    action: "建议处理：核对实际产出，防止「假完成」。",
  },
  "unverified-completion": {
    label: "未经验证的完成",
    what: "智能体宣称任务完成，但缺少可验证的产出。",
    action: "建议处理：人工核对结果后再结案。",
  },

  // ── 预算（budget.ts）────────────────────────────────────────
  budget: {
    label: "用量预算",
    what: "模型用量或花费的预算记录。",
    action: "信息性记录，一般不用处理。",
  },
  "budget-threshold": {
    label: "预算告警",
    what: "花费或用量越过了你设的预算线。",
    action: "建议处理：确认花费是否符合预期，必要时调预算或换模型。",
  },

  // ── 金丝雀发布（canary.ts）──────────────────────────────────
  canary: {
    label: "灰度验证",
    what: "升级后的灰度验证过程记录（观察期指标采样）。",
    action: "信息性记录；出现异常指标才需要处理。",
  },
  "canary-rollback": {
    label: "灰度回滚",
    what: "灰度验证不达标，已自动回滚到旧版本。",
    action: "回滚是自动保护。建议确认失败原因后再升级。",
  },

  // ── 急停（killswitch.ts）────────────────────────────────────
  killswitch: {
    label: "急停已触发",
    what: "紧急开关被按下，所有智能体实例已被停止。",
    action: "确认原因后，到顶栏解除急停恢复运行。",
  },
  "killswitch-release": {
    label: "急停已解除",
    what: "紧急开关解除，实例恢复运行。",
    action: "信息性记录。",
  },

  // ── 配置与依赖（watch.ts）───────────────────────────────────
  "config-invariant": {
    label: "配置约束被破坏",
    what: "某条安全配置约束不再成立（例如端口绑定范围被改动）。",
    action: "建议处理：按事件说明恢复配置，管家不会自动改回。",
  },
  "external-dependency": {
    label: "外部依赖异常",
    what: "管家依赖的外部服务探活失败。",
    action: "建议处理：检查对应服务是否在运行。",
  },
  "critical-memory-probe": {
    label: "记忆探针异常",
    what: "记忆系统的写入或读取探针失败。",
    action: "建议处理：影响智能体的记忆能力，优先排查。",
  },

  // ── 自我进化（evolution.ts）─────────────────────────────────
  "evolution-regression": {
    label: "进化候选被拦截",
    what: "自我进化产生的候选没有通过守门器评估，被拦下了。",
    action: "拦截是守门器在保护 baseline，一般不用处理。",
  },
  "evolution-run-failed": {
    label: "进化任务失败",
    what: "自我进化进程未能启动或中途失败。",
    action: "看事件详情里的失败原因；配置问题先修配置。",
  },
  "evolution-preflight-blocked": {
    label: "进化前置检查未通过",
    what: "进化开始前的安全检查没过，任务被阻止。",
    action: "按提示补齐前置条件后再试。",
  },
  "evolution-config-blocked": {
    label: "配置错误阻断进化",
    what: "配置有错，进化功能被整体阻断。",
    action: "建议处理：先修配置错误，进化会自动恢复。",
  },

  // ── 周报（weekly-report.ts）─────────────────────────────────
  "weekly-report": {
    label: "周报",
    what: "每周自动生成的运行情况汇总。",
    action: "信息性记录，闲时看看即可。",
  },
};

/** 未命中 kind 的兜底：原始 kind + 通用说明，不渲染空白。 */
export function eventKindCopy(kind: string): EventKindCopy {
  const hit = EVENT_KIND_COPY[kind];
  if (hit !== undefined) return hit;
  return {
    label: kind,
    what: "管家记录的一类信号，暂无详细说明。",
    action: "看标题与证据链判断；拿不准可以贴给维护者。",
  };
}
