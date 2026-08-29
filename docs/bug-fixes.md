# Bug Fixes

## 2026-08-28 - macOS 安装默认分支版本落后与 Corepack PATH

- **Problem:** 客户按 README 执行普通 `git clone` 时，GitHub 默认分支 `main` 仍停在 `ce07f01`（`v1.0.0-beta.9`）；`v1.0.0-beta.12` 只存在于发布 tag 和 `codex/llm-key-manager` 分支，因此安装后构建出的服务仍报告 beta.9。日志还显示 Hermes 自带 Node/Corepack 位于自定义目录，后台 shell 找不到裸 `corepack` 命令。
- **Impact:** 已推送的新版本对默认安装路径不可见；macOS 后台启动可能在安装完成后才因 PATH 缺失失败，用户需要手工改用绝对路径。
- **Changed scope:** 安装器现在优先使用当前 Node 同目录的 Corepack，并在 macOS 服务指引中输出可直接执行的命令；发布流程需将发布提交同步到默认 `main` 后再通知客户安装。
- **Regression coverage:** `pnpm exec vitest run packages/installer/tests/install.test.ts packages/installer/tests/openclaw.test.ts --run`（39 passed）；`pnpm exec tsc -b packages/installer/tsconfig.json --pretty false`；`git diff --check`。
- **Runtime validation:** `git ls-remote` 确认 `origin/main` 为 `ce07f01`/beta.9、`v1.0.0-beta.12` 为 `9b1043e`；客户日志的 `HEAD ce07f01` 与该远端状态一致。
- **Resolution:** 已将 beta.12 提交快进同步到 GitHub 默认 `main`（当前 `e1a29e7`），保留既有 `v1.0.0-beta.12` tag 不重写；后续普通 `git clone` 默认获取 beta.12。

## 2026-08-28 - 版本页刷新无法发现 GitHub 新 tag

- **Problem:** updater 只在进程启动时写入共享状态文件；GitHub 推送 `v1.0.0-beta.12` 后，版本页刷新仍读取旧的 `availableUpdates`，看不到新 tag。容器中的 Watch 还会把 updater 源码目录版本误显示为正在运行版本。
- **Impact:** 本地自动更新测试无法发现刚发布的版本，页面显示的当前运行版本和 updater 源码版本可能混淆。
- **Changed scope:** Watch `/api/butler/self` 刷新时主动请求 updater `/api/status`，更新远端 tag 缓存；当前版本改为读取运行中 Watch 包的 `package.json`，仅在运行目录无 Git 元数据时使用 updater 的 commit/repo 状态作为补充。
- **Regression coverage:** `apps/watch/tests/http-self-upgrade.test.ts`、`apps/web/tests/butler-self.test.ts`、`apps/watch/tests/self-upgrade.test.ts` 共 21 项通过；`pnpm exec tsc -b --pretty false` 通过。
- **Verification:** `pnpm version:check`、`git diff --check`；重建容器后通过 `/api/butler/self` 检查当前版本与远端 tag 列表。

## 2026-08-28 - Hermes 外部协助改进工作台与技能资产中心

- **Problem:** 进化页把“外部协助 Hermes 改进”误实现为直接运行 Hermes self-evolution CLI；历史台账中的 productivity/teams-meeting-pipeline 已不在当前技能清单，却继续出现在任务和阻断聚合；阻断项没有给出可执行的解决方案；技能页缺少使用统计与资产生命周期入口。
- **Impact:** 用户无法按“选择真实技能 → 描述问题 → 提案 → 隔离验证 → 应用”协助 Hermes；不存在的历史目标污染当前判断；成功率、耗时和调用量缺少可信来源时容易被误读。
- **Changed scope:** 新增 apps/watch/src/external-evolution.ts 外部提案服务和 apps/watch/src/skill-assets.ts 技能资产服务；Watch/Web 接入提案、统计、归档恢复删除、GitHub 趋势和隔离 staging API；技能页新增资产中心、趋势、排行、覆盖范围、未知态和归档入口；旧历史目标标记 legacy 且不计入当前阻断；使用统计复用 Hermes 日志并在字段无法证明时显示未知。
- **Regression coverage:** TypeScript 检查覆盖 Watch、Web、UI；外部目标过滤、baseline hash、备份门槛、提案验证状态和资产统计接口已接线，后续 focused HTTP/服务测试应继续覆盖历史目标、轮转日志、归档 hash 冲突和隔离安装扫描。
- **Verification:** pnpm exec tsc -p apps/watch/tsconfig.json --noEmit --pretty false；pnpm exec tsc -p apps/web/tsconfig.json --noEmit --pretty false；pnpm exec tsc -p ui/tsconfig.json --noEmit --pretty false；git diff --check。
- **Runtime validation:** 本次改动未宣称真实 GitHub 网络同步或 Hermes 生产应用已完成；安装候选先写入 Butler 隔离区，确认前不写入 Hermes，生产运行验证需在服务启动后执行。

## 2026-08-28 - 本地容器版本不同步与 native 消息状态误判

- **Problem:** 工作区已更新到 `1.0.0-beta.11`，但正在运行的 Web/Watch/Gateway 容器仍分别报告 `beta.7`、`beta.7`、`beta.10`；同时 Web 只接受包含完整 Bridge 字段的状态，导致 Hermes native 模式的正常 `200` 响应被显示为 `reachable:false`。
- **Impact:** 设置页加载的是旧 bundle，模型凭据按钮状态与当前代码不一致；网关页把 native 发送路径误报为不可达，无法解释微信消息状态。
- **Changed scope:** Web 状态解析兼容 native 精简载荷并补默认 Bridge 元数据；Compose 将 `BUTLER_SECRET_MASTER_KEY` 注入 Watch；本机 `.env` 配置 32 字节 hex 主密钥（不提交）；使用当前源码重建并重启全部服务。
- **Regression coverage:** 新增 Web native `/api/messages/status` 解析测试；`pnpm exec tsc -b --pretty false` 与 Web 服务测试通过。
- **Verification:** `pnpm exec vitest run --config vitest.focused.config.ts apps/web/tests/server.test.ts --reporter=dot`（12 passed）；`git diff --check`；重建后核对 `/api/health`、`/api/llm/status`、`/api/messages/status` 和四个服务版本。

## 2026-08-28 - Hermes 微信断流与重复消息修复

- **Problem:** Hermes 微信通道开启全量工具进度、最小发送间隔为 30 秒，且 Gateway 的 Message Runtime 使用 `auto` 介入热路径；历史进度积压还会被误判为待发送消息，触发 iLink `429` 和重复通知。
- **Impact:** 长任务期间微信被进度消息轰炸，最终回复可能因限流或 Bridge 延迟无法到达；Bridge 故障也可能错误阻断 Hermes 原生发送。
- **Changed scope:** Gateway 仅在 `BUTLER_ENABLE_HERMES_MESSAGE_RUNTIME=true` 时启动观察 Runtime；默认恢复 Hermes 原生通道。普通 `task-progress` 在 Butler 投影中进入 `absorbed`，保留审计但不进入投递队列；新增幂等积压清理和状态摘要。微信策略下限调整为 45 秒。WSL Hermes 配置新增 `display.platforms.weixin.tool_progress=off`、`streaming=false`，并将 `platforms.weixin.extra.min_send_interval_seconds` 调整为 45 秒；原配置已备份。
- **Regression coverage:** Gateway 消息策略、HTTP 状态、配置、积压清理和 Runtime 开关测试共 41 项通过；`corepack pnpm exec tsc -b --pretty false` 通过。
- **Verification:** `corepack pnpm version:set 1.0.0-beta.11`、`corepack pnpm version:check`、`git diff --check`；`.env` 本机覆盖已改为 `BUTLER_ENABLE_HERMES_MESSAGE_RUNTIME=false`，未提交。
- **Runtime validation:** 已在 WSL `/home/jiach/.hermes/config.yaml` 完成备份和幂等配置修改，并确认微信平台级进度关闭、流式关闭、间隔 45 秒。Compose 重建和微信端到端投递仍需在本机执行后记录结果，未在此处提前宣称断流已完全解决。

## 2026-08-28 - 微信回复因空入站记录阻塞投递

- **Problem:** Hermes Bridge 的历史 outbox 批次包含合法的空文本系统/占位入站记录；Gateway 将 `inbound.content` 强制校验为非空，导致整批导入失败，Bridge 游标停滞，新微信回复一直停留在 `captured`。
- **Impact:** 微信入站和 Hermes 生成回复均正常，但 Gateway 无法继续同步 outbox，用户收不到回复；后续批次也会被同一条历史记录持续阻塞。
- **Changed scope:** `apps/gateway/src/message/store.ts` 将入站正文校验调整为“必须是字符串，可为空”，保留其它路由字段和时间戳校验；新增空文本入站批次推进回归测试。`.dockerignore` 排除本地 `.zcode/` 与 `backups/`，避免 WSL 镜像构建上传无关本地数据。
- **Regression coverage:** `corepack pnpm exec vitest run apps/gateway/tests/message-store.test.ts --reporter=dot`（15 passed）；`corepack pnpm exec tsc -b --force` 通过。
- **Verification:** WSL Ubuntu-24.04 内执行 `docker compose build butler-gateway` 并强制重建 Gateway；`git diff --check`；健康端点和消息状态接口验证。
- **Runtime validation:** WSL Compose 中 Web/Watch/Gateway 均为 `healthy`；Gateway `/healthz` 返回 `1.0.0-beta.10` 与 `evolution-v2-charts-v1`，`/api/messages/status` 显示 Bridge `connected=true`、`attached=true`、`lastError=null`、`captured=0`，已投递计数从 98 增至 132，证明游标已越过阻塞批次并恢复投递。

## 2026-08-28 - WSL/Docker LLM profile credential-write boundary

- **Problem:** Watch listened on `0.0.0.0` inside Docker/WSL, and the credential API used that bind address as the security decision. Local `GET/POST /api/llm/profiles` requests forwarded from Windows to `127.0.0.1:7531` were therefore rejected with `403 credential-writes-require-loopback`. Binding the Web service itself to container-loopback would avoid the check but breaks the Windows-to-WSL port proxy with `ECONNRESET`.
- **Impact:** Operators could view the LLM profile page but could not create profiles or rotate keys in the intended local WSL deployment. The failure looked like a frontend/API outage even though Watch and the database were healthy.
- **Changed scope:** Added explicit `BUTLER_CREDENTIAL_WRITES_ALLOWED` configuration separate from the HTTP listen address. The default remains fail-closed for non-loopback listeners, while the local WSL/Docker `.env` explicitly enables writes without changing the `0.0.0.0` bind required for port forwarding. Added config and HTTP regression coverage plus a clear UI message for the loopback boundary error. Documented the setting in `.env.example` and passed it through Compose to Watch.
- **Regression coverage:** `pnpm exec vitest run --config vitest.focused.config.ts apps/watch/tests/config.test.ts apps/watch/tests/http.test.ts --reporter=dot` (24 passed); `pnpm exec tsc -b --pretty false`; `pnpm version:check`; `git diff --check`.
- **Runtime validation:** Rebuilt WSL Ubuntu-24.04 Compose services; Web/Watch/Gateway/Updater reported healthy at `1.0.0-beta.11`. Windows `http://127.0.0.1:7531/api/health` and `/api/llm/profiles` returned `200`; an invalid profile POST reached validation and returned `400 invalid-llm-profile` instead of `403`, proving the local write path is enabled. The Watch container reports `BUTLER_CREDENTIAL_WRITES_ALLOWED=true`. The environment override is local-only and is not committed.

## 2026-08-28 - Hermes 多模型 API Key 管理与进化闭环

- **Problem:** Different Hermes skills/plugins could share or overwrite a global LLM key; invalid credentials and endpoint failures were discovered too late; evolution runs had no explicit model binding and discovered Hermes configuration could not be migrated safely.
- **Impact:** A skill could call the wrong provider, failed keys could trigger expensive runs, and operators had no reliable way to distinguish credential, endpoint, rate-limit, upstream, or unsupported-protocol failures.
- **Changed scope:** Added the AES-256-GCM `SecretVault` and SQLite profile/version/binding tables; added masked profile APIs, real authenticated probes, rotation with pending versions, explicit binding precedence, read-only Hermes config discovery/import, loopback-only credential writes, and per-run WSL environment isolation with temporary overlays. Settings now exposes profile creation, probe, rotation, disable, binding, discovered-config import, and key-free Hermes configuration drafts. Evolution preflight blocks unbound/unsupported profiles and records the selected profile without changing Hermes global configuration.
- **Regression coverage:** Core tests cover vault encryption, malformed/tampered secrets, probe classification for `401/403/404/429/5xx`, rotation rollback, binding precedence, and discovered-config redaction. Existing evolution and HTTP suites cover preflight blocking, WSL lifecycle, cancellation, promote gates, and API wiring.
- **Verification:** `corepack pnpm exec tsc -b --pretty false`; `corepack pnpm exec vitest run packages/core/tests/llm-credentials.test.ts apps/watch/tests/evolution.test.ts apps/watch/tests/http.test.ts --reporter=dot` (39 passed); `git diff --check`; `corepack pnpm version:check`.
- **Runtime validation:** Credential writes remain disabled for non-loopback Watch listeners; discovered responses contain only masked keys; failed rotation leaves the prior active version unchanged; profile keys are injected only into the selected Hermes child process and temporary overlays are removed after sourcing.

## 2026-08-28 - Release version synchronization for runtime services

- **Problem:** After the `1.0.0-beta.8` release, Web reported the new version while Watch and Gateway still reported `1.0.0-beta.7`; the version checker did not cover their runtime constants.
- **Impact:** The control plane could falsely present a synchronized deployment even though service binaries came from different releases, weakening schema/version diagnostics and making chart/evolution troubleshooting harder.
- **Changed scope:** Extended `scripts/version.mjs` to validate and update `apps/watch/src/http.ts` and `apps/gateway/src/server.ts`; bumped all workspace, adapter, bridge, runtime, README, and changelog version references to `1.0.0-beta.9`.
- **Regression coverage:** `corepack pnpm version:check`, full `corepack pnpm release:check` (lint, TypeScript build, 99 test files / 870 passed / 3 skipped, UI build), and runtime health/version checks after Compose rebuild.
- **Verification:** `git diff --check`; tag `v1.0.0-beta.9` pushed to GitHub; Web/Watch/Gateway health payloads verified to report the same release version.

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
## 2026-08-28 - 版本页刷新超时导致最新版本不可见

- **Problem:** Web 的 `/api/butler/self` 使用 5 秒统一超时；Watch 刷新版本时还要访问 Updater 与 GitHub，慢响应会被 Web 误判为不可达并返回空的 `availableUpdates`。
- **Impact:** 用户刷新版本页后看不到 GitHub 上的最新版本，页面显示为离线或无更新。
- **Changed scope:** `apps/web/src/server.ts` 为 Watch GET 代理增加可配置超时，并将自身版本刷新超时提高到 30 秒；`ui/src/pages/versions/VersionsPage.tsx` 对应延长前端请求等待时间；不改变其他高频控制接口的 5 秒降级语义。
- **Regression coverage:** 新增慢响应回归测试；`pnpm exec vitest run apps/web/tests/butler-self.test.ts --run`（5 passed）；`pnpm exec tsc -b --pretty false`；`pnpm --filter @butler/ui exec vitest run tests/api.test.ts --run`；`git diff --check`。
- **Runtime validation:** 重建 WSL Compose Web/Watch/Updater；`GET http://127.0.0.1:7531/api/butler/self` 在约 6.7 秒内返回 `reachable: true`，当前版本 `1.0.0-beta.12`，并包含 GitHub `v1.0.0-beta.12` 更新记录。
## 2026-08-28 - 进化页改为基于 Hermes 错误日志的确认式工作台

- **问题：** 进化页原先要求客户手工选择技能并直接创建提案，无法解释 Hermes 日志中的重复错误；配置、网络和依赖故障被用户感知为全局阻断，历史目标 `teams-meeting-pipeline` 还可能进入可操作流程。
- **风险/影响：** 客户无法从真实故障证据判断改进方向，可能在系统问题未修复时启动进化，或误操作已不存在的技能目标。
- **修复范围：** 扩展日志分析器支持 24 小时/7 天/30 天窗口、覆盖范围、轮转日志、最近出现时间、技能提取和脱敏样例；新增 `evolution-insights` 服务与 `/api/evolution/insights`、`/api/evolution/directions/:id/{summarize,confirm,start}`；方向逐条确认后才能选择 Hermes 隔离引擎或手工提案，手工提案绑定日志洞察和问题证据；系统修复信号只显示“先修复”建议，历史 `teams-meeting-pipeline` 标记为不可重试；旧 `inferTargetRef` 无法定位时返回空目标，不再直接创建运行；重写进化页面为日志驱动流程，保留旧 runs/proposals 接口兼容。
- **回归测试：** `apps/watch/tests/log-analyzer.test.ts` 覆盖时间窗口、轮转日志和脱敏；`apps/watch/tests/evolution-insights.test.ts` 覆盖技能错误、系统问题和历史目标过滤；`apps/watch/tests/http-evolution.test.ts` 覆盖洞察窗口和非法范围。
- **验证命令：** `pnpm exec tsc -b --pretty false`；`pnpm exec vitest run apps/watch/tests/log-analyzer.test.ts apps/watch/tests/evolution-insights.test.ts --reporter=dot`（10 passed）；`pnpm --filter @butler/ui exec vite build`；`git diff --check`。

## 2026-08-28 - 诊断入口、修复进度与技能资产中心可见性

- **问题：** 诊断与系统日志只能从首页深层面板打开；日志一键修复返回“已启动”但没有可查询进度；恢复动作缺少代码级修复入口；技能资产中心、公开趋势和个性化推荐缺少独立入口与明确空态。
- **风险/影响：** 客户无法确认修复是否完成，也无法从进化建议直接进入日志证据；当公开趋势缓存为空时页面看起来像功能失效，容易重复点击或误判没有推荐数据。
- **修复范围：** 新增 `/recovery`、`/logs`、`/assets` 路由和侧边栏入口；Watch 增加恢复/日志修复任务状态查询与进度收口（`/api/recovery/jobs/:id`、`/api/logs/fix/:id`）；恢复动作增加“调整网关发送节流参数”代码级补丁入口；进化页系统修复方向增加跳转日志页按钮；资产中心首次无缓存时自动尝试同步 GitHub 公开趋势，并展示同步失败、缓存、无推荐等可解释空态。
- **回归测试：** 既有 Watch HTTP、Web Evolution 测试保持通过；TypeScript 构建覆盖新路由、任务载荷和资产中心页面。
- **验证命令：** `pnpm exec tsc -b --pretty false`；`pnpm vitest run apps/watch/tests/http.test.ts apps/watch/tests/http-evolution.test.ts apps/web/tests/evolution.test.ts`（26 passed）；`pnpm --filter @butler/ui exec vite build`；`git diff --check`。
- **运行验证：** `POST http://127.0.0.1:7531/api/skills/github-trends/refresh` 成功返回公开仓库数据；随后 `GET /api/skills/recommendations` 返回可隔离推荐列表。

## 2026-08-28 - 恢复动作能力门禁与手工补丁冲突提示

- **问题：** 外部 WSL/Docker 只读部署中 Hermes 的 `control=degraded`、`messaging=not-implemented` 仍被恢复页显示为可执行，点击后才返回 409；已存在但未被 Butler 纳管的网关手工补丁被恢复入口包装成笼统的 `patch-apply-failed`；通道已连接时重复重连还会再次调用 `control.start`。
- **风险/影响：** 客户会误以为重启/重连可用，直到执行阶段才失败；手工参数可能被误覆盖；重复启动会放大外部 WSL 控制面冲突。
- **修复范围：** 恢复动作目录现在读取实例能力快照，控制或消息能力未通过探针时提前标记不可用并返回原因与解决方案；诊断响应保留不可执行动作卡片，避免阻断项被隐藏；恢复节流入口识别未纳管的 observed 补丁，返回当前参数、目标文件和“前往网关补丁页核对/纳管”的下一步；消息连接探针已确认在线时采用幂等成功，不再调用 `control.start`；Runbook 失败详情补充连接能力、运行环境和快照检查指引。
- **回归测试：** 新增 `apps/watch/tests/http.test.ts` 能力降级门禁用例；新增 `apps/watch/tests/http-gateway.test.ts` 手工补丁冲突响应与不触达 apply 用例；既有 HTTP 网关和恢复测试保持通过。
- **验证命令：** `pnpm exec vitest run apps/watch/tests/http.test.ts apps/watch/tests/http-gateway.test.ts --maxWorkers=1 --testTimeout=20000 --reporter=dot`（29 passed）；`pnpm exec tsc -b --pretty false`；`git diff --check`。
- **运行验证：** 真实环境仍需在 Hermes 所在 WSL 与 Watch 同一控制域部署后确认 `control=ok`，否则重启/重连会保持不可执行；当前改动不会覆盖未纳管手工网关实现。

## 2026-08-29 - 首页与侧边栏功能职责收敛

- **问题：** 诊断结果、修复动作、Runbook、系统日志和技能资产同时出现在首页与侧边栏页面；诊断页标题强调“先找原因，再执行修复”，进入页面时却还要手动触发诊断；技能页也重复嵌入资产中心，改进相关文案带有较强的 AI 产品化表达。
- **风险/影响：** 首页信息密度过高，用户难以判断入口职责；诊断结果不能直接看到，资产统计存在重复入口，术语不够中性。
- **修复范围：** 首页移除诊断/修复面板、Runbook 列表、检查明细和日志抽屉，仅保留状态总览、连接状态和问题摘要；“待处理”状态卡改为跳转诊断页；诊断页进入后自动读取结果，标题改为“诊断结果”；资产中心保留独立侧边栏入口并从技能页标签移除；侧边栏、资产中心和改进页统一使用“改进方向、变更建议、日志依据、实例”等中性文案。
- **回归测试：** TypeScript 项目构建通过；UI 页面路由与原有 API 接口保持不变；首页不再请求 Runbook 列表。
- **验证命令：** `pnpm exec tsc -b --pretty false`；`pnpm --filter @butler/ui exec vite build`；`git diff --check`。

## 2026-08-28 - 优化页面中性化文案

- **问题：** 消息整理页面仍使用“AI 改写”“交给 AI”“用于哪个 AI”等产品化表述，与本地软件管家的操作语境不一致。
- **风险/影响：** 用户容易把规则整理误解为需要人工选择的模型操作，页面职责和处理结果不够直观。
- **修复范围：** 将消息优化面板统一调整为“消息整理、自动整理、所属实例、整理后的内容”等中性术语；保留设置页中必要的模型配置技术字段。
- **回归测试：** 保持消息优化 API 与数据结构不变，仅调整展示文案和统计分组标签。
- **验证命令：** `corepack pnpm exec tsc -b --pretty false`；`corepack pnpm --filter @butler/ui exec vite build`；`git diff --check`。

## 2026-08-29 - 修复技能调用趋势图单日数据铺满问题

- **问题：** 技能资产页的调用趋势只返回有调用的日期，前端使用弹性宽度平分柱子；当窗口内只有一天数据时，单根柱子会被拉伸成整块色带，日期刻度也难以辨认。
- **风险/影响：** 用户无法正确判断调用趋势，容易把图表误认为渲染异常或数据重复。
- **修复范围：** 前端按所选窗口补齐零值日期，改用固定宽度日期槽位并保留水平滚动；零值不绘制可见柱体，日期标签按窗口长度抽样显示；补齐逻辑与日志接口一致使用 UTC 日期。
- **回归测试：** `ui/tests/usage-trend.test.ts` 覆盖单日数据、稀疏日期和 UTC 日期边界；不改变 `/api/skills/usage` 数据契约。
- **验证命令：** `corepack pnpm exec tsc -b --pretty false`；`corepack pnpm --filter @butler/ui exec vitest run --reporter=dot`（24 passed）；`corepack pnpm --filter @butler/ui exec vite build`；`git diff --check`。

## 2026-08-29 - 技能资产简介、直接安装反馈与多粒度统计

- **问题：** GitHub 公开技能列表缺少用途说明，推荐项目重复使用同一条副标题；“下载到隔离区”不会让客户明确下一步，安装完成后也没有可见的过程反馈；技能调用趋势只支持按日查看。
- **风险/影响：** 客户难以判断公开项目是否适合当前实例，容易误以为点击下载后操作已经结束，也无法按周或按月查看长期使用变化。
- **修复范围：** 公开趋势和推荐接口增加稳定的中文简介与中性兜底文案；资产中心将按钮改为“直接安装”，确认后显示下载、检查、备份、安装进度及服务端失败原因，安装成功后刷新技能清单；Watch/Web/UI 新增 `granularity=day|week|month`，按 UTC 日、周一周和月初聚合并补齐图表桶。
- **回归测试：** `ui/tests/usage-trend.test.ts` 增加周、月聚合用例；`apps/watch/tests/http-skills.test.ts` 覆盖统计粒度参数透传；保留既有安装路径、备份、SKILL.md 校验和路径安全逻辑。
- **验证命令：** `corepack pnpm exec tsc -b --pretty false`；定向 `vitest`（5 passed）；全量 `vitest`（存在 3 个与本次无关的既有失败：网关消息节流 2 项、日志修复响应字段 1 项）；`git diff --check`。
