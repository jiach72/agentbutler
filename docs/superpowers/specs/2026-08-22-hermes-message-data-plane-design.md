# Hermes 消息数据面接管设计

- 日期：2026-08-22
- 状态：用户已于 2026-08-22 确认，进入实施
- 适用项目：Agent Butler V1 / WSL Hermes
- 目标实例：`/home/jiach/.hermes/hermes-agent`

## 1. 决策摘要

本设计采用已经确认的方案：**适配器实例统一包装 + 严格接管 + WSL 本地 SQLite 持久 Outbox**。

```text
Hermes adapter.send() / API response finalizer
  → Hermes Butler Bridge 捕获并持久化
  → WSL SQLite Outbox
  → transport class
      ├─ queued-push → Butler 策略管线 → Bridge /deliver → 原生 send()
      └─ inline-response → Bridge 有效策略快照 → 原生响应路径
```

严格接管的含义是**不存在未被 Bridge 捕获、持久化和审计的原生旁路**，而不是把所有协议都强制改造成延迟队列。微信等异步推送在 Butler 不在线时必须等待；API Server 和 A2A 的请求/响应通道先落盘并执行 Bridge 中缓存的、由 Butler 下发的版本化策略快照，然后走低延迟内联响应。普通入站消息不因 Butler 暂时离线而阻断 Hermes；桥接层仍记录关联信息，并把原始消息交给 Hermes。

该设计以当前真实源码为准，而不是机械服从 PRD 或旧 Trae 规格。旧规格中“Hermes 无 L3 出站扩展点，因此 messaging 固定 not-implemented”的结论被本设计取代。Hermes 没有官方稳定的 L3 插件接口，但真实出站路径广泛汇聚到已创建的 adapter 实例，因而可以通过受管补丁安装实例包装器，并以运行时覆盖探针决定能力是否生效。

## 2. 范围

### 2.1 本阶段交付

1. Hermes 全量业务消息出口接管。
2. 任务消息聚合简报。
3. 免打扰策略。
4. AIMD 动态配速。
5. 任务生命周期订阅。
6. 通道预热。
7. 入站消息、指令、任务、出站消息的双向关联。
8. Butler UI 中可观察、可配置、可审计的消息网关页面，视觉样式遵循 PRD 的浅色产品原型，不保留黑底占位页。
9. 消息网关闭环后，给出 M5 提示词优化的独立实施方法。

### 2.2 明确不在消息热路径中实现

- 不用 LLM 改写每一条出站消息。消息优化采用确定性的聚合、去重、优先级、拆分、附件预算和配速规则。
- 不在本阶段自动改写 Hermes 系统提示词、技能提示词或用户提示词。
- 不把 Butler 变成通用消息平台，也不重写 Hermes 的各平台适配器。
- 不承诺所有外部平台都具备可证明的远端 exactly-once 语义；本设计保证 Butler 不主动重复投递，并对无法确认的崩溃窗口停止自动重发。

## 3. 已核验的真实约束

### 3.1 Hermes

- 真实代码：`/home/jiach/.hermes/hermes-agent`。
- 真实服务：`hermes-gateway.service`。
- 当前启用平台：Weixin、A2A、API Server。
- 适配器基类入口：`gateway/platforms/base.py::BasePlatformAdapter.send()`。
- 微信入站入口：`gateway/platforms/weixin.py::_process_message()`，最终进入 `handle_message(event)`。
- 任务主路径：`gateway/run.py::_run_agent_inner()`、`TurnRunner.progress_callback()`、`TurnContext.process_task_id`。
- Hermes 当前的 process `task_id` 通常等于 session id，不是每轮唯一标识；Bridge 必须生成独立 `runId`。
- API Server 的 HTTP 请求/响应不使用其 adapter `send()`，需要在 JSON/SSE 最终响应边界单独接入；A2A 的任务回复使用 `adapter.send()` 解析等待方，但不能误套微信节流。
- 微信现有末端保护保留，真实参数基线为 `30 / 30 / 1 / 2000`，不由 AIMD 绕过。

### 3.2 Butler

- `packages/contract/src/messaging.ts` 目前只有接口定义。
- Hermes manifest 当前仍声明 L2，`capability-scan.ts` 把 messaging 固定为 `not-implemented`。
- `apps/gateway` 目前只有 Butler 自身告警队列，不是业务消息 Outbox。
- 业务消息需要独立数据表、状态机、策略管线、投递循环和 UI，不复用告警队列表来伪装完成。

## 4. 总体架构

### 4.1 Hermes Butler Bridge

Bridge 是安装到 Hermes 运行环境中的小型 Python 模块，职责只有四类：

1. 包装已创建的 adapter 实例，捕获出站和入站事件。
2. 在返回 Hermes 调用方之前，把出站消息提交到本地 SQLite。
3. 暴露只监听本机的 Bridge HTTP API，供 Butler 读取事件、写入策略裁决和触发原生投递。
4. 保存原生 bound method；queued-push 通过 `/deliver` 调用，inline-response 在当前请求中调用，二者都避免再次进入包装器形成递归。

包装发生在实例层，不修改所有 adapter 子类的实现。安装器保存每个实例的原生 `send` 引用，并为新建或重连的实例重复执行幂等 attach。重复 attach 不得形成多层包装。

为了兼容 Hermes 的进度消息编辑行为，Bridge 同时管理 synthetic message id：

- 捕获成功后向 Hermes 返回 `butler:<messageId>`。
- 对尚未投递的 synthetic id，`edit_message` 更新同一 Outbox 行，而不是创建新平台消息。
- 已投递消息保存 `providerMessageId` 映射；后续编辑通过受管原生 edit 路径执行。
- 任务进度优先转化为 TaskEvent 并聚合，不让高频 edit 直接冲击平台。

安装后的严格模式必须通过覆盖探针：至少验证最终回复、进度消息、失败通知、附件消息，以及启用平台的直接发送路径。探针未覆盖的 adapter 不得标记 messaging=`ok`，应为 `degraded` 并在 UI 明示旁路风险。

### 4.2 WSL SQLite Outbox

Outbox 位于 WSL Linux 文件系统，默认路径：

```text
/home/jiach/.hermes/agent-butler/outbox.sqlite
```

不放在 `/mnt/c`，避免跨文件系统 SQLite 锁和 fsync 语义差异。数据库启用 WAL、foreign keys、busy timeout，并使用短事务。

Outbox 是消息生命周期的权威来源。Butler 可以在自己的状态库保存指标和 UI 投影，但不得以 Windows 侧副本取代 WSL Outbox 的投递真相。这样即使 Butler 或 Windows 侧服务停止，Hermes 已捕获的消息仍保留在源机器上。

### 4.3 Butler 消息策略管线

queued-push 管线按固定顺序执行：

```text
校验与幂等
  → 消息分类与任务关联
  → 进度聚合/去重
  → 免打扰裁决
  → 通道预热检查
  → AIMD 与平台末端约束
  → 投递计划
  → /deliver
  → 结果与指标回写
```

任何策略异常都不能降级为无策略原生直发。queued-push 进入 `policy_error`，展示原因并允许修复后重算；inline-response 返回明确的可重试协议错误。

策略配置以带版本和 hash 的快照同步到 Bridge。这样 API Server/A2A 的低延迟响应不需要每次跨 Windows/WSL 请求 Butler，也不会在 Butler 离线时退化成无策略旁路。Bridge 没有有效策略快照或 Outbox 不可写时，内联响应返回明确的可重试错误，而不是绕过接管。

### 4.4 Hermes Messaging Adapter

`packages/adapters/hermes` 新增 Bridge client，并实现实际的 MessagingAdapter。能力不再由硬编码结论决定，而由以下事实共同决定：

- Bridge 版本与协议握手通过。
- 实例 attach 成功。
- 启用平台覆盖探针通过。
- Outbox 可写。
- `/deliver` 能调用保存的原生方法。

全部通过时 manifest/effective capability 为 L3 messaging=`ok`；部分通过为 `degraded`；未安装仍为 `not-implemented`。

### 4.5 两类投递语义

`queued-push` 用于 Weixin、后台通知和没有同步等待方的消息：捕获后由 Butler 决定 DND、聚合、预热和 AIMD，再调用 `/deliver`。Butler 离线时只排队，不原生直发。

`inline-response` 用于 API Server 请求/响应、API 流的最终结果，以及 A2A 正在等待的任务回复：Bridge 先提交 Outbox 事务，按本地有效策略快照做确定性裁决，再立即调用原生响应路径。该类消息是 solicited reply，不应用免打扰或微信最小间隔，但仍记录 run、正文 hash、完成状态和时延。SSE token/chunk 是同一响应的传输片段，不各自视为独立业务消息；Bridge 记录流开始、任务事件和最终组装结果。

A2A 的主动 callback/push 若没有同步等待方，则按 `queued-push` 处理。Bridge 必须根据 A2A pending waiter/task registry 分类，不能只根据 adapter 名称猜测。

## 5. 标识与关联模型

### 5.1 标识

- `messageId`：Bridge 捕获时生成的 UUIDv7，整个生命周期不变。
- `runId`：每次 `_run_agent_inner` 调用生成的 UUIDv7，不能复用 Hermes session id。
- `sessionId`：Hermes 原始会话标识，可跨多轮复用。
- `inboundMessageId`：平台原始入站 id；缺失时由 Bridge 生成稳定代理 id。
- `attemptId`：每次真实投递尝试生成，供审计和崩溃恢复。
- `providerMessageId`：真实平台返回的消息 id。

### 5.2 关联链

```text
platform inbound message
  ↔ inboundMessageId
  ↔ sessionId + runId
  ↔ TaskEvent sequence
  ↔ one or more outbound messageId
  ↔ providerMessageId
```

普通入站消息进入 Hermes 前，Bridge 记录 source、chat、user、thread、平台消息 id 和接收时间。`_run_agent_inner` 创建 `runId` 后补齐关联。后续进度、最终回复、失败通知均携带 `runId`。

新消息打断旧任务时，记录 `supersedesRunId`，不能仅按 session id 覆盖旧关系。UI 可从任何一条入站或出站消息反查任务，也可从任务查看触发消息和最终投递结果。

## 6. Bridge 协议

Bridge 默认监听 WSL `127.0.0.1` 上的独立端口，端口由安装器分配并写入受管配置。Windows Butler 通过 WSL localhost forwarding 访问；安装验收必须真实探测该路径，失败时改用当前 WSL 地址并显示其易变性。

协议使用版本头 `X-Butler-Bridge-Version: 1`，请求使用 bearer token。token 文件权限为 `0600`，日志和 UI 永不展示原值。

### 6.1 Bridge 提供的接口

- `GET /v1/health`：版本、实例、attach、数据库和平台覆盖状态。
- `GET /v1/outbox/changes?after=<seq>&limit=<n>`：按单调 sequence 增量读取待处理消息和任务事件。
- `POST /v1/outbox/{messageId}/decision`：写入 Butler 的策略结果、可投时间和变换轨迹。
- `POST /v1/deliver`：按 `messageId + attemptId + contentHash` 投递已存在消息；禁止提交任意新正文。
- `POST /v1/prewarm`：执行指定通道的无用户可见预热动作。
- `POST /v1/inbound/{inboundMessageId}/decision`：写入入站确定性优化或指令裁决。
- `GET /v1/tasks/{runId}`：返回任务事件及关联消息，用于重建 Butler 投影。

### 6.2 Butler Gateway 提供的接口

- `POST /internal/hermes/outbound`：Bridge 主动通知有新消息；重复 messageId 返回 deduped。
- `POST /internal/hermes/task-event`：接收任务事件。
- `POST /internal/hermes/inbound`：接收入站关联并返回快速确定性裁决。

Bridge 的主动通知只是降低延迟，不是可靠性的唯一来源。Butler 启动和周期性运行时必须通过 `changes` 接口对账，避免通知丢失。

### 6.3 负载约束

- 正文、metadata 和附件都有显式大小上限。
- metadata 只接受 JSON 安全类型和允许的路由字段；不序列化 Python 对象或密钥。
- 本地临时附件在捕获事务前复制到 `~/.hermes/agent-butler/spool/<messageId>/` 并记录 SHA-256。复制失败时捕获失败，不虚报发送成功。
- Outbox 和 spool 设置容量水位；达到硬上限时拒绝新捕获并产生本地高优先级告警，不删除未投递数据。

## 7. Outbox 数据模型

### 7.1 核心表

`outbound_messages`

| 字段 | 含义 |
|---|---|
| `message_id` | 主键，UUIDv7 |
| `sequence` | 单调递增对账序号 |
| `instance_id` / `adapter_id` / `channel` | 来源实例与通道 |
| `account_id` / `chat_id` / `thread_id` | 平台投递地址 |
| `session_id` / `run_id` / `inbound_message_id` | 任务关联 |
| `message_kind` | final、task_progress、failure、alert、system、mutation |
| `content` / `content_sha256` | 当前有效正文及校验 |
| `reply_to` / `metadata_json` | 原生路由元数据 |
| `priority` | urgent、normal、low |
| `state` | 生命周期状态 |
| `available_at` / `lease_until` | 调度和租约 |
| `attempt_count` / `last_error` | 重试信息 |
| `policy_json` / `transform_trace_json` | 策略裁决与消息优化轨迹 |
| `provider_message_id` | 真实平台 id |
| `captured_at` / `updated_at` / `delivered_at` | 时间戳 |

辅助表：

- `message_attachments`：spool 路径、原文件名、MIME、大小、SHA-256、状态。
- `delivery_attempts`：attemptId、开始/结束时间、结果、平台错误、是否限流、是否不确定。
- `task_events`：runId、严格递增 seq、kind、进度摘要、eta、时间。
- `message_correlations`：入站、run、出站、provider id 的多向索引。
- `dnd_rules`：作用域、时区、时间窗、临时暂停到期时间和来源指令。
- `channel_pacing`：当前速率、成功/拥塞窗口、冷却时间、末次发送。
- `bridge_meta`：schema version、bridge version、attach generation。

### 7.2 状态机

```text
captured
  → policy_pending
  → held_dnd ───────────────┐
  → held_pacing ────────────┤
  → ready                   │
  → absorbed                │  进度被简报吸收，终态
  → policy_error            │
                            ↓
                         delivering
                         ↙    ↓      ↘
                 retry_wait delivered delivery_unknown
                     ↓                    ↓
                   ready          manual_retry | cancelled

任意非终态 → dead_letter（达到重试/数据错误门槛）
任意非 delivering 状态 → cancelled（显式取消）
```

`delivered`、`absorbed`、`cancelled`、`dead_letter` 为终态。`delivery_unknown` 不自动重发，从而满足“重启后不主动重复”；只有平台能按稳定 id 查询确认，或用户显式批准重试，才继续。

inline-response 使用同一状态集合，但正常路径是 `captured → policy_pending → delivering → delivered`，不进入 DND/AIMD 持有状态。

## 8. 七项功能设计

### 8.1 全量消息出口接管

- attach 在 adapter 实例创建后执行，并覆盖之后的重连实例。
- 原生 bound method 存在仅进程内可见的注册表；`/deliver` 只能按已持久化 messageId 调用。
- 捕获事务成功后才向 Hermes 返回成功；Outbox 不可写时返回 `SendResult(success=False)`。
- queued-push 在 Butler 离线时不触发 passthrough；inline-response 使用 Bridge 中最近一次有效策略快照，不依赖实时 Butler RPC。
- 进度 synthetic id 的 edit 在 Outbox 内合并；已投递 edit 使用 provider id。
- API Server 在 session chat、chat completions、responses API 和 SSE 最终化边界接入统一 helper；覆盖探针必须验证非流式和流式结果都被记录。
- A2A 的 pending waiter 回复内联交付，主动 push/callback 单独进入排队语义。
- 安装器运行覆盖测试，未证明的直接媒体或特殊通知路径必须列为 degraded，不能宣称“全量”。

### 8.2 任务消息聚合简报

- `TurnRunner.progress_callback` 产生结构化 TaskEvent，不直接把每个工具事件变成用户消息。
- 聚合键为 `instance + channel + chat + runId`。
- 同一窗口内只维护一个未投递简报，后续事件更新其正文和 ETA。
- 默认使用确定性模板，不调用 LLM；模板展示已完成步骤、当前步骤、失败项和预计剩余时间。
- 最终回复优先于进度简报。最终回复进入队列时，尚未投递的低价值进度简报变为 `absorbed`；若任务很长且简报有独立价值，可在最终回复前保留一条收尾摘要。
- 失败事件生成 urgent 消息，可绕过免打扰，并包含 runId 短标识用于追查。

### 8.3 免打扰

- 支持全局、通道、会话三层规则，越具体的规则优先。
- 支持固定日程与“暂停推送 N 分钟/小时”的临时规则，全部保存时区。
- urgent 和 failure 可绕过；普通后台任务结果进入 `held_dnd`。
- 用户刚发送消息后形成的直接应答属于 solicited reply，不按后台推送处理，可立即返回。这样免打扰不会让用户在主动会话中看似“机器人失联”。
- 免打扰结束后不逐条倾泻积压消息：先按任务聚合，再由 AIMD 逐步恢复。

### 8.4 AIMD 动态配速

每个通道维护平台全局 lane，同时每个 chat 维护会话 lane；投递必须同时满足两层约束。

- 速率变量以 deliveries/minute 表示。
- 稳定成功窗口后执行 additive increase：`rate = min(rate + alpha, maxRate)`。
- 出现 429、平台限流错误、连接断流或 Hermes 微信熔断信号时执行 multiplicative decrease：`rate = max(rate × beta, minRate)`，并尊重 `Retry-After` 或冷却时间。
- 重启后从 SQLite 恢复 rate、拥塞历史和冷却状态，不瞬间恢复到最高速率。
- Weixin 的有效间隔始终是 `max(AIMD 计算间隔, Hermes 末端 min_send_interval)`；现有 30 秒末端保护保留。
- API Server/A2A 的 inline-response 不继承微信 30 秒下限，也不进入异步 AIMD 等待；A2A 主动 push 才使用其独立的高吞吐 AIMD lane。

alpha、beta、minRate、maxRate 是按通道配置的受控参数，UI 展示当前值、触发原因和恢复趋势，而不是只给一个模糊的“智能限流”开关。

### 8.5 任务生命周期订阅

每个 run 产生以下事件：

- `started`：`_run_agent_inner` 已认领本轮。
- `progress`：工具开始/完成或可解释的阶段变化。
- `completing`：模型执行结束，最终回复正在排队或投递。
- `done`：最终回复已真实投递，或任务无用户可见结果且已明确结束。
- `failed`：Agent 运行失败或最终消息进入不可自动恢复状态。

事件按 `(runId, seq)` 幂等，乱序到达时 Butler 重排，缺口由 Bridge 对账补齐。Hermes 的 session-scoped process task id 只作为辅助字段，不能替代 runId。

### 8.6 通道预热

预热必须是无用户可见动作，不能发送“测试消息”。

- Weixin：刷新/验证 token、context token、typing ticket 或连接状态；不绕过原生安全检查。
- API Server：健康和鉴权自检，不调用 `send()`。
- A2A：连接/会话能力探测，按其真实协议实现。
- 普通消息预热失败时延迟投递并重试；urgent 消息仍尝试一次真实投递，同时产生告警。
- 预热结果带 TTL，避免每条消息重复探测。

### 8.7 入站指令与任务双向关联

Bridge 在 `handle_message` 前记录入站，Butler 对普通文本只做快速、确定性的规范化；超时或 Butler 离线时原文继续进入 Hermes。

第一阶段内建指令只管理消息数据面，不擅自扩大到高风险任务控制：

- `/推送状态`
- `/暂停推送 2h`
- `/恢复推送`
- `/任务 <run短ID>`
- `/重试消息 <message短ID>`：仅对 `delivery_unknown`/`dead_letter` 请求二次确认，不直接重发。

指令解析结果、操作者、来源通道和目标对象全部审计。普通自然语言不因“像命令”而自动执行高风险操作。

## 9. 消息优化边界

本阶段所谓“消息优化”包括：

- 进度去重与聚合。
- 最终回复优先级。
- 超长正文摘要/附件化和附件预算。
- 免打扰后的积压合并。
- 平台格式适配。
- 失败信息结构化。
- 确定性 transform trace，可解释每一步变化。

不得默认使用 LLM 改写用户或 Agent 的最终语义。任何未来的语义改写都必须是显式开关、保留原文、可对照、可撤销，并通过 M5 的评估门槛。

## 10. 故障与恢复语义

| 故障 | 行为 |
|---|---|
| Butler 停止 | queued-push 落盘后等待；inline-response 使用最后一份有效策略快照继续低延迟响应 |
| Bridge HTTP 暂时不可达 | Outbox 仍在；Butler 重连后按 sequence 对账 |
| Outbox 不可写/磁盘满 | 捕获失败并返回 Hermes 失败；不假装已发送 |
| 策略异常 | `policy_error`，不旁路 |
| Hermes 停止 | Butler 保留投影；Bridge 恢复后继续按 Outbox 状态处理 |
| 平台限流 | AIMD 降速并进入冷却 |
| 原生 send 明确失败 | `retry_wait`，按分类重试 |
| send 结果不确定 | `delivery_unknown`，不自动重发 |
| 附件源文件即将消失 | 捕获前复制到 spool；复制失败则拒绝捕获 |
| Bridge/Butler 版本不兼容 | attach 拒绝，能力标记 degraded/not-implemented |

远端发送存在不可消除的崩溃窗口：平台已经接受消息，但本地尚未提交 `delivered`。对支持稳定客户端 id 的通道使用 `messageId` 派生的 client id；对无法查询或去重的通道进入 `delivery_unknown`，选择“不自动重复”而不是盲目重发。

## 11. 安全、权限与审计

- Bridge 和 Butler 管理接口只监听本机。
- bearer token 存在权限 `0600` 的文件中，并支持轮换。
- `/deliver` 只能投递 Outbox 中已存在且 hash 匹配的消息，不能成为任意发信接口。
- 请求限制 body size、速率、时间偏差和 nonce 重放。
- metadata 做 allowlist；密钥、token、完整环境变量不得进入 Outbox、UI 或日志。
- 指令、策略变更、手工重试、旁路检测、安装、卸载和服务重启都写追加式审计。
- 对真实 Hermes 写入前必须快照，补丁失败自动恢复文件；不得使用旧的 `rb-restart`，实际重启目标为 `hermes-gateway.service`。

## 12. 安装、补丁与升级

### 12.1 受管安装

安装器执行：

1. 校验 Hermes 根目录、版本、当前 SHA 和运行服务。
2. 快照受影响文件、Bridge 配置和数据库 schema。
3. 安装独立 `gateway/butler_bridge/` 模块。
4. 以最小语义锚点补丁接入 adapter attach、run 生命周期和稳定 client id。
5. 写入 systemd user drop-in 和权限 `0600` 的环境文件。
6. 运行 Python 编译、Bridge 单测和补丁覆盖探针。
7. 使用 `systemctl --user restart hermes-gateway.service` 重启。
8. 验证 Bridge、Hermes API、已启用平台和 Butler UI。

### 12.2 升级重打

补丁注册表记录原版本、目标文件、锚点、前后 hash 和验证命令。Hermes 升级后先执行 `--check`；锚点冲突时停止，不在未知源码上强行套补丁。恢复原文件后 messaging 能力回到 not-implemented/degraded，不能继续显示“已接管”。

## 13. UI 与可观察性

消息网关页使用 PRD 的浅色原型体系，并展示真实数据：

- Bridge/Outbox/投递链路状态。
- 当前 queued、held_dnd、held_pacing、delivery_unknown、dead_letter 数量。
- Weixin、A2A、API Server 各自的 attach、预热和速率状态。
- 当前免打扰规则与下一次释放时间。
- AIMD 当前 rate、最近拥塞原因和末端最小间隔。
- 活跃任务、聚合简报、入站触发消息和最终投递结果。
- 单条消息的 transform trace、attempt 历史和可审计手工动作。

页面不得用静态演示数字冒充真实状态。Bridge 未安装、Hermes 不在线或数据尚未产生时，要显示明确空状态和下一步，而不是黑屏或无解释的空表。

## 14. 测试与真实验收

### 14.1 自动测试

- Python：实例 attach 幂等、原生方法保存、SQLite 事务、synthetic edit、附件 spool、Bridge 鉴权、崩溃恢复。
- TypeScript：策略顺序、DND 优先级、solicited reply、进度聚合、AIMD 增减、通道隔离、幂等、对账。
- 合同测试：Bridge v1 envelope、状态转换、错误码、旧/新版本兼容拒绝。
- 故障注入：Butler 停止、Hermes 重启、磁盘满、429、超时、send 结果不确定、重复通知、乱序 TaskEvent。
- UI：真实 API 数据、空状态、错误态、配置保存、手工重试确认。

### 14.2 真实 WSL 验收

1. 启动 Butler 开发服务并确认 UI 可实时刷新。
2. 安装 Bridge 后验证 Hermes capability 从固定 not-implemented 变为基于探针的真实状态。
3. 停止 Butler，触发一条 Hermes 出站消息，确认只进入 WSL Outbox、真实通道未收到；恢复 Butler 后按策略投递一次。
4. 在消息处于 ready/delivering 的不同时间点重启 Hermes 和 Butler，确认不发生 Butler 主动重复；不确定状态必须停在 `delivery_unknown`。
5. 运行长任务，确认高频工具事件变成少量简报，最终回复优先。
6. 验证免打扰、主动会话直接应答、到期聚合释放和 urgent/failed 绕过。
7. 制造可控限流信号，观察 AIMD 降速和稳定恢复；确认微信末端 30 秒保护仍生效。
8. 验证 API Server 非流式、SSE 最终结果和 A2A pending waiter 回复均先落盘且没有被套用微信 30 秒间隔；A2A 主动 push 仍可独立限流。
9. 验证入站消息可反查 run 和出站结果，指令动作有审计记录。
10. 用真实已启用通道做最终受控发送验收，保存 messageId、attemptId、providerMessageId 和时间证据。

只有上述真实路径通过后，才可以回答“消息网关正常工作”或“功能已全部实现”。单元测试、页面截图或 manifest 声明都不能替代真实验收。

## 15. M5 提示词优化实施方法与边界

M5 是消息数据面完成后的独立工作流，不嵌入每条消息的发送路径。实施顺序为：

1. 盘点 Hermes 系统提示词、channel prompt、技能提示词和命令模板，建立来源与版本索引。
2. 建立代表真实任务的 baseline 评估集，区分功能正确性、安全性、格式、成本和时延。
3. 优化器只生成候选 diff，不直接覆盖当前提示词。
4. 先跑静态门禁：危险指令、密钥泄漏、权限扩大、格式冲突和长度预算。
5. 在 holdout 上对比 baseline；样本不足时拒绝自动结论。
6. UI 展示原文、候选、逐项指标、风险和回滚点，由用户批准后才能应用。
7. 小流量 canary，持续比较失败率、用户纠正率、工具误调用和 token 成本。
8. 指标恶化或用户撤销时原子回滚，保留完整台账。

消息数据面为 M5 提供可观测的任务、消息和结果关联，但二者不共享自动写权限。M5 不能通过“优化消息”的名义绕过评估守门员。

## 16. 实施切片建议

后续实施计划应拆成可独立验证的切片：

1. Bridge 协议、Outbox schema 与纯本地测试。
2. Hermes adapter attach、严格捕获与 synthetic edit。
3. Butler Bridge client、对账和基础投递。
4. runId/TaskEvent/双向关联。
5. 聚合、DND、AIMD、预热策略。
6. PRD 风格 UI 与真实数据接入。
7. WSL 故障注入和真实通道验收。
8. M5 提示词优化独立规格与实施计划。

每个切片都必须保持仓库可测试，并在触及真实 Hermes 前生成可恢复快照。
