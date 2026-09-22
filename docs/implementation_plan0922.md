# TypeSafe Jev 规范化重构与系统核心安全加固实施计划

根据系统只读 Review 发现的 11 项缺陷与 `/grill-me` 讨论决策，本项目将实施两大部分核心优化：
1. **TypeSafe Jev System One 规范化重构**：修复原实现调用不存在的 `/v1/choice`、`/v1/score`、`/v1/noul`（恒定 404）严重破损缺陷，重构为官方标准的 `POST /v1/systemone` 单点原语；引入双层架构（底层通用 `systemOne` 批处理并发 + 顶层单原语便利封装），并在业务层（选型顾问、任务归因、消息分流）落地 Speculative Fan-out 单次并发模式；重构单元测试与 Mock。
2. **系统关键安全加固（受控收敛模式）**：
   - 修复 **Updater** 越权漏洞（改为 Fail-Closed，未配口令直接拒绝一切升级与回滚操作）；
   - 修复 **Watch 控制通道** 缺失鉴权（增加 `BUTLER_ACCESS_TOKEN` / `credentialWritesAllowed` 校验，阻断内网无凭据恶意调用）；
   - 修复 **SSRF 盲测风险**（`POST /api/credentials/test` 拦截云厂商元数据 `169.254.169.254` 与私有内网探测，并施加鉴权门禁）；
   - 收敛 **URL Query 传参 Token** 风险（`updater` 与 `gateway` 移除 `?token=...` 支持，统一收敛为 Header 鉴权）；
   - 保留 **Web 面板** 原生本机免密体验，保障本地开发便利性。

---

## User Review Required

> [!IMPORTANT]
> **关于 Updater 鉴权调整为 Fail-Closed 的行为变更**：
> 在过去未配置 `BUTLER_UPDATER_ACCESS_TOKEN` 或 `BUTLER_ACCESS_TOKEN` 时，任何容器或访问者均可随意调用 `/api/upgrade`。加固后，未配置口令时 Updater 将直接返回 `401 Unauthorized`（拒绝一切升级操作）。这要求所有正常升级调用（包括 Watch 转发）必须携带正确的口令。`deploy.sh` 与 `deploy.ps1` 首次部署时已内建自动生成主密钥与访问口令，既有正常部署不受影响。

> [!WARNING]
> **关于 TypeSafe Score 原语 criteria 契约变更**：
> 过去 `score()` 原语接收 `levels: Record<number, string>`，但 TypeSafe 官方 API 强制要求字段名为 `criteria` 且必须为描述性字符串数组 `string[]`。本次重构将同步更新 `ScoreQuestion` 与 `score()` 的参数类型，并确保全项目调用点平滑过渡。

---

## Proposed Changes

### Component 1: TypeSafe Jev 契约与核心客户端 (packages/contract & packages/core)

#### [MODIFY] [typesafe.ts](file:///c:/Users/jiach/Documents/Agent%20Butler/packages/contract/src/typesafe.ts)
- 补充 TypeSafe System One 通用请求与响应的类型定义：
  - `SystemOneQuestion`: 包含 `type: "choice" | "score" | "noul"`、`instructions`、`criteria`；
  - `SystemOneRequest`: 包含 `model`、`state`、`questions: Record<string, SystemOneQuestion>`；
  - `SystemOneResponse`: 包含 `model`、`usage`、`answers: Record<string, SystemOneAnswer>`；
- 将 `Score` 评分标尺类型由旧的 `Record<number, string>` 修正为规范的 `criteria: string[]`。

#### [MODIFY] [client.ts](file:///c:/Users/jiach/Documents/Agent%20Butler/packages/core/src/typesafe/client.ts)
- **重构底层请求链路**：
  - 彻底废除向 `/v1/choice`、`/v1/score`、`/v1/noul` 发送请求的旧逻辑；
  - 封装统一的底层调用方法 `systemOne<Q extends Record<string, SystemOneQuestion>>(params: { state: unknown; questions: Q; model?: string }): Promise<Record<keyof Q, SystemOneAnswer> | null>`，统一打向 `POST /v1/systemone`，默认 `model: "jev-latest"`；
  - 正确解析 TypeSafe 规范的 `answers` 返回格式，具备网络与 JSON 异常保护。
- **重构单原语便利方法**：
  - `choice()`: 基于 `systemOne` 单问题包装，安全提取 `answer.choice`、`answer.probabilities`、`answer.confidence`；
  - `score()`: 接收 `criteria: string[]`，基于 `systemOne` 单问题包装，安全提取 `answer.score`、`answer.probabilities`、`answer.confidence`；
  - `noul()`: 基于 `systemOne` 单问题包装，安全提取 `answer.noul`。
- **业务评估方法升级为 Speculative Fan-out 单次并发模式**：
  - `adviseMemorySystem()`: 单次请求同时评估架构选型 `choice` 与硬件契合度 `score`，免除串行往返与 Token 浪费；
  - `diagnoseTaskError()`: 单次请求同时评估错误根因 `choice` 与严重程度 `score`；
  - `triageMessage()`: 单次请求同时评估紧急打扰门禁 `noul` 与业务分类 `choice`；
  - 维持原有的确定性启发式兜底逻辑（Heuristic Fallback）不变，确保无 Key 或服务离线时平滑降级。

#### [MODIFY] [jev-client.test.ts](file:///c:/Users/jiach/Documents/Agent%20Butler/packages/core/tests/jev-client.test.ts)
- 移除测试中所有伪造的 `/v1/choice`、`/v1/score`、`/v1/noul` 假端点 Mock；
- 改为模拟真实 TypeSafe `POST /v1/systemone` 请求及其 `answers` 结构；
- 增加针对新原生 `systemOne()` 批量并发原语的单测覆盖；
- 校验当配置有效 `TYPESAFE_API_KEY` 时，新代码能正常跑通真实 API 逻辑。

---

### Component 2: Updater 安全加固 (apps/updater)

#### [MODIFY] [main.ts (updater)](file:///c:/Users/jiach/Documents/Agent%20Butler/apps/updater/src/main.ts)
- **修复越权与空口令漏洞**：
  - 将鉴权门禁调整为严格 Fail-Closed：若未配置 `accessToken`，或者传入的 Token 与 `accessToken` 不匹配，坚决拒绝除 `/healthz` 之外的所有请求，返回 `401 Unauthorized`；
  - 移除从 URL Query `?token=...` 获取口令的逻辑，仅允许通过 `Authorization: Bearer <token>` 或 `X-Butler-Token` 请求头鉴权，防止口令进入访问日志。

---

### Component 3: Watch 控制通道与凭据探针加固 (apps/watch)

#### [MODIFY] [http-common.ts (watch)](file:///c:/Users/jiach/Documents/Agent%20Butler/apps/watch/src/http-common.ts)
- **修正 `originAllowed` 逻辑**：
  - 针对带有状态变更的敏感写操作（POST/PUT/DELETE），当缺失 `Origin` 头时，不再无条件放行；
  - 若调用来自非浏览器客户端（无 Origin），必须强制要求携带 `BUTLER_ACCESS_TOKEN`（或 `BUTLER_INTERNAL_TOKEN`），阻断内网未鉴权容器或脚本随意调用。

#### [MODIFY] [http.ts (watch)](file:///c:/Users/jiach/Documents/Agent%20Butler/apps/watch/src/http.ts)
- **为敏感写操作注入鉴权校验**：
  - 在请求分发前校验口令：当配置了 `BUTLER_ACCESS_TOKEN` 时，凡涉及运行 Runbook、系统还原、配置应用、记忆变更等接口，必须经过 Token 校验；
  - 内部由 Web 面板发起的代理请求继续自动附加 Token，平滑兼容既有体验。

#### [MODIFY] [handlers/credentials.ts](file:///c:/Users/jiach/Documents/Agent%20Butler/apps/watch/src/handlers/credentials.ts)
- **加固 `POST /api/credentials/test`**：
  - 增加对 `credentialWritesAllowed` 或访问口令的基本检查；
  - 在调用 `probeApiKey` 前，对自定义 `endpoint` 执行 SSRF 防护校验。

#### [MODIFY] [probes/api-key-probes.ts](file:///c:/Users/jiach/Documents/Agent%20Butler/apps/watch/src/probes/api-key-probes.ts)
- **增加 SSRF 防护过滤器**：
  - 限制仅允许 `http:` 与 `https:` 协议；
  - 严格拦截公有云元数据服务 IP（`169.254.169.254`）及非法内网重定向；
  - 对非本地回环服务的私有网段（`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`）阻断外部探针探测。

---

### Component 4: Gateway 口令传输规范收敛 (apps/gateway)

#### [MODIFY] [server.ts (gateway)](file:///c:/Users/jiach/Documents/Agent%20Butler/apps/gateway/src/server.ts)
- 移除从 URL Query `?token=...` 获取口令的兼容逻辑，统一强制要求通过 `Authorization: Bearer` 或 `X-Butler-Token` 请求头传递。

---

## Verification Plan

### Automated Tests
1. **TypeSafe 核心原语与客户端测试**：
   - 运行单元测试套件：
     ```bash
     pnpm --filter @butler/core test
     ```
   - 验证 `jev-client.test.ts` 全部通过（包含单原语、批处理、平滑降级与启发式兜底）。
2. **全项目编译与类型检查**：
   - 运行工程构建与类型检查：
     ```bash
     pnpm run build
     ```
   - 确保 `packages/contract`、`packages/core`、`apps/watch`、`apps/updater`、`apps/web` 均无类型错误。
3. **真实 TypeSafe API 连通性冒烟测试**：
   - 执行测试脚本，携带宿主机当前已配置的 `TYPESAFE_API_KEY`：
     - 测试 `JevClient.systemOne()` 真实调用 `POST https://api.typesafe.ai/v1/systemone`；
     - 验证 `adviseMemorySystem`、`diagnoseTaskError`、`triageMessage` 能正确拿到 `source: "jev"` 的真实判定结果。

### Manual Verification
1. **Updater 鉴权 Fail-Closed 验证**：
   - 模拟未配置 Token 的请求：`curl -X POST http://127.0.0.1:7540/api/upgrade -d '{"confirmed":true}'`；
   - 预期断言：返回 `401 Unauthorized`，拒绝执行。
   - 模拟携带非法 Token 的请求：返回 `401 Unauthorized`。
   - 模拟在 URL Query 带 Token：`?token=...`，预期断言：返回 `401 Unauthorized`（URL Query 传递已被彻底禁止）。
2. **Watch 控制通道安全门禁验证**：
   - 不带 `Origin` 请求头且不带 Token 请求敏感写接口（如 `POST http://127.0.0.1:7533/api/credentials/sync`）；
   - 预期断言：返回 `401` 或 `403`，阻断未授权内网请求。
3. **SSRF 防御验证**：
   - 请求 `POST /api/credentials/test`，指定 `endpoint: "http://169.254.169.254/latest/meta-data"`；
   - 预期断言：接口拦截并返回拒绝信息，禁止向云厂商元数据发起请求。
4. **Web 前端面板体验验证**：
   - 启动 Web 服务或访问本地面板，验证本机回环免密进入功能完好无损，记忆中心 Jev 选型顾问推荐展示正常。
