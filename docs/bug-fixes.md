# Bug Fixes

## 2026-08-22 · 远程图片与多图出口可绕过 Butler Outbox

- 问题：真实 Hermes 的 Weixin/WeCom 等适配器除本地文件媒体方法外，还公开 `send_image`、`send_animation` 和 `send_multiple_images`。原 Bridge 只包装本地文件媒体出口，因此这些远程 URL/多图方法仍可能直接调用平台原生发送；初版补丁还把所有媒体方法的 `None` 返回统一当作成功，而 Hermes 契约只允许 `send_multiple_images` 用 `None` 表示成功。
- 风险/影响：远程图片和多图可绕过聚合、免打扰、AIMD、幂等与审计；单图或本地媒体异常返回 `None` 时还可能被误记为 delivered，形成“界面显示已送达、平台实际未确认”的假成功。
- 改动范围：NativeRegistry 纳管三个远程媒体出口；wrapper 在捕获阶段只写 Outbox、不调用原生方法，投递阶段按原签名重放 URL、caption、多图列表和 human delay；Outbox 对 route 类型、数量、总大小和 delay 范围做闭合校验；仅多图的合法 `None` 返回归一化为成功，其他媒体仍按失败进入 `retry_wait`。
- 回归测试：覆盖远程图片、动画和多图捕获阶段原生调用均为 0，策略放行后每个方法恰好调用一次；覆盖多图 `None` 成功，以及单图 `None` 不得误报 delivered。
- 验证命令：WSL Hermes venv 下执行 Bridge 全量 `unittest discover`（73 passed）、`python -m compileall -q packages/adapters/hermes/bridge/agent_butler_bridge` 与 `git diff --check`；并对照真实 Hermes Base/Weixin/WeCom/Signal/Telegram/Discord 等方法签名。
- 部署/运行验证：已按旧 manifest 精确 rollback，再从当前仓库安装到真实 `/home/jiach/.hermes/hermes-agent`，新 manifest 为 `/home/jiach/.hermes/agent-butler/backups/installer/20260822T081153.872136Z/manifest.json`；Hermes 与 Butler Gateway 重启后 `media=ok`，本机 API JSON、API SSE 和带鉴权 A2A 回环使 live coverage 达到 `12/12 ok`。Hermes capability 实测 `effectiveLevel=3`、`messaging=ok`、无 anomaly；`weixin.py` SHA 仍为 `39b9dccd39dfe4442794c5373433dfb1198e6a195f5d732412e842efa2a4d220`。

## 2026-08-22 · WSL 临时后台进程与含空格工作目录导致 Butler Gateway 无法稳定常驻

- 问题：通过一次性 WSL shell 启动的临时后台 Gateway 会随宿主调用边界退出；直接把 Windows 工作区 `/mnt/c/Users/jiach/Documents/Agent Butler` 写入 user-systemd 启动命令时，含空格路径又会产生参数解析失败。
- 风险/影响：Bridge 虽在线，Butler 对账 worker 仍可能悄然消失，导致页面长期无真实消息数据、Outbox 不推进、能力状态停在 degraded；人工看到过一次进程或端口并不能证明服务可持续运行。
- 改动范围：改由 user-systemd 管理 `agent-butler-gateway.service`，以 `/home/jiach/.hermes/agent-butler/workspace` 符号链接指向 Windows 工作区，避免 unit 命令中的空格路径；服务仅使用本机 Bridge/token/投影路径并启用开机随 user session 启动。
- 回归测试：停止旧 `dist/main.js` 临时进程，连续检查 systemd active 状态、主 PID、`127.0.0.1:7532` 监听和 Gateway Web API；重启 Hermes 后确认 Butler Gateway 可独立恢复连接。
- 验证命令：`systemctl --user status agent-butler-gateway.service`、`systemctl --user show ... -p MainPID -p ActiveState -p SubState`、`ss -ltnp` 与本机 HTTP health/message API 检查。
- 部署/运行验证：user unit 已 enabled，工作区链接指向当前仓库；滚动部署后 `hermes-gateway.service` 与 `agent-butler-gateway.service` 均为 active/running，Bridge `127.0.0.1:8754`、Butler message API `127.0.0.1:7532` 正常监听，策略为 `message-policy-v1`，token/Outbox/projection 均为属主私有 `0600`。停机时 Hermes 产生的一条过时微信 shutdown 通知被 Outbox 捕获且未外发，随后以“未授权真实外发”为原因审计转入 `dead_letter`。

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

## 2026-08-22 · 消息工作台因 Bridge 合法 null 字段被安全校验错误降级为空

- 问题：Web 新增的消息代理最初只接受可选路由字段为字符串或缺省；真实 Bridge 会把 `accountId/threadId/replyTo/runId/inboundMessageId` 的缺失值显式序列化为 `null`。前三条带 run 的消息可通过部分查询，但包含无 run 死信的完整列表被判为畸形，UI 显示 0 条消息。
- 风险/影响：Gateway 状态计数仍显示 delivered/dead-letter，消息列表却为空，用户会误判投影丢失；若简单取消运行时校验，又会重新引入畸形上游载荷导致 React 崩溃的风险。
- 改动范围：Web 代理继续逐字段校验，仅把 Bridge 契约允许的五个可选路由字段扩展为 `undefined | null | non-empty string` 兼容形态；UI 明确把 `null` run 解释为“未关联任务”，不发起无效任务查询。
- 回归测试：`apps/web/tests/gateway.test.ts` 覆盖带 run 的 delivered 消息和 `runId/inboundMessageId=null` 的 dead-letter 同时出现，断言消息列表完整透传；畸形部分对象仍整体降级。
- 验证命令：Web/UI TypeScript 构建；`apps/web/tests/gateway.test.ts` 9/9；UI Vite 生产构建；真实 `/api/messages/overview?limit=60` 返回 `degraded=[]`、4 条消息。
- 部署/运行验证：WSL Web PID `2338887` 连接 Gateway `127.0.0.1:7532`，页面显示 `AB_JSON_OK`、`AB_SSE_OK`、`AB_A2A_OK` 与未外发 shutdown 死信；未发送任何第三方消息。

## 2026-08-22 · 长期运行的 Vite 未刷新挂载盘源码，实时入口继续显示旧暗色/观察模式页面

- 问题：Vite 从 2026-08-21 起在 WSL PTY 中持续运行，对 `/mnt/c` 文件变更没有刷新已缓存模块；生产构建已是新 UI，但 `http://localhost:5173/gateway` 仍返回“补丁与限流 / 不接管原生消息路径”的旧页面。
- 风险/影响：用户实时验证入口与源码、生产包不一致，容易把已经完成的浅色 UI 和严格接管能力误判为未实现；孤立 PTY 进程也没有清晰的运行状态和自动恢复能力。
- 改动范围：停止旧 Vite 父子进程，使用 `agent-butler-ui-dev.service` 受管运行 Vite；补齐 systemd 用户环境的 Node `PATH`。Gateway 顶部摘要调整为纵向信息层级，避免“严格接管/可写”在桌面与移动端被旧 flex 规则挤断。
- 回归测试：Windows Edge headless 访问 `http://localhost:5173/gateway`，验证浅色背景、导航“消息与节律”、严格接管、Outbox 可写、12/12、4 条真实消息、点击切换与 4 个任务事件；390×844 视口无页面横向溢出。
- 验证命令：UI TypeScript 构建与 Vite 生产构建；Playwright 桌面/移动截图；`systemctl --user show agent-butler-ui-dev.service`。
- 部署/运行验证：`agent-butler-ui-dev.service` active，Vite 监听 `0.0.0.0:5173` 并代理 Web `127.0.0.1:7531`；Hermes 未重启，外部消息未发送。

## 2026-08-22 · M5 提示词优化尚不能宣称闭环，先补齐只读 Registry/快照/门禁基础

- 问题：用户已批准 M5，但此前项目只具备消息网关确定性优化；提示词候选、评估、批准、canary、提升/回滚均未实现，容易在 UI 或汇报中把“提示词优化”误当成可用闭环。
- 风险/影响：若跳过登记、快照、保护段门禁与人工批准直接写 Hermes 提示词文件，可能弱化安全边界或修改用户不可覆盖规则，且缺少审计。
- 改动范围：在 M5 切片 1 实现 Prompt Registry（`prompt_targets`/`prompt_versions`）、`BUTLER_HOME/prompts/<targetId>/baseline-<sha>.txt` baseline 快照、由 Hermes guidance 常量提取的 protected clauses 静态门禁，以及只读 Watch/Web API 与 `/evolution` “提示词优化”页签；不写 Hermes 源文件、不触碰 Gateway/Outbox 热路径。
- 回归测试：`packages/core/tests/prompt-store.test.ts`、`packages/core/tests/paths.test.ts`、`apps/watch/tests/prompt-optimization.test.ts`、`apps/watch/tests/http-prompt-optimization.test.ts`、`apps/web/tests/prompt-optimization.test.ts`，覆盖未登记路径、源缺失、hash 漂移、保护段变化、未知字段、只读契约和 Web 降级。
- 验证命令：`pnpm exec tsc -b`；`pnpm exec vitest run --maxWorkers=4`（74 文件，638 passed / 3 skipped）；`pnpm --filter @butler/ui exec vite build`；涉及文件 Prettier/ESLint 检查通过。
- 部署/运行验证：尚未标记完整 M5；切片 1 保持只读，未启动真实 Hermes 写操作，后续候选生成、评估、批准、canary、提升/回滚必须逐项验收后再更新。

## 2026-08-22 · M5 切片 2：候选持久化与 baseline/holdout 成对评估

- 问题：切片 1 只交付 Registry/快照/静态门禁，候选与评估 API、SQLite 用例登记和 UI 可见状态均缺失；`POST /candidates/:id/evaluate` 路由未实际接线，且浮点均值会输出 0.8000000000000004 这类不稳定数值。
- 风险/影响：若继续宣称 M5 已闭环，或跳过 `<10` 硬拒绝、探索性区间与正式 `>=30` 门禁，会让弱样本或负优化候选进入后续人工批准/canary 流程；报告缺少可复现用例也不利于回滚审计。
- 改动范围：新增 `prompt_candidates`/`prompt_evaluations`/`prompt_evaluation_cases` 持久化与读写方法；候选快照落在 `BUTLER_HOME/prompts/<targetId>/`，权限目录 0700、文件 0600；评估写入成对指标、成功率、工具错误率、安全违规、P95、成本变化、失败样本与 paired normal-approx 95% 置信区间；`<10` 返回 rejected-insufficient，`10-29` 返回 exploratory 且 `canPromote=false`，`>=30` 通过门禁才 `approval-pending`；补齐 `/api/prompt-optimization/candidates`、`:id`、`:id/report`、`:id/evaluate` 的 Watch 路由，Web 代理与 `/evolution` 候选状态表；指标统一保留 10 位小数，报告 baseline hash 取实际 baseline 快照 `contentSha256`。
- 回归测试：`packages/core/tests/prompt-store.test.ts`、`apps/watch/tests/prompt-optimization.test.ts`、`apps/watch/tests/http-prompt-optimization.test.ts`、`apps/web/tests/prompt-optimization.test.ts`，覆盖候选创建/静态拒绝、三类 holdout、质量/安全拒绝、受控数据集路径、HTTP 状态码与 Web 降级；全量 `pnpm exec tsc -b`、`pnpm exec vitest run --maxWorkers=4`（74 文件，646 passed / 3 skipped）、`pnpm --filter @butler/ui exec vite build`、涉及文件 Prettier/ESLint 通过。
- 部署/运行验证：重启 WSL `agent-butler-watch-dev.service`/`agent-butler-web-dev.service`，在 `127.0.0.1:7533`、`127.0.0.1:7531`、`127.0.0.1:5173` 验证候选列表、创建与评估链路；使用 `/home/jiach/.hermes/SOUL.md` 原文创建 3 个候选（内容 hash 不变），分别以 2/12/30 条合成成对用例评估，确认 `rejected-insufficient`、探索性 `approval-pending`（无置信区间、不可提升）、正式 `approval-pending`（有置信区间、可申请提升）；`/tmp/agent-butler-dev/home/prompts/hermes-soul/evaluations/` 生成 3 组 report + cases JSONL（0600）。未修改 Hermes 源文件，未发送任何外部消息；M5 完整闭环（批准、canary、提升、回滚、真实回环）仍未标记完成。

## 2026-08-23 · 电脑管家方向：普通界面仍暴露运维术语，明细未收进高级区

- 问题：首页、消息通知、进化、提示词优化、技能与记忆、安全与设置仍直接暴露 messageId、transport、规则版本、补丁参数、实验台账、driverId、raw 状态等专业信息；升级/回滚/修复等危险操作缺少统一的二次确认表达。
- 风险/影响：普通用户首屏信息密度过高，容易误操作，产品定位与 PRD V1.6“先给结论、一键操作、高级详情折叠”不一致。
- 改动范围：`Layout.tsx`、`Dashboard.tsx`、`Versions.tsx`、`Gateway.tsx`、`Evolution.tsx`、`PromptOptimizationPanel.tsx`、`Skills.tsx`、`Settings.tsx`、`AlertBanner.tsx`、`SecurityNotice.tsx`、`EventTicker.tsx`、`styles.css`；专业信息默认收入「高级详情 / 高级设置」，普通界面改用口语化结论，危险操作补充明确确认。
- 回归测试：`tsc -b`、全路由 HTTP 200、无头 Chrome 截图检查；后续执行 `vitest run`、`git diff --check`、Vite 生产构建。
- 验证命令：`node node_modules\typescript\bin\tsc -b`；`node node_modules\vitest\vitest.mjs run --maxWorkers=4`；`git diff --check`；Chrome headless 访问 `/dashboard`、`/gateway`、`/evolution`、`/prompt`、`/skills`、`/settings`。
- 部署/运行验证：本地 Vite 5173 + butler-gateway 7532 + Hermes 8642 联调；未发送真实外部消息、未修改 Hermes 源文件。

## 2026-08-23 · 提示词优化未随消息网关收敛，专业字段与安全文案仍外泄

- 问题：M5 提示词优化仍保留独立导航与 `/evolution` 页签，用户以为它不是消息网关的一部分；Gateway 列表和详情直接显示 `weixin · final · queued-push`、`instanceId/runtime/driverId/candidateId/sourcePath/messageId` 等原始字段；安全基线文案使用“鉴权”等术语，但产品实际没有登录验证。
- 风险/影响：小白用户会在错误的导航里找提示词优化，界面会给出不可理解的内部状态；安全提示与真实能力不一致，容易造成“是否安全”的误判。
- 改动范围：提示词优化面板并入 Gateway 并作为页内锚点，移除 Layout 的独立菜单、Evolution 的提示词页签、`/prompt` 入口及组件内已无路由引用的 standalone 独立页面分支；Gateway/Evolution/Versions/Prompt 增加中文映射并隐藏原始标识；安全基线改为“管家面板只在你的电脑上运行，请勿转发外网；当前没有登录验证，仅限本机使用”。
- 回归测试：`apps/web/tests/server.test.ts` 断言由“鉴权”改为“登录验证”；新增/调整 Gateway、消息格式、提示词位置相关测试。
- 验证命令：`node node_modules/typescript/bin/tsc -b --pretty false`；Vite 生产构建 `ui`；定向 Vitest 6 文件 36 tests；全量 `node node_modules/vitest/vitest.mjs run --maxWorkers=4`（73 files passed，646 tests passed / 3 skipped）；`git diff --check`。
- 部署/运行验证：WSL `butler-web.service` 已重建、重启并访问 `http://127.0.0.1:7531/api/health` → `{"ok":true,"db":true,"gateway":true}`；`butler-gateway` `/healthz` 200；`butler-vite.service` 以 systemd 托管在 `127.0.0.1:5173`。

## 2026-08-23 · 消息详情与提示词优化仍太技术化，普通用户看得懂的内容还不完整

- 问题：`/gateway` 展开消息明细后仍直接显示“消息编号 / 任务编号 / 相关消息编号 / 平台消息编号”和“消息 #85”等内部标识；提示词优化面板虽已并入消息通知，但“指令文件、保护内容、优化候选”等措辞仍偏运维；技能页会直接显示服务端返回的 `notice`，设置页也保留“控制适配器、校验、快照登记表”等术语。
- 风险/影响：普通用户仍会看到不可理解的内部编号和专业词，容易误以为自己需要配置代码级内容，与 PRD V1.6“先给结论、专业信息收进高级详情、术语通俗化”不一致。
- 改动范围：消息详情只保留“会话 / 通道、发送方式、收到 / 送达、尝试次数”等可理解字段，四类编号折叠到“技术编号”；提示词优化改为“提示内容、保存格式、必须保留的规则、当前正在用、检查结果、试用明细、测试结果”；技能页不再直显驱动 notice，改为固定中文说明；安全设置改为“本机访问说明、记录不会被改写、敏感信息保护、备份记录”；事件 ticker 的悬浮提示也使用中文。
- 回归测试：`ui` TypeScript 构建；Vite 生产构建；浏览器检查 `/gateway` 默认不显示技术编号、展开提示词优化后可见，`/skills`/`/settings` 不暴露原始内部字段。
- 验证命令：`node node_modules/typescript/bin/tsc -b --pretty false`；WSL `node node_modules/vite/bin/vite.js build`；`git diff --check`。
- 部署/运行验证：`butler-vite.service` 重启，`127.0.0.1:5173` 与 `127.0.0.1:7531` 页面均可用；未发送外部消息、未修改 Hermes 源文件。

## 2026-08-23 · 提示词优化面板残留未使用变量，代码门禁未完全收口

- 问题：`PromptOptimizationPanel.tsx` 仍声明 `targetList` 与 `candidateList`，但组件已直接读取 `data.targets` / `candidates.candidates`，ESLint 因此报 unused vars。
- 风险/影响：类型与运行逻辑正常，但静态门禁会让后续提交失败，也让人误以为面板还在使用旧字段。
- 改动范围：删除两行未使用变量；对 `ui/src` 统一 Prettier 格式，保持后续改动基线一致。
- 回归测试：WSL 全量 Vitest 73 passed / 1 skipped，646 passed / 3 skipped；`tsc -b`、UI `tsc -b ui`、ESLint、Prettier 全部通过。
- 验证命令：`wsl node node_modules/vitest/vitest.mjs run --maxWorkers=4`；`wsl node node_modules/typescript/bin/tsc -b --pretty false`；`wsl node node_modules/eslint/bin/eslint.js ui/src`；`wsl node node_modules/prettier/bin/prettier.cjs --check ui/src`；WSL Vite 生产构建。
- 部署/运行验证：`butler-vite/butler-web/agent-butler-gateway/butler-watch` 均 active；7531 服务新产物 `index-Cp9hhOzp.js` 与 `index-BRMAylRz.css`，7532/7533 健康正常；未发送外部消息、未修改 Hermes 源文件。

## 2026-08-23 · 微信消息完全收不到回复（Outbox 投递队列卡死 + 5 秒超时重复发送 + prewarm 死锁）

- 问题：用户在微信发消息后完全收不到任何回复。直接原因链：① Bridge `prewarm` 对没有 `prewarm_channel` 钩子的 Hermes 适配器一律返回 `warmed=false`，网关把所有普通消息永久 hold 在 `held_pacing`，投递管道自 2026-08-22 17:00 起停摆；② 网关把历史 ready 决策当作"历史重放"返回旧行，`seq26` 永远卡住，其后 60+ 条消息排不到；③ 微信适配器单条发送约 30-33 秒，而网关 Bridge 请求超时默认 5 秒，投递请求被反复中断并重试，产生 58 条 `outcome=NULL` 悬挂尝试。
- 风险/影响：全部微信外发（含用户等待的回复）停滞；重复投递尝试会累积悬挂 attempt 记录并可能触发平台限流；界面无法看到真实投递进度。
- 改动范围：
  - `outbox.py apply_decision`：历史重放时若行仍处于活跃状态（非 terminal、非 delivering）则重新应用该语义决策；`delivering` 行直接返回旧行防重复发送；`outbound_decisions` 支持 `ON CONFLICT` 更新 `applied_at`。
  - `registry.py prewarm`：无 prewarm 钩子的已挂载适配器视为 warm（5 分钟 expiresAt），不再永久 hold。
  - `registry.py deliver`：恢复同步投递（发送完成才返回 ack），保留"在途等待"保护（`delivering` 行等待其终态，避免重复发送）；曾尝试异步后台投递，但 Bridge `listChanges` 只返回新增行、网关投影依赖 ack 更新，异步会导致投影永久停在 `delivering`，已回退。
  - 网关 `runtime.ts`/dist：`BUTLER_MESSAGE_REQUEST_TIMEOUT_MS` 默认 120000ms（范围 1000-600000），systemd unit 显式设置 120000。
- 回归测试：Python Bridge `unittest discover` 73 passed（含新增 `test_prewarm_reports_available_without_adapter_hook` 与更新后的决策重放测试）；Gateway `vitest` message-reconciler/message-runtime/message-store 30 passed；`tsc -p apps/gateway` 通过；`git diff --check`。
- 验证命令：`systemctl --user status hermes-gateway.service agent-butler-gateway.service`；`tr "\0" "\n" < /proc/<gw-pid>/environ | grep BUTLER_MESSAGE_REQUEST_TIMEOUT_MS`；sqlite 观察 outbox/projection 状态推进与 delivery_attempts。
- 部署/运行验证：重启后 seq29/27/28/30/31/32/96 先后投递微信成功（provider `hermes-weixin-*`），积压按限速约 40-50 秒/条排空；seq91/seq101（用户等待的回复）已入队随排空送达。iLink 曾返回 ret=-2 限流（10:55-11:05），平台冷却后恢复；DeepSeek 402 曾致 cron 失败，但 10:30/11:07 的微信回复均正常生成。

## 2026-08-23 · 首页「查看详情」点不开、当前状态不截断，全站 UI 仍带“AI 味”

- 问题：Dashboard「查看详情」用 `document.querySelector("details.advanced-details")?.setAttribute("open", "")` 直接改 DOM，既不依赖 React state，也不滚动/聚焦；用户点击无反馈，刷新后展开状态丢失。当前状态列表一次渲染全部条目，无 5 条默认截断。全站 PRD V1.5 浅色层仍带紫色渐变、Outfit/Consolas 字体、毛玻璃、侧条纹、hover 上浮与重阴影、9-10px 大写眉题等“AI 感”装饰。
- 风险/影响：核心操作按钮形同虚设，长列表在小白用户面前信息过载；装饰性紫色渐变/毛玻璃让产品观感像 AI 生成页而不是电脑管家。
- 改动范围：Dashboard 增加 `advancedOpen`/`issuesExpanded` 状态与 `advancedRef`，「查看详情」改为受控展开并平滑滚动/聚焦；`<details>` 改为 `open` + `onToggle` 受控；当前状态默认显示 5 条，超过 5 条时显示“展开全部 N 条 / 收起”按钮（带 `aria-expanded`）。styles.css 末尾新增“电脑管家化整理”覆盖层：紫色系换为沉稳蓝 `#2456d8`、纯浅色背景、系统字体、去掉毛玻璃/渐变/侧条纹/大写小字眉题/重阴影/hover 上浮，小字号统一到 12px 以上，圆角与按钮交互收敛。
- 回归测试：Playwright 实测 `/dashboard` 默认 5 条、展开后 11 条、按钮文案切换；点击「查看详情」后高级详情展开并滚动到视口；body 背景无渐变、sidebar 无 backdrop-filter、active 导航无 inset 侧条纹；`/gateway`、`/versions`、`/evolution` 均为浅色系统字体无渐变。
- 验证命令：`node node_modules/typescript/bin/tsc -b --pretty false`；WSL `node node_modules/vite/bin/vite.js build`（ui 目录）；`git diff --check`。
- 部署/运行验证：`butler-vite.service` 重启后 `127.0.0.1:5173` 提供新样式与组件；未触碰 Hermes/消息服务，未外发消息。
## 2026-08-23 · 版本源默认值配错导致看不到新版本，消息优化入口无实际反馈，全站文案仍有 AI 味

- 问题：版本管理「可以升级的版本」一直为空，根因是版本源默认值 `hermes-agent/hermes`（GitHub 404、Docker Hub 404），而真实仓库是 `NousResearch/hermes-agent`；即使拉到版本，release 标签是日期式（v2026.8.19），页面会显示成「2026.8.19」而不是用户认识的 0.20.5。消息通知页「优化 AI 指令」只是一个锚点跳转，点击后没有任何反馈，且面板内容是“查看 prompt 文件”，与 PRD M5“入站消息优化”的产品表达不一致；各页面残留「置信度、基线版本、候选版本、未评估、等待事件」等技术词和 HTTP 状态码错误提示。
- 风险/影响：用户无法得知有新版本，无法升级；消息优化按钮形同虚设并误导用户以为会执行优化；技术词让小白用户产生距离感。
- 改动范围：
  - 版本源：`DEFAULT_VERSION_REPO` 改为 `NousResearch/hermes-agent`，Docker 镜像改为 `nousresearch/hermes-agent`；GitHub release 解析新增 `displayVersion`（从 release 正文提取 vX.Y.Z）、`notes`（发布说明摘要，截断 220 字）、`publishedAt`；Docker 源保持原样。
  - 版本页：只显示等于或新于当前版本的条目，卡片显示版本号、发布标签、发布日期、发布说明，「当前版本」标记并禁用升级按钮；更新来源显示中文；toast 去掉 HTTP 状态码。
  - 消息优化：按钮改为「查看消息优化」，点击后滚动到面板并高亮 2 秒；面板标题改为「消息优化」，表格字段改为「规则内容 / 不能改动的部分 / 当前状态」等白话，明示“自动替换、先少量试用和恢复原样还在开发中”。
  - 全站文案：Dashboard「可信度→把握」、去 HTTP 状态码；EventTicker「等待事件→等待管家动态」「指令优化→消息优化」；Skills「自进化→自动改进」；Gateway 指标与错误文案去术语。
- 回归测试：version-source 测试更新为真实仓库形态的 fixture（日期标签 + 正文版本号 + 发布说明），16 passed；watch + hermes 全量 347 passed / 3 skipped；`tsc -b` 与 Vite 生产构建通过；Playwright 实测 `/versions` 显示 0.20.5（新）与 0.20.4（当前版本）两张卡片、发布说明与中文来源，`/gateway` 点击「查看消息优化」后面板滚动并高亮、文案无残留。
- 验证命令：`curl 127.0.0.1:7533/api/upgrade/versions` 与 `curl 127.0.0.1:7531/api/versions` 均返回 `source=github-releases`、`displayVersion=0.20.5`；`git diff --check`。
- 部署/运行验证：重启 `butler-watch.service`（版本源生效）与 `butler-vite.service`（新 UI），其余服务未动；`agent-butler-gateway` / `hermes-gateway` 保持 active，未外发任何消息。
## 2026-08-23 · M5 入站提示词优化只有只读面板，没有对照历史，优化按钮“点了没区别”

- 问题：消息通知页的「消息优化」实际展示的是提示词文件 Registry（人设/系统提示等文件快照与候选），不是 PRD M5 定义的“入站消息改写”；Bridge 虽有 `inbound_decisions` 表和 `POST /v1/inbound/{id}/decision` 接口，但没有任何一方生成决策，运行时也不消费优化文本，因此用户永远看不到“我发了什么 → 优化后的指令”的对照历史，按钮点击只是滚动到面板。
- 风险/影响：核心产品能力（M5 提示词优化）名存实亡；继续在 UI 上做“看起来已支持”的展示会误导用户；没有对照记录，用户无法学习怎么写指令，也无法验证优化是否生效。
- 改动范围：
  - Bridge 新增 `message_optimizer.py`：确定性规则式快速通道（快捷指令 `/日报` `/巡检` `/暂停推送 N h` 展开、去客套语、去指代词、口语动词归一、失败句式改写），不匹配或结果可疑时原样透传；`HERMES_BUTLER_INBOUND_OPTIMIZE=0` 可关闭。
  - `hermes_hooks.py`：新入站消息记录后自动生成并落库决策（action=forward / optimizedText / transformTrace / changes / mode）；Hermes 处理前把优化文本应用到事件副本，任何异常回退原文，绝不阻塞或丢失消息；api-server 与功能上线前的旧消息不生成决策（历史如实标记“没有优化记录”）。
  - `outbox.py`：`get_inbound_decision` / `list_inbound_history`（最近 30 天按时间倒序，LEFT JOIN 决策）；`apply_inbound_decision` 支持可选 `changes` 与 `mode` 字段并校验。
  - `server.py`：新增 `GET /v1/inbound/history?limit=`（1-200）；入站决策接口允许 `mode`/`changes`。
  - 契约/适配器/网关/Web：`InboundHistoryView` 与 `MessagingAdapter.inboundHistory`；网关 `GET /api/messages/optimization-history`（本地投影不可用/桥接失败返回 503 或空降级）；Web 代理并校验结构后供 UI 使用。
  - UI：`PromptOptimizationPanel` 重做为 PRD 原型“原文 / 优化后 / 改动要点”对照卡：今日改写/快捷指令/原样发送/处理中统计、消息通道与时间、状态徽标（快捷指令/已改写/原样发送/接口消息不优化/没有优化记录/正在处理）、改动要点 chips；旧的规则文件 Registry 折叠到“高级：规则文件改进记录（只读）”。
- 回归测试：Bridge unittest 90 passed（新增优化器 9 项、Outbox 决策/历史 3 项、HTTP 历史 2 项、hooks 应用与兜底 3 项）；`tsc -b` 通过；Vitest messaging/gateway/web 23 passed；UI Vite 生产构建通过。
- 验证命令：WSL `PYTHONPATH=. python -m unittest discover -s tests`；WSL `node node_modules/vitest/vitest.mjs run packages/adapters/hermes/tests/messaging.test.ts apps/gateway/tests/message-http.test.ts apps/web/tests/gateway.test.ts`；WSL `node node_modules/vite/bin/vite.js build`（ui 目录）；`git diff --check`。
- 部署/运行验证：同步 bridge 包到 WSL `gateway/butler_bridge` 并重启 `hermes-gateway` 用户服务；`curl -H "Authorization: Bearer <token>" 127.0.0.1:8754/v1/inbound/history` 返回历史条目；`127.0.0.1:7531/api/messages/optimization-history` 与 `/gateway` 页面可用；真实微信新消息会生成对照记录，旧消息如实显示“没有优化记录”，未外发任何消息。
## 2026-08-23 · 入站优化器只做字面替换，“检查一下”被错改成“检查看一下”，用户看不到真实优化

- 问题：规则优化器只做字面归一（查一下→查看一下、看一下→查看等），没有把口语消息改写成结构化指令；且“检查一下现在显示器的配置正常了吗？”被“查一下”子串规则误拆成“检查看一下……”，既没有优化效果又产生别扭中文。用户实测发现“优化后和原文一样”，长上下文消息（显示器默认设置问题）也基本原样透传。
- 风险/影响：M5 核心体验名存实亡，UI 上的“已改写”反而变成错误改写，误导用户以为指令被优化；用户无法验证优化是否生效，也无法学习如何写指令。
- 改动范围：重写 `message_optimizer.py` 规则集：
  - 修正顺序漏洞：`检查一下`、`查看一下` 等长词先于 `查一下`/`看一下` 替换，杜绝“检查看一下”类误拆；动词+一下统一归一（检查一下→检查、看一下→查看、调一下→调整），并增加“改成→改为”的前瞻保护（避免“变更成”被拆坏）。
  - 指代消解：这台电脑/我的电脑/这台机器/这台设备/这台服务器→本机；设备名词前多余的“这个/那个/这台”删除（如“小米的这个外接显示器”→“小米的外接显示器”）。
  - 疑问句转明确指令：X正常了吗→检查X是否正常并报告结果；是不是又X了→检查是否又X并报告结果；为什么X→排查X的原因并报告结果；怎么不/没X→排查原因并报告结果。
  - 陈述句转直接指令：我想把X默认为Y→将默认X设置为Y；我想把X设置为Y→将X设置为Y；我想做X→X；把字句倒装（把配置调整→调整配置）。
  - 快捷指令、去客套语、失败句式改写保留；不匹配或结果可疑仍原样透传。
- 回归测试：Bridge `unittest discover` 100 passed（优化器 19 项，新增“检查一下”回归、疑问句、指代消解、幂等、口语问候透传等 10 项）；`git diff --check`。
- 验证命令：WSL hermes venv `python -m unittest discover -s tests -p 'test_*.py'`；部署目录 `python3 -m py_compile message_optimizer.py`；`systemctl --user restart hermes-gateway`；真实接口 `GET /v1/inbound/history` 与 `GET 127.0.0.1:7531/api/messages/optimization-history` 仍返回 200。
- 部署/运行验证：同步 `message_optimizer.py`（备份 `.bak-promptopt-v2-20260823`）并重启 `hermes-gateway`，四个 systemd 服务均 active；用部署模块对用户真实消息验证：检查一下现在显示器的配置正常了吗？→检查现在显示器的配置是否正常，并报告结果；是不是又限流了？→检查是否又限流，并报告结果；长显示器消息→将默认显示器设置为小米的外接显示器……就是本机。旧决策记录保持不可变（对应当时实际发送内容），新消息按新规则生成决策；未外发任何消息。

## 2026-08-23 · Dashboard 告警条过细过碎、看板信息密度低且“查看详情”不可用

- 问题：首页消息上方同时渲染多条细横幅（3-4 条红/黄条），视觉碎且告警等级不突出；状态卡没有明确操作入口，“查看详情”此前点不开；问题列表一次性铺开所有条目，默认信息过载；首页文案偏“AI 味”，不符合 PRD 电脑管家式原型“先结论、再操作”的体验。
- 风险/影响：小白用户看不到首要待办，告警被多条细条稀释，关键“去处理”路径不明确；默认 10+ 条问题列表让首页变成长表单，难以一眼判断要不要处理。
- 改动范围：
  - `ui/src/components/AlertBanner.tsx`：多条窄横幅收敛为单条汇总条（“需要处理 / 需要留意”），右侧带“去消息通知 →”链接，点击跳转 `/gateway`。
  - `ui/src/pages/Dashboard.tsx`：顶部新增 6px 状态色带 hero（“有 N 件事需要你处理 / 需要留意”）；状态卡增加可点动作（去处理 / 去看看 / 查看详情）；待处理卡“查看详情”展开高级详情；问题列表默认 5 条 + “展开全部 N 条 / 收起”；首页副标题等文案去 AI 味。
  - `ui/src/styles.css`：新增“电脑管家化 v2”覆盖段——单条浅色横幅、hero 顶部色带与浅色渐变、状态卡 4px 色条与 error/warn 数值着色、问题卡左侧 4px 粗色条 + 浅色底。
- 回归测试：`node node_modules/typescript/bin/tsc -b --pretty false` 通过；Playwright 1440x1000 实测单条黄条、hero 色带、默认 5 条 + 展开全部 10 条、“查看详情”展开、“去消息通知 →”跳转 `/gateway` 均正常。
- 验证命令：WSL `systemctl --user restart butler-vite`；`curl -I http://127.0.0.1:5173/`；Playwright 截图 `.tmp-dashboard-v2.png`、`.tmp-dashboard-v2-top.png`。
- 部署/运行验证：butler-vite 重启后 `127.0.0.1:5173/src/pages/Dashboard.tsx` 与 `styles.css` 返回新代码，`/dashboard` 实际渲染单条告警与强化状态卡；未外发任何消息。


## 2026-08-23 · 记忆清理（purge）SQL 逻辑错误：归档表缺失时 prepare 即抛错、探针清理条件不闭合

- 问题：记忆「清理探针 / 清理过期归档」在真实库上暴露两类 SQL 逻辑错误：一是归档表 `butler_memory_archive` 不存在时，清理代码无条件 prepare `DELETE FROM butler_memory_archive ...`，在语句准备阶段就抛 `no such table`，导致「清理归档」直接失败；二是探针自清理与 UI 清理的删除条件不一致，且删除时若只删主表行，FTS5 外容表（facts_fts）的旧索引行可能残留，出现「显示已清理、FTS 仍能召回」的假删除。
- 风险/影响：UI 上一键「清理记忆」会失败或清理不彻底；用户可能误以为探针测试记忆已删除，实际旧索引仍可被召回；若删除条件写错（如把归档时间戳与探针 epoch tags 混用）还可能误删用户记忆。
- 改动范围：
  - `packages/adapters/hermes/src/drivers/memory.ts` purge 分支：`probes` 按 `category = butler-probe` + `created_at` 保留窗口选择目标；`archived` 先 `ensureArchiveTable` 通过后才准备归档删除语句，不再在表缺失时 prepare 报错；删除统一在单个事务内先删 `facts_fts` 索引行再删 `facts` 主行（归档另删归档表行），逐行容错并汇总 errors。
  - `apps/watch/src/probes/memory-probe.ts` 24h 自清理：按 `category` + `CAST(tags AS INTEGER)` epoch 阈值判定，只清管家自己的探针行，用户记忆不受影响。
- 回归测试：`apps/watch/tests/memory-probe.test.ts`（真实 FTS5 fixture：旧探针行被删且 FTS 索引同步、用户记忆保留、新探针行写入、FTS 查询失败/schema 缺失/库打不开均覆盖）；`packages/adapters/hermes/tests/drivers.test.ts`（purge 未确认拒绝、归档清理只删归档行、探针清理不动用户记忆）；临时调试脚本验证归档表缺失时 prepare 不再抛错、FTS 外容表可直接按 rowid 删除。
- 验证命令：WSL `node node_modules/vitest/vitest.mjs run apps/watch/tests/memory-probe.test.ts packages/adapters/hermes/tests/drivers.test.ts`（17 项通过）；`node node_modules/typescript/bin/tsc -b --pretty false` 通过。
- 部署/运行验证：UI `/skills` 记忆健康区「清理探针记忆（N 条）/ 清理过期归档」先弹二次确认，确认后调用 `/api/memory/purge` 带 `confirmed:true` 才执行并返回 `purged` 条数；未外发任何消息。

## 2026-08-23 · M7 安全设置：备份/还原、配置不变式、密钥权限扫描与审计接口（Task 18）

- 问题：安全设置页此前是静态占位（“敏感信息保护”“操作记录查看还没完成”等文案），没有真实的备份/还原、配置核验、密钥权限扫描和操作记录；设置页在 WSL Vite（/mnt/c 文件监听不可靠）重启前会一直渲染旧版模块；`apps/web/tests/skills.test.ts` 夹具停留在旧契约（缺 plugins 分类、记忆 health/archived/probe 字段），全量测试 1 项失败。
- 风险/影响：用户看不到真实安全状态，误以为备份/还原可用或不可用；Vite 缓存旧模块会让前端改动“看起来没生效”而重复排查；测试夹具过期会让回归测试误报。
- 改动范围：
  - 新增 `apps/watch/src/backup.ts`：每日全量 + 每小时记忆增量 + 升级/进化/还原前事件备份；数据库用 `VACUUM INTO` 一致性快照、失败回退文件复制；不备份 `.env` 等密钥明文；还原前先备份当前态，只回写 Hermes 白名单文件；自动轮转（full 14 / memory 24 / event 10）。
  - 新增 `apps/watch/src/invariants.ts`：三条配置不变式（开放策略必须带白名单、消息外发间隔 ≥45s、密钥与接口地址成对）+ 密钥文件 0600 权限扫描（跳过深层目录/.example/.envrc）。
  - `packages/core/src/store.ts` 新增 `backups` 表与增查改接口；`packages/core/src/events.ts` 新增 `backup-completed`；`apps/watch/src/http.ts` 新增 `GET/POST /api/backups`、`POST /api/backups/:id/restore`、`GET /api/security`；`apps/web/src/server.ts` 新增对应代理与 `/api/audit`。
  - `apps/watch/src/watch.ts` 用 `upgradeWithBackup`/`evolutionWithBackup` 包装升级与进化，事件备份失败不阻断主操作。
  - `ui/src/pages/Settings.tsx` 重写：6 条真实安全基线、备份时间线 + 立即全量/记忆备份/还原按钮、配置规则与密钥权限详情、操作记录列表；`ui/src/styles.css` 增加对应浅色电脑管家风格样式。
  - 行尾修复：将此前误写为 CRLF/混合行尾的 11 个文件统一还原为 LF（内容不变），`git diff --check` 恢复通过，diff 从 +6208/-4759 回落到真实改动 +1530/-81。
  - 测试夹具：`apps/web/tests/skills.test.ts` 对齐真实契约（skills 带 category、plugins 分类、memory health/archivedEntries/probeEntries）。
- 回归测试：`apps/watch/tests/backup.test.ts` + `apps/watch/tests/invariants.test.ts` 8 项通过；全量 `vitest run --maxWorkers=4` 681 项（677 通过 + 3 跳过 + 1 修复后通过）；`tsc -b` 通过；`vite build` 52 模块构建通过；`git diff --check` 通过。
- 验证命令：WSL `systemctl --user restart butler-vite.service`（清除旧模块缓存）后 `/settings` 渲染新代码；`curl /api/security /api/backups /api/audit` 返回真实数据；Playwright 实测 6 条安全基线、2 条备份 + 还原按钮、10 条 audit 行、无控制台错误。
- 部署/运行验证：真实扫描结果——消息外发间隔配置为 30s，低于 45s 安全线（status=fail）；发现 DeepSeek 密钥但缺对应接口地址（status=warn）；`.env`、`auth.json`、`bridge.token` 均为 0600（3/3 安全）。手动记忆备份 196.0KB、全量备份 500.6MB/13 文件，均标记可用；audit 已累计 900+ 条（backup-full/backup-memory/inspection 等）。还原操作会先自动备份当前状态，仅回写 Hermes 白名单文件，运行中的 Butler 自身数据库不回写。未外发任何消息。

## 2026-08-23 · 记忆按需自检（PRD S5：记忆服务看似正常但写不进/召不回）

- 问题：记忆写入召回探针只在 60 分钟巡检里运行，用户无法主动验证记忆库是否真的能写入并召回；且探针运行后会留下一行测试记忆（保留 24h 后清理），按需触发时会让“管家自己的测试行”悄悄积累，与“不会改动你的记忆”的承诺不一致。
- 风险/影响：记忆嵌入服务挂了但进程活着时，用户没有即时入口发现“失忆”；多次按需检查会在记忆库留下探针行，干扰记忆统计。
- 改动范围：
  - `apps/watch/src/http.ts` 新增 `POST /api/memory/self-check`（body `{ instanceId? }`；200 返回 `{ ok, instanceId, result }`；无实例/未接线 503；GET 405），文档头同步更新。
  - `apps/watch/src/watch.ts` 新增 `runMemorySelfCheck`：解析实例 → 运行专用 memory-probe 单阶段 → 审计 `memory-self-check`（actor=memory），并注入 `memorySelfCheck` 依赖。
  - `apps/watch/src/probes/memory-probe.ts` 新增 `removeOwn` 开关：召回通过后立即按内容精确删除本次测试行（FTS 触发器同步清索引），定期巡检仍按原设计保留 24h 观察窗口。
  - `apps/web/src/server.ts` 新增 `/api/memory/self-check` POST 代理（结果原样透传）。
  - `ui/src/pages/Skills.tsx` 记忆健康卡新增「立即自检记忆」按钮与结果展示（通过/需留意/跳过/失败 + 详情），点击后调用新端点并刷新；`ui/src/styles.css` 增加结果样式。
  - 测试：`apps/watch/tests/memory-probe.test.ts` 新增 removeOwn 用例（召回后行数归零、用户行保留）；`apps/watch/tests/http-memory.test.ts` 新增端点 200/503/405 用例；`apps/web/tests/skills.test.ts` 新增代理透传用例。
- 回归测试：`memory-probe`、`http-memory`、`skills` 三个测试文件 17 项通过；全量 `vitest run --maxWorkers=4` 通过；`tsc -b` 通过；`vite build` 52 模块通过；`git diff --check` 通过。
- 验证命令：WSL `systemctl --user restart butler-watch.service butler-web.service`；`curl -X POST http://127.0.0.1:7531/api/memory/self-check -d '{}'`；Playwright 实测 `/skills` 按钮点击后显示“记忆读写正常”与探针详情、无控制台错误。
- 部署/运行验证：真实 Hermes 记忆库连续三次按需自检均 pass，detail 含“本次测试行已清理”；自检前后 `facts WHERE category='butler-probe'` 计数保持不变（30→30），证明不再积累探针行；定期巡检保留 24h 观察窗口的设计未改动。未外发任何消息。

## 2026-08-23 · M7 一键生成诊断报告缺失（PRD M7「一键生成诊断报告」）

- 问题：PRD M7 原型区要求「一键生成诊断报告」，但 watch/web/UI 均无对应能力；用户遇到系统错误时只能逐页翻日志，拿不到一份脱敏、可导出的汇总报告去排障或交给维护者。
- 风险/影响：系统日志与错误指纹有数据但缺少出口，排障成本高；若直接把原始日志/密钥内容贴出去会有泄露风险。
- 改动范围：
  - `apps/watch/src/diagnostics.ts` 新增 `renderDiagnosticReport`：5 节 Markdown（环境信息、最近巡检快照、日志问题与近 7 天错误指纹聚类、配置摘要、进化台账摘要）；路径用户名替换为 `~`、压缩空白、每行截断，不含密钥值/聊天正文/原始日志样本。
  - `apps/watch/src/http.ts` 新增 `GET /api/diagnostics/report`（text/markdown 附件下载；未接线 503；非 GET 405），`WatchHttpDeps` 注入 `renderDiagnostics`。
  - `apps/watch/src/watch.ts` 接线 `renderDiagnostics`（core / butler / logAnalyzer / security / gateway / evolution / now）。
  - `apps/web/src/server.ts` 新增 `/api/diagnostics/report` GET 代理（透传 content-type 与 content-disposition；watch 不可达 502）。
  - `ui/src/pages/Settings.tsx` 安全设置页新增「一键生成诊断报告」区块：生成按钮、预览、Markdown 下载按钮；`ui/src/styles.css` 增加预览样式。
- 回归测试：新增 `apps/watch/tests/diagnostics.test.ts`（3 项：5 节结构+脱敏、错误指纹近 7 天窗口聚合、空状态）、`apps/watch/tests/http-diagnostics.test.ts`（2 项：200/503/405）、`apps/web/tests/diagnostics.test.ts`（2 项：透传/502）；全量 `vitest run --maxWorkers=4` 694 通过/3 跳过；`tsc -b`、`vite build`、`git diff --check` 通过。
- 验证命令：WSL `systemctl --user restart butler-watch.service butler-web.service butler-vite.service`；`curl -s http://127.0.0.1:7531/api/diagnostics/report | head`。
- 部署/运行验证：见本轮真实 curl/浏览器验证（生成报告含 5 节、路径已脱敏、附件头正确）。未外发任何消息。


## 2026-08-23 · PRD 四项对齐：管家自身版本管理、记忆索引重建、系统错误导出入口、插件分类文案

- 问题：① 管家自身版本页只有展示，没有「可用更新 / 一键升级 / 回滚 / 快照 / 更新通道与版本锁定」动作；② 记忆健康分析会提示 FTS 索引不一致（rebuild-index），但驱动、服务、HTTP 与 UI 都没有可执行的索引重建动作；③ Dashboard 上不可自动修复的事件只有「查看详情」，缺少 PRD M1 要求的「查看日志 / 导出诊断包」入口；④ 插件分类文案（平台通道/工具）与 PRD 的「通道插件 / 工具插件 / 适配器插件」不一致。
- 风险/影响：用户无法对管家自身做版本管理闭环；记忆检索漏结果时只能看不能修；排障现场无法从问题卡直接带走；分类语义与 PRD 漂移。
- 改动范围：
  - packages/contract/src/drivers.ts 新增 RebuildIndexReport 与 MemoryDriver.rebuildIndex；MemorySuggestion.action 增加 rebuild-index。
  - packages/adapters/hermes/src/drivers/memory.ts 实现 rebuildIndex（清空 FTS 后按 facts 表全量重建，统计前后行数），健康分析增加「切换嵌入供应商建议」notice。
  - apps/watch/src/skills.ts 增加 rebuildIndex 服务方法；apps/watch/src/http.ts 新增 POST /api/memory/rebuild-index。
  - 新增 apps/watch/src/self-upgrade.ts 与 apps/watch/src/self-upgrade-runner.ts：管家自身状态（版本/分支/提交/tag/远程仓库/可用更新/快照/偏好/最近 Job）、一键升级与回滚（快照默认保留 3 份、升级前全量备份、detached 子进程自举执行、失败自动回滚）、更新通道与版本锁定偏好；watch.ts 接线，http.ts 新增 /api/butler/self、/api/butler/self/upgrade、/api/butler/self/rollback、/api/butler/self/prefs。
  - ui/src/pages/Versions.tsx 管家自身区块增加可用更新列表、一键升级、版本快照回滚、更新通道/锁定开关、运行中进度轮询；ui/src/styles.css 增加对应样式。
  - ui/src/pages/Skills.tsx 记忆健康卡增加「重建索引」「记忆备份」（POST /api/backups kind=memory）动作与建议按钮映射。
  - ui/src/pages/Dashboard.tsx 不可自动修复事件卡增加「查看日志 / 导出诊断包」。
  - packages/adapters/hermes/src/drivers/plugin.ts 分类文案对齐 PRD（平台通道→通道插件、工具→工具插件、新增适配器插件）。
- 回归测试：新增 apps/watch/tests/self-upgrade.test.ts（状态/确认/快照/内联流水线/锁定/回滚）、apps/watch/tests/http-self-upgrade.test.ts（4 端点 + 503）；packages/adapters/hermes/tests/drivers.test.ts 增加 FTS 重建一致性测试；apps/watch/tests/http-memory.test.ts 增加 rebuild-index 端点测试；更新 http-skills fake。
- 验证命令：tsc -b、定向 vitest（self-upgrade / http-self-upgrade / http-memory / drivers）、vite build、git diff --check；重启 butler-watch/butler-web/butler-vite 后 curl /api/butler/self、POST /api/memory/rebuild-index 实测。
- 部署/运行验证：管家自身升级/回滚需源码仓库配置 origin 并打 tag 后真正走 detached 流水线（当前仓库已具备 git 信息，但尚未上传远程）；本机记忆库真实执行 rebuild-index 后 FTS 行数应与 facts 一致。


## 2026-08-23 · PRD 四项对齐（续）：升级失败真实回滚、管家自身日志、技能/插件分类筛选、记忆加密导出

- 问题：① 管家自身升级流水线的失败路径只把状态写成 rolled-back，没有真正切回原 commit 并重建重启，e2e 测试暴露“回滚后 HEAD 仍是新版本”；② PRD M1 要求“被管组件日志 + 管家自身日志”，/api/logs 只有 Hermes 日志，看不到 butler-watch/web/gateway/vite 自身日志；③ 技能/插件虽有分类数据，但页面只有搜索框，无法按类别筛选，且平铺技能库绝大多数没有 category 元数据（65 个里仅 7 个），全部归入“未分类”；④ PRD M6 要求全量备份与加密导出，现有备份只有明文落盘，没有带口令的加密导出。
- 风险/影响：升级失败时用户以为已回滚但代码停在坏版本，服务可能起不来；排障时看不到管家自身日志；技能库无法按领域浏览；记忆库外带没有加密保护。
- 改动范围：
  - apps/watch/src/self-upgrade.ts：executeSelfJob 失败路径真正执行回滚（构造 rollback job，target=升级前 commit，复用 rollbackSelfJob 完成 checkout→build→restart→verify），回滚成功后再把状态写为 rolled-back 并保留原始错误说明；apps/watch/tests/self-upgrade.test.ts 新增两个真实 git 仓库 e2e（一键升级落 done、构建失败自动回滚到原 commit 落 rolled-back），并修正测试起点（先 checkout v0.1.0 再发起升级）。
  - apps/watch/src/watch.ts：新增 BUTLER_LOG_SERVICES（butler:watch / butler:web / butler:gateway / butler:vite）与 readJournalTail（journalctl --user，无 systemd 环境返回可读错误）；listSources 无条件附加管家自身日志源，readTail 支持 butler:* 前缀读取；ui/src/pages/Dashboard.tsx 日志源列表对 journald 源显示“服务日志”与“管家·”前缀。新增 watch.test.ts 集成测试覆盖。
  - packages/adapters/hermes/src/drivers/skill.ts：inferCategory 对平铺技能库（每个目录一个 SKILL.md）按名称规则推断领域分类（开发运维/数据与 AI/设计与前端/安全与合规/办公文档/商务与产品/研究与知识/内容与传播/系统与自动化/开发与代码/通用技能），嵌套目录保持原语义；drivers.test.ts 新增平铺分类测试。
  - ui/src/pages/Skills.tsx + styles.css：技能库与插件库各增加“按分类筛选”下拉（技能还保留名称/来源搜索），插件库按选中分类过滤分组；新增 .skills-filter-row / select 样式。
  - apps/watch/src/skills.ts：新增 MemoryExportResult 与 exportEncrypted（AES-256-GCM + scrypt 口令派生，.abmem 文件头 ABMEM01 + salt + iv + authTag + 密文；口令至少 8 位；库缺失返回可读错误）；apps/watch/src/http.ts 新增 POST /api/memory/export（application/octet-stream 附件）；apps/web/src/server.ts 新增二进制透传代理；ui/src/pages/Skills.tsx 记忆健康卡新增“加密导出”按钮与口令弹窗（两次输入校验、blob 下载、完成后清空口令）；styles.css 增加弹窗样式。
- 回归测试：self-upgrade.test.ts 7 项（含 2 项真实 git e2e）、watch.test.ts 7 项、drivers.test.ts 13 项、skills.test.ts 5 项、http-memory.test.ts 11 项（含导出 200/400/405）、http-skills.test.ts 2 项；全量 vitest 719 通过 / 3 跳过（85 文件）；tsc -b、vite build、git diff --check 通过。
- 验证命令：WSL 重启三服务后 curl：/api/logs 含 4 个 butler:* 源；/api/logs/butler%3Awatch?limit=15 返回 journald 行；POST /api/memory/export（口令 test-pass-12345）落盘后用 node crypto 解密，头部为 SQLite format 3；POST /api/memory/rebuild-index 返回 92/92；/api/skills 技能含 数据与 AI/通用技能 等分类。
- 部署/运行验证：本机管家自身日志可读、加密导出可解密为合法 SQLite、索引重建与真实技能分类均验证通过；未外发任何消息。


## 2026-08-23 · PRD 四项对齐（续二）：记忆健康评分、写前快照、日志分页、错误指纹影响组件与修复预览

- 问题：① PRD M6 明确记忆健康评分须含“写入失败率、召回命中率、索引一致性”，当前只有索引一致性等信号，写入失败率/召回命中率完全没有；② PRD M6 要求“所有写动作默认执行前快照”，记忆归档/恢复/清理/重建索引只有审计、没有执行前快照；③ PRD M1 要求“日志按时间倒序分页查看”，当前日志面板只显示尾部 300 行、无分页；④ PRD M1 要求错误事件展示首次/最近发生时间、影响组件、频次，当前指纹表只有次数/最近出现，且一键修复确认框没有影响范围与步骤预览。
- 风险/影响：记忆库健康评分缺关键可测量维度，探针历史没有沉淀；记忆写动作不可回退现场；日志一长就看不到历史；排障时不知道错误影响哪个组件、修复会动什么。
- 改动范围：
  - 记忆健康评分：packages/adapters/hermes/src/drivers/memory.ts 新增 butler_memory_ops 探针统计表读取（最近 50 次窗口），collectStats 增加 recalledEntries/cumulativeRecalls/probeWriteAttempts/probeWriteFailures/probeRecallAttempts/probeRecallHits；analyze 新增 write-reliability（写入失败率）、recall-hit-rate（召回命中率）、recall-coverage（召回覆盖）三个信号并计入扣分（失败率>10% 或命中率<90% 扣 20，否则扣 8）。apps/watch/src/probes/memory-probe.ts 每次运行把 probe-write / probe-recall 结果写入统计表（静默失败不影响探针结论）。packages/contract MemoryStats 同步扩展。ui/src/pages/Skills.tsx 记忆统计区新增“累计召回”“探针召回命中”，健康信号标签补齐。
  - 记忆写前快照：apps/watch/src/skills.ts 新增 snapshotBeforeWrite 依赖，archiveCold（dryRun 不触发）/restoreCold/purge/rebuildIndex 执行前调用；apps/watch/src/watch.ts 注入事件备份（覆盖 Hermes memory_store.db 与 Butler 自身数据），快照失败只告警不阻断，动作仍逐条落审计。
  - 日志分页：apps/watch/src/watch.ts 新增 readLogFilePage（byte offset 游标，单页最多回读 512KB），readTail 支持 before 参数并返回 pageStart/hasOlder/hasNewer；apps/watch/src/http.ts 解析 before 查询参数（非法返回 400）；ui/src/pages/Dashboard.tsx 日志查看器新增“更早的日志 / 回到最新”按钮与样式；journald 源保持尾部读取并明确不分页。
  - 错误事件与修复预览：packages/core/src/store.ts fingerprints 表新增 instance 列（老库自动 ALTER 迁移），upsertFingerprint 支持 instanceId 且未知来源不覆盖已知归属，FingerprintRow 返回 instance；FingerprintEngine.ingest 透传 instanceId。apps/watch/src/runbook/executor.ts RunbookDefinition 新增 impact 说明（三条内置 runbook 均补影响范围），http.ts RunbookSummary 新增 impact/steps，watch.ts runbookSummaries 输出步骤 label 预览；ui/src/pages/Dashboard.tsx 指纹表新增“影响组件”“首次出现”列，一键修复确认框展示影响范围与按序步骤列表。
- 回归测试：drivers.test.ts 新增探针历史健康评分用例（写入失败率/召回命中率信号与扣分）、stats 断言更新；memory-probe.test.ts 验证 ops 表记录；skills.test.ts 新增写动作快照顺序用例（dryRun 不触发）；http-logs.test.ts 新增 before 游标与非法游标用例；watch.test.ts 新增真实文件分页集成用例；store.test.ts/fingerprint.test.ts 新增 instance 归属用例。全量 vitest 722 通过 / 3 跳过（86 文件，control.test.ts 并发负载偶发超时、单独重跑 42 项全过）；tsc -b、vite build、git diff --check 通过。
- 验证命令：WSL 重启三服务后 curl：/api/runbooks 返回 impact/steps；/api/memory 返回 write-reliability / recall-hit-rate / recall-coverage 信号与累计召回；/api/logs/hermes%3Alogs%3Aagent.log?limit=3 与 ?before=<pageStart> 翻页正确；/api/dashboard 指纹含 instance 字段（旧数据为空串，新错误行归属实例）。
- 部署/运行验证：本机实测管家重启后首轮探针即落 1 次写入/召回记录，健康评分 85 且三条新信号可见；agent.log 最新页/更早页行序与 hasOlder/hasNewer 正确；runbook 影响范围与步骤预览返回正确；未外发任何消息。

## 2026-08-23 · Hermes V1 能力边界恢复为 L2

- 问题：Hermes manifest 申报 `declaredLevel=3` 和 `messaging`，能力扫描在 Bridge 健康时可提级到 L3，正式适配器还能通过配置直接挂载消息接管能力；这与 PRD 明确的 Hermes L2 上限冲突。
- 风险/影响：V1 会把未经真实上游扩展点、失效逃生和通道验收证明的消息接管当成正式能力，存在消息截留和产品边界漂移风险。
- 改动范围：`packages/adapters/hermes/manifest.json`、`src/manifest.ts` 固定声明 L2 并移除 `messaging`；`src/capability-scan.ts` 将消息能力固定为 `not-implemented` 且不再运行时提级；`src/index.ts` 移除正式适配器的 Bridge 配置与 messaging 注入入口。实验 Bridge 客户端代码仍保留为未接入 V1 的独立模块。
- 回归测试：更新 manifest、fixture、messaging capability 和 adapter 暴露测试，覆盖 manifest 不申报 messaging、扫描始终不超过 L2、正式适配器不暴露 messaging。
- 验证命令：`node node_modules\\typescript\\bin\\tsc -b`；WSL `node node_modules/vitest/vitest.mjs run packages/adapters/hermes/tests/smoke.test.ts packages/adapters/hermes/tests/fixture.test.ts packages/adapters/hermes/tests/messaging-capability.test.ts packages/adapters/hermes/tests/messaging.test.ts`（4 文件、42 项通过）。Windows Vitest 因既有 `@rollup/rollup-win32-x64-msvc` 可选依赖缺失未运行。
- 部署/运行验证：本段为契约与适配器装配修复，未改动或重启用户现有 Hermes/Butler 服务；未外发任何消息。

## 2026-08-23 · 宿主与 Docker 三服务启动交付修复

- 问题：watch/gateway/web 的 Dockerfile 仅运行 placeholder；三个包缺少 installer 指引引用的 `start` 脚本；根构建不生成 UI；Compose 使用子目录构建上下文，拿不到 workspace 依赖，且容器内服务仍绑定回环地址、web 未配置内部 watch/gateway 地址。
- 风险/影响：宿主和容器两种正式安装路径均无法按仓库指引启动完整三服务，直接阻断 V1 新机安装验收；即使单容器启动，服务间请求和宿主端口访问也会失败。
- 改动范围：三个应用包新增 `start`；根 `build` 同时执行 TypeScript 与 Vite 构建；三份 Dockerfile 改为完整多阶段构建、非 root 运行、真实入口和健康检查；新增 `.dockerignore` 排除密钥与本地状态；Compose 改用仓库根上下文、内部 DNS/env、容器内 `0.0.0.0`、宿主仅 `127.0.0.1:7531`、健康依赖和完整 `BUTLER_HOME` 持久卷；watch 支持从 `BUTLER_HERMES_ROOT`/`HERMES_ROOT` 读取容器挂载路径。
- 回归测试：新增 `packages/installer/tests/delivery.test.ts` 锁定 start/Dockerfile/Compose 契约，新增 `apps/watch/tests/config.test.ts` 覆盖 Hermes root 环境变量；installer 既有安装测试继续通过。
- 验证命令：`docker compose config`；`node node_modules\\typescript\\bin\\tsc -b`；WSL Vitest（3 文件、30 项通过）；`docker compose build butler-gateway butler-watch butler-web`（三张镜像均构建成功，Vite 52 模块构建成功）。
- 部署/运行验证：完成镜像级真实构建，未替换或重启用户当前运行中的 Butler/Hermes 服务；未外发任何消息。Docker socket 以非 root 使用时可通过 `DOCKER_GID` 覆盖宿主实际组 ID。

## 2026-08-23 · 配置不变式与 M4 提示词提升改为强制门禁

- 问题：三条 Hermes 配置不变式此前只提供查询结果，start/restart、升级预检和补丁 apply/reapply 均可绕过 block 级违例；文件变化后也没有 30 秒自动复验。M4 的通用结果接口会依据调用方手填指标返回 `allowWrite:true`，提示词候选只有 `canPromote` 标记，没有唯一服务端采用入口，调用方可伪造指标或忽略结论直接改写真实文件。
- 风险/影响：开放策略无白名单、非回环接口无密钥等危险配置仍可启动或升级；负优化或未经受信评估的提示词可落盘，破坏 PRD 的 baseline 保留、安全保护段与“不越改越坏”承诺。
- 改动范围：Hermes control 在 start/restart 与升级 precheck 强制执行 `validateConfig`，补丁 apply/reapply 遇 block 违例返回 `config-blocked`/HTTP 409；security 服务每 30 秒复验配置指纹，变化写审计并对 fail 告警。提示词评估在配置 evaluator 时始终忽略调用方预填分数并使用 evaluator 输出，报告持久化 `trustedEvaluator`；无 evaluator 只允许留档、永不授予提升资格。新增唯一 `promoteCandidate` 服务/HTTP/web/UI 入口，要求最新正式评估、holdout>=30、受信 evaluator、人工 `confirmed:true`、baseline/source/candidate hash 与保护段全部复验；真实源文件原子替换，版本、active、候选状态和审计在同一 SQLite 事务提交，数据库失败会恢复旧文件。通用 evolution 手填指标接口固定 `allowWrite:false`、`baselinePreserved:true`。
- 回归测试：control 覆盖 block 配置拒绝 start/restart；upgrade pipeline 覆盖配置预检；gateway 覆盖配置违例拒绝 apply/reapply；invariants 覆盖配置变化回调；prompt optimization 覆盖受信/不受信评估、调用方分数不可绕过、确认门槛、原子采用、候选篡改 fail-closed、active/审计更新；watch/web HTTP 覆盖 promote 代理；evolution 覆盖手填正增益也不授予写权限。
- 验证命令：`node node_modules\\typescript\\bin\\tsc -b --pretty false`；WSL Vitest `prompt-optimization/http-prompt-optimization/evolution/http-evolution/web prompt-optimization`（5 文件、28 项通过）；配置不变式相关定向测试通过，upgrade pipeline 26 项与 invariants 5 项通过。control/gateway 全文件并发跑出现既有 WSL `/mnt/c` fixture 清理超时，变更用例分别单跑通过。
- 部署/运行验证：本段完成构建与本地文件/SQLite 回归，未对用户真实 Hermes 提示词执行采用，未重启生产服务，未外发任何消息。

## 2026-08-23 · PRD 审计高风险收口：一致性快照、自升级备份、巡检 SLA 与 M6 只读边界

- 问题：① 被管实例升级/进化快照直接复制运行中 `memory_store.db`、WAL 与 SHM，且复制步骤失败仍登记快照，无法证明回滚数据完整；② 管家自身升级对全量备份使用 fire-and-forget，备份失败或未完成时仍会创建快照登记并启动升级；③ 默认巡检周期为 60 分钟，无法满足“记忆嵌入停止后 10 分钟内告警并自动修复”的验收；④ V1 页面与 API 提前暴露 M6 归档、恢复、清理、索引重建和加密导出，写前快照失败后仍继续调用记忆驱动。
- 风险/影响：升级回滚可能得到不一致或不可读的 SQLite 数据；用户可能在没有可用备份时进入自升级；关键故障最长接近一小时才被发现；V1 只读承诺被破坏，备份失败时仍可能发生不可逆记忆写入或删除。
- 改动范围：
  - `packages/adapters/hermes/src/control/snapshot.ts` 对 `data`/`memory` 改用 SQLite `VACUUM INTO` 生成不依赖 WAL/SHM 的独立主库，并在登记前执行 `PRAGMA integrity_check`；任一生成/校验步骤失败时不登记并清理部分目录；回滚覆盖主库前移除旧 WAL/SHM；登记失败同样清理孤儿目录。
  - `packages/adapters/hermes/tests/control.test.ts` 将快照夹具改为真实 SQLite，新增保持 WAL 连接打开时的可读性/完整性用例和损坏库不登记用例，既有回滚断言改为查询数据库内容。
  - `apps/watch/src/self-upgrade.ts` 将 `startUpgrade` 改为异步硬门禁：等待全量备份成功并取得有效 `backupId` 后才登记快照和创建 Job；备份缺失/失败返回 `backup-failed`，等待期间拒绝并发升级与回滚；自动回滚成功直接落 `rolled-back`，不再短暂暴露 `done`。
  - `apps/watch/src/http.ts` 等待自升级前置备份并映射 `backup-failed`；`apps/web/src/server.ts` 与 `ui/src/pages/Versions.tsx` 将该单一路径超时放宽到 10 分钟，避免客户端先报失败而服务端随后仍启动升级。
  - `apps/watch/src/config.ts` 将 `DEFAULT_INSPECT_INTERVAL_MIN` 从 60 收紧到 5，保留正数环境变量/显式覆盖能力，为检测、告警与 runbook 执行预留 10 分钟 SLA 预算。
  - `apps/watch/src/http.ts` 新增默认关闭的 `m6WritesEnabled`，V1 对 archive/restore/purge/rebuild-index/export 统一返回隐藏式 404；生产接线不启用。`apps/watch/src/skills.ts` 与 `apps/watch/src/watch.ts` 将所有真实写动作改为写前快照 fail-closed，快照能力缺失或失败返回 `snapshot-failed` 且不调用驱动，并追加失败审计。
  - `ui/src/pages/Skills.tsx` 移除 M6 写操作及加密导出入口，只保留只读清单/健康分析、临时自检与 M7 手动记忆备份。
- 回归测试：WSL Vitest 运行 10 个定向文件共 127 项通过，覆盖真实 WAL 一致性快照、升级流水线、自升级备份等待/失败/并发、5 分钟默认配置、M6 默认 404、写前快照失败时驱动零调用，以及 web 代理契约。
- 验证命令：`node node_modules\\typescript\\bin\\tsc -b --pretty false`；WSL `node node_modules/vitest/vitest.mjs run packages/adapters/hermes/tests/control.test.ts packages/adapters/hermes/tests/upgrade-pipeline.test.ts apps/watch/tests/config.test.ts apps/watch/tests/self-upgrade.test.ts apps/watch/tests/http-self-upgrade.test.ts apps/watch/tests/http.test.ts apps/watch/tests/skills.test.ts apps/watch/tests/http-memory.test.ts apps/web/tests/skills.test.ts apps/web/tests/butler-self.test.ts --testTimeout 30000 --hookTimeout 30000`；WSL Vite build（52 模块）。Windows Vite 因既有 `@rollup/rollup-win32-x64-msvc` 可选依赖缺失未运行，未修改依赖树。
- 部署/运行验证：本段完成本地文件、SQLite、HTTP 与构建回归；未对用户真实 Hermes 执行升级、回滚、记忆写操作或服务重启，未外发任何消息。

## 2026-08-24 · 消息旧答复淘汰、单通道提示、版本页收敛与加载进度

- 问题：① 系统明确只使用当前消息通道，页面仍把“备用通道未配置/不可用”当作降级提醒；② Hermes Outbox 遗留回答可在新问题到达后继续重试，`delivery.maxAttempts=5` 未真正阻止第 6 次投递，且无 `inboundMessageId` 的普通 `final` 消息会进入异步队列，造成新问题收到旧答案；③ 版本管理展示旧快照和提交历史，不符合“只保留退回上一版本”；④ 版本页初次读取和 Dashboard 手动巡检缺少页面级进度反馈，接口执行期间像假死。
- 风险/影响：旧问题答案可能错投到当前会话，用户无法信任消息顺序；无备用通道的正常配置被误报为故障；版本页信息噪声与误操作面扩大；长接口没有反馈会诱发重复点击。
- 改动范围：
  - `outbox.py` 新增会话最新入站索引：新问题会取消同会话旧问题的待发、重试和 `delivery_unknown` 回答；旧问题较晚生成的回答在捕获时直接取消；Bridge 重启会重建会话头并清理历史积压。
  - 普通 `final`/`failure`/`task-progress` 的 queued-push 缺少入站关联时失败关闭；合法主动通知必须显式携带 `proactive` 标记。A2A callback 已加标记，投递到原生适配器前会剥离内部标记。
  - `reconciler.ts` 达到 `delivery.maxAttempts` 后生成 `cancelled` 决策，不再发起下一次投递。
  - `AlertBanner.tsx`、`Gateway.tsx`、`Settings.tsx` 移除备用通道缺失告警，只保留真实离线、发送失败和紧急提醒，并明确“只使用当前通道，不设置备用通知链路”。
  - `Versions.tsx` 只展示当前版本、最新可升级版本和单个上一版本恢复点；移除快照列表与提交历史。`PageProgress.tsx`、`Dashboard.tsx`、`Versions.tsx` 和 `styles.css` 增加首次加载、巡检、升级和回滚的阶段进度、禁用态与 reduced-motion 支持。
- 回归测试：Bridge WSL 全套 113 项通过；Outbox 定向 29 项通过；Gateway 策略/存储/协调器 39 项通过，新增达到 5 次后不进行第 6 次投递用例；TypeScript 与 Vite 构建通过。
- 验证命令：WSL Hermes venv `python -m unittest discover -s tests -q`；WSL `node node_modules/typescript/bin/tsc -b apps/gateway/tsconfig.json`；Gateway 定向 Vitest；UI Vite build；`git diff --check`。
- 部署/运行验证：部署前使用 SQLite backup API 生成 `/home/jiach/.hermes/agent-butler/backups/outbox-before-stale-cleanup-20260824T024703Z.sqlite`，`integrity_check=ok`。同步 Bridge 文件并重启 `hermes-gateway.service` 后，3 条风险消息全部变为 `cancelled`，Outbox 非终态计数为 0；再启动 `agent-butler-gateway.service`，`127.0.0.1:7532/healthz` 返回 `{"ok":true,"pending":0}`，5 秒复查仍无积压，未外发历史消息。浏览器实测 `/versions` 桌面与 390×844 窄屏无页面横向溢出、无历史版本列表；初次加载显示三阶段进度；Dashboard 手动巡检显示禁用按钮、状态提示和页面级进度条，完成后自动恢复；消息页与设置页均无备用通道缺失提醒。

## 2026-08-24 · 点击升级后即时进度缺失

- 问题：受管实例的“升级到这一版”只在 POST 返回 202 后显示提示，页面进度完全依赖 WebSocket 事件触发的后续刷新；请求等待、事件延迟或事件流断开时没有本地进行中状态。原进度组件还位于页面顶部，用户在版本按钮附近点击后可能看不到。
- 风险/影响：升级这种长操作表现为无响应，用户容易重复点击或误以为任务没有启动；服务端已经接收任务但页面仍显示“目前没有正在进行的升级”。
- 改动范围：`ui/src/pages/Versions.tsx` 新增受管升级 pending 状态和 `managedUpgradeProgress`；确认后立即显示不确定进度并禁用重复点击，202 后主动刷新，pending/运行期间每 2 秒轮询真实 Job，服务端 Job 返回后切换为五步真实进度。进度组件移动到“升级进度”区域，保持在点击位置下方可见。
- 回归测试：新增 `apps/web/tests/versions-ui-progress.test.ts`，覆盖服务端 Job 尚未返回时的即时进度模型；版本页聚合与代理测试共 8 项通过。
- 验证命令：WSL Vitest `apps/web/tests/versions-ui-progress.test.ts apps/web/tests/versions.test.ts`；`node node_modules\\typescript\\bin\\tsc -b --pretty false`；WSL Vite build（53 modules transformed）；`git diff --check`。
- 部署/运行验证：使用隔离的本地模拟服务延迟 3 秒返回升级 POST，未触发真实升级。确认后 150ms 内进度标题、说明和进度条可见，位置 `top=478/bottom=547`，完整落在 720px 高视口内，按钮为禁用；随后自动切换为真实五步进度。开发页面继续由 `127.0.0.1:5173` 提供。

## 2026-08-24 · Dev 预发布版本通道与排序修复

- 问题：管家自身版本源只把 `alpha/beta/rc/preview` 识别为测试通道，合法的 `-dev.N` 标签会被误判为稳定版；版本排序只比较三段数字，`dev.10` 与 `dev.2` 会被当成同一版本。
- 风险/影响：首个公开开发版可能错误出现在稳定更新通道，多个预发布标签的升级顺序也不可靠。
- 改动范围：`apps/watch/src/self-upgrade.ts` 按 SemVer 核心版本、稳定/预发布优先级和预发布标识符排序；所有带预发布段的版本统一归入测试通道。新增统一版本脚本、发布规范和 CI 版本一致性检查。
- 回归测试：`apps/watch/tests/self-upgrade.test.ts` 新增 `v0.1.0`、`v0.1.0-dev.10`、`v0.1.0-dev.2` 排序与通道断言。
- 验证命令：`corepack pnpm version:check`；Windows Node 入口执行 ESLint 与 `tsc -b`；WSL Vitest 全量 `750 passed / 3 skipped`；WSL Vite build（53 modules transformed）；Hermes venv Bridge 全量 `113 passed`；Semgrep secrets 规则集；`docker compose config --quiet`；`git diff --check`。
- 部署/运行验证：发布前本地验证，不触发真实升级、回滚或消息外发。
