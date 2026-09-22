# Agent Butler 前端 UI/UX 深度复盘与系统优化实施计划

> **规范输入**：
> - [产品审计报告 (docs/product-audit-2026-09-20.md)](file:///c:/Users/jiach/Documents/Agent%20Butler/docs/product-audit-2026-09-20.md)
> - 前期架构与事实复查报告（纠偏了侧栏过载与状态映射的误判，澄清了 Hermes IM 通道 vs Butler 运维告警的双轨架构）
> - **`/ui-ux-pro-max` 设计工程智囊**（10 大交互准则、无障碍 AA、触控 44px、防抖、CLS 预占位、等宽数字）

---

## 一、复盘与战略决策定调

通过 `/ui-ux-pro-max` 对当前全栈代码深度扫描，确认产品视觉基础（`tokens.ts` v2.0 管家蓝主色、无 Emoji 矢量图标、WCAG 对比度、`prefers-reduced-motion`）具有极高起点。

但现有交互和工程架构存在**三项深层体验短板**与**三项核心技术债务**：

```
                    ┌────────────────────────────────────────────────────────┐
                    │                      三大交互痛点                      │
                    ├────────────────────────────────────────────────────────┤
                    │ 1. 任务通知假闭环：打开开关却未感知未连 IM 通道 (盲盒)│
                    │ 2. 移动触控热区小：行内 Button < 28px 易误触 (违背HIG) │
                    │ 3. 动态数据微抖动：倒计时/货币无 tabular-nums，首屏CLS │
                    └────────────────────────────────────────────────────────┘
                                                │
                                                ▼
                    ┌────────────────────────────────────────────────────────┐
                    │                      三大技术债务                      │
                    ├────────────────────────────────────────────────────────┤
                    │ 1. apps/web/src/server.ts 4297行 单体 Fastify 装配     │
                    │ 2. apps/watch/src/http.ts 4077行 原生 node:http 单调度 │
                    │ 3. packages/core/src/store.ts 3426行 32张表全混居      │
                    └────────────────────────────────────────────────────────┘
```

---

## 二、详细实施方案（分阶段演进）

---

### Phase 1: 前端 UI/UX 体验跃迁（基于 `ui-ux-pro-max`）

#### 1. [UX-01] 定时任务抽屉的通知闭环（Progressive Disclosure & Inline Validation）
* **现状痛点**：用户在 [TaskEditorDrawer.tsx](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/tasks/TaskEditorDrawer.tsx) 中打开“执行完成后通知”，系统只记录 `delivery: { enabled: true }`，如果用户尚未在 Hermes 接入微信/钉钉/QQ，任务跑完结果无处可发，用户以为系统坏了。
* **改进方案**：
  - 任务编辑抽屉挂载时，并行调用 `/api/messages/channels` 缓存通道概况；
  - 当“执行完成后通知”开关开启时，**渐进式展示上下文提示块**：
    - **已有可用通道**（如微信已登录）：展示小绿标 `[微信 · 张三] 将接收任务执行报告`；
    - **无任何可用通道**：展示黄色警告提示框：*“当前尚未连接任何通讯工具，任务完成后结果仅保留在执行历史中”*，并附带 `[扫码配置微信/QQ →]` 快捷跳转。
* **涉及文件**：
  - [MODIFY] [ui/src/pages/tasks/TaskEditorDrawer.tsx](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/tasks/TaskEditorDrawer.tsx)

#### 2. [UX-02] 移动端触控热区合规化（Touch Targets ≥ 44×44px）
* **现状痛点**：`ChannelGrid.tsx` 中的「扫码登录」「发送测试消息」「配置」以及任务列表操作栏使用了 `size="small"`（高度 24~28px），不满足移动端 44×44pt 触控标准，在手机或触摸屏设备上极易误点。
* **改进方案**：
  - 引入 CSS 媒介查询与现代触控检测 `@media (pointer: coarse)`，在移动端自动扩展小按钮的伪元素点击热区（`hitSlop` 模式）：
    ```css
    @media (pointer: coarse) {
      .channel-grid .ant-btn-sm,
      .task-action-btn {
        min-height: 40px;
        min-width: 44px;
        padding: 8px 14px;
      }
    }
    ```
  - 调整卡片间距保证操作项间隔 ≥ 8px，彻底消除手势碰撞。
* **涉及文件**：
  - [MODIFY] [ui/src/pages/gateway/gateway.css](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/gateway/gateway.css)
  - [MODIFY] [ui/src/pages/tasks/tasks.css](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/tasks/tasks.css)

#### 3. [UX-03] 数据文本等宽对齐与消除排版抖动（Tabular Figures & No Jitter）
* **现状痛点**：首页时间相对显示（“约 12 分钟后”）、成本页指标（`$12.34`）、周报数据中的数字使用了普通比例字体。数字从 `1` 变 `8` 时字符宽度变化，引发微小但明显的文本晃动。
* **改进方案**：
  - 在 `tokens.ts` 中固化数字排版标准：全局对指标（Metrics）、倒计时、金额标签注入 `font-variant-numeric: tabular-nums`；
  - 核心大数字看板强制采用等宽数字栈：`JetBrains Mono, Fira Code, monospace`。
* **涉及文件**：
  - [MODIFY] [ui/src/theme/tokens.ts](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/theme/tokens.ts)
  - [MODIFY] [ui/src/styles/base.css](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/styles/base.css)

#### 4. [UX-04] 首屏骨架屏对齐以消除视觉跳跃（CLS < 0.1）
* **现状痛点**：首页加载时渲染通用的 6 行骨架段落，高度远小于真实卡片，真实数据到达瞬间引起页面跳跃。
* **改进方案**：
  - 按照 `ui-ux-pro-max` 规则构建高度拟真的 `DashboardSkeleton`，由占位脉搏药丸、结论横幅（高 ~110px）和 3 栏指标卡预留空间组成，保证渲染前后 Cumulative Layout Shift 趋近于 0。
* **涉及文件**：
  - [MODIFY] [ui/src/pages/dashboard/DashboardPage.tsx](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/dashboard/DashboardPage.tsx)

#### 5. [UX-05] 首页 Agent 连接状态胶囊消除二义性
* **现状痛点**：`DashboardPage.tsx#L76` 显示“Hermes Agent 待命 / 离线”，未区分空闲待命与断线离线。
* **改进方案**：
  - 拆分为三态：
    1. 在线就绪：`Hermes Agent 就绪待命 (N/M 在线)` (绿色脉搏)；
    2. 全部离线：`Hermes Agent 离线 (请检查实例)` (灰色静止)；
    3. 正在探测：`正在检查 Hermes 连接…` (黄色呼吸)。
* **涉及文件**：
  - [MODIFY] [ui/src/pages/dashboard/DashboardPage.tsx](file:///c:/Users/jiach/Documents/Agent%20Butler/ui/src/pages/dashboard/DashboardPage.tsx)

---

### Phase 2: 核心技术债务拆解（工程健壮性与解耦）

#### 1. [ENG-01] `apps/web/src/server.ts`（4,297行）拆解为 Fastify 插件架构
* **拆分原则**：
  - 保持 `createWebServer(options)` 入口不变，保证单测与启动层 100% 兼容；
  - 提炼公共 `WebContext = { gatewayUrl, watchUrl, store, doFetch, ... }`；
  - 将原 18 个 `/* ----- */` 区域解耦为独立路由插件文件：
    - `apps/web/src/routes/health.ts` (健康检查/状态/凭据)
    - `apps/web/src/routes/alerts.ts` (告警代理)
    - `apps/web/src/routes/messages.ts` (Hermes 消息与通道管理)
    - `apps/web/src/routes/watch-proxy.ts` (定时任务、巡检、连接代理)
    - `apps/web/src/routes/trust-layer.ts` (急停、审计、会话、审批流)
    - `apps/web/src/routes/gateway-panel.ts` (网关大聚合与补丁)
    - `apps/web/src/routes/ollama.ts` (本地模型管理)
    - `apps/web/src/routes/ws.ts` (WebSocket /ws 事件泵)
  - `server.ts` 收敛为纯装配入口（~300 行）。
* **涉及文件**：
  - [MODIFY] [apps/web/src/server.ts](file:///c:/Users/jiach/Documents/Agent%20Butler/apps/web/src/server.ts)
  - [NEW] `apps/web/src/routes/*.ts`

#### 2. [ENG-02] `apps/watch/src/http.ts`（4,077行）拆解为子路径分发调度器
* **拆分原则**：
  - 保持原生 `node:http` 与注入接口 `WatchHttpDeps` 不变；
  - 将主 `handle` 函数中 2,800 行的庞大条件链，按 URL 前缀抽取为纯函数调度子模块：
    - `handlers/tasks.ts` (`/api/scheduled-tasks*`)
    - `handlers/trust.ts` (`/api/budget*`, `/api/audit*`, `/api/killswitch*`, `/api/trust/*`, `/api/sessions*`, `/api/approvals*`, `/api/canary*`, `/api/progress*`)
    - `handlers/system.ts` (`/healthz`, `/api/runtime`, `/api/backups*`, `/api/logs*`, `/api/inspect*`)
    - `handlers/skills.ts` (`/api/skills*`, `/api/llm/*`, `/api/memory*`)
  - `http.ts` 只保留安全性 Origin/Token 校验、分派管道与全局兜底。
* **涉及文件**：
  - [MODIFY] [apps/watch/src/http.ts](file:///c:/Users/jiach/Documents/Agent%20Butler/apps/watch/src/http.ts)
  - [NEW] `apps/watch/src/handlers/*.ts`

#### 3. [ENG-03] `packages/core/src/store.ts`（3,426行）仓储模式领域分包
* **拆分原则**：
  - **杜绝使用脆弱的 Mixin 模式**；
  - 采用 **门面模式 + 子仓储 (Facade + Sub-repositories)**：
    - `packages/core/src/repositories/telemetry.ts` (events, fingerprints, tail_positions, instances)
    - `packages/core/src/repositories/lifecycle.ts` (jobs, snapshots, backups, runtime_settings)
    - `packages/core/src/repositories/trust.ts` (budget, killswitch, action_events, trust_events, session_index, approvals, canary, progress)
    - `packages/core/src/repositories/prompt.ts` (M5 提示词优化 5 张表)
    - `packages/core/src/repositories/llm.ts` (llm_profiles, versions, bindings)
  - `SqliteStore` 持有各个子仓储实例，所有原有公开方法保持为单行委托（如 `insertTrustEvent(e) { return this.trust.insertEvent(e); }`），调用方与单测 100% 免改动。
* **涉及文件**：
  - [MODIFY] [packages/core/src/store.ts](file:///c:/Users/jiach/Documents/Agent%20Butler/packages/core/src/store.ts)
  - [NEW] `packages/core/src/repositories/*.ts`

#### 4. [ENG-04] 精准速率限制（防误杀策略）
* **策略纠偏**：
  - **严禁**针对所有接口一刀切设置 100/min；
  - 为 `@fastify/rate-limit` 建立分级策略：
    - 静态资源、WebSocket、`/api/health`：完全豁免；
    - 轮询聚合端点（`/api/dashboard`, `/api/messages/status`, `/api/alerts`）：宽容限流 600/min；
    - 高危与破坏性端点：
      - `/api/killswitch/*`：严格限制 10/min；
      - `/api/upgrade/run`：限制 5/min；
      - `/api/inspect/run`：限制 10/min。
* **涉及文件**：
  - [MODIFY] [apps/web/src/server.ts](file:///c:/Users/jiach/Documents/Agent%20Butler/apps/web/src/server.ts)

---

### Phase 3: 架构规范与战略演进（长期规划）

1. **Watch 服务框架对齐**：P6 拆分就绪后，将 Watch 逐步迁入 Fastify，与 Web / Gateway 形成同构中间件与 Schema 验证体系。
2. **环境自适应结构化日志**：生产/容器镜像环境下启用 `pino` JSON 输出并携带 `requestId`，本地开发环境通过 pretty 保持高可读性。
3. **OpenClaw 适配器战略收口**：在设置页关于卡片明确标注入门支持范围，避免用户产生消息接管能力的错误预期。

---

## 三、验证与交付标准 (Verification Plan)

### 1. 自动化工程门禁（零回归验证）
每次代码变更后必须严格跑通全量门禁流水线：
```bash
corepack pnpm version:check
corepack pnpm lint
corepack pnpm test
corepack pnpm build
docker compose config --quiet
```

### 2. 交互与体验实测（基于 `ui-ux-pro-max` 检查清单）
- **触控面积检查**：在 Chrome DevTools 模拟移动设备（iPhone 14 / Pixel 7），使用检查器核对通讯工具按钮和任务卡片热区尺寸 ≥ 44×44px；
- **通知上下文联动**：在未配置通讯工具的环境中打开新建定时任务抽屉，验证警告卡片出现，点击外链能直达扫码页面；接入通道后，警告自动消失并替换为通道标签；
- **排版稳定性检查**：观察仪表盘 15 秒轮询刷新瞬间，验证倒计时与状态药丸是否零布局跳动（CLS < 0.1）；
- **接口压力测试**：自动化并发压测仪表盘轮询端点，验证正常浏览不会误触 429 报错，急停连击时精准触发防护。

---

## 四、执行排期与首步建议

建议优先开启 **Phase 1 的 [UX-01] 定时任务抽屉通知联动** 与 **Phase 2 的 [ENG-01] Web server.ts 路由拆解**。两者分别在用户最易困惑的体验盲区和最脆弱的代码单体处发力，风险最小、体感最强。
