# Bug Fixes

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
