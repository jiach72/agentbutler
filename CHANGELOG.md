# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)；开发预览版本可能包含不兼容调整。
版本规则：`0.1-beta.YYMMDD.构建号`（构建号=CI 流水线号；详见 README「版本规则」）。

## [0.1-beta.260911.13] - 2026-09-11 — 版本体系切换 + 信任层（Trust Layer）全量（M1-M4）

### Changed（版本体系）
- 版本号从 `1.0.0-beta.N` 递增制切换为 **`0.1-beta.YYMMDD.构建号`** 日期构建制（存储形态 `0.1.0-beta.YYMMDD.构建号`，合法 SemVer）。
- `scripts/version.mjs` 新增 `next [buildNumber]` 子命令：按 UTC 时间生成下一版本；`set`/`check` 保持原语义，新增日期构建段格式校验（YYMMDD 6 位 + 构建号 ≤3 位）。
- CI 新增 `release` job：推 `v` 前缀 tag 触发（`v0.1-beta.YYMMDD.x`），三门通过后 **构建号以流水线号覆写** 并创建 GitHub Release（prerelease）——本地 set 的构建号仅是占位。
- README 新增「版本规则」章节；全仓 11 个 package.json、源码版本标记（core/web/watch/gateway/双 adapter/bridge）、双 manifest 同步到新版本。

依据 `docs/trust-layer-upgrade-plan-2026-09-11.md` 落地全部四个里程碑：成本防线、行为审计、全局急停、事件中心、Agent 周报、会话追踪、通知即操作、升级金丝雀、假进度检测、通道口令急停、移动端 PWA、安装医生、记忆可视化与多实例联邦。

### Added

- **升级金丝雀（M3.2）**：新版本先在影子环境跑一轮真实任务再切换。任务抽样取自真实会话索引（10 常规 + 全部失败，确定性可复现）；三指标准入判据（成功率降幅 ≤5pp、token 增幅 ≤15%、无新增 error 级指纹）**任一指标缺失一律按不通过处理**；观察窗（标准 24h / 保守 48h）内检出升级疑似回归（复用 M2.2 R1 关联规则）→ 自动回滚登记快照 + 推送说明；回滚成败按子步骤判定，无快照或子步骤失败时明说无法自动回滚，不假称成功。版本策略三档：激进（跳过）/ 标准（默认）/ 保守（验证不可用则拦截升级）。影子执行器（`shadow-runner.ts`）已接线：数据卷隔离 venv 安装目标版本 + 对抽样任务做真实端点冒烟回放（指标全部实测；API key 只经环境变量，绝不进命令行；回放为等价冒烟任务——历史 prompt 不存档是隐私红线，口径写入 metrics.source）；模型端点未配置时 available=false，仍按策略诚实降级（标准记「未验证」、保守拦截）——**绝不伪造「验证通过」**。新增内核 `canary_runs` 与 `runtime_settings` 表；端点 `GET /api/canary`、`POST /api/canary/plan|start|tick`、`GET|POST /api/canary/policy`、`GET /api/canary/:id`；面板 `/canary` 版本策略页（策略切换 + 五维汇总 + 差异报告详情），设置页「进阶工具」提供入口。配置 `BUTLER_CANARY_ENABLED` / `BUTLER_UPGRADE_POLICY`。
- **假进度检测（M3.3，差异化王牌）**：把「声称完成 X%」与同会话真实副作用动作对账——增量解析执行日志提取进度声明，与 [上一条声明, 本条声明] 窗口内的写文件/删文件/执行命令/调接口/发消息/抓页面对账。三态判定：有副作用 → `verified`；可观测但窗口空 → `suspect`；归属不到会话或无可观测记录 → `unverifiable`（显式「无法验证」，**绝不猜成可疑**）。防误报：只认带明确进度语汇的行，裸百分数（token 占比等）不判为声明。连续 ≥3 次 suspect → `progress-untrusted` 事件；终态 ok 但零副作用 → `unverified-completion` 事件。**可信度分母只含 verified+suspect**（「无法验证」≠「不诚实」）。呈现：`/progress` 页（三态卡 + 可疑会话点名 + 明细 + 判定口径）、会话时间线并入 ✓/？ 节点、周报「进度可信度」与 suspect 会话点名。新增内核 `progress_claims` 表；端点 `GET /api/progress`、`POST /api/progress/scan`、`GET /api/progress/sessions/:id`；配置 `BUTLER_PROGRESS_INTEGRITY_ENABLED` / `BUTLER_PROGRESS_RETENTION_DAYS`。
- **通道口令急停（M1.3）**：在通道里发「<口令> 急停 / 恢复 / 状态」即可远程急停。口令未配置或 <6 位功能整体关闭；口令必须完整出现且只认显式动词；可配置会话白名单防口令泄露后旁路使用；实际执行桥接到 Watch 既有 `/api/killswitch/*`（复用快照→停实例→三路留痕），结果回执到会话。配置 `BUTLER_KILLSWITCH_PASSPHRASE`。
- **移动端（M4.1）**：PWA manifest + iOS 添加到主屏；≤600px 底部 Tab 四格（周报/事件/成本/急停，急停红底强化复用同一确认逻辑）；单列重排 + 表格横滚 + 触控目标加大 + 刘海屏安全区。不开发原生 App。
- **安装医生（M4.2）**：`node scripts/doctor.mjs` 十项只读体检（docker/compose/git、三端口、`/api/health` 网关联通、Hermes Bridge 链路、.env 关键项安全自检——主密钥只看有无绝不打印、公网暴露必须配套口令）。三态结论 + 失败项给「下一步」修复命令；退出码 0/1；输出脱敏可整段分享。设置页提供命令复制入口。
- **记忆可视化（M4.3）**：`/memory-diff` 从行为审计流推导本周 added / modified / forgotten 记忆文件变更（删除后未再写=遗忘；删除后又写回=修改）；观测口径与边界（不做内容级语义 diff、「不在受管清单内」≠「已删除」）在接口与 UI 显式声明；周报新增「本周它记住了什么（TOP5）」。端点 `GET /api/memory-diff`。
- **多实例联邦（M4.4）**：`/federation` 按实例聚合成本 / token / 会话（session_index.instance 维度）；活跃事件按 evidence 归属（提取不到归 global 不假归属）；实例分组（工作/实验/沙箱）；**统一急停覆盖性**（已停/总数，覆盖不全 UI 显式警示）；无实例归属的孤儿会话单列不摊派。端点 `GET /api/federation`、`POST /api/federation/group`。
- **周报增强**：新增「本周它记住了什么（TOP5）」与「进度可信度（7 天）」两个段落（均含边界诚实声明：无可核实声明时明说，不硬造指标）。

- **通知即操作（M3.1）**：高危动作触发带按钮的通知卡片，可在手机通知里直接「批准一次 / 拒绝」，不必回电脑。新增内核 `action_approvals` 表（`action_id` 唯一 + `fingerprint` 升级计数口径）与 `apps/watch/src/approvals.ts` 审批服务：
  - **超时默认拒绝**：`BUTLER_APPROVAL_TTL_SEC`（60-7200，默认 900=15 分钟）到期未应答一律置 `expired` 并生成「已拦截」事件（severity warn）+ 审计 + 告警归档；踩在超时点上的批准也按拒绝结算，不给「迟到的批准」开口子。
  - **升级防误触**：同一动作指纹（kind + 目标）在 24h 内第 `BUTLER_APPROVAL_ESCALATION_THRESHOLD`（默认 3）次请求时自动升级为「需 Web 端确认」——卡片撤下内联一键放行，只留「前往面板确认」链接；通道侧对已升级单的批准请求被服务端拒绝（409），拒绝请求仍允许（拦比放安全）。
  - **自动侦测**：`BUTLER_APPROVAL_AUTO_DETECT`（默认开）按 `action_events.id` 水位增量侦测高危动作自动开单，不全量重扫；同一动作事件幂等（只开一张单、不重复推送与留痕）。
  - **全链路留痕**：请求 / 批准 / 拒绝 / 超时四类动作全部写入审计流与事件中心（`approval-requested|approved|denied|expired`），卡片终态后自动归档。
  - 新增 `GET /api/approvals`（列表 + summary + scan 视图）、`POST /api/approvals`（显式登记，幂等，201）、`GET /api/approvals/:id`（404）、`POST /api/approvals/:id/decide`（409 已结算/需面板确认、410 已超时）；配置 `BUTLER_APPROVAL_ENABLED` / `BUTLER_APPROVAL_TTL_SEC` / `BUTLER_APPROVAL_ESCALATION_THRESHOLD` / `BUTLER_APPROVAL_AUTO_DETECT` / `BUTLER_APPROVAL_RETENTION_DAYS` / `BUTLER_PUBLIC_BASE_URL`。
  - **网关交互卡片**：`POST /api/alerts` 支持 `actions`（≤3 项，`label` + `url` 或 `callbackData`），队列新增 `actions_json` 列（含老库迁移）；Telegram 走 `inline_keyboard`（`callback_data=apr:<id>:approve|deny`），不支持内联按钮的通道（Server酱 / Bark / SMTP / 面板）**降级为正文追加 Web 确认链接**——这是计划书「微信不支持内联按钮时降级为链接到 Web 确认页」的落点。新增 `POST /api/channels/telegram/webhook` 接收 `callback_query` 并桥接到 Watch 决策端点（`BUTLER_WATCH_HTTP_URL` 可配），带 `BUTLER_TELEGRAM_WEBHOOK_SECRET` 常量时间校验，无论成败返回 200 避免 Telegram 重投。
  - 面板新增 `/approvals`（待处理 / 需面板确认 / 全部 + 五维汇总 + 剩余时限倒计时）与 `/approvals/:id` 确认页（倒计时、结构化摘要折叠、升级与超时显式说明、「批准一次只对当前动作生效」提示）。
- **会话追踪（M2.3）**：新增 `session_index` 表与会话索引服务——Hermes `state.db` 会话元数据（会话表/列按候选清单探测，命中才用）+ butler `action_events` 动作聚合 → 会话级索引（起止/时长/模型/任务类型/token/成本/终态/动作数/高危数）。异常规则首版 4 条（全部可判定）：`error-terminated`、`context-truncated`、`long-running`(>30min)、`high-risk-actions`；计划书中依赖 Hermes 工具级耗时/失败归因的 2 条规则**显式声明未实现**（接口返回 `unimplementedRules`，不冒名顶替）。新增 `GET /api/sessions`、`GET /api/sessions/:id`（时间线）、`POST /api/sessions/reindex`；配置 `BUTLER_SESSION_INDEX_ENABLED` / `BUTLER_SESSION_INDEX_RETENTION_DAYS` / `BUTLER_SESSION_REPLAY_ENABLED`。面板新增 `/sessions` 列表与 `/sessions/:id` 时间线（节点可展开脱敏载荷、异常红边）；**深链编织**：成本页会话、审计页会话标签一键跳转会话时间线。隐私红线：只索引元数据与结构化动作，**不采集对话正文**；完整回放开关为占位并在 UI 显式说明未实现。
- **Agent 周报（M2.1）**：周一 08:00（本地时区）幂等生成并推送本周汇总——成本（本周 vs 上周环比、月度预算用量、最贵会话）、实例状态、事件中心活跃项、行为审计高危计数、技能用量 TOP5、最近全量备份；全确定性组装零 LLM。推送走网关告警通道 `severity:"info"`（不挤占 warn/critical 告警语义），`dedupeKey=weekly-report:<周一日期>` 网关端幂等；crash-safe 调度（每 15 分钟 tick，服务重启错过时点自动补生成）。新增内核 `report_history` 表（week_start 唯一键 + markdown 原文 + data_json 快照）与 `GET /api/trust/report`（本周实时）、`GET /api/trust/report/history`、`GET /api/trust/report/:id`、`POST /api/trust/report/run`；配置 `BUTLER_WEEKLY_REPORT_ENABLED` / `BUTLER_WEEKLY_REPORT_PUSH`；面板新增 `/report` 页（本周速览六卡 + 正文预览 + 历史 12 周存档）。
- **成本贯通（M1.1）**：`/api/llm/usage` 透出 `estimatedCostUsd` / `actualCostUsd` / `cost.verifiedUsd`（读 Hermes `session_model_usage` 计费元数据，成本列按候选名探测、缺失时 `costAvailable=false` 显式「待接入」而非伪造 0）；新增 `GET /api/llm/cost/summary`（按日 / 模型 / 会话聚合 + 最贵会话 TOP10）与 `monthToDateCost` 月度核算。
- **预算引擎（M1.1）**：`BUTLER_BUDGET_MONTHLY_USD`（0=关闭）+ `BUTLER_BUDGET_ACTION`（alert/downgrade/pause，首版为建议+事件记录，不自动执行侵入性控制）；每 15 分钟核算，80% warn / 100% critical 告警（阈值标记持久化防重放），新增 `GET /api/budget`、`POST /api/budget/check`。
- **行为审计流（M1.2）**：Watch 增量解析 Hermes 执行日志（默认 `<hermesRoot>/logs/*.log`，`BUTLER_AUDIT_LOG_PATHS` 可覆盖；启动对齐文件末尾，不全量重扫）生成结构化动作事件（file-write/file-delete/shell-exec/api-call/message-send/web-fetch）；高危集合（删除/外发/危险命令）红色标记；行片段过凭据脱敏（sk-/Bearer/token= → ***），**不存储 prompt/对话正文**；保留期 `BUTLER_AUDIT_RETENTION_DAYS`（7-90，默认 14）。新增 `GET /api/audit/actions|summary`。
- **全局急停（M1.3）**：`POST /api/killswitch/engage|release` + `GET /api/killswitch`。engage 顺序：自动全量快照（失败如实记录不阻断）→ 经能力路由逐实例停止 → `killswitch_log` 落库（crash-safe：重启按未 released 行恢复状态）→ 事件中心 + 审计 + 网关告警三路留痕；engage 期间拒绝实例重连与升级任务（409 killswitch-engaged）。
- **事件中心数据层（M2.2）**：统一事件对象（kind/severity/title/first_seen/last_seen/count/status/evidence/related）+ 首版关联规则（版本变更 2h 内指纹 → 升级疑似回归；resolved 同键复发 → regressed 置顶，回归一等公民）。新增 `GET /api/trust/events`、`GET /api/trust/events/:id`、`POST /api/trust/events/:id/status`。
- **面板**：新增「信任层」导航组与三页——`/cost`（大数字 + 按模型/按日 + 最贵会话 TOP10）、`/audit`（按天时间线 + 类型/级别/时间窗过滤 + 降级态显式标注）、`/events`（列表 + 证据链详情 + 确认/解决/重开）；顶栏常驻「紧急暂停」按钮（两次点击触达，确认卡 → 暂停态 → 恢复）。
- **数据模型**：butler 库新增 `budget_state` / `killswitch_log` / `action_events` / `trust_events` 四表（幂等 DDL）与配套存取方法；保留期清理扩展覆盖新表。

### Changed

- `apps/web` BFF 新增信任层全部端点代理（含 `/api/sessions*`）；`docker-compose.yml` 与 `.env.example` 透传 `BUTLER_BUDGET_*` / `BUTLER_AUDIT_*` / `BUTLER_WEEKLY_REPORT_*` / `BUTLER_SESSION_*`。
- 全链路零 LLM 调用（判定规则全确定性）。

### Fixed

- **生产装配漏注信任层服务（重要）**：`createWatchApp` 的 `watchHttp` deps 未注入 `budget` / `actionAudit` / `killswitch` / `trustEvents` / `weeklyReport`，导致 M1/M2 端点在真实部署下返回 503（测试因直接构造 deps 而掩盖该问题）。本批次一并接线，并把 `sessions`（M2.3）同时注入，避免同类回归。

### Security

- 隐私红线落地：审计流仅存结构化动作字段与脱敏片段；会话索引仅存元数据与结构化动作（不含对话正文）；急停/预算/事件全部动作入审计。

## [1.0.0-beta.33] - 2026-09-06

### Added

- 技能管理收拢为「SkillHub + Git」两条原生链路，Hermes 技能目录成为唯一事实来源：
  - 新增本机技能清单（`/api/skills/local`，扫描 SKILL.md + source.json 合成名称/描述/版本/来源）；
  - 新增更新检查（`/api/skills/local/updates`）：SkillHub 来源比对平台最新版本号，Git 来源比对 GitHub 最新 commit；
  - 新增更新落位（`/api/skills/local/update`）与删除（`/api/skills/local/remove`，整目录移入备份区可手动恢复）；安装接口支持覆盖语义，更新时旧版本先备份；
  - 新增 GitHub 仓库整包安装（`/api/skills/git/stage`）：支持 owner/repo、完整 URL 与 /tree/分支；根目录含 SKILL.md 按单技能安装，合集仓库自动安装所有含 SKILL.md 的一级子目录（任一成员命中风险规则即整体拒绝）；
  - Watch 新增无依赖 tar.gz 读取器（与 ZIP 读取器同一套路径安全与解压上限约束）。

### Changed

- 技能页「我安装的」视图改用原生清单：卡片操作收敛为「更新 / 详情 / 删除」，一键更新全部按更新检查结果执行；安装状态合并 Hermes 目录与本会话记录，装完立即变已安装；「收编本机技能」「绑定源」「标签管理」等中央库概念随 skills-manager 一并从 UI 摘除（后端 `/api/skills-manager/*` 保留一个发布周期后移除）。

## [1.0.0-beta.32] - 2026-09-06

### Added

- 技能市场接入 SkillHub（skillhub.cn）开放目录：新增分类 chips / 关键词搜索 / 排序 / 分页浏览与「精选技能 · 换一换」，卡片右上「+」即可安装；安装走「下载 zip → Butler 隔离区 → 静态风险扫描 → 确认」既有安全链路。Watch 新增 SkillHub Open API 客户端（分类 6h 缓存、失败降级为可重试提示）与无依赖 ZIP 读取器（拒绝路径穿越、加密条目，防解压炸弹）。

### Changed

- 技能页按 WorkBuddy 布局重构：顶部「SkillHub / 推荐」内容 Tab + 搜索 + 「我安装的」胶囊 + 「添加技能」下拉，分类侧栏改为 chips 行，瀑布流改为自适应等高卡片网格；原有部署/升级/删除（两段式确认）/标签/Git 源绑定等管理能力保持不变。
- GitHub 令牌解析抽取为 `resolveGithubToken`（env > 注入 > 设置页保存文件），供趋势与推荐链路复用。

### Fixed

- 隔离技能安装、归档、恢复在跨挂载场景（Butler 数据卷 → Hermes 目录，rename 抛 EXDEV）不再以 500 失败：自动回退「复制 → 校验 SKILL.md → 删源」，校验失败保留源目录可重试；修复后 SkillHub / GitHub 推荐安装可正常落位。
- 技能页概览带「中央库受管」计数因取值错误恒显示 null：已修正为读取 skills-manager 状态，读不到时显示「含内置/系统技能」。

## [1.0.0-beta.31] - 2026-09-06

### Added

- 智能分析修复闭环：系统日志页修复会话完成后自动重新分析并刷新日志流；每张问题卡显示「最后出现」相对时间，并以修复完成时间为分界标记「修复后未再出现 / 修复后仍出现」——修复是否真正生效不再靠猜；修复执行中的同动作问题禁用按钮防重复发起。
- 诊断近 30 天本机结果摘要（明确窗口与证据边界）、备份可恢复性验证（每日全量在临时目录做文件与 SQLite `quick_check` 校验，状态落审计）、消息端到端等待 P50/P95 与可证明重试数。
- 推荐技能安装增加隔离确认与静态风险门禁：暂存下载即返回风险报告（外联域名/敏感路径/高风险命令），确认前完整展示，命中阻断规则 fail-closed 不写入 Hermes。

### Changed

- 常驻链路性能治理（后端）：`message_projection` 补 `(state, available_at)`/`(updated_at)` 索引并把分组判据下推 SQL；`messageStatusSummary` 聚合下推不再整表 JSON.parse；历史清理节流至 60s；`/ws` 事件轮询改 `afterId` 增量；`events`/`audit` 按 45/90 天保留期每 6 小时清理；备份的 VACUUM INTO/复制/quick_check 下沉常驻 worker（不再冻结 Watch 事件循环）；巡检跨实例并行；journald 读取异步化（日志分析链路最坏 4×15s 阻塞归零）；SQLite 预编译语句缓存。
- 前端轮询治理：首页告警数据复用通知中心轮询（去掉重复的 `/api/alerts` 请求）；轮询回调统一「内容不变不更新」稳定状态模式，`loading` 仅首屏进入——面板不再以 5-10 秒周期无意义重渲染；vendor 分包按包名归位（图表库保持懒加载）。
- 关键告警优先级抢占（critical 不再被普通提醒排队阻塞）；Watch 到 Gateway 的告警转发对瞬时故障增加有限重试；一级导航收敛「维护与升级」分组并保留全部入口。

## [1.0.0-beta.30] - 2026-09-05

### Added

- 消息死信中心：Bridge 新增 `POST /v1/outbox/{messageId}/requeue`（dead_letter → policy_pending，分配新变更序列并落审计事件），Gateway 新增 `POST /api/messages/:messageId/redeliver` 并在重投后立即触发 reconcile；面板消息明细支持按状态筛选（点击计数 chips），死信详情提供「重新投递」确认入口——同类"消息被误吞"事故用户可自助重投，不再只能等发版。
- 消息结构化指标：新增 `GET /api/messages/metrics`（按通道聚合近 N 天送达/失败/存疑与成功率，数据来自消息投影与终态历史），消息页新增「通道健康（近 30 天）」卡；替代此前对 lastError 文本的正则猜测。
- 关键事件外发通道：在 Telegram/SMTP 之外新增 Bark 与 Server酱（微信服务号）推送，critical 告警默认降级序列 Telegram → Bark → Server酱 → SMTP（新 env：`BUTLER_BARK_DEVICE_KEY` / `BUTLER_BARK_SERVER` / `BUTLER_SERVERCHAN_SENDKEY`）。
- Gateway 访问口令：配置 `BUTLER_ACCESS_TOKEN` 后所有业务路由要求鉴权（`/healthz` 与 `/internal/hermes/*` 豁免），`/internal/hermes/*` 增加每分钟 wake 限速（`BUTLER_GATEWAY_WAKE_RATE_LIMIT`，默认 120）；Web 代理自动携带口令；Compose 为 gateway 注入同一口令——内网不再等于可信。
- 设置 → 本机安全新增「记忆写操作」开关可见性：`BUTLER_MEMORY_WRITES_ENABLED` 接线到 M6 写路由与修复向导（默认关闭；开启后归档/恢复/清理/重建索引/加密导出可用，写动作仍走备份门禁与审计）——能力实现与用户出口打通。
- 「自进化」页新增「提示词优化」分区（自消息通知页迁入，两套评估/采用口径归并到同一"越改越坏"防线页面）；技能页插件库从一级 Tab 降级为只读折叠区。
- ui 引入 `@butler/contract`：消息状态过滤枚举改为契约单一来源，消除前后端双份手写漂移。

### Fixed

- 一键升级期间面板失联/误报失败：updater 的 checkout/构建/重启全部改为异步子进程，202 立即返回；`/api/status` 仓库视图 10s 缓存且升级进行中不再触碰 git（此前每次轮询同步执行 5+ git 子进程）。新增"构建期间健康检查与状态轮询保持可用"回归测试。
- 通道启停/首次配置在 Hermes 运行时不支持在线重启时不再空转 60 秒「应用中」：UI 跳过无效轮询并保留「需手动重启」提示；Bridge 将 `request_restart` 失败原因写入宿主日志（此前静默吞掉）。
- 进化页「应用到 Hermes」两处入口补齐危险操作二次确认弹窗（对齐全站统一确认层）；用户可见降级文案中的 "Watch" 统一改为「管家服务」。
- OpenClaw 能力位如实标注：README 与连接卡明确「实验性只读——支持连接探测、启停与升级回滚，技能/记忆/配置只读，不支持消息接管」。
- deploy.ps1 补齐升级前数据卷备份门禁（与 deploy.sh 同口径：失败默认阻断、保留最近 4 份、`BUTLER_ALLOW_UNBACKED_DEPLOY=true` 显式豁免）；deploy.ps1 增加 UTF-8 BOM，修复 Windows PowerShell 5.1 下中文脚本解析失败；deploy.sh 在 WSL 场景成功输出 portproxy 修复提示；README 标注 `npx agent-butler` 依赖 npm 发布状态。
- 清理约 1500 行无引用 UI 组件与 re-export 垫片；根目录调试遗留物归档至 docs/archive/；修复存量 eslint 告警（scripts/*.mjs 显式声明 Node 全局、未使用导入）。

## [1.0.0-beta.29] Added

- 技能管理页对齐 skills-manager v1.36.1：新增 skills.sh 市场搜索安装、标签管理与筛选、批量部署/取消部署/删除、一键更新全部，以及本机收编技能绑定 Git 源。

## [1.0.0-beta.28] - 2026-09-03

### Fixed

- 技能库管理器（skills-manager CLI）不再依赖镜像内置：watch 运行时检测 CLI 缺失时自动下载到数据卷（原子落位 + 0755），一键升级未重建镜像（updater 的 docker-compose 路径在部分环境不生效）也能自动恢复；下载失败才提示重新构建镜像。

## [1.0.0-beta.27] - 2026-09-03

### Fixed

- 消息网关修复：无入站关联的 queued-push 消息（Hermes 定时任务/晨报等主动外发）此前被误判取消，导致每天晨报与定时报告收不到；现按主动外发放行，并恢复重投被吞的最新消息。
- 技能管理细节：概览技能卡标注口径（Hermes 全量 vs 中央库受管）、说明更新按钮出现条件、本机收编技能标注「本机运行中」。

## [1.0.0-beta.26] - 2026-09-03

### Added

- 技能库支持一键收编本机已安装技能（dry-run 预览候选清单后确认收编，原目录保持不变）；收编技能标注「本机已有」并按来源隐藏不适用的部署/更新操作。

## [1.0.0-beta.25] - 2026-09-03

### Added

- 技能库升级为技能管理主界面：支持安装（Git 来源）、更新、删除（先取消部署再移除中央库）与部署/取消部署到 Hermes 技能目录；删除与部署均为预览+确认二段式。
- 设置 · 本机安全新增「GitHub 访问令牌」配置入口：保存后版本检查与技能市场自动携带鉴权，避免 GitHub API 匿名限流（令牌 0600 落盘，接口不回显）。

## [1.0.0-beta.24] - 2026-09-02

### Fixed

- 「关于」页更新按钮不出现的根因修复：默认更新通道由 stable 改为 beta（本项目发布全部为 beta 标签），并恢复发版打 tag 流程——tag 与当前运行版本对齐后，更新检测即可发现候选。
- 「关于」页信息密度简化：常驻仅保留管家自身、受管实例与可升级版本、退回上一版本三块；升级进度与升级前检查改为任务运行时才出现，备份节奏图移入折叠区。

## [1.0.0-beta.23] - 2026-09-02

### Added

- 集成 [skills-manager](https://github.com/xingkongliang/skills-manager) CLI：技能页新增「技能库」标签，提供中央技能库（Git/本地来源安装）、部署/取消部署到 Hermes 技能目录、更新检查。破坏性操作均为预览+确认二段式，中央库持久化在数据卷。

## [1.0.0-beta.22] - 2026-09-02

### Added

- 首页「本机运行就绪度」新增两张信息卡：「Agent 主机状态」（CPU/内存/磁盘/uptime，GPU 可选显示，多实例 Tab 切换，含各 agent 进程资源）与「管家运行指标」（巡检耗时与 14 天走势、连接响应延迟、记忆探针耗时、各服务健康检查延迟）。
- 重复问题支持一键处置：「复制求助提示词」与「转发给智能体」（新 `/api/agent-message`，经 Hermes api_server 聊天接口，回复直接展示在面板）。

### Fixed

- 消息整理「对照历史」收敛：单条默认折叠为摘要、按日期快筛、分页显示，不再无限展开；轮询降频。
- 「提示词版本管理」状态去错误化：文件被手动修改等正常状态不再显示为红色错误。
- 首页连接检查项改为一行紧凑排布（悬停查看详情），节省空间。
- `/api/health` 增加各服务健康检查延迟（latencyMs）。

## [1.0.0-beta.21] - 2026-09-02

### Fixed

- 消息网关队头永久阻塞修复：投递尝试超限的消息在取消时若残留旧的待重放决策，会导致每一轮投递循环失败、后续所有回复无法送达。现在取消与任务保持路径会先清理被取代的旧决策。

## [1.0.0-beta.20] - 2026-09-02

### Added

- 消息通知页新增一键接管开关：关闭后 Hermes 原通道直发（记录仍保留），Bridge 离线时切换保持待生效、重连后自动生效。
- 新增国内 IM「通讯工具」卡片，集中展示微信/QQ 机器人/腾讯元宝/飞书/钉钉/企业微信的连接与登录状态。
- 支持微信扫码登录，扫码状态在面板内实时展示。
- 支持通道启停与凭据型通道的首次接入配置：写入前自动备份 Hermes 配置，启停经优雅重启生效。
- 部署备份排除数据卷内备份目录并提供保留策略（`BUTLER_BACKUP_KEEP`，默认 4 份），抑制磁盘增长。

### Fixed

- 通道启停改写 Hermes 实际读取的 `enabled` 键（此前写入的 `disabled` 键不生效），并对齐 QQ 机器人（`client_secret`）与元宝（`app_id`/`app_secret`）凭据字段；通道目录按 env 强制启用判定展示真实状态。
- 原通道（passthrough）直发失败的消息现在正确落 `dead_letter`，不再永久滞留 `delivering`。
- 通道配置写入保持 `config.yaml` 与备份文件的 0600 权限基线。
- 消息策略安装全链路串行化：快速切换接管不再产生状态竞争，Bridge 离线期间的切换在恢复后自动清账生效。
- 网关启动期策略安装失败降级为周期重试，不再进入容器崩溃循环。
- Bridge 投递状态跳变分配新变更序列号，消除面板消息永久停留在「发送中」。
- 编辑消息引发的内容哈希冲突改为对账恢复，不再阻塞整个消息队列处理。
- 消息明细列表与详情两栏固定等高并内部滚动；通道操作与扫码弹窗补充错误提示、断连重试与会话泄漏修复。

## [1.0.0-beta.17] - 2026-08-31

### Added

- 核心 Markdown 文件中心：支持固定文件发现、只读保护、修改前 Diff、版本历史、备份与冲突检测。
- 自进化分析与运维诊断页面，补充技能资产安装、升级兼容性和消息通道重连能力。

### Changed

- 统一控制台视觉层级、响应式布局和图表表现，优化首次使用与跨页面操作体验。
- 本机从 `localhost` / `127.0.0.1` 访问 Web 面板时免查口令；跨设备访问继续要求管理员口令。

### Fixed

- 改善 GitHub 技能下载限流错误分类、备份门禁、原子写入和操作锁，避免错误提示误导或并发覆盖。

## [1.0.0-beta.16] - 2026-08-30

### Fixed

- 修复 Hermes Bridge 已将旧终态消息吸收后，Gateway 重放旧决策返回 `409 already terminal`，导致队列头阻塞、微信最终报告停留在 `captured` 的问题。
- Gateway 现在会自动同步 Bridge 已确认的 `delivered/absorbed/dead_letter/cancelled` 终态，并清理过期 pending 决策，后续消息可继续投递。

## [1.0.0-beta.15] - 2026-08-30

### Added

- 微信任务消息统一进入 Hermes Bridge Outbox，任务执行期间仅发送一次“已收到，任务完成后汇报。”回执，进度消息保留在站内时间线。
- 任务终态前等待 `done/failed`，使用现有 OpenAI-compatible LLM 生成“结论、已完成、异常、下一步”四段式中文报告；总结失败时自动回退原始最终结果并记录脱敏原因。
- 同一任务的重复 final/failure 结果只保留首条 canonical 消息；无 `runId` 的微信系统/告警/主动通知按聊天 120 秒窗口汇总。
- 消息详情新增等待终态、生成总结、原始结果回退与总结失败原因状态展示。

### Fixed

- 修复任务仍在运行时提前写入 `completing`、导致最终结果过早投递的问题。
- 修复微信进度消息和重复终态结果可能直接外发、造成断流与重复通知的问题。

## [1.0.0-beta.12] - 2026-08-28

### Added

- 增加 Hermes 外部协助改进工作台与技能资产中心，支持提案验证、使用统计和隔离安装流程。
- 同步所有服务、适配器、Bridge 与 updater 版本，便于本地验证管家自动更新。

## [1.0.0-beta.10] - 2026-08-28

### Fixed

- 修复统一版本脚本遗漏 Watch/Gateway 运行时版本常量的问题，确保三项服务启动后报告同一版本。

## [1.0.0-beta.8] - 2026-08-28

### Added

- Hermes WSL 自我进化闭环：真实运行时编排、预检、日志诊断、候选评估、人工采用、取消与安全阻断。
- 进化、网关、技能和版本页面统一接入真实图表数据，并增加无数据、接口错误和版本不同步状态。

### Fixed

- 修复 API Key 失效、模型端点错误和任务崩溃无法及时发现的问题；告警脱敏并按去重键合并。
- 修复 Web、Watch、Gateway 实例版本不同步及投递历史图表接口不可用的问题。

## [1.0.0-beta.7] - 2026-08-26

### Added

- 右上角重要通知中心，支持未读徽标、单条/全部标记已读和通知偏好。
- 左侧导航新增常规设置入口，主题与通知偏好会保存在当前浏览器。
- 新增 updater sidecar：生产容器可从管家内拉取 Git、构建、重启 Compose，并在失败后自动回滚。

### Fixed

- 告警队列增加 `read_at` 迁移与已读 API，旧数据库可平滑启动。
- 首页与通知轮询禁用浏览器缓存，手动刷新可读取最新消息网关状态。
- 容器自更新不再提示必须在宿主机手动执行部署脚本。

## [1.0.0-beta.6] - 2026-08-26

### Improved

- Agent Butler UI 支持「纸墨管家」亮色与「墨青夜灯」暗色主题，首屏读取系统偏好并持久化用户选择。
- 重构响应式导航与顶栏：移动端使用 Drawer，桌面端显示当前页面标题和主题切换入口。
- 拆分 UI 样式层，统一主题 token、键盘焦点环、动效时长与 `prefers-reduced-motion` 支持。

### Fixed

- 修复主题入口引用旧 API 导致的 TypeScript/Vite 构建失败。

## [1.0.0-beta.2] - 2026-08-25

### Added

- Dashboard 恢复诊断与分级修复：探测、索引重建、消息重连、网关清理和实例重启按风险执行并复验。
- Evolution 真实外部评估入口，返回样本数、指标、置信度和安全门禁结论。

### Improved

- 技能/插件按分类折叠并限制滚动区域，记忆预览独立滚动。
- 版本页按目标实例比较候选版本，无候选或不可达时显示明确原因和重新检查入口。
- 进化页优先真实评估，手工指标仅保留为旧评估器兼容入口；关键状态统一使用 Ant Design 反馈组件。

## [1.0.0-beta.1] - 2026-08-25

### Added

- Ant Design UI 组件与 Hermes/OpenClaw 连接状态、消息状态面板。
- Gateway 自动接入 Hermes Bridge，Bridge 短暂断线后持续重试并自动恢复。
- Web `/api/connections` 代理、健康检查和消息降级路径。

### Fixed

- 修复部署后 `/api/connections` 落到 Web 404 的问题。
- 修复消息运行时未接入默认 Gateway、Compose 缺少 Bridge 配置的问题。
- Docker 默认配置补齐宿主 Bridge 映射、token 路径和消息投影库路径。

### Known Limitations

- 这是 1.0 测试版，管理面仍未提供公网鉴权。
- 真实 Hermes Bridge/token 和消息通道仍需在目标环境完成现场验收。

## [0.1.0-dev.2] - 2026-08-24

### Fixed

- `pnpm test` 会先构建 TypeScript workspace，干净检出不再依赖本地遗留的 `dist/`。
- Hermes Bridge 正式声明 PyYAML 运行依赖，干净 Python 环境可解析自定义 provider 配置。

## [0.1.0-dev.1] - 2026-08-24

### Added

- 本地 Web 控制台、Watch 巡检服务与持久消息 Gateway。
- Hermes 实例探测、健康检查、日志与诊断、补丁和版本管理。
- 升级前备份、失败自动回滚，以及管家自身升级流程。
- 技能、插件和记忆资产的只读盘点与健康分析。
- 消息节流、聚合、投递状态管理及旧问题回答淘汰机制。
- Dashboard 巡检、页面加载、实例升级与回滚的可见进度反馈。

### Security

- 管理服务默认绑定回环地址；本机状态、浏览器资料、缓存、数据库和密钥文件不进入版本库。
- 记忆写操作在 V1 默认关闭，敏感写动作要求快照与审计。

### Known Limitations

- 当前为开发预览版，管理面没有公网鉴权能力。
- Hermes Bridge 需要在目标 Hermes 环境中单独安装和接线。
- 真实消息通道、升级与回滚应先在隔离环境验证。

[Unreleased]: https://github.com/jiach72/agentbutler/compare/v1.0.0-beta.30...HEAD
[1.0.0-beta.30]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.30
[1.0.0-beta.29]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.29
[1.0.0-beta.28]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.28
[1.0.0-beta.17]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.17
[1.0.0-beta.16]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.16
[1.0.0-beta.15]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.15
[1.0.0-beta.12]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.12
[1.0.0-beta.7]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.7
[1.0.0-beta.6]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.6
[1.0.0-beta.2]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.2
[1.0.0-beta.1]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.1
[0.1.0-dev.2]: https://github.com/jiach72/agentbutler/releases/tag/v0.1.0-dev.2
[0.1.0-dev.1]: https://github.com/jiach72/agentbutler/releases/tag/v0.1.0-dev.1
