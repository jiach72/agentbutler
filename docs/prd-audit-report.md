# Agent Butler PRD 符合性审计报告

> 审计对象：`C:\Users\jiach\Documents\Agent Butler`
>
> 需求基线：`docs/agent-butler-prd.html`，PRD V1.7；文本定位基线为 `.workbuddy/prd-text.txt`
>
> 审计日期：2026-08-24（增量复核）
>
> 审计类型：静态代码审计、契约与数据模型核对、测试结果复核、桌面/移动端 UI 实测

## 1. 执行摘要

### 1.1 发布结论

**结论：V1 不符合，当前为 No-Go。**

V1/P0 的主体代码并非空壳：M1 巡检和三类探针、M2 升级五步与回滚、M3 Hermes 节流补丁、M4 holdout 门槛与扩集、M6 只读资产列表、M7 备份与审计均已有可识别实现。然而，交付链路、架构边界和关键守门语义存在发布阻断：

1. Docker + OpenClaw 核心链路已在 Node 24.15 容器中真实启动并通过健康检查；宿主形态、真实微信接入和端口冲突处理仍未形成完整发布证据。
2. Hermes L2 边界已恢复，消息接管明确移出 V1；真实通道与宿主形态验收仍未完成。
3. Hermes 消息接管实验路径仍不具备“管家失效时原生消息照发”的逃生门，也没有可交付的 Bridge 拓扑；但默认 Gateway 生产入口未装配该 launcher，当前风险是实验代码边界证明不足，而非默认 V1 已接管 Hermes 消息。
4. M4 已增加一次性写入授权令牌和唯一 `promoteArtifact` 入口，负优化、无显著提升不会签发令牌；真实进化引擎端到端验收仍缺。
5. 五条真实 V1 验收中没有一条具备完整的真实环境通过证据；第 4 条仅在代码层具备较完整闭环。

### 1.2 范围结论

| 范围 | 审计结论 | 说明 |
|---|---|---|
| V1/P0 | **不符合** | 交付、真实通道、真实升级回滚和 10 分钟修复验收仍存在硬缺口 |
| P1 | **部分提前实现，但边界混乱** | 消息接管实验代码、M5、M6 写驱动等仍在仓库，但 V1 HTTP/UI 默认不暴露 |
| P2/V1.5 | **部分实现，未产品闭环** | OpenClaw 已有 L0-L2 适配器和 Docker 一键安装基线；移动端适配、沙箱、蓝绿、迁移向导仍未完成；这不应判为 V1 缺陷 |
| 明确不做项 | **已隔离** | Hermes Bridge 实验代码保留但不进入 V1 Hermes 适配器、HTTP/UI 和生产接线 |

### 1.3 严重度统计

| 等级 | 数量 | 处理口径 |
|---|---:|---|
| 阻断 | 2 | V1 发布前必须关闭 |
| 高 | 5 | 发布前修复或明确移出 V1 可执行面 |
| 中 | 7 | 本轮收敛或列入有负责人、有验收的后续版本 |
| 低 | 3（已关闭 2，开放 1） | 不阻断发布，但应进入工程债清单 |

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
| M2 宿主服务常驻（代码层） | P0 | 安装器支持 Linux/WSL user-systemd：生成三项 unit，执行 daemon-reload/enable --now，随后检查三项 active 与 Web/Watch/Gateway loopback 健康接口；健康失败会停止三项服务并返回失败；dry-run、非 systemd 和写入失败均有安全分支 | **符合（代码层）** | 尚无全新 Linux/WSL 现场的常驻、健康和重启恢复记录 |
| M2 一键安装，宿主/容器双形态，国内镜像 | P0 | Dockerfile 已能在干净上下文构建三服务；OpenClaw override 提供 Node 24.15、npm/setup、Gateway token、持久化卷和健康检查；真实 Docker 核心链路已通过；Docker 与宿主安装器均会前置探测 loopback 端口并在外部占用时 fail-closed | **部分符合** | 宿主形态与真实微信接入尚未验收；端口冲突可提前失败，但暂未自动改用替代宿主端口 |
| M2 被管实例升级五步 | P0 | `packages/adapters/hermes/src/control/upgrade-pipeline.ts` 实现预检、快照、拉取、补丁、验收与失败回滚；SQLite 快照使用 `VACUUM INTO` 并做完整性校验 | **部分符合** | 真实升级/回滚验收、相邻版本补丁重打和数据对账未跑 |
| M2 快照默认 3 份 | P0 | `packages/adapters/hermes/src/control/snapshot.ts:25-27,144-148` | **符合** | M7 通用备份另有 14/24/10 份策略，应在 UI 区分“升级快照”和“日常备份” |
| M2 管家自身升级/回滚 | P0 | 有版本、快照登记、升级、回滚和健康检查；升级入口等待前置备份 | **部分符合** | 真实升级/回滚 smoke 与数据对账仍未跑 |
| M1 进程 + 三类功能探针 | P0 | 七阶段巡检入口 `apps/watch/src/pipeline.ts:274-291`；记忆、通道、LLM 探针均有实现与测试 | **符合** | 真实通道 smoke 未执行 |
| M1 错误指纹、日志、修复入口 | P0 | 事件、指纹、日志分页、一键 runbook、审计链路已实现；tail 已改为 64 KiB 固定块扫描和分块 UTF-8 解码 | **符合** | 真实长时间日志压测仍未执行 |
| M1 三条 runbook + 10 分钟 5 次熔断 | P0 | `apps/watch/src/runbook/executor.ts:368-439`；完整巡检默认 5 分钟；独立关键记忆探针 `apps/watch/src/scheduler.ts` 默认 1 分钟、固定 10 分钟 deadline；`/api/inspect/status` 暴露耗时/逾期/漏 tick，审计记录 `critical-probe-sla` | **部分符合（代码层收口）** | 真实最坏边界 SLA 故障注入尚未完成；UI/审计链路已接入真实熔断状态 |
| M1 面板横幅 + 单条备用通道 | P0 | 有告警队列、转发和面板横幅 | **部分符合** | 真实备用通道与微信限流场景未跑通 |
| M1 Dashboard `/api/status` 补充信号 | P0 | 有独立 dashboard signal 探测 | **符合** | 无真实 Dashboard 联调证据 |
| M3 Hermes 补丁管理 + 观察模式 | P0 | 三条补丁默认值覆盖 45 秒、20 秒、附件预算和超长整形；Hermes 能力已固定为 L2，消息接管不进入 V1 | **部分符合** | 真实相邻版本重打和通道 smoke 仍未完成 |
| M3 管家告警持久队列缓释 | P0 | `apps/gateway/src/queue.ts:59-78` 提供持久队列和重试状态 | **符合** | 与提前实现的全量消息接管代码耦合过深 |
| M4 三项预检 + 运行前快照 | P0 | `apps/watch/src/evolution.ts` 只接受本次新增的 `pre-evolution` 登记；OpenClaw 通过 `snapshotRecorder` 写入 Core store，并用 manifest 支持 skills/memory 回滚；`watch.ts` 进化前事件备份 fail-closed | **符合（代码层）** | 真实进化引擎启动入口与端到端替换验收仍缺 |
| M4 holdout<10 拒绝 + 最小扩集 | P0 | 门槛 `apps/watch/src/evolution.ts:22`；扩集和自动重检 `apps/watch/src/evolution.ts:625-704` | **符合（代码层）** | 尚无真实进化引擎验收 |
| M4 回归拒绝落盘、保留 baseline | P0 | `recordResult` 仅在显著正增益且路径/hash 可验证时签发一次性令牌；`promoteArtifact` 是唯一受控替换入口，原子写入失败会恢复旧文件 | **符合（代码层）** | 真实进化引擎与实际技能产物端到端验收仍缺 |
| M6 技能/插件/记忆只读列表 | P0 | 驱动枚举、目录降级、统计、预览、健康评分和 UI 已实现；M6 写路由默认 404，UI 只保留只读与备份入口；分类、来源筛选和风险标记已贯通 | **符合（代码层）** | 真实 OpenClaw/Hermes 记忆健康数据仍需现场验收 |
| M7 loopback、安全、备份、审计 | P0 | 宿主侧端口仍限制 loopback；容器服务通过 `0.0.0.0` + 内部 DNS 互联；OpenClaw token 注入且 healthcheck 使用同一 token；Docker 与宿主安装器都会前置探测端口 | **部分符合** | 密钥 0600 在 Windows 无法验证；冲突端口仍需用户停止占用进程或手工配置替代端口 |
| M7 三条配置不变式 | P0 | Hermes/OpenClaw start/restart、升级预检和 Gateway 补丁 apply/reapply 已消费统一校验；文件变化默认 30 秒复验并审计告警 | **部分符合** | 仍缺真实配置变更时间线与所有控制旁路的现场验收 |
| 契约 I-1 全部 | P0 | Hermes 与 OpenClaw 均有 detect、capabilityScan、logSources 实现；Watch 真实容器检出 `openclaw-main` | **符合** | 真实多形态探测证据仍有限 |
| 契约 I-2 全部，双执行器 | P0 | Process/Docker 控制与升级、快照、回滚、validateConfig 均存在；start/restart 已先做配置校验；systemd 仅接受显式 unit | **部分符合** | 默认 unit 猜测风险已关闭，仍需真实控制面验收 |
| 契约 I-4 只读消费面 | P0 | V1 HTTP/UI 默认隐藏 M6 archive/restore/purge/rebuild/export，读路径仍可用 | **符合（边界层）** | 驱动层保留 P1 写能力，需持续防止旁路接线 |
| Hermes 适配器 L0-L2 | P0 | Manifest、能力扫描和正式适配器均固定 L2，不申报 messaging | **符合** | 真实 Hermes 通道 smoke 仍未执行 |

## 4. 五条 V1 验收结论

| # | 验收条款 | 结论 | 证据与原因 |
|---:|---|---|---|
| 1 | 国内新机完成宿主/容器双形态安装并接微信 | **未通过（Docker 基线通过）** | 2026-08-24 Node 24.15 Bookworm + OpenClaw 容器中四服务均 healthy，Web `/api/health` 返回 `ok/db/gateway=true`，Watch 诊断检出 `openclaw-main`；但宿主形态、真实微信接入、无端口冲突的新机记录仍缺失 |
| 2 | 1 分钟触发 30 条，按至少 45 秒配速全部送达且零限流 | **未通过** | 补丁参数存在，但真实微信 smoke 全跳过；独立实验 launcher 的 `queued-push` 仍不能证明原生 fail-open 或最终送达，且默认 V1 Gateway 未装配该路径 |
| 3 | 停记忆嵌入后 10 分钟内告警并自动修复 | **代码层通过，真实故障注入未执行** | 完整巡检默认 5 分钟；独立关键 memory probe 默认 1 分钟、固定 10 分钟 deadline，与整轮巡检分离且失败接 `rb-restart`、告警/审计；`/api/inspect/status` 和 `critical-probe-sla` 审计记录开始/完成/deadline/耗时/逾期。仍缺“故障发生在轮询边界”的真实时间线证据 |
| 4 | holdout=2 被拒并获得扩集路径 | **代码层通过，真实验收未执行** | `MIN_HOLDOUT_COUNT=10`，拒绝结果附 `/expand`，扩集后自动重检；缺少真实引擎端到端证据 |
| 5 | 升级已知回归版本后自动回滚，数据完好，补丁重打或提示冲突 | **未通过** | 流水线、`VACUUM INTO` 快照和单测存在，但真实 smoke、相邻版本补丁重打、回滚后数据对账仍缺失 |

**V1 成立要求是五条全过。当前完整通过为 0/5，因此不能宣称 V1 已达成。**

## 5. 严重度发现

### 5.1 阻断项

#### [B-01] 双形态与真实通道验收仍未闭环

- **事实**：2026-08-24 使用 `docker compose -f docker-compose.yml -f .tmp-openclaw-compose.override.yml -f .tmp-openclaw-port.override.yml up -d`，OpenClaw、Gateway、Watch、Web 均为 `healthy`；Web `/api/health` 返回 `{"ok":true,"db":true,"gateway":true}`，Watch 诊断检出 `openclaw-main`。
- **事实**：本机已有宿主 `apps/web/dist/server.js` 占用 `127.0.0.1:7531`，既有 Hermes 进程占用 `127.0.0.1:7532`；Docker 安装器会在 `web-port-check` 阶段提前失败，宿主安装器会在 `services-port-check` 阶段检查 7531/7532/7533，均不写入 unit/override、不启动 Compose。
- **事实**：PRD 验收 1 还要求宿主形态和真实微信通道；当前没有 Node 24.15+ 宿主一键安装的完整服务常驻记录，也没有 OpenClaw 真实消息通道发送证据。
- **事实**：宿主安装器代码已能在 Linux/WSL 真实执行时生成三项 user-systemd unit，并执行 daemon-reload 与 enable --now；本轮仅以注入式临时目录测试验证，未写入真实用户 unit 或启动服务。
- **增量事实**：宿主安装器现在在启动后检查三项 `systemctl --user is-active`，并用 Node fetch 检查 Watch/Gateway `/healthz` 与 Web `/api/health`；任一健康检查失败会停止三项服务并返回失败。该逻辑已由 32 项安装器回归覆盖，但仍未在真实 Linux/WSL 用户 unit 上执行。当前 Ubuntu-24.04 已具备 Node `v24.14.1`、Corepack pnpm `10.20.0` 与 user-systemd；三项 Butler unit 仍为 `inactive`，且既有 Hermes 进程占用 `127.0.0.1:7532`，因此本轮未执行真实安装写入或重启。
- **增量事实**：宿主安装器新增 `services-port-check` 前置门禁：端口被对应且 active 的 Butler unit 托管时允许幂等重跑，外部占用则 fail-closed；35 项安装器回归覆盖外部占用不写 unit 与 Butler 托管端口可复用。真实用户 unit 写入/重启仍未执行。
- **增量事实**：端口复用判定已进一步收紧：仅当对应 unit 的 `MainPID` 出现在 `ss -H -ltnp` 的目标端口监听者中才允许重跑；`systemctl` 或监听者证据缺失、PID 不匹配均按外部占用 fail-closed。安装器定向回归现为 35 项。
- **影响**：Docker 核心基线已解除“不可启动”阻断，但验收 1 仍不能宣称通过。
- **建议**：在全新 Linux/WSL 环境运行宿主安装器，记录三项服务常驻、健康和重启恢复；同时完成 OpenClaw Gateway WebSocket/出站 hook spike 与真实消息通道 smoke 后，再关闭该项。

#### [已关闭 B-02] Hermes L3 与 PRD 硬约束

- **事实**：`packages/adapters/hermes/manifest.json`、能力扫描和正式适配器已固定为 L2，生产路径不再申报或接入 messaging；相关修复已有适配器回归测试。
- **事实**：PRD 要求的真实 Hermes 通道、宿主安装和失效逃生验收仍没有可复核的完整运行记录。
- **影响**：Hermes L3 冲突已关闭，但验收 1/2 仍不能宣称通过。
- **建议**：保持 V1 只读/观察边界，补充宿主安装与真实通道 smoke；任何未来 L3 变更必须先提供上游 hook、ACK、原生回退和灾难恢复证据。

#### [B-03] 消息接管实验没有失效逃生门，Bridge 仍不具备可交付性（默认生产路径已隔离）

- **事实**：`apps/gateway/src/main.ts` 默认只创建普通 Gateway server；只有独立的 `apps/gateway/src/message/launcher.ts` 才装配 Hermes message runtime，Compose 运行的是普通 `dist/main.js`。
- **事实**：独立实验路径中的 `wrapper.py` 仍会在 `queued-push` 捕获成功后向 Hermes 返回 success，不调用原生发送；Bridge 默认 loopback 监听，Compose/installer 也未安装或启动它。
- **已修复（代码层）**：`apps/gateway/src/message/launcher.ts` 现在要求 `BUTLER_ENABLE_HERMES_MESSAGE_RUNTIME=true`（或 `1`），缺少开关时在创建 runtime 前拒绝启动；启动日志显式标注实验开关。默认 V1 生产路径仍未接管消息。
- **残余推断（高置信度）**：实验 launcher 即使被显式启用，Gateway/Bridge 故障仍可能造成静默截留；该路径没有可交付的 fail-open 逃生门，因此不能作为 V1 生产能力。
- **影响**：Hermes L2 V1 的默认路径保持隔离，但任何误接线都会使验收 2 和 fail-open 语义失效。
- **建议**：保持默认入口不装配 message launcher；未来 L3 必须采用可证明的 fail-open/fail-bypass 语义，明确 ACK 时点、原生回退、队列所有权、投递未知态和灾难恢复。

#### [已关闭 B-04] M4 强制写入门禁

- **事实**：`recordResult` 只在显著正增益且候选/目标 hash 可登记时签发一次性授权；`promoteArtifact` 校验 runId、路径、baseline/candidate hash、令牌一次性消费，并在登记失败时恢复旧文件。
- **事实**：HTTP 已提供 `/api/evolution/runs/:runId/promote`，M4 写权限不再由 `allowWrite` 布尔值单独决定。
- **影响**：代码层的“负优化不可落盘”门禁已关闭该阻断；仍无法替代真实进化引擎、真实 skills 目录和现场回滚验收。
- **建议**：补一次真实 OpenClaw/Hermes 进化 smoke，验证候选生成、评估、promote、重启后 baseline 与审计台账一致。

#### [已关闭 B-05] M4 快照登记与 OpenClaw 回滚资产闭环

- **问题**：OpenClaw 控制适配器原先只把快照复制到磁盘，不登记 Core store；M4 预检无法绑定本次 `snapshotId`，且即使登记后，回滚入口也只恢复 `config/workspace/state`，对 `skills + memory` 快照可能返回成功但不恢复资产。预检还可能从历史同标签登记中误拾取旧快照。
- **修复**：`packages/adapters/openclaw/src/control.ts` 增加受控 `snapshotRecorder`、唯一快照 ID、来源/目标 manifest 和相对路径校验；`rollback` 按 manifest 恢复原始路径，缺失或篡改路径 fail-closed；升级前快照含 skipped/failed 步骤时立即拒绝 npm 安装。`apps/watch/src/watch.ts` 将 OpenClaw 快照登记接入 Core store；`apps/watch/src/evolution.ts` 只接受本次调用新增的同标签快照行。
- **回归测试**：`packages/adapters/openclaw/tests/smoke.test.ts` 覆盖 OpenClaw M4 资产快照登记、manifest 回滚和升级缺资产阻断；`apps/watch/tests/evolution.test.ts` 覆盖历史快照不可冒充本次快照。
- **验证命令**：`corepack pnpm exec vitest run packages/adapters/openclaw/tests/smoke.test.ts apps/watch/tests/evolution.test.ts apps/watch/tests/http-evolution.test.ts --maxWorkers=1`（25 项通过）；`corepack pnpm exec tsc -b --pretty false`；随后执行全量测试、lint、build 与 `git diff --check`。
- **部署/运行验证**：仅使用临时 OpenClaw/Hermes fixture、注入式快照登记和本地文件回滚；未启动/停止现有 OpenClaw、未执行真实 npm 安装、未发送真实消息。真实快照回滚、数据对账和端到端进化验收仍保持开放。

### 5.2 高风险项

#### [H-01] 10 分钟 SLA 仍缺真实故障注入证据

- 当前完整巡检默认 5 分钟、启动立即执行；新增独立 `CriticalProbeScheduler`，关键 memory probe 默认每 1 分钟运行，固定 10 分钟 deadline，独立于完整巡检的 `inFlight`，失败接 `rb-restart` 自动处置。
- `/api/inspect/status` 提供 `criticalProbe` 的 `lastStartedAt/lastCompletedAt/deadlineAt/lastDurationMs/lastWithinSla/overdue/missedTicks`；Dashboard“管家最近检查”展示关键探针状态、频率和 SLA；每轮另写 `critical-probe-sla` 审计，故障注入单测覆盖完整巡检阻塞与 deadline 逾期。
- 2026-08-24 增量收口：关键探针 fail 现在无条件进入共享 Gateway 告警队列（即使 `runbookAuto=false`），并写入 `critical-memory-alert-queued`；发现、告警排队和修复起止时刻进入审计。确定性边界测试复现 `t=0` 启动、`t=60s` 漏 tick、`t=600001ms` 完成，断言 `deadlineAt=600000ms`、`withinSla=false`、`missedTicks=1`。
- 尚未执行“刚错过一次轮询”的真实 Hermes 故障注入，也未记录真实发现、修复、告警各时间戳，因此仍不能把代码层通过当作现场验收通过。

#### [H-02] SQLite 快照已改为一致性副本，但真实回滚证据缺失

- `packages/adapters/hermes/src/control/snapshot.ts` 当前对 SQLite 使用 `VACUUM INTO`，不热拷贝 WAL/SHM，并在登记前执行 `PRAGMA integrity_check`。
- 代码层已消除原文件级热拷贝风险；仍缺真实升级回滚后的数据对账与相邻版本 smoke，故验收 5 不能关闭。

#### [H-03] 升级前备份已改为 fail-closed，真实升级证据仍缺失

- 管家自身升级 `apps/watch/src/self-upgrade.ts:665-705` 等待 `runFull` 完成并在失败时中止。
- 被管实例升级的 watch 包装入口 `apps/watch/src/watch.ts` 现在等待事件备份成功并取得有效登记 ID 后才调用升级流水线；备份失败返回 `upgrade-prebackup-failed`，不创建升级 Job。
- 仍缺真实升级/回滚 smoke 与备份失败运行证据，验收 5 暂不能关闭。

#### [H-04] 配置不变式已接入控制路径，真实时间线验收仍缺

- `packages/adapters/hermes/src/control/upgrade-pipeline.ts` 预检已调用 `validateConfig`；Gateway 补丁 apply/reapply 也会阻断 block 级违例。
- `apps/watch/src/invariants.ts` 已默认每 30 秒复验并对变化审计/告警。
- Hermes/OpenClaw 的 start/restart、升级预检和 Gateway 补丁 apply/reapply 已接入校验；Hermes 升级流水线内部的 stop/start/snapshot/rollback/validateConfig 也通过注入的 `core.invoke` 能力路由，代码层控制旁路已收口。仍需完成配置变更后的真实时间线验收。

#### [H-05] 能力路由已收口，发现阶段保持只读直连

- `packages/core/src/executor.ts` 的 `core.invoke` 现在支持可选 `capability`，调用前执行 `router.check`，调用后记录运行结果；Skills/Memory 主要读写路径已传入 `skill-driver`/`memory-driver`。
- `apps/watch/src/watch.ts:createRoutedControl` 统一包裹 start/stop/restart/upgrade/snapshot/rollback 与 `validateConfig`；Hermes 适配器另注入同一 `core.invoke` invoker，使升级流水线内部调用也不再绕过能力门禁。Runbook、升级、进化快照/回滚和 Gateway 校验均保持 fail-closed，新增回归测试锁定 `not-implemented` 行为。
- detect、初次 capabilityScan 与同步 `logSources` 属于能力报告产生前的只读发现阶段，保持直连是有意设计，不构成业务执行旁路。代码层该项已收口；仍需真实双形态控制面 smoke 和故障注入验收。

### 5.3 中风险项

#### [已关闭 M-08] 宿主端口复用可能误信 active unit

- **事实**：旧逻辑在端口被占用时只检查对应 Butler unit 是否 `active`，没有证明该 unit 的进程实际持有端口。
- **改动**：安装器现在同时核验 `MainPID` 与 `ss -H -ltnp` 监听者 PID；无法证明归属即拒绝幂等重跑，不写 unit、不执行 `daemon-reload/enable`。
- **回归证据**：`packages/installer/tests/install.test.ts` 新增“active unit 但其它 PID 监听”用例；35/35 定向测试通过。
- **残余风险**：真实 WSL 环境若缺少 `ss` 或权限不足会安全失败，需要用户补齐诊断工具或释放端口；这不会放行错误服务。

#### [M-01] M6 写能力默认隐藏，后续仍需防旁路

- PRD V1 仅只读，写操作在 P1/P2，见 `.workbuddy/prd-text.txt:889-892`。
- `apps/watch/src/http.ts` 通过 `m6WritesEnabled` 默认关闭 archive/restore/purge/rebuild/export；UI 已移除这些写入口，只保留只读清单、健康分析和备份。
- 写驱动与后端实现仍保留在代码中，未来重新启用前必须保留写前快照 fail-closed、确认令牌、影响预览和审计，并避免绕过能力路由。

#### [M-02] M6 分类展示不完全符合 V1.7（已收口）

- 技能缺 category 时现在保留缺失事实，由 UI 归入“未分类”，不再按名称或目录猜测；显式 frontmatter category 仍原样透传。
- 契约、Watch、Web 和 UI 已增加并透传 riskStatus（unscanned/clear/blocked）；解析失败资产显示为“受限”，普通未扫描资产显示为“未扫描”。
- 技能与插件页面均已提供独立来源筛选，分类筛选仍保持只读。
- 回归证据：packages/adapters/hermes/tests/drivers.test.ts、apps/watch/tests/skills.test.ts、apps/web/tests/skills.test.ts 定向测试通过；真实资产扫描与 OpenClaw/Hermes 现场数据验收仍是发布前工作。

#### [M-03] 提前实现的 M3 接管参数偏离完整愿景

- `apps/gateway/src/message/config.ts:7-53` 使用简报 8 条/120 秒、AIMD `0.5`、成功窗口 4；PRD 完整愿景为 5 条/10 分钟及另一组自适应规则。
- 这些能力属于 P1/“扩展点就绪后”，不是 V1 缺陷；但既然已进入代码与 UI，就必须标记为实验性，避免被当作 PRD 已实现。
- 建议在 Hermes V1 完全禁用该路径；未来启用时以契约测试固定参数语义或正式修订 PRD。

#### [M-04] 接管队列的重试上限与 7 天轨迹保留（代码层已闭环）

- `delivery.maxAttempts=5` 定义在 `apps/gateway/src/message/config.ts:16-20`，`apps/gateway/src/message/reconciler.ts` 在投递前消费 `attemptCount`，达到上限后写入 `cancelled`，不会再发起第 6 次投递。
- Gateway `MessagePolicyStore.pruneMessageHistory` 和 Bridge `Outbox.prune_history` 均按 7 天默认保留清理旧终态消息及其子记录；活动状态（包括 `retry_wait`、`delivery_unknown`）不会被清理。Gateway 只清理本地投影，Bridge 仍是权威 Outbox。
- Gateway 在每次 reconciliation 后清理，Bridge 启动时清理并每小时巡检；Bridge health 暴露 `retention: ok/degraded`。这项不再是代码层的无限重试或无界存储缺陷，但实验路径仍未接入 V1，真实 Bridge 长时间运行与升级后的现场验收仍缺。

#### [已关闭 M-05] 宿主控制默认 systemd unit 可能操作错误服务

- `packages/adapters/hermes/src/control/executor.ts` 现在只有显式 `process.unitName` 才会探测或执行 systemd；未配置时完全跳过 `systemctl --user cat/start/stop/kill`，回退到实例 `rootPath` 下的 venv/pgrep 路径。
- 回归测试覆盖显式 `hermes-gateway.service` 的 start/stop/restart，以及未配置 unit 时 systemd 零调用；因此默认不会再猜测或操作名为 `hermes` 的其他服务。
- 残余风险：真实宿主安装仍需在 detect/安装配置中提供正确 unit，并完成现场控制面 smoke。

#### [M-06] 熔断状态与 UI 真实边界不一致（代码层已收口）

- `apps/watch/src/runbook/breaker.ts` 已支持从持久化跳闸事件恢复活动状态，并提供显式 reset；watch 启动时从 events 表恢复最近一次同 key 跳闸。
- `ui/src/pages/Settings.tsx` 现在消费 `/api/runbooks` 的真实 `breakerTripped`，并通过 `/api/runbooks/:id/reset` 提供人工解除。
- 解除操作写入 `circuit-breaker-reset` 审计；仍需补浏览器端真实交互证据与最坏轮询边界的 SLA 时间线，但不再是 UI 硬编码状态缺陷。

#### [M-07] 自动化验证已通过本地质量门槛，真实环境门槛仍未满足

- 全量 TypeScript 构建通过。
- `corepack pnpm test` 当前通过：93 个测试文件通过、1 个跳过；801 个测试通过、3 个跳过。
- `corepack pnpm lint`、`corepack pnpm build` 和 `git diff --check` 当前通过；本轮 `tsc -b --pretty false` 也通过，Hermes control 定向测试 47/47 通过。
- `packages/adapters/hermes/tests/real-smoke.test.ts` 的真实 smoke 仍因未设置 `RUN_REAL_SMOKE` 而跳过；宿主/微信/已知回归版本仍缺真实证据。
- 因此本地自动化门槛已收口，但发布质量门槛仍受真实环境验收阻断。

### 5.4 低风险项

#### [L-01] 日志 tail 可能一次分配 offset 到 EOF 的全部内容

- 原实现已确认会按 `size - offset` 一次分配整段增量，对大文件/长时间无换行日志有内存峰值风险。
- 2026-08-24 已修复：`packages/core/src/tail.ts` 现在以 64 KiB 固定块扫描换行，并用 `StringDecoder` 分块组装完整行；位点提交、轮转和多源继续处理语义保持不变。
- 回归证据：`packages/core/tests/tail.test.ts` 覆盖大增量分配上限、部分行、多源、UTF-8 跨块和超长尾行补全，定向测试 10/10 通过。
- 状态：**已关闭（代码/单测）**；真实长时间日志压测仍列为发布前现场验证项。

#### [L-02] 危险操作确认体验不统一

- 2026-08-24 已修复：新增 `ui/src/components/DangerConfirmModal.tsx`，Settings 的熔断解除/备份还原和 Gateway 的补丁应用/恢复统一使用应用内确认层。
- 确认层展示目标对象、影响范围、备份/写入步骤和冻结后的参数；确认前不调用 API，并提供 Escape、Tab 焦点限定、焦点回收和忙碌态。
- 回归证据：`apps/web/tests/ui-confirmation.test.ts` 定向测试 2/2 通过；UI Vite 构建和 ESLint 通过。
- 状态：**已关闭（代码/UI 构建/静态回归）**；真实桌面与移动浏览器点击、遮罩和焦点 smoke 仍列为发布前验收项。

#### [L-03] 备份保留口径容易混淆

- 升级快照仍保留 3 份；M7 日常备份按类型保留 full=14、memory=24、event=10。
- 代码层已通过 `/api/butler/self` 和 `/api/backups` 返回各自的保留上限；Settings 现在分开显示“升级快照”和“日常备份”，并展示当前升级恢复点占用。
- 状态：**已关闭（代码/API/UI/静态回归）**；真实升级回滚和跨重启轮转仍需发布前现场验收。

## 6. 范围蔓延与额外功能

| 额外实现 | PRD 归属 | 审计判断 | 风险 |
|---|---|---|---|
| Hermes Bridge + L3 出站接管实验代码 | PRD 明确不进入 V1 | **已隔离的范围蔓延** | 不得重新接入生产适配器或默认部署 |
| 完整消息 outbox、任务投影、DND、AIMD、预热 | P1/扩展点就绪后 | **提前实现** | 两套 SQLite 投影与同步游标扩大状态空间和故障面 |
| `prompt_targets/versions/candidates/evaluations` | 不属于 M5 的“入站消息预处理”主定义 | **需求外扩展** | 把提示词文件生命周期管理混入 V1 内核数据模型 |
| M6 归档/恢复/物理删除/索引重建/导出 | P1/P2 | **提前暴露** | 破坏 V1 只读承诺并引入数据删除风险 |
| M5 Bridge 规则/LLM 入站优化 | P1 | **提前实现，方向基本相关** | 依赖未交付，且与违规 L3 Bridge 绑定 |
| 诊断报告、较完整备份管理 | P1/V1.1 中部分能力 | **可接受提前实现** | 只要不挤占 P0 修复且真实边界明确，可保留 |

范围蔓延本身不总是缺陷；当前主要风险是实验性消息接管代码仍在仓库，必须继续保持与 V1 生产路径隔离，同时优先补齐真实安装、通道和升级回滚证据。

## 7. 关键业务流程审计

| 业务流程 | 目标流程 | 当前实现 | 结论 |
|---|---|---|---|
| 新机安装 | 检测环境 -> 国内源切换 -> 安装 -> 启动三服务 -> 接微信 -> 健康确认 | Docker/OpenClaw 核心链路已可构建并 healthy；宿主常驻服务、真实微信接入和无冲突新机证据仍缺 | **部分符合** |
| 日常巡检与自愈 | 定时探针 -> 指纹聚合 -> runbook -> 熔断/告警 -> 审计 | 主链存在且结构清晰；默认 5 分钟巡检，熔断活动状态可跨重启恢复 | **部分符合**，仍缺最坏时刻 SLA 故障注入与 UI 真实状态闭环 |
| Hermes 消息治理 | V1 仅补丁 + 观察，不进原生消息路径 | 默认 Gateway 生产入口未装配 message launcher；独立 Bridge/launcher 实验路径仍不具备 fail-open | **部分符合**，默认边界已隔离，实验交付不可用 |
| 进化守门 | 预检 -> 快照 -> 引擎运行 -> 可信指标 -> gate -> 唯一 promote | 预检/台账/gate/promote 均有代码层门禁，真实引擎运行和现场验收缺失 | **部分符合** |
| 被管实例升级 | 预检 -> 一致快照 -> 拉取 -> 补丁重打 -> 验收 -> 失败回滚 | 步骤基本齐全 | **部分符合**，数据一致性和真实 smoke 不足 |
| 管家自身升级 | 自身快照完成 -> 升级 -> 健康验收 -> 回滚 | 自身升级与被管实例升级入口均等待备份成功；真实运行证据仍缺 | **部分符合** |
| 记忆管理 | V1 只读；P1 写前快照、审计、确认 | V1 HTTP/UI 默认只读；写驱动保留但写前快照失败会 fail-closed | **符合（边界层）** |

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
4. 升级快照对 SQLite 使用 `VACUUM INTO` 并在登记前执行 `PRAGMA integrity_check`；真实回滚后的数据对账证据仍缺。
5. 消息轨迹 7 天保留和 Bridge/Gateway 状态表清理已在代码层实现；仍需在真实 Bridge 长时间运行、重启和升级验收中确认定时清理、附件 spool 回收与运维告警行为。

## 9. 接口与契约审计

### 9.1 符合项

- Manifest schema、契约版本校验、统一 `Result`、错误码表、实例生命周期和能力报告均有对应实现。
- I-1 的 detect/capabilityScan/logSources 结构清晰，capabilityScan 基本按能力逐项判定。
- I-2 有宿主与 Docker 双执行器、幂等控制、Job、快照、回滚和配置校验接口。
- I-4 的只读枚举、统计、preview 上限 50、完整性探针和目录降级路径已落地。

### 9.2 不符合项

1. Hermes manifest/运行时能力已固定为 L2；Bridge/message launcher 仍作为独立实验代码保留，默认生产入口未装配，真实控制面验收仍缺。
2. CapabilityRouter 已由 `core.invoke({ capability })` 接入 Skills/Memory 与全部 watch 控制业务路径；发现阶段直连仅限 detect/capabilityScan/logSources，真实控制面验收仍缺。
3. `validateConfig` 已被升级预检、补丁 apply/reapply 以及 Hermes/OpenClaw 的 start/restart 入口消费；Hermes 升级流水线内部的 stop/start/snapshot/rollback/validateConfig 现也统一经过注入的 `core.invoke` 能力路由，代码层旁路已进一步收口；仍需补真实控制面验收。
4. SkillDriver.validate 只校验名称/版本，见 `packages/adapters/hermes/src/drivers/skill.ts:300-307`；没有实现契约描述的 frontmatter 完整性、trigger 正则可编译、依赖存在或风险扫描。OpenClaw 相关部分属 V1.5，但通用接口语义仍未兑现。
5. V1 HTTP/UI 默认隐藏 M6 archive/restore/purge/rebuild/export 写入口，驱动层写方法仍保留以供后续版本，需持续防止旁路接线。
6. Bridge 使用额外 HTTP 服务和 token 文件，但不在 Compose/installer 的部署契约中；默认生产入口已隔离，实验 launcher 仍需显式 feature flag 和独立交付契约。

## 10. P1/P2/V1.5 愿景矩阵

| 后续范围 | 当前状态 | 审计说明 |
|---|---|---|
| V1.5 OpenClaw L0-L2 + 首批格式驱动 + 多实例大盘 | **部分实现** | OpenClaw L0-L2 适配器、只读技能/插件/记忆驱动、Docker 一键安装基线已落地；真实消息通道、Gateway WebSocket/出站 hook、升级/回滚和多实例 UI 仍需验收 |
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
- Settings 已展示真实熔断状态并提供人工解除；浏览器端完整交互和时间线证据仍待补齐。
- 危险操作仍混用原生 confirm，影响一致性和影响范围说明，但属于低风险体验项。
- 截图证据位于 `.workbuddy/audit-*-202316.png`。

## 12. 整改建议与发布门槛

### 12.1 第一阶段：恢复 V1 边界，关闭阻断项

1. **保持 Hermes L2 与消息实验隔离**：manifest/正式适配器继续不申报 messaging；普通 Gateway 入口不装配 message launcher，并为实验路径补显式 feature flag、启动审计和独立交付说明。
2. **完成双形态交付证据**：Docker/OpenClaw 基线已能构建并 healthy；继续补齐宿主形态 service/start 常驻、端口冲突前置检查，并在全新 Linux/WSL 环境跑通宿主与容器安装。
3. **满足 10 分钟 SLA**：关键记忆探针独立高频调度已落地；发布前必须在真实 Hermes 上做“最坏触发时刻”故障注入，导出发现、runbook、告警时间线。
4. **完成真实升级证据**：运行相邻版本补丁重打、已知回归版本自动回滚、SQLite 完整性与数据对账；保留现有 fail-closed 备份门禁。
5. **完成配置时间线验收**：在真实 start/restart/upgrade/apply 旁路上记录 30 秒复验、告警和拒绝事件。

### 12.2 第二阶段：收敛接口和超范围功能

1. 保持新增业务接线统一使用 `createRoutedControl`/`core.invoke({ capability })`，并在真实 Hermes/OpenClaw 控制面验收中验证拒绝、降级与恢复事件。
2. V1 隐藏 M6 写入口；P1 重新启用时采用 fail-closed 快照和内核物理删除路径。
3. M6 分类、来源维度和插件风险标记已在代码层收口；发布前补真实资产扫描与现场验收。
4. 将完整消息接管与 `prompt_*` 数据模型放入明确 feature flag/实验分支，避免污染 V1 默认运行面。
5. 接管实验路径的 maxAttempts、7 天清理和显式 feature flag 已在代码层收口；继续保持 Hermes L2 隔离，并补真实 Bridge 长时间运行、升级和现场消息验收。systemd unit 猜测风险已关闭，熔断 UI 真实状态与人工解除审计已完成。

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
- 2026-08-24 OpenClaw Docker 真实验收：Node `24.15-bookworm-slim` 安装 `openclaw@latest`，Gateway token + LAN 绑定，`openclaw`、`butler-gateway`、`butler-watch`、`butler-web` 均为 `healthy`。
- 同次验收：Web `http://127.0.0.1:17531/api/health` 返回 `{"ok":true,"db":true,"gateway":true}`；Watch `/healthz` 返回 `{"ok":true}`；诊断报告检出 `openclaw-main`；`/home/openclaw/.openclaw/openclaw.json` 存在；Compose 配置确认 command/healthcheck 使用 `$$OPENCLAW_GATEWAY_TOKEN`。
- `corepack pnpm test`：93 个测试文件通过、1 个跳过；801 个测试通过、3 个跳过。
- Ubuntu-24.04 Hermes venv Bridge：`unittest discover` 114 项通过；`compileall` 通过。
- `corepack pnpm lint`：通过。
- `corepack pnpm build`：通过。
- Hermes control 定向测试：47/47 通过，覆盖显式/未配置 systemd unit。
- Hermes real smoke：3 项全部跳过，原因是未设置 `RUN_REAL_SMOKE`。
- Windows/WSL UI 构建已由 `corepack pnpm build` 覆盖通过。
- 本机 Chrome headless 已完成桌面和 390x844 移动端截图核对。

- 本轮安装器回归：`packages/installer/tests/install.test.ts` 32 项通过，覆盖宿主 user-systemd unit、systemd 写入/启停、健康门禁失败回滚、dry-run 零写入、非 Linux fail-closed，以及 Docker 形态回归；未执行真实 user-systemd 写入或服务重启。
- 本轮 M1 SLA 增量：`apps/watch/tests/watch.test.ts` 与 `apps/watch/tests/scheduler.test.ts` 共 19 项通过，覆盖关键探针告警队列、`runbookAuto=false` 仍告警、漏 tick 与 deadline 逾期时间线；宿主安装器现场启动验收仍被既有 `127.0.0.1:7532` 端口占用和未获授权的真实服务写入/重启操作阻断。
- 本轮 WSL 只读复核：Ubuntu-24.04 返回 Node `v24.14.1`、Corepack pnpm `10.20.0`，`systemctl --user show-environment` 成功；`butler-watch.service`、`butler-web.service`、`butler-gateway.service` 均为 `inactive`，`127.0.0.1:7532` 已被既有 Hermes 进程占用。未写入 unit、未启动/停止服务、未执行消息外发。

### 13.2 增量复核：OpenClaw 升级回滚

- **已收口（代码层）**：OpenClaw `upgrade()` 现在先做配置不变式校验并记录当前 `openclaw --version`，再创建可追踪的升级前快照；npm 安装失败、升级后配置校验非零、损坏 JSON 或 `valid:false` 均触发数据目录与旧 npm 包版本恢复。
- **失败语义**：`skipSnapshot=true` 明确返回“无法自动回滚，需要人工介入”；文件恢复或旧包恢复任一失败返回 E204，并把人工介入写入用户提示，避免误报成功。公开 `snapshot/rollback` 行为保持契约兼容。
- **回归证据**：`packages/adapters/openclaw/tests/smoke.test.ts` 10/10 通过，覆盖成功幂等、安装失败、`valid:false`、损坏 JSON、skipSnapshot 和回滚失败；`tsc -b --pretty false` 通过。
- **状态影响**：OpenClaw M2 升级失败回滚的代码缺口已关闭；V1 验收 5 仍为未通过，因为真实已知回归版本升级、相邻版本验证、数据完整性对账和现场恢复证据尚未执行。

### 13.3 审计限制

- 未连接真实 Hermes/OpenClaw 微信账号、未完成宿主形态全新环境和已知回归版本验收；Docker 交付基线已在本机容器完成，但使用临时 `17531` 端口规避既有宿主进程占用 `7531`，不能替代无冲突新机证据。
- 工作区存在大量未提交和未跟踪内容；本审计未回退或整理这些改动，结论针对 2026-08-24 当前工作树。
- PRD 中引用的第三方事实不在本次审计范围；本报告核对的是仓库实现是否遵循 PRD 已定口径。

## 14. 最终判定

**V1/P0：不符合，禁止按 V1 发布。**

最短合规路径不是继续补齐 P1 功能，而是保持 Hermes L2 与消息实验隔离、完成双形态可运行交付、补齐 10 分钟 SLA 与真实升级回滚证据，并用五条真实验收建立发布证据。M4 门禁、SQLite 一致性快照、升级前备份、配置校验和能力路由已在代码层收口；P1/P2/V1.5 的未实现项应保留在路线图，不应继续与 V1 默认运行面混合。
