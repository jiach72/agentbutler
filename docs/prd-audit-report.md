# Agent Butler PRD 符合性审计报告

> 审计对象：`C:\Users\jiach\Documents\Agent Butler`
>
> 需求基线：`docs/agent-butler-prd.html`，PRD V1.7；文本定位基线为 `.workbuddy/prd-text.txt`
>
> 审计日期：2026-08-23
>
> 审计类型：静态代码审计、契约与数据模型核对、测试结果复核、桌面/移动端 UI 实测

## 1. 执行摘要

### 1.1 发布结论

**结论：V1 不符合，当前为 No-Go。**

V1/P0 的主体代码并非空壳：M1 巡检和三类探针、M2 升级五步与回滚、M3 Hermes 节流补丁、M4 holdout 门槛与扩集、M6 只读资产列表、M7 备份与审计均已有可识别实现。然而，交付链路、架构边界和关键守门语义存在发布阻断：

1. 宿主和 Docker 两种交付形态都不能按仓库提供的正式入口启动三服务。
2. Hermes 被申报为 L3 并进入消息接管路径，直接违反 PRD 明确的 Hermes L2 上限与“补丁管理 + 观察模式”结论。
3. 接管路径没有“管家失效时原生消息照发”的逃生门，Bridge 也没有依赖安装、部署接线或可用的容器拓扑。
4. M4 只返回 `allowWrite`，没有包围任何技能产物写入/替换路径，不能保证负优化“不落盘”。
5. 五条真实 V1 验收中没有一条具备完整的真实环境通过证据；第 4 条仅在代码层具备较完整闭环。

### 1.2 范围结论

| 范围 | 审计结论 | 说明 |
|---|---|---|
| V1/P0 | **不符合** | 交付、Hermes 能力等级、M4 强制守门和 10 分钟修复验收存在硬缺口 |
| P1 | **部分提前实现，但边界混乱** | 消息接管、M5、M6 写操作等提前进入主干，部分实现与 PRD 参数或安全纪律不一致 |
| P2/V1.5 | **大部分未实现** | OpenClaw 适配器、移动端适配、沙箱、蓝绿、迁移向导均未产品闭环；这不应判为 V1 缺陷 |
| 明确不做项 | **存在冲突** | 当前 Hermes Bridge 实质进入消息路径，与“不重写通道适配器”和 Hermes 无 L3 的边界冲突 |

### 1.3 严重度统计

| 等级 | 数量 | 处理口径 |
|---|---:|---|
| 阻断 | 4 | V1 发布前必须关闭 |
| 高 | 5 | 发布前修复或明确移出 V1 可执行面 |
| 中 | 7 | 本轮收敛或列入有负责人、有验收的后续版本 |
| 低 | 3 | 不阻断发布，但应进入工程债清单 |

## 2. 审计口径与证据可信度

### 2.1 PRD 口径

- V1/P0 权威范围：`.workbuddy/prd-text.txt:861-900`。
- P1/P2/V1.5：`.workbuddy/prd-text.txt:901-912`。
- 五条真实验收：`.workbuddy/prd-text.txt:913-915`。
- V1 契约消费面：`.workbuddy/prd-text.txt:971`、`.workbuddy/prd-text.txt:897-900`。
- Hermes 能力上限：`.workbuddy/prd-text.txt:1450-1455` 明确 `declaredLevel=L2`，无 L3 出站扩展点。
- 本报告严格区分“V1 缺陷”和“后续愿景未实现”。P1/P2/V1.5 的缺失仅作为路线图差距，不作为 V1 发布阻断。

### 2.2 状态定义

| 状态 | 含义 |
|---|---|
| 符合 | 代码、接口和可用入口覆盖 PRD，且有相称验证证据 |
| 部分符合 | 核心结构存在，但缺少一段业务闭环、真实接线或关键验收 |
| 不符合 | 与硬约束冲突，或用户无法通过交付入口使用 |
| 延期符合 | PRD 已明确排入 P1/P2/V1.5，当前未实现不计 V1 缺陷 |
| 超范围 | 当前实现超出 V1，且带来额外复杂度、风险或产品口径冲突 |

### 2.3 证据层级

- **事实**：来自 PRD、代码、配置、测试输出和截图，可直接复核。
- **推断**：基于调用路径和部署拓扑作出的高置信度判断，均在条目中标注。
- **未验证**：需要真实 Hermes、微信通道、已知回归版本或国内新机环境才能完成。

## 3. V1/P0 需求覆盖矩阵

| PRD 项 | 优先级 | 实现与证据 | 状态 | 主要偏差 |
|---|---|---|---|---|
| W1 OpenClaw 出站前 hook spike | 风险前置 | 未发现可复核 spike 结论或产物 | **不符合** | 风险项未关闭；但它不是 V1 产品功能 |
| W1 Hermes 补丁跨相邻版本重打 spike | 风险前置 | 有补丁漂移检测和升级单测，未见两个真实相邻版本验证记录 | **部分符合** | 单测不能替代 PRD 要求的真实版本 spike |
| M2 一键安装，宿主/容器双形态，国内镜像 | P0 | 安装器有平台/网络/构建步骤，但启动指引引用不存在的 `start` 脚本；三 Dockerfile 为 placeholder | **不符合** | 用户无法从正式交付入口运行系统 |
| M2 被管实例升级五步 | P0 | `packages/adapters/hermes/src/control/upgrade-pipeline.ts` 实现预检、快照、拉取、补丁、验收与失败回滚 | **部分符合** | 配置不变式未进入预检；SQLite 快照一致性不足；真实升级验收未跑 |
| M2 快照默认 3 份 | P0 | `packages/adapters/hermes/src/control/snapshot.ts:25-27,144-148` | **符合** | M7 通用备份另有 14/24/10 份策略，应在 UI 区分“升级快照”和“日常备份” |
| M2 管家自身升级/回滚 | P0 | 有版本、快照登记、升级、回滚和健康检查 | **部分符合** | 升级前全量备份未等待完成即启动升级 |
| M1 进程 + 三类功能探针 | P0 | 七阶段巡检入口 `apps/watch/src/pipeline.ts:274-291`；记忆、通道、LLM 探针均有实现与测试 | **符合** | 真实通道 smoke 未执行 |
| M1 错误指纹、日志、修复入口 | P0 | 事件、指纹、日志分页、一键 runbook、审计链路已实现 | **符合** | 大日志 tail 有一次性读到 EOF 的性能风险 |
| M1 三条 runbook + 10 分钟 5 次熔断 | P0 | `apps/watch/src/runbook/executor.ts:368-439`；阈值 `apps/watch/src/watch.ts:462-464` | **部分符合** | 熔断状态仅内存；Settings 又把状态硬编码为通过 |
| M1 面板横幅 + 单条备用通道 | P0 | 有告警队列、转发和面板横幅 | **部分符合** | 真实备用通道与微信限流场景未跑通 |
| M1 Dashboard `/api/status` 补充信号 | P0 | 有独立 dashboard signal 探测 | **符合** | 无真实 Dashboard 联调证据 |
| M3 Hermes 补丁管理 + 观察模式 | P0 | 三条补丁默认值覆盖 45 秒、20 秒、附件预算和超长整形，见 `packages/adapters/hermes/src/patches/registry.ts:269-275,328-363` | **部分符合** | 同时引入了 PRD 明确禁止的 Hermes L3 接管，破坏产品边界 |
| M3 管家告警持久队列缓释 | P0 | `apps/gateway/src/queue.ts:59-78` 提供持久队列和重试状态 | **符合** | 与提前实现的全量消息接管代码耦合过深 |
| M4 三项预检 + 运行前快照 | P0 | `apps/watch/src/evolution.ts:500-574` | **符合** | 仅是管家侧 API，没有绑定引擎启动入口 |
| M4 holdout<10 拒绝 + 最小扩集 | P0 | 门槛 `apps/watch/src/evolution.ts:22`；扩集和自动重检 `apps/watch/src/evolution.ts:625-704` | **符合（代码层）** | 尚无真实进化引擎验收 |
| M4 回归拒绝落盘、保留 baseline | P0 | `apps/watch/src/evolution.ts:707-773` 返回判定并记台账 | **不符合** | 没有实际写路径受该门禁控制，调用方可忽略结果 |
| M6 技能/插件/记忆只读列表 | P0 | 驱动枚举、目录降级、统计、预览、健康评分和 UI 已实现 | **部分符合** | 分类和风险字段不完全符合；页面同时暴露 P1/P2 写动作 |
| M7 loopback、安全、备份、审计 | P0 | 三服务默认 loopback；日常备份优先 `VACUUM INTO`；审计表为追加接口 | **部分符合** | 容器内仍绑定 loopback 导致不可达；密钥 0600 在 Windows 无法验证 |
| M7 三条配置不变式 | P0 | 两套三规则校验实现，见 `apps/watch/src/invariants.ts:260-269`、`packages/adapters/hermes/src/control/validate-config.ts:94-133` | **部分符合** | 没有升级前强制消费，也没有文件变更后 30 秒自动复验 |
| 契约 I-1 全部 | P0 | detect、capabilityScan、logSources 有实现 | **符合** | 真实多形态探测证据仍有限 |
| 契约 I-2 全部，双执行器 | P0 | Process/Docker 控制与升级、快照、回滚、validateConfig 均存在 | **部分符合** | 默认 systemd unit 可能错误；validateConfig 未接入控制流程 |
| 契约 I-4 只读消费面 | P0 | 只读技能/插件/记忆驱动存在 | **不符合** | 写方法、物理删除和 UI 写入口已进入 V1 主路径 |
| Hermes 适配器 L0-L2 | P0 | Manifest 和运行时扫描均可提级到 L3 | **不符合** | 与 PRD 明确结论直接冲突 |

## 4. 五条 V1 验收结论

| # | 验收条款 | 结论 | 证据与原因 |
|---:|---|---|---|
| 1 | 国内新机完成宿主/容器双形态安装并接微信 | **失败** | Dockerfile 仅输出 placeholder；宿主指引引用不存在的 `start` 脚本；Bridge 无依赖安装与部署接线 |
| 2 | 1 分钟触发 30 条，按至少 45 秒配速全部送达且零限流 | **未通过** | 补丁参数存在，但真实微信 smoke 全跳过；当前 L3 `queued-push` 先返回成功、后续失败不原生透传，不能证明“全部最终送达” |
| 3 | 停记忆嵌入后 10 分钟内告警并自动修复 | **失败** | 默认巡检周期为 60 分钟：`apps/watch/src/config.ts:82,160-166`，故障可能接近 60 分钟才被下一次巡检发现 |
| 4 | holdout=2 被拒并获得扩集路径 | **代码层通过，真实验收未执行** | `MIN_HOLDOUT_COUNT=10`，拒绝结果附 `/expand`，扩集后自动重检；缺少真实引擎端到端证据 |
| 5 | 升级已知回归版本后自动回滚，数据完好，补丁重打或提示冲突 | **未通过** | 流水线和单测存在，但真实 smoke 跳过；升级快照对运行中 SQLite 主库/WAL/SHM 直接复制，不能证明数据完好 |

**V1 成立要求是五条全过。当前完整通过为 0/5，因此不能宣称 V1 已达成。**

## 5. 严重度发现

### 5.1 阻断项

#### [B-01] 正式交付物不可启动

- **事实**：`apps/watch/Dockerfile:1-6`、`apps/web/Dockerfile:1-8`、`apps/gateway/Dockerfile:1-6` 都是 placeholder，进程打印一行后退出；`docker-compose.yml:2-28` 却把它们作为正式三服务部署。
- **事实**：宿主安装器指导执行 `pnpm --filter @butler/* start`，见 `packages/installer/src/install.ts:247-257`；仓库 package scripts 中没有任何 `start`。
- **事实**：Compose 未注入 `BUTLER_WATCH_URL`、`BUTLER_GATEWAY_URL` 等服务间地址。web/watch 默认访问自身容器的 `127.0.0.1`，见 `apps/web/src/server.ts:41-45,1234-1240`、`apps/watch/src/config.ts:82-85,160-169`。
- **事实**：web/gateway 默认绑定 `127.0.0.1`，见 `apps/web/src/main.ts:8-29`、`apps/gateway/src/main.ts:10-16`；容器端口发布后仍无法从容器外访问只绑定内部 loopback 的 web。
- **影响**：直接阻断验收 1，也使其他真实验收没有稳定部署基线。
- **建议**：先完成可复制构建的镜像、非 root 运行、健康检查、服务间 DNS/env、容器内 `0.0.0.0` 绑定与宿主侧 `127.0.0.1` 端口限制；宿主形态提供真实 service/start scripts，并在全新环境做一次可重复安装记录。

#### [B-02] Hermes L3 与 PRD 硬约束直接冲突

- **事实**：`packages/adapters/hermes/manifest.json:6-13` 与 `packages/adapters/hermes/src/manifest.ts:3-13` 均声明 `declaredLevel: 3` 和 `messaging`。
- **事实**：`packages/adapters/hermes/src/capability-scan.ts:91-101` 在 Bridge 可用时把 Hermes `effectiveLevel` 提升为 3。
- **PRD**：Hermes 无出站前扩展点，V1 必须为 L2；M3 为补丁管理 + 观察模式，见 `.workbuddy/prd-text.txt:881-884,1450-1455`。
- **影响**：这不是普通“提前实现 P1”，而是推翻了 PRD 已由源码审阅关闭的技术结论；接口、UI、部署和测试都被带入错误方向。
- **建议**：V1 立即恢复 Hermes manifest/capabilityScan 为 L2，移除 `messaging` 申报和默认接管入口。若要改变 PRD，必须先提供可审阅的真实上游出站前 hook 证据、失效逃生设计和真实通道验收，再走 PRD/契约变更。

#### [B-03] 消息接管没有失效逃生门，且 Bridge 不具备可交付性

- **事实**：`packages/adapters/hermes/bridge/agent_butler_bridge/wrapper.py:273-320` 在 `queued-push` 捕获成功后立即向 Hermes 返回 success，不调用原生发送。
- **推断（高置信度）**：Gateway/Bridge 后续故障时，Hermes 已认为发送成功，消息只留在 outbox；“管家全挂时消息照发”的互不共生边界不成立。
- **事实**：Bridge 默认只监听 `127.0.0.1`，见 `packages/adapters/hermes/bridge/agent_butler_bridge/runtime.py:22-23`；Gateway 又强制 Bridge URL 必须 loopback，见 `apps/gateway/src/message/runtime.ts:288-307`。Gateway 容器无法通过自身 loopback 访问宿主 Bridge。
- **事实**：Compose/installer 没有安装或启动 Bridge，也没有注入 URL/token；Python 代码直接依赖 `aiohttp`，但仓库无 Bridge 的 `pyproject.toml`、requirements 或安装步骤。
- **影响**：消息可能被静默截留；验收 2 无法成立；容器拓扑不可用。
- **建议**：V1 不接管 Hermes 出站。未来 L3 必须采用可证明的 fail-open/fail-bypass 语义，明确 ACK 时点、原生回退、队列所有权、投递未知态和灾难恢复，并提供独立可安装 Python 包或取消 Python sidecar。

#### [B-04] M4 是建议器，不是强制守门员

- **事实**：`apps/watch/src/evolution.ts:1-7` 明确说明只做准入判定，不执行引擎或写技能。
- **事实**：`recordResult` 仅返回 `allowWrite`，见 `apps/watch/src/evolution.ts:707-773`；仓库未发现技能候选写入/替换路径被该结果包围。
- **事实**：HTTP 允许调用方直接提交 `baselineMetric`、`candidateMetric` 和 `significant`，见 `apps/watch/src/http.ts:1130-1168`；UI 由用户手填并勾选“确实更好”，见 `ui/src/pages/Evolution.tsx:491-552`。
- **影响**：调用方可忽略 `allowWrite` 或伪造指标，负优化仍可落盘；V1 核心承诺“不越改越坏”没有被技术保证。
- **建议**：把“候选产物提交/技能替换”收口为唯一内核 API：先验证 runId、快照、holdout 与指标来源，再由内核原子 promote；所有旁路写技能目录的调用必须拒绝或被审计告警。

### 5.2 高风险项

#### [H-01] 默认调度无法保证 10 分钟发现并修复

- 默认巡检 60 分钟，见 `apps/watch/src/config.ts:82,160-166`。启动时立即巡检只能覆盖启动瞬间，不能覆盖运行中任意时刻发生的嵌入停服。
- 建议将关键探针独立为不超过 5 分钟的轻量调度，确保检测、告警、runbook 全链路在 10 分钟预算内，并以故障注入测试证明最坏情况。

#### [H-02] 升级/进化快照对运行中 SQLite 做文件级热拷贝

- `packages/adapters/hermes/src/control/snapshot.ts:35-53,97-119` 直接复制 `memory_store.db`、WAL、SHM；升级流水线在停止实例之前先做快照，见 `packages/adapters/hermes/src/control/upgrade-pipeline.ts:364-400`。
- 文件复制不能保证主库与 WAL/SHM 位于同一一致性点，回滚后存在损坏或丢事务风险。
- 建议复用 M7 已采用的 SQLite online backup/`VACUUM INTO`，或短暂停写/停止服务后快照，并在登记成功前执行 `PRAGMA integrity_check`。

#### [H-03] 管家自身升级前备份存在竞态

- `apps/watch/src/self-upgrade.ts:600-641` 对 `runFull` 使用 fire-and-forget；无论备份是否完成或失败，升级任务都会立即开始。
- 建议把升级入口改为异步状态机，备份成功并校验后才进入拉取；备份失败必须中止升级并给出可操作错误。

#### [H-04] 配置不变式没有成为控制面强制条件

- `validateConfig` 只有定义和单测，生产代码无调用点；全仓除声明外未发现 `.validateConfig(...)`。
- `packages/adapters/hermes/src/control/upgrade-pipeline.ts:330-354` 的预检只检查路径、版本和 venv，没有阻止 block 级配置违例。
- PRD 要求配置变更后 30 秒内自动复验，见 `.workbuddy/prd-text.txt:1188-1190`；当前 `apps/watch/src/invariants.ts:260-284` 仅在请求 `status()` 时现算，没有 watcher/30 秒调度。
- 建议将三条规则收敛为单一来源，升级、启动、应用补丁和配置变更前统一强制调用；对面板外文件变化增加去抖监听和告警。

#### [H-05] 能力路由与 V1 只读边界未被内核执行

- `packages/core/src/router.ts:46-71` 定义了 `not-implemented` 隐藏、`unavailable` 置灰的裁决，但生产代码没有调用 `router.check` 或 `router.recordResult`。
- `packages/core/src/index.ts:78-79` 的 `core.invoke` 只进入执行器，不包含能力路由。
- 结果是 M6 写接口即使不属于 V1，也能从 UI/API 直接调用；Hermes 的错误 L3 申报也不会被第二层硬限制。
- 建议提供唯一 `invokeCapability(instance, capability, fn)`，把路由、超时、审计和降级记录合并；禁止业务模块直接调用裸 `core.invoke` 访问能力方法。

### 5.3 中风险项

#### [M-01] M6 提前暴露危险写操作，且快照失败后仍继续写

- PRD V1 仅只读，写操作在 P1/P2，见 `.workbuddy/prd-text.txt:889-892`。
- 后端暴露 archive/restore/purge/rebuild 等路由，见 `apps/watch/src/http.ts:672-735`；UI 提供相应按钮，见 `ui/src/pages/Skills.tsx:307-394`。
- `apps/watch/src/skills.ts:292-299` 捕获快照失败后只告警并“继续执行”，与“所有写动作默认执行前快照”冲突。
- `MemoryDriver.purge` 直接物理删除，见 `packages/adapters/hermes/src/drivers/memory.ts:949-1070`；PRD 契约却要求物理删除不经驱动，见 `.workbuddy/prd-text.txt:1331-1335`。
- 建议 V1 隐藏写入口。保留到 P1 时，快照失败必须 fail-closed，物理删除改为内核确认路径，并加入不可伪造的确认令牌、影响预览和审计。

#### [M-02] M6 分类展示不完全符合 V1.7

- 技能缺 `category` 时被规则推断为领域或“通用技能”，见 `packages/adapters/hermes/src/drivers/skill.ts:164-174`；PRD 要求归入“未分类”并提示补齐。
- 插件模型/UI 没有风险标记字段，见 `packages/contract/src/drivers.ts:85-100`、`ui/src/pages/Skills.tsx:23-31,483-497`；PRD V1.7 要求显示风险标记。
- 技能以业务类别分组，但来源只作为文本标签/搜索项，尚未形成第二个明确分类维度。
- 建议保留原始 `category` 是否缺失的信息，不用推断覆盖事实；增加 `riskStatus: unscanned|clear|blocked` 和来源筛选。

#### [M-03] 提前实现的 M3 接管参数偏离完整愿景

- `apps/gateway/src/message/config.ts:7-53` 使用简报 8 条/120 秒、AIMD `0.5`、成功窗口 4；PRD 完整愿景为 5 条/10 分钟及另一组自适应规则。
- 这些能力属于 P1/“扩展点就绪后”，不是 V1 缺陷；但既然已进入代码与 UI，就必须标记为实验性，避免被当作 PRD 已实现。
- 建议在 Hermes V1 完全禁用该路径；未来启用时以契约测试固定参数语义或正式修订 PRD。

#### [M-04] 接管队列的重试上限与 7 天轨迹保留未闭环

- `delivery.maxAttempts=5` 定义在 `apps/gateway/src/message/config.ts:16-20`，但 `apps/gateway/src/message/reconciler.ts:161-190` 的 `retry_wait` 未消费上限，存在无限重试。
- `apps/gateway/src/message/store.ts:19-92,530-553` 未发现 7 天投递轨迹清理。
- 这些属于后续接管模式质量风险，不应反过来阻断 Hermes L2 V1；若保留代码，至少应避免无界存储和永久重试。

#### [M-05] 宿主控制默认 systemd unit 可能操作错误服务

- `packages/adapters/hermes/src/control/executor.ts:90-109` 默认 unit 为 `hermes`；真实部署可能使用 `hermes-gateway.service` 或其他名称。
- 建议从 detect/capability scan 记录真实 unit/PID 归属，控制动作只能针对已确认实例，禁止猜测式默认。

#### [M-06] 熔断状态与 UI 真实边界不一致

- `apps/watch/src/runbook/breaker.ts:9-10,39-45` 明确熔断只在内存，watch 重启后复位。
- `ui/src/pages/Settings.tsx:270-274` 却把“反复崩溃自动停下”永久硬编码为 pass。
- 建议持久化活动熔断状态并在启动时恢复；在此之前 UI 显示“当前进程周期有效”，不得宣称无条件达标。

#### [M-07] 自动化验证未达到发布质量门槛

- 全量 TypeScript 构建通过。
- WSL 全量 Vitest 为 84 文件通过、1 失败、1 跳过；722 测试通过、1 失败、3 跳过。失败用例为 `apps/gateway/tests/message-runtime.test.ts:280` 的 15 秒超时，单独放宽到 30 秒后 7/7 通过，说明并发/性能脆弱。
- ESLint 当前有 21 个错误。
- Python 在 Windows 下 106 个测试出现 21 error、1 failure、1 skipped，主要与 0600 权限语义不兼容；WSL 又因缺 `aiohttp` 导致 9 个模块导入失败。
- `packages/adapters/hermes/tests/real-smoke.test.ts` 的 3 项真实 smoke 因未设置 `RUN_REAL_SMOKE` 全跳过。
- 建议先建立 Linux/WSL 为主的可复制依赖清单和 CI 门槛，再把真实 smoke 设为发布候选必跑任务。

### 5.4 低风险项

#### [L-01] 日志 tail 可能一次分配 offset 到 EOF 的全部内容

- `packages/core/src/tail.ts:89` 对大文件/长时间无换行日志有内存峰值风险。
- 建议改为固定块大小读取并保留半行缓冲。

#### [L-02] 危险操作确认体验不统一

- Settings 还原和 Gateway 补丁使用原生 `window.confirm`，见 `ui/src/pages/Settings.tsx:298-304`、`ui/src/pages/Gateway.tsx:641-644`。
- 建议统一使用能展示影响范围、备份状态和目标实例的应用内危险操作对话框。

#### [L-03] 备份保留口径容易混淆

- 升级快照确实保留 3 份；M7 日常备份却为 full=14、memory=24、event=10，见 `apps/watch/src/backup.ts:67-68`。
- 这不必然违反 PRD，但 UI 和文档必须区分两类保留策略，避免用户误以为所有备份都只保留 3 份。

## 6. 范围蔓延与额外功能

| 额外实现 | PRD 归属 | 审计判断 | 风险 |
|---|---|---|---|
| Hermes Bridge + L3 出站接管 | PRD 明确不允许，等待上游 hook | **冲突型范围蔓延** | 改写架构边界，可能吞消息，阻断 V1 |
| 完整消息 outbox、任务投影、DND、AIMD、预热 | P1/扩展点就绪后 | **提前实现** | 两套 SQLite 投影与同步游标扩大状态空间和故障面 |
| `prompt_targets/versions/candidates/evaluations` | 不属于 M5 的“入站消息预处理”主定义 | **需求外扩展** | 把提示词文件生命周期管理混入 V1 内核数据模型 |
| M6 归档/恢复/物理删除/索引重建/导出 | P1/P2 | **提前暴露** | 破坏 V1 只读承诺并引入数据删除风险 |
| M5 Bridge 规则/LLM 入站优化 | P1 | **提前实现，方向基本相关** | 依赖未交付，且与违规 L3 Bridge 绑定 |
| 诊断报告、较完整备份管理 | P1/V1.1 中部分能力 | **可接受提前实现** | 只要不挤占 P0 修复且真实边界明确，可保留 |

范围蔓延本身不总是缺陷；本项目的问题是高风险 P1/L3 能力已经进入主部署和核心数据模型，而 P0 安装与强制守门仍未闭环。当前资源顺序与 PRD 优先级倒置。

## 7. 关键业务流程审计

| 业务流程 | 目标流程 | 当前实现 | 结论 |
|---|---|---|---|
| 新机安装 | 检测环境 -> 国内源切换 -> 安装 -> 启动三服务 -> 接微信 -> 健康确认 | 前半段存在，启动脚本/镜像/服务接线断裂 | **不符合** |
| 日常巡检与自愈 | 定时探针 -> 指纹聚合 -> runbook -> 熔断/告警 -> 审计 | 主链存在且结构清晰 | **部分符合**，10 分钟 SLA 与跨重启熔断不足 |
| Hermes 消息治理 | V1 仅补丁 + 观察，不进原生消息路径 | 当前 Bridge 捕获出站并由 Gateway 决策投递 | **不符合**，业务流与 PRD 相反 |
| 进化守门 | 预检 -> 快照 -> 引擎运行 -> 可信指标 -> gate -> 唯一 promote | 预检/台账/gate 有，运行和 promote 未受控 | **不符合** |
| 被管实例升级 | 预检 -> 一致快照 -> 拉取 -> 补丁重打 -> 验收 -> 失败回滚 | 步骤基本齐全 | **部分符合**，数据一致性和真实 smoke 不足 |
| 管家自身升级 | 自身快照完成 -> 升级 -> 健康验收 -> 回滚 | 备份与升级并发启动 | **部分符合** |
| 记忆管理 | V1 只读；P1 写前快照、审计、确认 | 已提前提供写操作，快照失败仍继续 | **超范围且不安全** |

## 8. 数据模型审计

### 8.1 符合项

- `packages/core/src/store.ts:267-357` 的 `events`、`fingerprints`、`jobs`、`snapshots`、`backups`、`audit`、`instances`、tail position 与 fingerprint window，能覆盖 V1 的观测、控制、快照和审计事实。
- `jobs.idempotency_key` 为唯一键，符合长操作幂等目标。
- 告警小队列 `apps/gateway/src/queue.ts:59-78` 具备持久状态、重试时间和 dedupe key，符合 V1 自身告警缓释需求。
- M7 备份对普通 SQLite 优先使用 `VACUUM INTO`，见 `apps/watch/src/backup.ts:110-140`，比升级快照路径更符合一致性要求。

### 8.2 偏差与风险

1. `packages/core/src/store.ts:359-432` 的四组 `prompt_*` 表承载提示词文件版本、候选和评估，不是 PRD M5 入站消息预处理的核心数据模型，属于范围扩张。
2. Bridge outbox `packages/adapters/hermes/bridge/agent_butler_bridge/outbox.py:56-188` 与 Gateway projection `apps/gateway/src/message/store.ts:19-92` 形成两套消息状态库和游标同步。该设计在 L3 中可以成立，但当前 Hermes V1 不应存在此数据面；它增加 delivery_unknown、重放、保留和一致性验证成本。
3. `MemoryDriver` 同时承担观察、归档、恢复、物理删除与重建，模糊了“格式驱动”和“内核高危动作”的所有权；尤其物理删除违反契约禁区。
4. 升级快照数据模型只登记“复制成功”，没有 SQLite 一致性校验结果，无法支撑验收 5 的“数据完好”证据。
5. 当前未发现消息轨迹 7 天保留或 Bridge/Gateway 状态表的系统化清理策略，长期运行有无界增长风险。

## 9. 接口与契约审计

### 9.1 符合项

- Manifest schema、契约版本校验、统一 `Result`、错误码表、实例生命周期和能力报告均有对应实现。
- I-1 的 detect/capabilityScan/logSources 结构清晰，capabilityScan 基本按能力逐项判定。
- I-2 有宿主与 Docker 双执行器、幂等控制、Job、快照、回滚和配置校验接口。
- I-4 的只读枚举、统计、preview 上限 50、完整性探针和目录降级路径已落地。

### 9.2 不符合项

1. Hermes manifest/运行时能力提级到 L3，违反契约适配表和 PRD 事实结论。
2. CapabilityRouter 没有进入实际调用路径，`not-implemented` 隐藏、`unavailable` 置灰和连续失败降级只是未被消费的类。
3. `validateConfig` 没有被升级/start/apply 等控制调用消费，block 级违例无法阻止动作。
4. SkillDriver.validate 只校验名称/版本，见 `packages/adapters/hermes/src/drivers/skill.ts:300-307`；没有实现契约描述的 frontmatter 完整性、trigger 正则可编译、依赖存在或风险扫描。OpenClaw 相关部分属 V1.5，但通用接口语义仍未兑现。
5. V1 只需 I-4 只读消费面，当前契约和实现却公开 archive/restore/purge/rebuild 写方法，并通过 HTTP/UI 暴露。
6. Bridge 使用额外 HTTP 服务和 token 文件，但不在 Compose/installer 的部署契约中，导致“代码接口存在、产品接口不可用”。

## 10. P1/P2/V1.5 愿景矩阵

| 后续范围 | 当前状态 | 审计说明 |
|---|---|---|
| V1.5 OpenClaw L0-L2 + 首批格式驱动 + 多实例大盘 | **未实现** | 仓库仅有类型、规划和 Hermes 代码；这是延期项，不是 V1 缺陷 |
| P1 M3 AIMD、任务感知、多通道降级、双向关联 | **部分提前实现** | 参数偏离、真实扩展点缺失，不能算完成 |
| P1 M1 全量探针、成本看板、任务控制台 | **未完成/局部** | V1 三探针已实现；其余按计划延期 |
| P1 M4 显著性、模型档案、数据集治理 | **局部且口径错误** | `significant` 由用户提交，不是可信统计；档案与运行中看门狗未闭环 |
| P1 M5 入站提示词优化 | **部分实现** | Bridge 有规则/LLM 逻辑，但交付依赖缺失；核心 store 另扩张为文件 prompt 版本系统 |
| P1 M6 写操作、健康度、冲突检测 | **部分提前实现** | 记忆写操作/健康度已做；冲突检测不完整；安全边界不足 |
| P1 M7 密钥库、故障知识库 | **未实现/局部** | 诊断和备份较完整，AES 密钥库与知识库未产品闭环 |
| P2 技能市场、沙箱、记忆瘦身 | **局部** | 记忆瘦身动作提前实现；市场和隔离沙箱未实现 |
| P2 蓝绿、迁移向导、第三框架 | **未实现** | 按计划延期 |
| P2 移动端适配 | **未实现** | 390x844 实测出现导航、标题、正文、卡片和表单水平溢出；不阻断 V1 |

## 11. UI/UX 实测结论

- 桌面端实际为统一浅色主题，旧报告中的“深浅主题割裂”结论不成立。
- Dashboard、Gateway、Skills、Settings 在离线/loading 场景能明确显示真实状态，未用演示数据冒充在线。
- 移动端 390x844 存在明显横向溢出和顶部导航裁切。PRD 将移动端适配列为 P2，因此应登记为愿景缺口而非 V1 阻断。
- Settings 的熔断状态硬编码为 pass，违反真实边界。
- 危险操作仍混用原生 confirm，影响一致性和影响范围说明，但属于低风险体验项。
- 截图证据位于 `.workbuddy/audit-*-202316.png`。

## 12. 整改建议与发布门槛

### 12.1 第一阶段：恢复 V1 边界，关闭阻断项

1. **冻结并下线 Hermes L3**：manifest 恢复 L2，移除 messaging capability 和生产 Bridge 接线；Gateway 只保留告警小队列与补丁观察面。
2. **完成可运行交付**：替换 placeholder Dockerfile；补全 workspace start/service scripts；配置容器 DNS、端口、健康检查和 loopback 安全边界；在全新 Linux/WSL 环境跑通宿主与容器安装。
3. **把 M4 变成强制门禁**：建立唯一候选 promote API，任何技能写入必须持有通过 gate 的不可伪造凭证。
4. **满足 10 分钟 SLA**：关键记忆探针独立高频调度，并做“最坏触发时刻”故障注入。
5. **修复数据安全**：升级/进化使用一致性 SQLite 快照；管家自身升级必须等待备份完成。
6. **强制配置校验**：把三条不变式接入 start/upgrade/apply，并完成 30 秒自动复验。

### 12.2 第二阶段：收敛接口和超范围功能

1. 把 CapabilityRouter 接入所有适配器/驱动调用，删除业务层裸调用旁路。
2. V1 隐藏 M6 写入口；P1 重新启用时采用 fail-closed 快照和内核物理删除路径。
3. 修正技能“未分类”、来源维度和插件风险标记。
4. 将完整消息接管与 `prompt_*` 数据模型放入明确 feature flag/实验分支，避免污染 V1 默认运行面。
5. 修复 maxAttempts、7 天清理、systemd 单元发现和熔断持久化。

### 12.3 第三阶段：建立发布证据

V1 发布候选必须提供以下可复核产物：

- 两种安装形态的全新机器录屏/日志、版本、端口和健康结果。
- 真实微信 30 条风暴的队列轨迹、发送时间、零限流证据。
- 记忆嵌入故障注入时间线，证明 10 分钟内告警和修复。
- holdout=2 的真实引擎拒绝、扩集、重检和台账。
- 两个相邻 Hermes 版本的补丁重打 spike，以及一个已知回归版本的自动回滚、SQLite 完整性与数据对账。
- TypeScript build、lint、全量测试、Python Bridge 测试和 real smoke 全绿；任何跳过项必须有发布批准。

## 13. 验证记录与限制

### 13.1 已执行验证

- `node node_modules\typescript\bin\tsc -b`：通过。
- WSL 全量 Vitest：84 文件通过、1 失败、1 跳过；722 测试通过、1 失败、3 跳过。
- `apps/gateway/tests/message-runtime.test.ts` 单独以 30 秒超时复跑：7/7 通过。
- ESLint：21 个错误，未达到全绿。
- Python Windows：106 个测试中 21 error、1 failure、1 skipped。
- Python WSL：缺 `aiohttp`，9 个模块导入失败。
- Hermes real smoke：3 项全部跳过，原因是未设置 `RUN_REAL_SMOKE`。
- Windows Vite 因缺 `@rollup/rollup-win32-x64-msvc` 启动失败；WSL Vite 可运行。
- 本机 Chrome headless 已完成桌面和 390x844 移动端截图核对。

### 13.2 审计限制

- 未连接真实 Hermes 微信账号、真实国内新机、Docker 交付环境或已知回归版本，因此所有相关结论以“代码可达性 + 测试证据 + 部署拓扑”判断，未冒充真实验收通过。
- 工作区存在大量未提交和未跟踪内容；本审计未回退或整理这些改动，结论针对 2026-08-23 当前工作树。
- PRD 中引用的第三方事实不在本次审计范围；本报告核对的是仓库实现是否遵循 PRD 已定口径。

## 14. 最终判定

**V1/P0：不符合，禁止按 V1 发布。**

最短合规路径不是继续补齐 P1 功能，而是恢复 Hermes L2 边界、完成可运行交付、把 M4 和配置不变式变成强制门禁、修复 SQLite 快照与 10 分钟 SLA，并用五条真实验收建立发布证据。P1/P2/V1.5 的未实现项应保留在路线图，不应继续与 V1 默认运行面混合。
