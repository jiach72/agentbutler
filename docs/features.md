# Agent Butler 完整功能介绍与功能列表

本文档提供 **Agent Butler** 系统的完整功能特性总览与详细功能清单，作为系统设计、产品手册及日常使用的标准参考。

---

## 一、 产品定位与核心理念

[Agent Butler](file:///c:/Users/jiach/Documents/Agent%20Butler/PRODUCT.md) 是一个**本地优先（Local-first）的智能体管家系统**（定位类似本机 AI 的“电脑管家”）。它面向部署在用户本机或局域网的智能体运行时（以 [Hermes Agent](https://github.com/nousresearch/hermes-agent) 为第一公民，兼容 [OpenClaw](file:///c:/Users/jiach/Documents/Agent%20Butler/README.md#L22-L24) 实验性只读监控），提供统一的**健康巡检、任务调度监控、多通道消息接管、行为安全审计、成本与预算控制、审批闭环与一键容灾运维**。

### 1. 核心设计原则
- **分工明确**：Hermes 是智能体任务唯一的调度与执行引擎，Agent Butler 负责**观测、展示、防御、审计与管控**，不越权替代调度引擎。
- **先给结论，再给动作**：首屏优先用通俗语言直接告诉用户“系统是否正常、需不需要我点一下”，杜绝让普通用户直面冷冰冰的堆栈或晦涩代码。
- **真实诚实，拒绝造假**：没有数据就明确标注“待接入/无法核实”，离线就提示离线，绝不用假数据、模拟消息或空按钮冒充真实能力。
- **严格隐私红线**：行为审计与会话索引仅采集结构化动作事件与元数据（敏感 Token 自动脱敏），**绝不抓取或存储用户的会话正文与 Prompt 隐私**。
- **安全失败（Fail-Closed）**：高危动作审批超时（15分钟）默认拒绝；踩点审批按拒绝结算；急停期间阻断一切外部调用与升级。

---

## 二、 系统架构与部署形态

```text
+-----------------------------------------------------------------------+
|                             Agent Butler                              |
|                                                                       |
|  +------------------+     +-------------------+     +---------------+ |
|  |     butler-web   |---->|   butler-gateway  |---->| Hermes Bridge | |
|  | (端口 7531, BFF) |     | (端口 7532, 消息) |     | 宿主机 loopback| |
|  +--------+---------+     +---------+---------+     +---------------+ |
|           |                         |                                 |
|           v                         v                                 |
|  +------------------+     +-------------------+                       |
|  |   butler-watch   |     | agent-butler-data |                       |
|  | (端口 7533, 巡检) |     |   (持久化数据卷)   |                       |
|  +--------+---------+     +-------------------+                       |
|           |                                                           |
|           v                                                           |
|  +------------------+                                                 |
|  |  butler-updater  | (内部自更新 Sidecar，带自动快照与失败回滚)         |
|  +------------------+                                                 |
+-----------------------------------------------------------------------+
```

系统采用 Docker Compose 容器化编排，所有路由与导航统一由前端 [`routeMeta.ts`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/lib/routeMeta.ts) 作为单一事实源驱动，涵盖**四大业务功能矩阵**：
1. **日常控制台（Console & Daily Operations）**
2. **信任层（Trust Layer：费用、记录、审计与管控）**
3. **维护、诊断与进阶工具（Maintenance & Advanced Tools）**
4. **系统设置与安全运维（Settings & Operations）**

---

## 三、 完整功能列表与模块详解

### 1. 日常控制台模块 (Console)

日常核心功能入口，满足用户每日查看状态、管理定时任务、收取通知和管理知识的基本需求。

| 功能模块 | 对应路由 | 核心功能与技术特性 |
| :--- | :--- | :--- |
| **首页看板**<br>`Dashboard` | [`/dashboard`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/dashboard/DashboardPage.tsx) | • **实时体检**：展示 Hermes / OpenClaw 实例运行状态、Bridge 连通性、本地服务健康度；<br>• **待办聚合**：汇聚待处理事项（高危审批、失败消息、待解决告警）；<br>• **任务透视**：直观展示下一条定时任务倒计时与最近任务执行结果；<br>• **一键动作**：提供“立即检查”、“快速修复”大白话入口。 |
| **定时任务**<br>`Tasks` | [`/tasks`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/tasks/TasksPage.tsx) | • **任务统一观测**：集中查看 Hermes 托管的 Cron 定时任务列表与状态；<br>• **手动执行**：支持一键手动立即触发任务并实时获取运行输出；<br>• **时区真实呈现**：按 Hermes 实际时区显示，不虚构未支持的单任务时区；<br>• **通知闭环抽屉**：配置任务完成后的推送偏好（通道概况、绿标有效通道、缺失告警跳转）。 |
| **消息通知网关**<br>`Gateway` | [`/gateway`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/gateway/GatewayPage.tsx) | • **待处理收件箱**：仅筛选展示发送失败、结果未知、待审批、待确认的重要消息，屏蔽已送达噪音；<br>• **一键接管切换**：支持运行时切换接管状态（关=原通道直发；开=Butler策略管线）；<br>• **断线自愈与重试**：Gateway 到 Bridge 自动断线重连，断网离线不崩溃，恢复后自动续传 Outbox；<br>• **多通道生态管理**：支持微信扫码登录、QQ、元宝、飞书、钉钉、企业微信、Telegram、Bark、Server酱、SMTP邮件等通道状态与配置备份；<br>• **防骚扰与节奏治理**：内建勿扰时段 (DND)、速率限制 (Pacing) 与消息摘要聚合 (Digest)。 |
| **智能体与记忆**<br>`Skills` | [`/skills`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/skills/SkillsPage.tsx) | • **原生技能管理**：Hermes 技能目录为唯一事实源，支持安装、更新与两段式安全删除（移入备份区可还原）；<br>• **市场接入**：接入 SkillHub 开放目录与 GitHub 仓库直接整包/单包安装；<br>• **安全防御沙箱**：内置静态风险扫描，防御路径穿越攻击（Zip-Slip）与解压炸弹；<br>• **记忆探针**：以只读方式透视智能体当前的记忆与上下文槽位状态。 |
| **本地知识库**<br>`Knowledge` | [`/knowledge`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/knowledge/KnowledgePage.tsx) | • **文档归集与切片**：本地资料与文档的统一收集、分块处理与向量存储；<br>• **RAG 问答支撑**：为智能体本地问答提供上下文语义检索与检索召回评估；<br>• **严格精确去重**：仅依据 SHA-256 哈希完全相同的副本进入清理队列，同名不同内容仅列为线索，二次确认防误删。 |
| **专家工具集**<br>`Tools` | [`/tools`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/tools/ToolsPage.tsx) | • **折叠高级入口**：为高阶用户收纳系统日志、排障引导、自进化、核心文件、大屏等专业维护工具，保持主界面清爽。 |

---

### 2. 信任层体系 (Trust Layer)

信任层是 Agent Butler 的核心护城河能力，专为解决“模型花费不可控、行为不可见、进度虚报、升级引入回归”等用户信任痛点而构建。

```text
┌─────────────────────────────────────────────────────────────┐
│                       信任层 (Trust Layer)                  │
├──────────────────────────────┬──────────────────────────────┤
│        费用与记录             │          审计与管控          │
│  • 成本中枢 (/cost)          │  • 行为审计流 (/audit)       │
│  • Agent 周报 (/report)      │  • 高危操作审批 (/approvals) │
│  • 会话追踪 (/sessions)      │  • 假进度检测 (/progress)    │
│  • 记忆变更 (/memory-diff)   │  • 事件中心 (/events)        │
│                              │  • 实例联邦 (/federation)    │
│                              │  • 升级金丝雀 (/canary)      │
└──────────────────────────────┴──────────────────────────────┘
```

#### (1) 费用与记录
- **成本中枢与预算引擎 ([`/cost`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/cost/CostPage.tsx))**：
  - **防御式计费探测**：对接底层真实 Token 消耗与模型计费元数据，无计费数据显式标注“待接入”，坚决不编造假数字；
  - **三维多角聚合**：支持按日、按模型、按会话多维透视，自动统计展示最昂贵的「TOP 10 会话排行榜」；
  - **月度预算防护**：每 15 分钟核算预算，到达 80% 触发警告（Warn），到达 100% 触发严重告警（Critical），具备告警防重放机制。
- **Agent 周报 ([`/report`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/report/ReportPage.tsx))**：
  - **全自动幂等生成**：每周一 08:00 自动结算上周数据并主动推送到指定通知通道；
  - **确定性计算**：全链路采用算法聚合，零 LLM 依赖，不额外产生 Token 开销；
  - **多维回顾**：囊括成本环比走势、预算用量、活跃高危动作数、技能使用排行、记忆新增与遗忘 TOP 5、进度可信度；支持近 12 周历史存档回溯。
- **会话追踪与回放 ([`/sessions`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/sessions/SessionsPage.tsx), [`/sessions/:id`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/sessions/SessionDetailPage.tsx))**：
  - **会话多维索引**：整合起止时间、耗时、模型版本、Token 量、实际成本与终态；
  - **异常行为规则引擎**：自动识别 4 类异常会话——异常中断（`error-terminated`）、上下文截断（`context-truncated`）、长耗时（`long-running > 30min`）以及高危操作（`high-risk-actions`）；
  - **时间线回放**：以时间轴展开动作节点并支持查看脱敏载荷；**严守隐私红线，绝不采集/存储对话正文**。
- **记忆变更与可视化 ([`/memory-diff`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/memory/MemoryDiffPage.tsx))**：
  - 从审计流增量分析本周记忆文件的变动；
  - 明确区分为新增（Added）、修改（Modified）与遗忘（Forgotten，即删除后未再写回）；显式标明口径边界。

#### (2) 审计与管控
- **行为审计流 ([`/audit`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/audit/AuditPage.tsx))**：
  - **实时动作解析**：增量抓取底层执行日志，提取 6 大类结构化动作（文件写 `file-write`、文件删 `file-delete`、命令执行 `shell-exec`、API 调用 `api-call`、消息发送 `message-send`、页面抓取 `web-fetch`）；
  - **高危行为红色警示**：对删文件、外发消息、危险终端命令打上醒目红标；
  - **敏感凭据自动脱敏**：正则自动屏蔽 `sk-*`、`Bearer`、`token=*` 等敏感信息。
- **操作审批与通知即操作 ([`/approvals`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/approvals/ApprovalsPage.tsx), [`/approvals/:id`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/approvals/ApprovalDetailPage.tsx))**：
  - **通知卡片交互**：高危动作触发即时通知卡片，支持在手机通道（如 Telegram Inline Keyboard）直接点击「批准一次」或「拒绝」，不支持按钮的通道自动降级为一次性 Web 确认链接；
  - **超时默认安全拦截**：默认 15 分钟无应答自动视为已拒绝（Expired），即使踩点审批也判定拒绝；
  - **防误触升级阶梯**：同一动作指纹在 24 小时内若第 3 次被触发，自动升级为强制“前往面板确认”，阻断通道侧直接放行；
  - **管理模式支持**：支持「逐项询问 (ask)」与「全部允许 (allow-all)」，可批量审批（最高 100 笔），且全部过程入库留痕，任何模式均不可绕过全局急停。
- **假进度检测（差异化王牌功能）([`/progress`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/progress/ProgressPage.tsx))**：
  - **言行对账算法**：增量提取智能体在对话或日志中声称的进度百分比（如“已完成 60%”），与窗口期内的真实系统副作用操作（写删文件、执行命令等）进行交叉比对；
  - **三态结论**：
    - `verified`（已验证）：存在对应的真实系统副作用；
    - `suspect`（可疑）：该时段系统可观测但没有任何副作用操作（疑似画饼或陷入思考幻觉）；
    - `unverifiable`（无法验证）：无观测上下文，绝不武断瞎猜为可疑；
  - **异常点名**：连续 $\ge 3$ 次 suspect 或最终宣称完成但零副作用时，自动升级生成信任异常事件，并在周报中点名通报。
- **事件中心 ([`/events`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/events/EventsPage.tsx))**：
  - **统一事件管理**：集中管理 41 种运行时及系统事件（涵盖状态流转：活跃、已确认、已解决、已回归）；
  - **通俗化转译**：附带通俗的中文解释与可执行的处理指引，避免枯燥的机器代码；
  - **升级回归关联**：升级后 2 小时内新出现的错误指纹，自动关联归因为“升级疑似回归”，帮助快速定位根因。
- **升级金丝雀与影子策略 ([`/canary`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/canary/CanaryPage.tsx))**：
  - **影子验证机制**：在目标版本切换前，基于真实历史任务抽取样本（10 笔常规 + 全部失败任务），在隔离的虚拟环境中进行冒烟重放；
  - **严苛三指标准入**：成功率降幅 $\le 5\%$、Token 消耗增幅 $\le 15\%$、无新增 Error 级别错误指纹；**缺少任一测试数据一律判定不通过**；
  - **观察窗与自动回滚**：切换后进入 24h/48h 观察窗，一旦发现严重回归故障，自动唤醒快照安全回滚。
- **多实例联邦 ([`/federation`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/federation/FederationPage.tsx))**：
  - 支持多台 Agent 实例的集中管理，按分组（工作、实验、沙箱）统揽成本与事件；
  - 提供全局急停覆盖率检测（警示未受保护的遗漏实例）与孤儿会话单列追踪。

---

### 3. 安全控制、高级维护与排障 (Maintenance & Tools)

| 功能特性 | 入口/工具 | 详细能力与机制 |
| :--- | :--- | :--- |
| **全局急停**<br>`KillSwitch` | 顶栏常驻红钮<br>& 通道口令 | • **面板两步触达**：顶栏显眼红色急停按钮，一键调起确认卡，立即生效；<br>• **四步安全熔断**：自动全量快照 $\rightarrow$ 能力路由停止实例 $\rightarrow$ 状态落盘防重启自启 $\rightarrow$ 审计/事件/告警三路留痕；<br>• **远程口令急停**：支持在通讯工具中直接发送「`<口令>` 急停/恢复/状态」完成跨网络远程熔断；口令长度与会话白名单严格防护。 |
| **核心文件管理**<br>`Core Files` | [`/core-files`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/CoreFilesPage.tsx) | • **关键资产维护**：针对智能体的角色设定、System Prompt、核心配置 Markdown 文件的安全查看与在线编辑；<br>• **版本历史与回滚**：自动保存修改历史快照，出现提示词漂移或异常时支持一键对比与历史回滚。 |
| **问题排查与恢复**<br>`Troubleshoot` | [`/troubleshoot`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/troubleshoot/TroubleshootPage.tsx) | • **Runbook 场景式排查**：按照具体现象分类引导（如网关断连、消息超时、启动失败），按步骤诊断并提供建议；<br>• **恢复作业（Recovery Jobs）**：执行系统状态重置与一键修复流程。 |
| **系统日志**<br>`Logs` | [`/logs`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/Logs.tsx) | • **多容器日志汇聚**：集中查看 Web、Gateway、Watch 服务及宿主日志；<br>• **错误指纹萃取**：自动聚合高频错误堆栈并匹配排障建议。 |
| **自进化与提示词优化**<br>`Evolution` | [`/evolution`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/evolution/EvolutionPage.tsx) | • **瓶颈定位**：分析历史失败会话与动作，诊断 Prompt 漏洞；<br>• **优化对比**：集成 Promptfoo 进行对照评测，支持方案快速应用（实验性功能，可按需开启）。 |
| **连接体检与安装医生**<br>`Setup & Doctor` | [`/setup`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/setup/SetupPage.tsx)<br>& 命令行工具 | • **首次配置向导**：三步环境与实例连接检查；<br>• **安装医生 (`doctor.mjs`)**：命令行运行 `node scripts/doctor.mjs`，执行 10 项只读环境体检（容器、端口、Bridge、.env 安全脱敏核查），输出标准修复指令。 |
| **记忆系统中心**<br>`Memory Center` | [`/memory`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/memory/MemoryCenterPage.tsx) | • **扩展记忆引擎**：支持切换与集成第三方记忆方案，提供 Docker 快速拉起与 Jev 智能记忆治理功能。 |
| **全屏大屏监控**<br>`Wall Dashboard` | [`/wall`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/wall/WallPage.tsx) | • **全屏大屏模式**：无侧栏顶栏的纯净大屏展示，具备自适应等比缩放能力，适合展台展示或副屏常驻只读监控。 |
| **Ollama 本地大模型**<br>`Local Ollama` | 后台服务集成 | • **双模支持**：支持 Compose 容器内一键自托管 Ollama，或直连 Mac 宿主 Metal GPU / Windows 本地原生 Ollama；<br>• **硬件感知**：自适应硬件阶梯推荐模型，内置本地用量统计与接口反代。 |

---

### 4. 系统设置与运维保障 (Settings & System Ops)

所有系统级配置收敛在 [`/settings`](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/settings/SettingsPage.tsx)，侧边栏底部固定钉住：

1. **本机安全与网络基线**：
   - 默认且强制建议绑定本机回环地址（`127.0.0.1:7531`）；
   - 开启局域网/公网跨设备访问时，强制要求设置高强度 `BUTLER_ACCESS_TOKEN`；
   - 访问口令仅存入浏览器的 `sessionStorage`，绝不写入 `localStorage`，地址栏 `?token=` 仅消费一次并立刻清理，杜绝 XSS 凭据常驻泄露；
   - WebSocket 采用一次性 Ticket 握手机制（`POST /api/ws-ticket`）；
   - Docker Socket 默认关闭挂载（`/dev/null`），仅在受管容器明确需要时由管理员手动开放。
2. **备份与一键平滑升级**：
   - **自动化数据保护**：每次系统升级或配置关键变更前，自动触发底层 SQLite 数据卷和关键配置的全量快照备份；
   - **容器内 Updater Sidecar**：在面板「设置 $\rightarrow$ 关于」可直接点击一键升级，Sidecar 自动拉取 Git 标签、重新构建镜像、滚动重启容器并执行健康等待，检测到故障自动回滚上个版本。
3. **模型与渠道凭据管理**：
   - **模型配置中心**：支持增删 LLM 配置 Profile，提供连通性真实探针测试，支持模型启用/禁用；
   - **主密钥加密存储**：首次启动自动生成 `BUTLER_SECRET_MASTER_KEY`，本地加密存储模型 API Key 等凭证，保障静态安全。
4. **移动端 PWA 支持**：
   - 支持移动端浏览器“添加到主屏幕”（PWA 标准 Manifest）；
   - 宽度 $\le 600\text{px}$ 自动激活移动端专用底部 Tab 栏（首页、任务、消息、设置，右侧支持抽屉展开全部工具）；
   - 移动端专门设计了适配刘海屏的安全区，放大触控目标，并在底部常显大红底急停按钮。

---

## 四、 页面导航与功能全景矩阵

| 导航分组 | 菜单名称 | 页面路由 | 核心功能速览 | 访问路径与推荐场景 |
| :--- | :--- | :--- | :--- | :--- |
| **日常使用** | 首页 | `/dashboard` | 系统健康、连接状态、待处理概览 | 日常打开首站，确认管家是否正常 |
| | 定时任务 | `/tasks` | Hermes 定时任务、手动执行、通知闭环 | 管理与查看自动化工作流 |
| | 消息通知 | `/gateway` | 待处理消息队列、通道配置、接管切换 | 处理失败/未知消息，扫码接入多渠道 |
| | 智能体与记忆 | `/skills` | 技能市场(SkillHub)、Git整包安装、记忆探针 | 扩展 Agent 能力，检查记忆文件 |
| | 本地知识库 | `/knowledge` | 文档切片、向量存储、SHA-256 去重治理 | 本地 RAG 知识检索增强 |
| | 专家工具 | `/tools` | 体检、排障、日志、自进化、核心文件入口聚合 | 专家级维护工具导航页 |
| **记录与审批**<br>*(信任层)* | 成本 | `/cost` | 实际/预估成本统计、最贵会话TOP10、月度预算 | 模型花费账单核算与限额告警 |
| | Agent 周报 | `/report` | 每周一 08:00 自动汇总推送、12周历史 | 周期性评估智能体产出与消耗 |
| | 会话追踪 | `/sessions` | 会话索引、异常规则识别、时间线回放 | 排查异常中断/上下文溢出会话（无对话正文） |
| | 记忆变更 | `/memory-diff` | 本周记忆新增、修改与遗忘（删除）明细 | 洞察智能体知识边界迭代 |
| | 行为审计 | `/audit` | 6 大类结构化动作流、高危标红、凭据脱敏 | 审查 Agent 在操作系统中的一举一动 |
| | 操作审批 | `/approvals` | 通知即操作卡片、15分钟超时拒绝、升级确认 | 高危动作的人在回路（HITL）把关 |
| | 进度可信度 | `/progress` | 进度声明与实际系统副作用交叉对账 | 防治 Agent 假进度与思考幻觉（差异化王牌） |
| | 实例联邦 | `/federation` | 多实例聚合成本、Token、急停覆盖率 | 集中管理多套 Agent 实例 |
| **维护工具** | 核心文件 | `/core-files` | Prompt、角色 Markdown 在线编辑与快照历史 | 修改 Agent 人设与系统配置 |
| | 记忆系统中心 | `/memory` | 第三方记忆引擎切换、Docker部署、Jev 治理 | 进阶记忆中枢维护 |
| | 排查问题 | `/troubleshoot` | 故障诊断、Runbook 方案执行、作业恢复 | 遇到连接或服务异常时的一键排障 |
| | 自进化 | `/evolution` | 执行日志分析、Promptfoo 评测优化 | 提升 Agent 提示词质量与准确率 |
| | 系统日志 | `/logs` | Web / Gateway / Watch 服务与宿主日志检索 | 深入底层排查故障堆栈 |
| | 连接体检 | `/setup` | 3 步设置向导与网络/Bridge/环境体检 | 首次部署或变更网络后的连通性检查 |
| **设置与常驻** | 设置 | `/settings` | 本机安全基线、升级与备份、模型与通知偏好 | 侧边栏底部固定，全局参数配置 |
| | 升级策略 | `/canary` | 升级金丝雀、影子冒烟环境验证、自动回滚 | 入口在「设置 $\rightarrow$ 进阶工具」，保障版本安全 |
| | 监控大屏 | `/wall` | 全屏只读、等比缩放、极简大屏呈现 | 独立大屏或副屏展示 |
| | 全局急停 | 常驻顶栏 | 自动快照 $\rightarrow$ 实例停止 $\rightarrow$ 防重启落盘 $\rightarrow$ 三路留痕 | 任何时刻一键熔断失控行为 |
