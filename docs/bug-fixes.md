# Bug Fixes

## 2026-08-22 · Hermes runtime 接入仍可能绕过 A2A Outbox，安装后失败也可能残留半成品

- 问题：真实 A2A 在任务 finalize 时会直接调用 `_send_push_notification()`，即使 agent `send()` 已纳入 Butler，callback 仍可绕过 Outbox；重复平台入站的首见时间不同会被误判为同 ID 异内容；安装器初版在全部写入后的最终 `check` 失败时没有自动恢复。
- 风险/影响：A2A callback 可跳过免打扰、聚合、AIMD 与审计；平台重投可能触发冲突或重复任务；编译后静态核验失败可能让真实 Hermes 留在部分安装状态。
- 改动范围：文件尾单点 hook 统一接入 Gateway 生命周期、adapter attach、入站、run/progress、API JSON/SSE 和 A2A；A2A 原 callback 创建路径改为只向 wrapped `send()` 排队，真实 HTTP callback 仅由 `butler_deliver_push` 执行并在成功后消费配置；入站按稳定路由字段幂等；安装器增加全量预检、原子替换、post-hash、最终 check 自动恢复和 hash 守卫 rollback，静态覆盖明确标注 `staticOnly`。
- 回归测试：覆盖普通通道 started/progress/completing/failed、失败消息 urgent、重复入站不重跑、API JSON/SSE 单次捕获且不调用 `send()`、A2A waiter/push/失败保留 callback/成功消费 callback/原 push 旁路替换，以及安装幂等、部分 marker/锚点漂移零写入、中途失败恢复、最终 check 失败恢复、rollback 漂移拒绝。
- 验证命令：WSL Hermes venv 下执行 Bridge 全量 `unittest discover`（71 passed）、`compileall`、真实 Hermes 四模块 disposable-process hook import、真实根目录 installer `check` 前后 SHA/Git 状态比对和 `git diff --check`。
- 部署/运行验证：真实 `/home/jiach/.hermes/hermes-agent` 仍未写入、安装或重启；只读检查确认四个目标可安装，Weixin SHA 仍为 `39b9dccd39dfe4442794c5373433dfb1198e6a195f5d732412e842efa2a4d220`，用户已有 `weixin.py` 修改与备份状态不变。消息网关尚不能据此宣称在线。

## 2026-08-22 · Bridge 可能把 A2A 丢弃误报为成功并在重启后虚报适配器覆盖

- 问题：真实 Hermes A2A `send()` 在没有 live waiter 时会丢弃正文但仍返回成功，API Server 的 `send()` 也不是 HTTP 最终响应出口；普通 adapter 的直接本地媒体方法此前可绕过 Butler Outbox。Task 3 审查还确认 `BridgeRuntime` 正常 stop/start 后会保留旧 coverage 键。
- 风险/影响：A2A 主动消息可能被标成 delivered 但实际无人收到，API Server 可能被错误套用无效发送路径，本地媒体会绕过 DND/聚合/配速；runtime 重启后尚未重连 adapter 时，健康接口仍可能虚报旧路径为 `ok`。
- 改动范围：新增按 channel/profile/account 生成的稳定 adapter id 与重连替换；A2A 仅在 live waiter 存在时走 `inline-response`，无 waiter 时进入 `queued-push` 并只允许显式 `butler_deliver_push`；API Server 只登记覆盖、不包装 `send()`；本地图片/文档/视频/语音先复制到私有 spool，再通过内存中的原生方法投递；公开消息视图不返回 delivery route 或 spool 路径；runtime reset 同时清空动态覆盖事实。
- 回归测试：覆盖重复 attach、同账号多 profile、重连对象替换、A2A waiter/no-waiter、缺失 push hook 显式 `retry_wait`、API Server 原方法保持、直接文档源文件删除后仍由 spool 投递、旧 Outbox 增量迁移，以及 stop/start 后不残留 adapter coverage。
- 验证命令：WSL Hermes venv 下执行 Bridge 全量 unittest、`python -m compileall -q packages/adapters/hermes/bridge/agent_butler_bridge` 与 `git diff --check`；同时对照真实 Hermes A2A pending 结构和四个本地媒体方法签名。
- 部署/运行验证：本阶段没有写入、安装或重启 `/home/jiach/.hermes/hermes-agent`；A2A push hook、API JSON/SSE finalizer 和真实覆盖探针仍需 Task 4 安装器与 Task 8 运行验收，当前不得宣称消息网关已在线。

## 2026-08-22 · Bridge 消息已落盘但入站、run、附件和受控终态没有闭合关联

- 问题：既有 Outbox 虽有基础 `task_events`/`inbound_messages` 表，但事件 sequence 由调用方任意提供、没有 run 生命周期记录或入站绑定更新；wrapper 只落正文，临时附件可能在延迟投递前消失；也没有 Butler 可审计的 `dead_letter` 转换接口。
- 风险/影响：UI 和策略层无法可靠从入站追到 run 与最终出站，重复/乱序事件可能污染任务视图；源附件被清理后会出现“正文已接管、附件丢失”；错误消息只能停在非终态或被非受控修改，且 `delivery_unknown` 容易被误归类后触发重复风险。
- 改动范围：新增事务化 `task_runs` 与 per-run sequence 分配、event-key 幂等、入站绑定刷新、`GET /v1/tasks/{runId}`、受 hash 保护且拒绝 `delivery_unknown` 的 dead-letter API/审计；新增 `contextvars` 关联继承、私有附件 spool、SHA-256/大小/数量校验、路径穿越防护和不含绝对路径的公开附件视图。
- 回归测试：覆盖嵌套/并发上下文、run started/progress/completing/done 严格序列、终态幂等与拒绝回退、supersedes、媒体型空文本入站、旧 task schema 迁移、dead-letter 冲突、附件删除后仍可读、超限清理、symlink/目录穿越拒绝，以及 HTTP 任务关联。
- 验证命令：WSL Hermes venv 下执行 Bridge 全量 unittest、`python -m compileall` 和 `git diff --check`。
- 部署/运行验证：当前仍只使用临时 SQLite、随机 loopback HTTP 和临时附件目录；真实 Hermes hook、API Server/A2A 捕获与外部通道投递尚未安装，不能据此宣称消息网关已在线。

## 2026-08-22 · Bridge 只有 HTTP 工厂，没有可由真实 Hermes 持有的安全生命周期

- 问题：已有 Bridge 只提供 `Outbox`、adapter wrapper 和 `create_app()`，没有进程级 bootstrap、私密配置加载、监听生命周期或失败清理；真实 `hermes-gateway.service` 因而无法可靠启动 Bridge，端口占用等部分启动失败还缺少统一回收路径。
- 风险/影响：Butler 策略层即使全部通过测试，也无法连接真实 Hermes；若直接临时拼装，可能把 token 放进环境/日志、绑定非 loopback 地址、遗留 SQLite/HTTP 资源，或在重复启动时形成多个 Bridge 实例。
- 改动范围：新增 `RuntimeConfig`、`BridgeRuntime` 和进程级 singleton API；强制 loopback（除非显式不安全覆盖）、token 普通文件/属主/`0600` 校验、私密数据目录/Outbox 权限、幂等 start/stop、部分启动失败清理、真实随机端口 health 探测和动态 adapter attach 覆盖状态。
- 回归测试：覆盖重复 start/stop、进程 singleton、配置冲突、token 权限拒绝、非 loopback 拒绝、端口占用后清理重试、健康鉴权、policy 未安装状态和 attach 后健康更新；并重跑既有 server/wrapper 测试。
- 验证命令：WSL Hermes venv 下执行 `python -m unittest discover -s packages/adapters/hermes/bridge/tests -p 'test_*.py' -v`、`python -m compileall packages/adapters/hermes/bridge/agent_butler_bridge` 与 `git diff --check`。
- 部署/运行验证：当前仅在随机 loopback 端口运行真实 aiohttp/SQLite 临时实例；尚未安装或重启真实 Hermes，部署证据留待 runtime integration Task 8。

## 2026-08-22 · 策略层验证命令可能零测试空跑并错误报告成功

- 问题：Task 7 原计划调用三个 package 的 `pnpm test`，但这些 package.json 没有 `test` script；命令会退出 0 且没有测试输出。此前临时 focused Vitest config 位于 `.superpowers/`，又被本地 exclude 排除，无法作为可复现验证入口。
- 风险/影响：Contract、Hermes Adapter 或 Gateway 回归可能在未运行任何测试的情况下被误判为绿色，形成真实 Hermes 安装前的假验收。
- 改动范围：新增受版本控制的 `vitest.focused.config.ts`；Task 7 改为显式列出三包测试文件，并要求输出非零测试计数。
- 回归测试：显式运行 Contract、Adapter、Gateway 全部目标测试，确认 240 passed、3 个 real-smoke 按环境条件 skipped。
- 验证命令：`./node_modules/.bin/vitest run --config vitest.focused.config.ts packages/contract/tests/*.test.ts packages/adapters/hermes/tests/*.test.ts apps/gateway/tests/*.test.ts`。
- 部署/运行验证：不修改运行时；该修复只提高验收真实性。

## 2026-08-22 · 消息状态 API 可能回显底层 Bridge 错误中的认证信息

- 问题：Task 6 初版状态路由直接返回 `MessageGatewayService.lastError`，底层 HTTP/Bridge 客户端若把认证头或 token 片段写入异常文本，会被本地 API 和 UI 原样展示。
- 风险/影响：在 Gateway 被误绑定到非 localhost、浏览器调试日志被收集或多人共享机器时，可能泄露 Bridge bearer token 等敏感信息。
- 改动范围：公开状态只返回稳定的 `Hermes Bridge unavailable` 摘要；503 E302/E303 同样使用固定错误文本，内部 hint 和策略接口不返回底层异常。
- 回归测试：注入包含 `Authorization: Bearer` 的 worker 错误，验证 200 degraded 状态和 503 响应均不包含秘密片段。
- 验证命令：Gateway HTTP 测试、Gateway TypeScript 检查、受影响 ESLint 与 `git diff --check`。
- 部署/运行验证：当前仅 Fastify inject；真实 Bridge 网络故障脱敏将在 runtime integration 阶段复验。

## 2026-08-22 · 消息 worker 可能跨 Hermes 实例投递并错误处理空 runId

- 问题：Reconciler 从全局策略候选中直接取首条，未限定当前 `instanceId`；同时 Bridge 兼容载荷中的 `runId: null` 会进入进度聚合路径，可能跨无 run 消息聚合并在渲染摘要时调用 `null.slice()`。策略快照还保留调用方对象引用，安装后外部修改可让运行配置与已确认 hash 脱节。
- 风险/影响：多 Hermes 实例共享 Butler Store 时可能由错误实例执行策略和投递；无 run 的进度消息可能被吸收或导致 worker 周期失败；策略审计 hash 可能不再代表实际运行配置。
- 改动范围：候选查询支持并强制 Reconciler 按实例过滤；digest、holder 和任务事件读取统一拒绝非字符串 runId；策略快照保存规范化深拷贝；修复 Reconciler ESLint 错误。
- 回归测试：覆盖跨实例候选隔离、Bridge-null runId、快照调用方修改隔离，以及既有崩溃恢复、预热和投递用例。
- 验证命令：聚焦 Vitest、Gateway TypeScript 检查、涉及文件 ESLint 与 `git diff --check`。
- 部署/运行验证：本条仅验证 Butler 本地投影和假 Bridge；真实 Hermes 安装与运行验收仍属于后续计划。

## 2026-08-22 · 对账 worker 可能将后续进度错误用作较早消息的聚合 holder

- 问题：Task 5 对账阶段的 holder 查询只按全局 sequence 排序，未明确要求 holder 必须早于当前消息；在同一 run 同批出现“较早 final、较晚 task-progress”时，较晚进度可能被错误吸收。
- 风险/影响：较晚进度投影会被错误标为 `absorbed`，导致真实消息丢失，且违反进度聚合仅更新最早 holder 的顺序语义。
- 改动范围：`earliestActiveProgressHolder()` 仅接受 sequence 更小（同序时 messageId 更小）的同组 active task-progress；未触及 Bridge/Hermes 权威状态机。
- 回归测试：`apps/gateway/tests/message-reconciler.test.ts` 覆盖先 final、后 progress 的同批输入，断言只对前者作出决策。
- 验证命令：Task 5 聚焦 Vitest、Gateway TypeScript 检查、涉及文件 ESLint 与 `git diff --check`。
- 部署/运行验证：仅本地 SQLite/假 Bridge；没有连接或修改真实 Hermes。

## 2026-08-22 · Butler 消息投影在多实例与异常输入下可能失去确定性

- 问题：`MessagePolicyStore` 不能为首次仅含任务事件的 Bridge 批次显式指定实例；它过早过滤已到期的 DND 暂停规则；外部 Bridge/DND/配速/预热载荷在写入前缺少运行时验证；相同 Bridge sequence 的跨实例候选没有稳定平局规则。
- 风险/影响：多实例对账可能拒绝有效事件或错误归属，Task 4 不能自行完成时区/日程裁决，畸形载荷可能污染持久化投影，同序消息的处理顺序和故障恢复行为不可复现。
- 改动范围：`ingestBatch(batch, instanceId?)` 接受并校验显式实例；DND 查询只过滤 disabled 规则；所有 Bridge 和支持状态写入增加状态、枚举、必填字符串、数值范围、UTC 时间戳与 IANA 时区验证；候选排序固定为 sequence、instance、message；新增触发器中止事务的全量回滚回归。
- 回归测试：`apps/gateway/tests/message-store.test.ts` 覆盖首批/多实例 event-only、显式/信封不匹配、过期暂停规则保留、畸形消息/任务/入站/DND/配速/预热拒绝、SQLite 触发器回滚，以及跨实例同序排序。
- 验证命令：`corepack pnpm exec vitest run --config .superpowers/sdd/task-3-review-vitest.config.ts apps/gateway/tests/message-store.test.ts`；`corepack pnpm --filter @butler/gateway exec tsc -p tsconfig.json --noEmit`；受影响文件 ESLint；`git diff --check`。
- 部署/运行验证：仅验证本地临时 SQLite 文件；未修改真实 Hermes 或 `apps/gateway/src/index.ts`。
- 协议兼容后续修复：Python Bridge 会将缺失的出站和入站可选路由字段序列化为显式 `null`，而 TypeScript 校验器此前只接受 `undefined` 或字符串，导致有效 Bridge 批次在持久化前被拒绝。现在这九个字段仅接受 `undefined`、`null` 或非空字符串；数值等其他类型仍拒绝。`message-store.test.ts` 使用真实 null 形状的批次确认投影和游标推进，并将 SQLite 中止触发器移到最后的 cursor 写入，以确认消息、入站、任务事件/投影和游标均回滚；同时删除兼容修复后遗留的未使用校验 helper，恢复受影响文件 ESLint 通过。

## 2026-08-22 · 进度聚合与免打扰策略可能提前发送或永久卡住消息

- 问题：Task 4 初版未使用 `digest.windowSec`，首条进度可能立即进入 ready；后续进度被标记 absorbed 时没有同步更新最早 holder 的正文；`held_dnd` 决策缺少下一次释放时间，而本地候选查询只重取到期的 held 消息；AIMD 拥塞更新还可能把已有更晚冷却缩短。
- 风险/影响：长任务仍可能高频打扰用户，聚合简报丢失后续状态/ETA，普通免打扰消息可能永远不再进入策略循环，连续限流时可能过早恢复发送。
- 改动范围：进度 holder 在聚合窗口结束前进入带 `availableAt` 的 `held_pacing`；吸收较晚进度前先用 companion decision 更新最早 holder；只允许非终态候选作为 holder；DND 纯函数计算临时暂停、普通/跨午夜窗口和多规则的下一次 inactive 时刻并写入裁决；拥塞冷却取已有冷却、Retry-After 和降速后单间隔三者最大值。
- 回归测试：`apps/gateway/tests/message-policy.test.ts` 新增首条进度窗口、holder 更新、终态 holder 拒绝、暂停/跨午夜 DND 释放时间、held 决策携带释放时间，以及不缩短已有 AIMD 冷却；聚焦套件 15/15 通过。
- 验证命令：聚焦 Vitest；`corepack pnpm --filter @butler/gateway exec tsc -p tsconfig.json --noEmit`；Task 4 涉及文件 ESLint；`git diff --check`。
- 部署/运行验证：仅验证纯策略与本地测试夹具；未修改真实 Hermes、Bridge 或 `apps/gateway/src/index.ts`。真实投递行为留待 Task 5 worker 和后续 WSL 故障注入验收。

## 2026-08-21 · 已有 Hermes 手工补丁被错报为“未应用”

- 问题：Butler 补丁面板只读取自身 `state.json`；开发环境使用临时 `BUTLER_HOME` 时没有旧状态，真实 `weixin.py` 中已经运行的发送节流、首条冷却和回复整形仍被显示为“未应用”，再次点击应用会因官方锚已被改写而返回 409。
- 风险/影响：用户会误判真实消息保护未生效，并可能反复尝试写入真实 Hermes 源码；面板同时展示 PRD 默认值 `45/20`，与当前源码及运行配置的 `30/30/1/2000` 不一致。
- 改动范围：补丁登记新增只读语义识别器；无纳管状态时从当前源码识别三层手工实现并提取参数，漂移报告返回 `observed` 且不写状态文件。Watch/Web/UI 新增独立 `observed` 数据，不伪造 `appliedAt`；页面区分“已纳管 / 手工已生效·未纳管 / 未应用”，手工状态下参数只读并禁用应用、重打。限流建议优先采用 observed 实际值。底层补丁应用契约保持不变，避免影响升级流水线；真实手工状态的防误写由网关面板层承担。
- 回归测试：`packages/adapters/hermes/tests/patch-manager.test.ts` 覆盖空状态 + 手工源码识别为 `30/30/1/2000`、不写 `state.json`；`apps/watch/tests/gateway-stats.test.ts` 覆盖 observed 面板映射、实际参数建议与写入口拒绝；`packages/adapters/hermes/tests/upgrade-pipeline.test.ts` 覆盖升级只重打 Butler 已纳管补丁、跳过 observed 手工实现；HTTP/Web 契约测试覆盖新增字段。
- 验证命令：`corepack pnpm exec tsc -b --pretty false`；`corepack pnpm exec vitest run packages/adapters/hermes/tests/patch-manager.test.ts apps/watch/tests/gateway-stats.test.ts apps/watch/tests/http-gateway.test.ts apps/web/tests/gateway.test.ts --maxWorkers=1`；`corepack pnpm exec vite build ui`；涉及文件 ESLint/Prettier；`git diff --check`。
- 部署/运行验证：真实 Hermes 源文件保持不写；通过 `/api/gateway` 校验三条补丁均为 `observed`，参数为 `30/30/1/2000`，并保留手工备份 `/home/jiach/.agent-butler/manual-backups/agent-butler-20260821-before-weixin-patches/weixin.py`。
- 残余风险：Butler 当前 runbook 默认查找 `hermes.service`，而真实服务单元为 `hermes-gateway.service`；在修复服务单元解析前，不使用面板 `rb-restart` 重启真实 Hermes。

## 2026-08-21 · 真实 Hermes 被旧实例记录卡在 Discovering

- 问题：Butler 数据库中已有 Trae 开发期写入的空 Hermes fixture；Watch 重启后发现同名实例时只复用旧记录，没有用本轮探测结果刷新根路径、版本和证据，也没有继续未完成的生命周期状态。
- 风险/影响：真实 `/home/jiach/.hermes` 已存在且 Hermes 正在运行，但 UI 仍显示空数据或降级状态，技能与记忆驱动无法绑定到真实实例。
- 改动范围：Watch 在重复发现实例时刷新 `rootPath`、`version`、`confidence` 和 `evidence`，并让 `Registered`、`Discovering`、`Confirmed`、`Offline` 状态继续完成协商；已有 `Serving` 实例保持服务态。
- 回归测试：`apps/watch/tests/watch.test.ts` 新增“重启时从持久化 Discovering 状态继续协商并刷新真实根路径”。
- 验证命令：`corepack pnpm exec vitest run --project @butler/watch tests/watch.test.ts --maxWorkers=1`；`corepack pnpm exec tsc -b --pretty false`。
- 部署/运行验证：WSL Watch 返回 `hermes-main`、`Serving`、版本 `0.20.4`；`/api/skills` 返回 driver 模式的 202 个技能和 60 条记忆。

## 2026-08-21 · 开发联调自动巡检可能写入真实 Hermes 记忆

- 问题：Watch 启动后会自动执行首轮巡检，记忆探针包含写入与召回，连接真实 `~/.hermes` 时会无提示产生 `butler-probe` 测试记忆。
- 风险/影响：只想查看真实数据的开发联调也会修改用户记忆库，污染资产统计并违反只读预期。
- 改动范围：新增 `BUTLER_AUTO_START` 配置；设为 `false` 时不自动执行首轮巡检，但 HTTP 只读接口和用户手动“立即巡检”仍可用。真实 Hermes 开发服务当前使用 `BUTLER_AUTO_START=false`。
- 回归测试：`apps/watch/tests/watch.test.ts` 覆盖关闭自动启动后不执行首轮巡检，同时保留显式巡检能力。
- 验证命令：`corepack pnpm exec vitest run --project @butler/watch tests/watch.test.ts --maxWorkers=1`；`corepack pnpm exec tsc -b --pretty false`。
- 部署/运行验证：Watch/Web 连接真实 WSL Hermes 后只读取得技能与记忆统计，启动期间没有触发记忆写入探针。

## 2026-08-21 · 全站暗色后台壳与 PRD 原型不一致

- 问题：Dashboard、版本、消息网关和设置页仍沿用早期暗色后台样式，设置页还是占位内容；这与 PRD 明确给出的浅灰背景、白色侧栏、紫色主色和模块化工作台原型不一致。
- 风险/影响：页面之间视觉断裂，用户会误以为只有部分模块完成；安全基线、告警降级和快照状态也无法从 UI 发现。
- 改动范围：统一应用壳和 M1/M2/M3/M7 页面为 PRD 浅色紫色体系，导航增加模块编号与副标题；设置页接入真实安全基线、告警网关和快照数据，未完成的 Task 18 能力明确标注“建设中”。同时修复 390px 下网关补丁说明中的长变量名撑宽页面问题。
- 回归测试：浏览器逐页验证 `/dashboard`、`/versions`、`/gateway`、`/evolution`、`/skills`、`/settings`；桌面端检查浅色背景和真实状态，390×844 检查无横向溢出。
- 验证命令：`corepack pnpm exec tsc -b --pretty false`；`corepack pnpm exec vitest run --maxWorkers=4`；`corepack pnpm exec vite build ui`；`git diff --check`。
- 部署/运行验证：开发服务器 `http://127.0.0.1:5173` 使用 PRD 色板 `#F6F6FB / #4B3FE3`；六个路由均显示同一浅色产品壳，并通过 Vite 代理读取 WSL Web/Watch 数据。

## 2026-08-21 · 技能与记忆页面只有占位内容，格式降级不可见

- 问题：Task 17 原先只有 `/skills`“建设中”占位页，Hermes 适配器虽在 manifest 声明 `hermes-skill` / `sqlite-fts5`，但未交付真实驱动、API 或检索预览；非默认格式也没有按 PRD 明示降级。
- 风险/影响：用户无法盘点技能名称、版本、来源与启停状态，也看不到记忆条目数、按月分布、冷候选和停写信号；格式漂移时页面只能空白，容易误判资产丢失。
- 改动范围：新增 Hermes 技能/记忆只读驱动、Watch 聚合服务、Watch/Web `/api/skills` 端点和 PRD M6 浅色双栏页面；检索预览固定钳制到 50 条，过滤 `butler-probe` 测试记忆，驱动不识别时执行有界目录统计并明示“暂不支持解析/写入”；全部写方法固定返回 `E403`。
- 回归测试：`packages/adapters/hermes/tests/drivers.test.ts`、`apps/watch/tests/skills.test.ts`、`apps/watch/tests/http-skills.test.ts`、`apps/web/tests/skills.test.ts`，覆盖清单解析、版本/来源保持、只读拒绝、统计、FTS 查询、50 条上限、目录降级、无实例和畸形上游载荷。
- 验证命令：`corepack pnpm exec tsc -b --pretty false`；`corepack pnpm exec vitest run --maxWorkers=4`（542 passed / 3 skipped）；`corepack pnpm exec vite build ui`；Task 17 涉及文件 ESLint 与 Prettier 检查。
- 部署/运行验证：隔离开发环境 `http://127.0.0.1:5173/skills`、Web `:7531/api/skills`、Watch `:7533/api/skills` 均已验证；另对真实 WSL `~/.hermes` 只读验证得到 202 个技能、60 条用户记忆与 3 条受限预览，不输出记忆正文、不执行写入。

## 2026-08-21 · 移动端固定侧栏挤压页面为不可操作窄列

- 问题：全局 `.sidebar` 在 390px 视口仍固定占用 216px，`/skills` 等页面只剩约 174px 内容宽度，标题、表单和资产列表严重截断。
- 风险/影响：移动端无法正常浏览或操作；新增页面即使自身响应式正确，也会被旧应用壳破坏。
- 改动范围：在 760px 以下将应用壳切为纵向布局，侧栏变为顶部横向可滚动导航，品牌区压缩，内容区恢复完整视口宽度；不改变桌面端导航结构。
- 回归测试：Windows Edge headless 分别以 1440×1100 与 390×844 实际渲染 `/skills` 并检查导航、双栏折叠、表单与列表可见性。
- 验证命令：`corepack pnpm exec vite build ui`；Task 17 CSS Prettier 检查。
- 部署/运行验证：桌面端保持 PRD M6 左右双栏；390px 下导航转为顶部横向条，页面内容恢复单栏全宽。

## 2026-08-21 · Watch 组装测试与开发服务器争用固定端口

- 问题：`apps/watch/tests/watch.test.ts` 创建 Watch 应用时沿用默认 `127.0.0.1:7533`；开发服务器在线时，5 个组装测试全部因 `EADDRINUSE` 失败。
- 风险/影响：为了跑回归必须先停止用户正在实时验证的服务，容易造成误判，也让本应隔离的测试依赖机器当前端口状态。
- 改动范围：所有 Watch 组装测试显式配置 `watchHttpPort: 0`，由操作系统分配随机回环端口。
- 回归测试：保持开发服务器继续监听 7533，同时运行 `apps/watch/tests/watch.test.ts`。
- 验证命令：`corepack pnpm exec vitest run --project @butler/watch tests/watch.test.ts --maxWorkers=1`。
- 部署/运行验证：真实开发 Watch 保持在 `http://127.0.0.1:7533`，测试使用独立随机端口，两者可并行。

## 2026-08-21 · 进化产物缺少独立写入守门与负优化拦截

- 问题：Task 16 原先只有 `/evolution` 占位页，外部进化引擎完成后没有统一的预检、运行前快照、结果准入与可导出台账；负优化候选存在被当作成功产物写回技能库的风险。
- 风险/影响：依赖缺失、端点不可达或 holdout 过小的运行可能浪费资源；指标回落的候选若落盘，会直接降低技能效果并覆盖可用 baseline。
- 改动范围：新增 `apps/watch/src/evolution.ts` 守门服务，接入 Watch/Web API 与 `/evolution` 页面；三项预检全部通过后才快照 `skills + memory`，holdout `<10` 时拒绝并提供最小扩集路径，结果回落时固定 `allowWrite=false`、保留 baseline、发送 critical 告警并写 Markdown 台账。
- 回归测试：`apps/watch/tests/evolution.test.ts`、`apps/watch/tests/http-evolution.test.ts`、`apps/web/tests/evolution.test.ts`，并覆盖快照语义范围、预检拒绝、扩集重检、负优化、无显著提升、显著提升与导出。
- 验证命令：`corepack pnpm run build`；`corepack pnpm exec vitest run apps/watch/tests/evolution.test.ts apps/watch/tests/http-evolution.test.ts apps/web/tests/evolution.test.ts`；`corepack pnpm exec vite build ui`；`git diff --check`。
- 部署/运行验证：开发服务使用隔离的 `BUTLER_HOME=/tmp/agent-butler-dev/home` 与空 Hermes fixture；通过 `http://127.0.0.1:5173/evolution`、`GET /api/evolution` 和预检拒绝/台账导出路径验证，不触碰真实 Hermes。

## 2026-08-21 · 零增益候选可能被错误授予写入许可

- 问题：守门逻辑原先只判断 `delta < 0` 与外部 `significant` 标记；当 `candidate === baseline` 且上游误传 `significant=true` 时，会进入 `accepted`。
- 风险/影响：没有任何指标提升的候选可能覆盖 baseline，违反 PRD 中“±0.000 保持 baseline”的硬规则。
- 改动范围：准入条件收紧为 `delta > 0 && significant`；零增益无论显著性标记如何都返回 `kept-baseline`。
- 回归测试：`apps/watch/tests/evolution.test.ts` 将零增益场景显式设为 `significant=true`，断言仍不允许写入。
- 验证命令：`corepack pnpm exec vitest run --project @butler/watch tests/evolution.test.ts --maxWorkers=1`；`corepack pnpm run build`。
- 部署/运行验证：该修复只影响结果守门判定，不执行外部引擎、不写技能文件。

## 2026-08-21 · 进化页未按 PRD M4 暴露可操作路径

- 问题：原页面是暗色主题下的“建设中”文字，占位内容无法运行预检、执行扩集、提交结果或导出台账，且视觉结构与 PRD 的浅色紫色双栏原型不一致。
- 风险/影响：后端即使具备能力，用户也无法发现和操作，功能不构成产品闭环；“看起来已有页面”还容易掩盖关键守门缺失。
- 改动范围：将占位页替换为 PRD M4 对齐的浅色紫色双栏工作台，左栏为配置、实时预检、拒绝卡与扩集动作，右栏为结果守门、实验台账和 Markdown 导出；明确标注 V1 与完整 PRD 的能力边界。
- 回归测试：UI TypeScript 构建、生产构建、浏览器运行时检查与实际 API 联调。
- 验证命令：`corepack pnpm run build`；`corepack pnpm exec vite build ui`；开发服务器访问 `/evolution`。
- 部署/运行验证：在本地 Vite 5173 + Web 7531 + Watch 7533 环境验证；未全局重做其他页面主题。

## 2026-08-21 · Gateway 补丁服务严格类型构建失败

- 问题：`apps/watch/src/gateway-stats.ts` 在 `Result.ok` 分支直接读取可选的 `data`，全量 `tsc -b` 报 `TS18048` / `TS2322`。
- 风险/影响：局部 Vitest 可以通过，但仓库无法完成严格 TypeScript 构建；异常适配器若返回 `ok=true` 且缺少数据，还可能在网关控制路由抛出裸异常。
- 改动范围：仅收紧 Task 15 网关补丁 apply/reapply/detect 的成功结果判断，并为异常成功载荷增加防御性降级。
- 回归测试：`apps/watch/tests/gateway-stats.test.ts`、`apps/watch/tests/http-gateway.test.ts`、`apps/web/tests/gateway.test.ts`。
- 验证命令：`corepack pnpm exec tsc -b --pretty false`；`corepack pnpm exec vitest run apps/watch/tests/gateway-stats.test.ts apps/watch/tests/http-gateway.test.ts apps/web/tests/gateway.test.ts --maxWorkers=1`。
- 部署/运行验证：本次未写入真实 Hermes 源文件；通过 UI 生产构建与 Fastify 注入测试验证网关页面和代理契约。

## 2026-08-21 · Gateway 聚合响应缺少运行时结构校验

- 问题：`apps/web/src/server.ts` 将 watch/gateway 的 JSON 直接断言为面板类型；畸形的数组或状态字段可能进入 React，触发 `.map()` 或字符串方法异常。
- 风险/影响：任一内部服务发生版本漂移或返回部分损坏载荷时，`/gateway` 页面可能整体白屏，而不是按设计分区降级。
- 改动范围：在 web 聚合边界校验限流统计、补丁 schema、告警计数/列表；异常统计置空、异常补丁过滤、异常告警载荷切换到固定降级视图。
- 回归测试：`apps/web/tests/gateway.test.ts` 新增畸形上游响应场景。
- 验证命令：`corepack pnpm exec tsc -b --pretty false`；`corepack pnpm exec vitest run apps/web/tests/gateway.test.ts --maxWorkers=1`；`corepack pnpm exec vite build ui`。
- 部署/运行验证：未连接真实外部通道；Fastify 注入测试确认异常载荷返回 HTTP 200 降级视图，UI 生产构建通过。

## 2026-08-22 · 消息网关停止时可能在对账未完成前关闭投影库

- 问题：`MessageGatewayService.stop()` 原先只清除定时器并立即返回，无法等待已经进入 Bridge 对账的 cycle；Gateway runtime 若随后关闭 SQLite，仍在执行的对账可能写入已关闭连接。
- 风险/影响：服务退出、重启或启动回滚时可能丢失本轮投影、产生未处理的异步异常，甚至让 HTTP 状态与 WSL Outbox 游标短暂不一致。
- 改动范围：服务现在持有单一 start/cycle Promise，停止先阻止新 cycle、清 timer，再在可配置上限内等待；超时会明确失败并保持投影库打开，允许在 cycle 结束后重试停止。新增受管 Hermes 消息 runtime，只有安全停稳后才关闭投影库，启动失败自动回滚。
- 回归测试：`message-reconciler.test.ts` 覆盖 in-flight 超时与二次停止；`message-runtime.test.ts` 覆盖并发 start/stop 单 owner、策略先安装、启动回滚、私有 token 文件、投影重启保持和真实 Gateway HTTP 注入。
- 验证命令：Gateway `tests/message-*.test.ts`（54 tests）、`tsc -p tsconfig.json --noEmit`、涉及文件 ESLint/Prettier、`git diff --check`。
- 部署/运行验证：本条仅覆盖本地测试 runtime；真实 WSL Hermes 的安装、服务重启和消息投递仍须通过 Task 7/8 门禁后执行。

## 2026-08-22 · Hermes 消息能力被静态写死且无法由真实覆盖证据升级

- 问题：Hermes manifest 和 capability scan 仍把 messaging 固定为 `not-implemented`；同时 Bridge 健康响应虽有动态 coverage，却没有稳定的 `queuedSend/edit/media` 汇总行，导致受管 Bridge 即使安装也无法用统一证据证明 L3。
- 风险/影响：UI 会继续显示消息接管未实现，或在只验证端口/声明的情况下误报可用；畸形健康 JSON 还可能让整个能力扫描抛错。
- 改动范围：manifest 声明可探测的 L3 messaging，实际 effective level 仍由认证 Bridge 的协议、实例、Outbox、策略、通道和 12 项运行时覆盖矩阵共同决定；无配置保持 L2/unavailable，任一缺口为 degraded，完整实时证据才升到 L3。Bridge 对 adapter 级 queued/edit/media 状态做保守聚合，远端错误与畸形载荷固定脱敏降级。
- 回归测试：新增 `messaging-capability.test.ts` 覆盖无配置、部分配置、不可达、鉴权、协议、实例、只读 Outbox、无 adapter、无策略、通道降级、覆盖缺口、畸形 JSON、完整 L3 与 adapter discovery wiring；Bridge runtime/hooks 测试覆盖汇总矩阵。
- 验证命令：Contract/Adapter TypeScript、Hermes adapter Vitest、Bridge 全量 unittest/compileall、ESLint/Prettier、`git diff --check`。
- 部署/运行验证：本条尚未安装到真实 Hermes；真实状态在 Task 8 安装并运行 coverage/health probe 前必须保持 unavailable 或 degraded，不得宣称 L3 已正常工作。
