# Bug Fixes

## 2026-08-27 - Hermes WSL 自我进化闭环与全页面图表修复

- **Problem:** “进化与优化”页只能手工填写指标，无法连接 Hermes WSL 自我进化运行；无鉴权探针会把 `401/403` 误判为可用，API Key 失效、端点错误和任务失败不能及时阻断。上一版图表能力也只在版本页可见，网关、技能和进化页缺少真实数据、空态与错误态。
- **Impact:** 进化候选无法安全生成、评估或人工采用；配置故障可能在高成本任务启动后才暴露；用户无法从页面比较质量/可靠性/运行时长，也无法判断接口 404、Watch 离线或 bundle/schema 版本错配。
- **Changed scope:** Watch 复用 WSL runtime 执行器，接入 Hermes `evolution.skills.evolve_skill`，增加任务状态、PID、超时/取消、目标并发锁、隔离 run 目录、候选 hash 与一次性 promote token；增加带鉴权 LLM 探针、Hermes 配置读取与密钥脱敏、日志驱动诊断/建议、阻断告警和审计。Web/Watch 增加进化状态、诊断、创建/启动/详情/评估/采用/取消代理与 schema/version 校验。UI 进化页新增健康阻断、诊断、候选任务、质量/可靠性/运行时长真实历史图表；网关页接入送达/提示词趋势；技能页显示记忆健康图表空态；所有图表补充 loading、404/连接失败和无数据状态。
- **Regression coverage:** `apps/watch/tests/evolution.test.ts` 覆盖 holdout、依赖缺失、`401/403/404/429/5xx` 探针分类、Key 缺失与脱敏、快照、回归拦截、并发/令牌和 baseline/candidate hash；`apps/watch/tests/http-evolution.test.ts` 与 `apps/web/tests/evolution.test.ts` 覆盖 API 接线、旧 Watch 路由缺失、schema/version 错配；网关、技能、版本和历史聚合测试覆盖真实图表数据与空态。
- **Verification:** `corepack pnpm exec vitest run apps/watch/tests/evolution.test.ts apps/watch/tests/http.test.ts apps/watch/tests/watch.test.ts --maxWorkers=1 --testTimeout=15000 --reporter=dot`（40 passed）；此前聚焦 Web/Watch/Gateway 测试 34 passed；`corepack pnpm exec tsc -b packages/contract apps/watch apps/gateway apps/web --pretty false`、`corepack pnpm exec tsc -p ui/tsconfig.json --noEmit`、`corepack pnpm --filter @butler/ui exec vite build`、`git diff --check` 均通过。全量并行测试曾受 Watch WSL 临时目录清理与默认 5 秒超时影响，相关用例已显式使用 15 秒并在单线程复核通过。
- **Runtime validation:** 使用 `wsl.exe -d Ubuntu-24.04 -- bash -lc 'cd "/mnt/c/Users/jiach/Documents/Agent Butler" && docker compose up -d --build'` 重建并重启 WSL Compose。当前 Web/Watch/Gateway 容器均为 `healthy`；`GET http://127.0.0.1:7531/api/health` 返回 Web/Gateway/Watch `1.0.0-beta.7+1.0`，schema `evolution-v2-charts-v1`，bundle `index-BPyjduot.js`；`GET /api/messages/delivery-history` 返回 HTTP 200 和真实历史数据。调用 `POST /api/evolution/runs`（skill `productivity/teams-meeting-pipeline`、holdout 10、`dryRun=true`）返回 `409 preflight-failed`：依赖探测已通过，因 Hermes 配置没有模型端点而阻断，未创建快照、未触碰 baseline。随后在 Watch 容器内以映射后的 runtime Python、venv `site-packages`、`HERMES_AGENT_REPO=/home/butler/hermes` 执行 Hermes `evolution.skills.evolve_skill --skill teams-meeting-pipeline --iterations 1 --dry-run`，成功加载 `skills/productivity/teams-meeting-pipeline/SKILL.md` 并输出 setup validated；未调用 LLM、未修改 Hermes checkout 或 baseline。API Key 未出现在响应、运行日志或台账中。

## 2026-08-27 - Complete daily metrics and delivery history persistence

- **Problem:** Gateway reconciliation called a missing `recordOutcome` method, so message ingestion and HTTP tests failed. Delivery history also read the seven-day `message_projection` table, losing data after projection pruning; inspection history scanned only the newest 4,000 events.
- **Impact:** Message reconciliation could not persist batches, `/api/messages/delivery-history` could not expose durable history, and high-volume inspection history could be silently truncated.
- **Changed scope:** Added terminal outcome persistence/backfill in `apps/gateway/src/message/store.ts` with a 365-day query window and indexed history table; updated gateway/Web route limits and fallbacks; added SQLite-backed `inspection-completed` aggregation and `(type, ts)` index in `packages/core/src/store.ts`; wired the Web inspection endpoint to the aggregate; retained the existing `@ant-design/charts` frontend integration. Tests now seed the durable outcome table and cover 365-day HTTP behavior and SQLite inspection aggregation.
- **Regression coverage:** Gateway message-store and HTTP tests, Web inspection-history and gateway tests, and core store tests.
- **Verification:** `corepack pnpm exec vitest run packages/core/tests/store.test.ts apps/gateway/tests/message-store.test.ts apps/gateway/tests/message-http.test.ts apps/web/tests/inspection-history.test.ts apps/web/tests/gateway.test.ts --maxWorkers=2` (48 passed); `corepack pnpm exec vitest run apps/watch/tests/watch.test.ts -t "重启后恢复已跳闸的 runbook 熔断状态|stop 优雅停止且幂等" --maxWorkers=1 --testTimeout=15000` (2 passed); `corepack pnpm build` (passed); `corepack pnpm exec tsc -b --pretty false` (passed); `git diff --check` (passed). Full suite reached 858 passed, 1 skipped; two watch tests only timed out under parallel default settings and passed in isolation with a longer timeout.

## 2026-08-27 - Remove intrusive global notification banners and anchor settings

- **Problem:** The application shell rendered a red alert summary and a yellow security warning above every route, while the settings entry stopped above a large unused area in the desktop sidebar.
- **Impact:** Repeated banners consumed workspace height and made route-level content feel blocked; settings was harder to find because it was not visually anchored to the sidebar corner.
- **Changed scope:** `ui/src/components/Layout.tsx` no longer mounts the two global banners; detailed notification and security information remains available on their dedicated pages. `ui/src/styles/layout.css` makes the desktop sidebar a full-height column and anchors the settings block to the lower-left corner without changing mobile drawer spacing.
- **Regression coverage:** Route content and the notification center remain available; mobile navigation keeps its existing drawer layout.
- **Verification:** `pnpm lint`, `pnpm build`, `git diff --check`; desktop and mobile browser screenshots of `/dashboard` and `/settings`.

## 2026-08-27 - Replace anthropomorphic navigation and status copy

- **Problem:** Several headings and navigation notes used slogan-like, anthropomorphic wording such as “帮你管住消息频率”“消息不会悄悄丢掉” and “AI 学会的东西”，which made operational pages feel informal and obscured the actual capabilities.
- **Impact:** Users had to infer whether a page controlled delivery, recorded state, or managed local assets; status messaging also made guarantees sound stronger than the displayed evidence.
- **Changed scope:** Updated navigation notes plus Dashboard, Gateway, Evolution, Settings, Skills, alert-banner, and empty-state copy to describe notification delivery, retained records, evaluation controls, and read-only assets directly.
- **Regression coverage:** Searched the UI source for the retired phrases and verified the updated headings/notes through the running browser DOM.
- **Verification:** `pnpm lint`, `pnpm build`, `git diff --check`; runtime validation against `http://127.0.0.1:17531/gateway`.

## 2026-08-27 - Dark theme contrast and legacy surface cleanup

- **Problem:** Dark mode still exposed historical light/purple styles on the Evolution preflight and ledger surfaces, and the dashboard recovery panel retained a light background. Labels, helper copy, status pills, refresh/disabled buttons, table rows, and the diagnostic heading therefore had poor contrast and inconsistent visual hierarchy.
- **Impact:** Users could miss preflight state and recovery guidance, while the dark theme looked visually fragmented and unfinished.
- **Changed scope:** `ui/src/styles/theme-overrides.css` now applies dark-only graphite tokens and semantic success/warning/error colors to Evolution states, checks, decision panels, gate forms, ledger tables, buttons, Ant Design alerts, and the dashboard `.recovery-panel`.
- **Regression coverage:** Existing light-theme rules remain unchanged; dark desktop screenshots were checked for `/evolution` and `/dashboard` after rebuilding the static bundle.
- **Verification:** `pnpm lint`, `pnpm build`, `git diff --check`; runtime validation against `http://127.0.0.1:17531/evolution` and `http://127.0.0.1:17531/dashboard` with dark color scheme.

## 2026-08-26 - Remove redundant global event ticker

- **Problem:** The bottom event ticker repeated status information already shown by page-level state, the alert banner, and the operation log while permanently consuming viewport height.
- **Impact:** The application workspace had less usable vertical space without adding a clear action or useful new context.
- **Changed scope:** `ui/src/components/Layout.tsx` no longer renders the global event ticker. Event-driven refreshes and page-level operation records are unchanged.
- **Regression coverage:** Navigation, alert banners, and page-level status components remain mounted in the application shell.
- **Verification:** `pnpm lint`, `pnpm build`, and desktop/mobile browser screenshots of `/settings` and `/skills`.

## 2026-08-26 - CI installer test writes to a protected absolute path

- **Problem:** The OpenClaw Compose validation test used `/repo` for `repoDir` and `overridePath`. The installer correctly creates the override directory, but GitHub Actions runners cannot create `/repo`, so the test failed with `EACCES` before it could validate the intended invalid Compose configuration.
- **Impact:** The TypeScript CI job failed and blocked every workflow run that executed the test suite.
- **Changed scope:** `packages/installer/tests/install.test.ts` now creates and removes its own writable temporary directory. `.github/workflows/ci.yml` upgrades `actions/checkout` from v4 to v5 to remove the Node 20 action-runtime deprecation warning.
- **Regression coverage:** The existing invalid merged-Compose test continues to assert that Compose validation fails and `docker compose up` is not invoked.
- **Verification:** `pnpm test --maxWorkers=4`, `pnpm lint`, `pnpm build`, and `git diff --check`.
