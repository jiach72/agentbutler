# Bug Fixes

## 2026-08-30 - 核心 Markdown 文件管理安全闭环

- **Problem:** 核心 Markdown 文件此前没有统一的固定路径发现、修改前 Diff、版本留存和外部修改冲突保护，直接编辑容易覆盖 Agent 最新内容。
- **Impact:** 用户无法可靠查看/回滚 USER、AGENT、SOUL 等核心文件；任意路径、符号链接或敏感内容处理不当会扩大本机数据暴露面。
- **Changed scope:** Hermes/OpenClaw 适配器声明固定候选；Watch 新增路径越界/符号链接/非法 UTF-8/1 MiB 门禁、实例级操作锁、SHA-256 冲突检测、BackupGate、原子写入、最近 50 个文件版本、审计元数据和单文件下载；Web 代理与 `/core-files` 页面支持安全查看、草稿、Diff、备份、历史恢复。`memory.md`/`MEMORY.md` 后端强制只读，下载敏感模式需二次确认。
- **Regression coverage:** `apps/watch/tests/markdown-files.test.ts` 覆盖固定文件发现、memory 只读、预览无副作用、确认保存生成版本和外部修改冲突。
- **Verification:** `corepack pnpm exec tsc -b --pretty false`；`corepack pnpm exec vitest run apps/watch/tests/markdown-files.test.ts --config vitest.focused.config.ts`（3 passed）；`corepack pnpm test -- --testTimeout=10000`（1029 passed，3 skipped）；`corepack pnpm build`；`corepack pnpm lint`；`git diff --check`。
- **Runtime validation:** 2026-08-30 在 Ubuntu-24.04 WSL 中直接执行 `docker compose config -q && docker compose up -d --build --wait --wait-timeout 600`，未运行默认带备份步骤的 `scripts/deploy.sh`；Web/Gateway/Watch/Updater 全部 healthy，`/core-files` 返回 200，`/api/markdown/files` 返回 4 个固定文件。

## 2026-08-30 - Hermes 核心 Markdown 路径修正

- **Problem:** 核心文件页面按通用根目录查找 Hermes 文件，导致 `USER.md`、`MEMORY.md`、`AGENT.md` 显示不存在并在点击时返回 `markdown-file-not-found`。
- **Impact:** 实际存在的 Hermes 用户记忆无法查看或编辑，页面状态与 WSL 文件系统不一致。
- **Changed scope:** Hermes 适配器改为解析 `memories/USER.md`、`memories/MEMORY.md`、根目录 `SOUL.md`，并将不存在独立 `agent.md` 的情况明确映射到 `hermes-agent/AGENTS.md` 项目指令文件；保留旧根目录候选兼容。
- **Regression coverage:** Markdown 文件管理聚焦测试通过；WSL `/api/markdown/files?instanceId=hermes-main` 返回 4 个存在文件，`MEMORY.md` 正确为只读。
- **Verification:** `corepack pnpm exec tsc -b --pretty false`；`corepack pnpm exec vitest run apps/watch/tests/markdown-files.test.ts --config vitest.focused.config.ts`（3 passed）；无备份 WSL Compose 重建后四个容器 healthy。

## 2026-08-30 - RWA 任务终态报告未到达微信

- **Problem:** 同一 `runId` 在 Hermes 结束边界产生了多条 `final` 消息。Bridge 在 `completing` 后立即快照，只看到了较早的短结果；Gateway 又按最早结果选择 canonical，较晚的完整 RWA 报告因此被标记为 `absorbed`，没有发生微信投递。
- **Impact:** Web 的合并列表能看到完整报告，但微信只收到任务回执和中间短消息，用户误以为最终结果丢失。现场记录显示完整报告 `seq=471` 的 `attemptCount=0`、`providerMessageId=null`，不是微信拒收或网络断流。
- **Changed scope:** Bridge 增加短暂终态稳定窗口，等待晚到的 final/failure 捕获后按最新序列选择 canonical，并吸收旧重复结果；Gateway 在 `done/failed` 后再等待 500ms 终态稳定窗口，并按最新活动终态结果竞争 canonical，避免短结果抢先投递。保留 Outbox 幂等、审计和原始结果回退，不修改协议 v1 或历史积压。
- **Regression coverage:** Gateway 消息策略、重协调和存储聚焦测试共 48 项通过；新增“短结果先到、完整结果晚到、终态后只投递完整结果一次”回归；WSL Bridge 新增晚到捕获与 canonical 提升测试通过。Windows Bridge 全量测试仍受 NTFS token `0600` 环境门禁影响，未将该环境失败归因于本次改动。
- **Verification:** `corepack pnpm --filter @butler/gateway exec tsc --noEmit`；`corepack pnpm exec vitest run apps/gateway/tests/message-policy.test.ts apps/gateway/tests/message-reconciler.test.ts apps/gateway/tests/message-store.test.ts`；WSL `uv run ... unittest ...HermesHooksTest.test_finalizer_waits_for_late_result_and_promotes_latest_capture`；`git diff --check`。
- **Runtime validation:** 修复部署后需在 WSL 重建 Gateway/Bridge，复核 `attached=true`、`outboxWritable=true`，并用新 `runId` 确认微信只收到一条终态报告；不得迁移或重发本次历史 `seq=471`。

## 2026-08-30 - Bridge 健康检查在 WSL 宿主误报

- **Problem:** `scripts/bridge-healthcheck.sh` 将完整 JSON 响应放入环境变量后交给 Node 解析，在 Windows/WSL 混合 shell 下会出现探针解析失败，即使 Bridge 已返回 `attached=true` 与 `outboxWritable=true`。
- **Impact:** 发布验收会错误显示 Bridge FAIL，掩盖真实的 Gateway/转发器健康状态，增加重复重启或回滚风险。
- **Changed scope:** 健康检查改为通过标准输入交给 Python JSON 解析；同时更新 Hermes API hook 的历史生命周期断言，明确 `completing` 不再在任务仍运行时产生。
- **Regression coverage:** `bash scripts/bridge-healthcheck.sh` 返回 0 个 FAIL；WSL `tests/test_hermes_hooks.py` 16 项通过。
- **Verification:** `corepack pnpm version:check`；`corepack pnpm exec tsc -b --pretty false`；Gateway 57 项聚焦测试；`git diff --check`。
- **Runtime validation:** WSL Bridge `/v1/health` 返回 `bridgeVersion=1.0.0-beta.15`、`attached=true`、`outboxWritable=true`；Compose 四个服务均为 `running + healthy`。

## 2026-08-30 - 过期 held 决策阻塞后续终态消息

- **Problem:** Gateway 对已到期的 `held_pacing`/`held_dnd` 待决策沿用 `ready` 的精确重放路径；Bridge 返回同一 hold 后，队列头一直不是 `ready`，后续 `captured` final 无法被处理。
- **Impact:** 任务已经完成且 Bridge 在线时，最终报告仍停在 `captured`，微信不会收到；界面却可能显示“已发送原始结果”，造成状态误导。
- **Changed scope:** 仅对非 `ready` 的到期待决策执行一次确认后清除旧 pending，并重新计算当前策略；`ready` 仍保持崩溃恢复所需的严格重放语义。
- **Regression coverage:** 新增“过期 hold 不得阻塞后续 final”回归；Gateway 消息策略/重协调/存储/HTTP 聚焦测试通过。
- **Verification:** `corepack pnpm exec vitest run apps/gateway/tests/message-policy.test.ts apps/gateway/tests/message-reconciler.test.ts apps/gateway/tests/message-store.test.ts apps/gateway/tests/message-http.test.ts --reporter=dot`；`corepack pnpm exec tsc -b --pretty false`；`git diff --check`。
- **Runtime validation:** 修复后需唤醒或重启 Gateway，确认 `captured=0`、`pendingFinalResults=0`，再用新 `runId` 验证微信收到单条终态报告。

## 2026-08-30 - Docker Desktop/WSL 真实部署验收

- **Problem:** 使用 Windows NTFS 下的 `.runtime\\hermes` 作为 Hermes Bridge 运行时目录时，容器内 token 文件无法满足 Linux `0600` 私有权限检查，Gateway 按设计拒绝启动；WSL 原生 Docker 还不能重复启用已存在的 `8755` 转发器。
- **Impact:** 直接从 PowerShell 绑定 Windows Hermes 目录会导致 Gateway 重启循环；显式启用 Compose `bridge-forward` profile 且宿主已有转发器时，辅助容器会因 `8755` 被占用而重启。两种情况都可能被误判为应用本身构建失败。
- **Changed scope:** 本次未修改产品代码；按部署约束改用 WSL Linux Hermes 目录 `/home/jiach/.hermes`，复用已有 `agent-butler-bridge-forward.service`，使用隔离 Compose 项目 `agent-butler-smoke`、临时端口 `127.0.0.1:17531` 与临时数据卷完成验证。保留 Windows NTFS 权限失败现场作为运维边界证据。
- **Regression coverage:** `docker compose -p agent-butler-smoke config --quiet`；Web `/api/health`、`/api/setup/status`、`/api/messages/status`；Gateway/Watch/Updater 容器内 `/healthz`；Updater 无/错 token `401`、正确 token `200`；Gateway token 文件容器内模式 `0600`；`bash scripts/bridge-healthcheck.sh`（0 个 FAIL）。
- **Verification:** Docker Server `29.7.2`、Compose `v5.3.1`；Ubuntu-24.04 与 `docker-desktop` 均运行；四个核心容器均 `running + healthy`，Web/Gateway/Watch 版本均为 `1.0.0-beta.12+1.0`，schema 为 `evolution-v2-charts-v1`。
- **Runtime validation:** Hermes `/v1/health` 与 Gateway 消息状态均返回 `connected=true`、`attached=true`、`outboxWritable=true`、`lastError=null`；消息统计显示 `delivered=150`、`dead_letter=1`。验证结束后仅清理本次 `agent-butler-smoke` 项目与 `agent-butler-smoke-data` 卷，不触碰既有 Agent Butler 或 WeKnora 资源。

## 2026-08-30 - 产品化收口：安装入口、首次设置、诊断包与首页高级详情

- **Problem:** 优化计划中 installer 虽有完整编排却不可发布，原生 Windows Hermes 宿主路径会误走 Bash；首次访问没有设置向导；诊断只能下载 Markdown；首页已写好的巡检明细、实例健康、Runbook 和错误指纹组件没有接入；侧栏仍暴露九个重复一级入口，日志整页错误使用 dialog 语义。
- **Impact:** 普通用户无法从公开入口可靠安装或卸载，Windows 可能留下半安装状态；首次使用需要自行猜测配置；Issue 求助缺少标准附件；高级证据长期不可见；键盘用户无法选择进化方向，页面信息架构和辅助技术语义不一致。
- **Changed scope:** installer 发布名改为 `agent-butler` 并提供 `agent-butler`/`butler` bin、Windows `.bat` 与 macOS `.command`；增加 Python/Hermes 探测、原生 Windows Hermes 引导、`reset`/`uninstall` 显式确认维护命令；新增 `/setup` 三步真实连接向导与首次访问跳转；首页接回高级详情面板和 Runbook 确认执行；侧栏收敛为首页/我的智能体/消息通知/设置；诊断接口支持脱敏 ZIP（Markdown 兼容保留）；修复日志页 dialog 语义、亮色次要文字对比度和进化表格键盘操作；根工作区包改名避免与可发布 installer 冲突。
- **Regression coverage:** 新增 `apps/watch/tests/diagnostic-zip.test.ts`；installer 增加 reset/uninstall、维护确认与公开 CLI 入口测试；既有 updater、恢复、日志、消息和安全测试保持通过。
- **Verification:** `corepack pnpm exec tsc -b --pretty false`；`corepack pnpm build`；`corepack pnpm test`（108 个测试文件，977 个用例通过，1 个真实环境冒烟文件按条件跳过）；`corepack pnpm exec vitest run apps/watch/tests/diagnostic-zip.test.ts packages/installer/tests/main.test.ts packages/installer/tests/install.test.ts`；`git diff --check`。
- **Runtime validation:** 诊断 ZIP 使用标准 ZIP store 格式并限制为 `diagnostic-report.md` 与 `manifest.json`；维护命令默认只展示计划，只有 `--yes` 才执行清理，且拒绝删除根目录、用户 home 或仓库目录本身。真实 Docker/WSL 生产重建和首次浏览器流程仍需在目标部署环境执行。

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

## 2026-08-29 - 移除诊断页重复的系统日志入口

- **问题：** 诊断结果页顶部单独展示“查看日志依据 / 打开系统日志”，与侧边栏日志入口和诊断结果本身重复，占用首屏空间。
- **风险/影响：** 用户进入诊断页后需要在无关入口和实际处理动作之间再次判断页面重点，且页面标题“诊断结果”重复出现。
- **修复范围：** 移除顶部系统日志提示卡；页面说明改为直接描述检查结果和处理动作；诊断面板小标题改为“检查项与处理”，保留日志页独立入口和现有诊断接口。
- **回归测试：** 保持诊断自动加载、重新诊断、分级动作、确认弹窗和执行进度逻辑不变；检查页面不再渲染“打开系统日志”文本。
- **验证命令：** `corepack pnpm exec tsc -b --pretty false`；`corepack pnpm --filter @butler/ui exec vite build`；`git diff --check`。

## 2026-08-29 - 技能资产简介、直接安装反馈与多粒度统计

- **问题：** GitHub 公开技能列表缺少用途说明，推荐项目重复使用同一条副标题；“下载到隔离区”不会让客户明确下一步，安装完成后也没有可见的过程反馈；技能调用趋势只支持按日查看。
- **风险/影响：** 客户难以判断公开项目是否适合当前实例，容易误以为点击下载后操作已经结束，也无法按周或按月查看长期使用变化。
- **修复范围：** 公开趋势和推荐接口增加稳定的中文简介与中性兜底文案；资产中心将按钮改为“直接安装”，确认后显示下载、检查、备份、安装进度及服务端失败原因，安装成功后刷新技能清单；Watch/Web/UI 新增 `granularity=day|week|month`，按 UTC 日、周一周和月初聚合并补齐图表桶。
- **回归测试：** `ui/tests/usage-trend.test.ts` 增加周、月聚合用例；`apps/watch/tests/http-skills.test.ts` 覆盖统计粒度参数透传；保留既有安装路径、备份、SKILL.md 校验和路径安全逻辑。
- **验证命令：** `corepack pnpm exec tsc -b --pretty false`；定向 `vitest`（5 passed）；全量 `vitest`（存在 3 个与本次无关的既有失败：网关消息节流 2 项、日志修复响应字段 1 项）；`git diff --check`。

## 2026-08-29 - Hermes 消息网关在配置完整时未启动

- **问题：** WSL Docker 部署已具备 Bridge URL、实例目录、私有 token 和投影数据库，但本地 `.env` 写入 `BUTLER_ENABLE_HERMES_MESSAGE_RUNTIME=false`，Gateway 因此不创建消息运行时。页面只能显示 Bridge 未运行和 outbox 不可用，实际 Bridge 健康状态没有被读取。
- **风险/影响：** Hermes 消息链路持续处于断开状态，且仅重启或重连无法恢复，因为启动配置每次都会明确关闭运行时。
- **修复范围：** Gateway 新增 `auto` 模式：配置齐全则启动观察运行时，配置不完整则保持控制面可用；`false` 仍可显式关闭，`true` 仍要求完整配置。Compose 默认值同步为 `auto`，安装器和示例配置明确该语义。
- **回归测试：** `apps/gateway/tests/message-main.test.ts` 覆盖 auto、显式启用和显式关闭模式；运行时既有测试继续覆盖 Bridge 离线后的重连、token 权限和策略重装。
- **运行验证：** WSL 中验证 `/v1/health` 的 `attached=true`、`outboxWritable=true`，重建 Gateway 后验证 `/api/messages/status` 返回运行中、已连接和已挂载状态。

## 2026-08-29 - 进化页面补充说明不可见且执行结果不可追踪

- **问题：** 点击“生成补充说明”后结果只在接口响应中短暂存在，页面刷新或重新分析日志后消失；启动 Hermes 进化流程后页面只提示“已启动”，用户看不到运行编号、候选产物、当前阶段和下一步。
- **风险/影响：** 用户无法判断优化内容，也无法确认修改是否真正执行，更无法在验证前审阅或应用候选变更。
- **修复范围：** 洞察状态新增持久化的优化说明（目标、建议改动、预期结果、来源和时间）；重新分析保留已生成说明；手工提案绑定优化内容；Hermes 运行状态接入运行查询并每 5 秒刷新，展示准备、执行、候选、评估和完成阶段、运行编号、候选差异及失败详情；统一文案为“生成优化说明、按 Hermes 流程执行、生成可编辑方案、应用到 Hermes”。
- **回归测试：** `apps/watch/tests/evolution-insights.test.ts` 新增说明持久化测试；既有日志洞察和 HTTP 进化接口测试保持通过。
- **验证命令：** `corepack pnpm exec tsc -b --pretty false`；`corepack pnpm exec eslint apps/watch/src/evolution-insights.ts ui/src/pages/evolution/EvolutionPage.tsx`；`corepack pnpm exec vitest run --config vitest.focused.config.ts apps/watch/tests/evolution-insights.test.ts apps/watch/tests/http-evolution.test.ts`（10 passed）；`corepack pnpm --filter @butler/ui exec vite build`；`git diff --check`。

## 2026-08-30 - P2 界面术语、状态徽标与键盘/触控可达性收口

- **问题：** 进化、连接、通知和排查界面仍有 `baseline hash`、`置信度`、`数据：`、`npm：` 等工程术语；部分页面直接手写 Ant Design Tag 颜色；密集交互控件和日志来源按钮未统一到可触控尺寸；路由入口还经过无业务价值的一级 re-export 壳文件。
- **风险/影响：** 普通用户难以理解页面内容，状态颜色在不同页面可能产生语义漂移，键盘和触控用户更难完成排查/连接流程；多余间接层增加维护和重构成本。
- **修复范围：** 使用 `StatusBadge` 统一影响、评估、安装进度、通知、探针、风险和证据状态；将路径与包目录移入默认折叠的“运行环境详情”；把进化页术语改为“把握程度/当前版本标识/改进方案标识”；统一 CSS 断点到 `1200/860/600`；为 Ant Design 控件、日志来源按钮和已有自定义交互补充 44px 最小命中区；主入口直接导入实际页面并删除 6 个无引用的 re-export 壳文件；新增首页实例详情、排查现象和排查动作的静态渲染回归测试。
- **回归测试：** 新增 `ui/tests/component-render.test.ts` 覆盖首页实例状态、排查现象键盘语义、排查动作推荐与风险展示；保留现有排查逻辑和 API 契约。
- **验证命令：** `corepack pnpm exec tsc -b ui/tsconfig.json --pretty false`；`corepack pnpm exec vitest run --config ui/vitest.config.ts tests/component-render.test.ts --reporter=verbose`（3 passed）；`corepack pnpm test`（110 个测试文件通过、1 个条件式真实 smoke 文件跳过；986 passed、3 skipped）；`corepack pnpm build`；`corepack pnpm lint`；`corepack pnpm version:check`；`git diff --check`。

## 2026-08-30 - WSL 部署 CRLF 与 Buildx 回退、beta.13 真实发布

- **问题：** Windows `.env` 的 CRLF 行尾把回车字符带入 Hermes 路径，导致 WSL 部署误报 bridge token 缺失；Docker Desktop 在 WSL 中提供的 Buildx 插件发生 `input/output error`，阻断镜像构建。
- **风险/影响：** 升级脚本在真实部署前直接退出；若强行绕过备份或构建错误，可能造成服务停机或版本未切换。
- **修复范围：** `scripts/deploy.sh` 与 `scripts/bridge-healthcheck.sh` 读取 `.env` 时移除行尾 `\r`；部署脚本检测 Buildx 不可用时自动设置 `DOCKER_BUILDKIT=0` 与 `COMPOSE_DOCKER_CLI_BUILD=0`，回退到经典 Docker builder。版本由 `1.0.0-beta.12` 提升为 `1.0.0-beta.13`。
- **回归测试：** `bash -n scripts/deploy.sh scripts/bridge-healthcheck.sh`；`corepack pnpm version:check`（版本一致：`1.0.0-beta.13`）；四个 Compose 镜像均以 `1.0.0-beta.13` 成功构建。
- **验证命令：** `BUTLER_VERSION=1.0.0-beta.13 bash scripts/deploy.sh`；`curl -fsS http://127.0.0.1:7531/api/health`；容器内 Gateway/Watch/Updater `/healthz`；`bash scripts/bridge-healthcheck.sh`；`git diff --check`。
- **运行验证：** WSL Ubuntu-24.04 的 Gateway、Watch、Web、Updater 均 running + healthy；Web 返回 `web@1.0.0-beta.13+1.0`，Gateway/Watch 返回对应 beta.13 版本；Hermes Bridge `attached=true`、`outboxWritable=true`，bridge healthcheck 结果为 0 个 FAIL。升级前真实数据卷备份保存在 `backups/butler-data-20260830-103732.tgz`。

## 2026-08-30 - 恢复隐藏的版本、自进化与 GitHub 技能入口

- **问题：** 优化侧栏收敛为首页、智能体和消息通知三个主入口后，版本升级、自进化和 GitHub 技能管理页面仍保留路由与后端接口，却没有可见导航入口，用户容易误认为功能被删除。
- **风险/影响：** 已部署能力不可发现；用户无法从界面进入版本回滚、自进化分析或 GitHub 技能安装流程。
- **修复范围：** `ui/src/components/Layout.tsx` 新增“管理工具”分组，恢复 `/versions`（版本升级）、`/evolution`（自进化）和 `/assets`（GitHub 技能管理）侧栏入口，并同步顶栏当前页面标题；`ui/src/styles/shell.css` 增加分组标题样式，兼容桌面和移动抽屉导航。
- **回归测试：** `ui/tests/component-render.test.ts` 通过真实 `Layout` 静态渲染断言三个入口路径、文案和管理工具分组均存在。
- **验证命令：** `corepack pnpm exec tsc -b ui/tsconfig.json --pretty false`；`corepack pnpm --filter @butler/ui exec vitest run --config vitest.config.ts tests/component-render.test.ts --reporter=verbose`（4 passed）；`corepack pnpm build`；`git diff --check`。
- **运行验证：** 2026-08-30 在 WSL Ubuntu-24.04 中直接执行 `BUTLER_VERSION=1.0.0-beta.13 DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 docker compose up -d --build`（按本地要求跳过数据卷备份）；Gateway、Watch、Web、Updater 均 `running + healthy`，Web `/api/health` 返回 `web@1.0.0-beta.13+1.0`，`/api/messages/status` 返回 `connected=true`、`attached=true`、`outboxWritable=true`；`scripts/bridge-healthcheck.sh` 结果为 0 个 FAIL；实际 bundle 已包含三个入口文案。

## 2026-08-30 - 普通用户上手、受管模型与安全排查闭环

- **问题：** 排查向导会直接提交 `confirmed: true`，中高影响修复绕过了用户确认；选择故障现象后诊断仍读取旧闭包状态，默认动作可能与刚选的现象不一致。首次使用只完成运行环境和连接检查，未覆盖受管任务模型、常用场景和完成后的下一步。模型配置页面也没有明确区分 Hermes 原生运行配置与 Butler 加密凭据绑定，侧栏同时展示所有高级工具，增加了普通用户的判断负担。
- **风险/影响：** 用户可能在不了解影响的情况下重建索引、重连或重启；故障处理的推荐顺序可能偏离实际症状；首次使用后仍不知道模型是否可用于受管任务、该从哪里继续；无障碍弹窗缺少标准焦点圈禁，首包会预加载多个不常用页面。
- **修复范围：** 排查动作现在按后端 `requiresConfirmation` 进入统一 `DangerConfirmModal`，确认后才发送 `confirmed: true`；诊断改为显式传入本次症状。首次向导扩展为环境、智能体、模型、连接验证、场景五步：模型真实探针后自动绑定到所选实例，已有通过探针的模型可一键绑定，场景选择只记录最合适的下一入口而不擅自安装技能或改写 Hermes。模型页将 Hermes 原生 `config.yaml`/`.env` 与 Butler 受管任务凭据明确分层，状态新增已绑定和可用判定。导航将首页、智能体与知识、消息通知、排查问题作为主路径，高级工具折叠但保持可发现；访问口令使用 Ant Design Modal 的焦点管理。页面改为路由懒加载，拆分 React/Ant Design 公共缓存；诊断未解决时按模型、消息、记忆或日志根因给出可点击的下一步。
- **回归测试：** 新增 `ui/tests/troubleshoot-guidance.test.ts` 覆盖模型、消息、记忆问题的下一步路由；更新 `ui/tests/component-render.test.ts` 覆盖主导航与高级工具可发现性；`apps/watch/tests/log-analyzer.test.ts` 使用固定时钟，避免七天日志窗口随真实日期失效。
- **验证命令：** `corepack pnpm test`（全量通过）；`corepack pnpm build`（通过）；`corepack pnpm exec vitest run ui/tests/troubleshoot-symptoms.test.ts ui/tests/troubleshoot-guidance.test.ts ui/tests/component-render.test.ts packages/core/tests/llm-credentials.test.ts --reporter=dot`（26 passed）；`corepack pnpm exec vitest run apps/watch/tests/watch.test.ts --reporter=dot`（11 passed）；`git diff --check`（通过）。
- **运行验证：** 本地 Vite 开发服务器通过 `http://127.0.0.1:5174` 提供本次 UI，并继续代理本机 `/api` 与 `/ws` 到 Butler Web 服务。

## 2026-08-30 - 首页问题卡补齐可执行下一步

- **问题：** 首页会显示实例异常、重复错误、未发现实例或尚无检查结果，却只给出说明文字；用户必须自行判断该去首次设置、重新检查还是排查问题。即使进入排查页，也要再次选择已经在首页可推断的故障现象。
- **风险/影响：** 普通用户在最需要帮助的时刻遇到操作断点，容易反复刷新首页或误入无关页面，拉长从发现异常到开始处理的路径。
- **修复范围：** `IssueView` 增加明确的下一步动作；首页问题卡按状态提供“立即检查”“继续设置”“查看本机安全”或“开始排查”。实例异常和重复错误进入 `/troubleshoot` 时会预选“它报错了，我看不懂”，降级实例会预选“说不上来，你帮我查”；URL 驱动的预选只触发一次，不会在用户返回现象页时重复诊断。
- **回归测试：** 新增 `ui/tests/dashboard-issue-actions.test.ts`，覆盖未发现实例、实例异常与无检查结果三条行动路由；既有排查症状和关键页面静态渲染测试继续通过。
- **验证命令：** `corepack pnpm exec vitest run ui/tests/dashboard-issue-actions.test.ts ui/tests/troubleshoot-symptoms.test.ts ui/tests/component-render.test.ts`（18 passed）；`corepack pnpm build`（通过）；`git diff --check`。

## 2026-08-30 - 首页持续展示本机运行就绪度

- **问题：** 首次向导会区分 Hermes 原生运行模型和 Butler 受管任务模型，但完成后首页只展示巡检与连接信息；用户无法持续确认两类模型是否都处于可用状态，也无法从断开连接、缺少原生模型、凭据库不可用或未绑定模型直接进入对应处理路径。
- **风险/影响：** 用户可能把“已连接实例”误解为智能体与所有受管任务均可运行，或把受管任务模型未就绪误判为 Hermes 原生对话不可用；本地配置变化后，已完成向导的浏览器还会跳过 `/api/setup/status` 的再次读取。
- **修复范围：** 首页在主结论下新增“本机运行就绪度”，持续分别展示本机智能体连接、Hermes 原生模型发现、Butler 受管任务模型的状态与下一步；模型发现仅在首屏、手动复查与 30 秒低频轮询时读取，避免影响连接操作。首次引导仍只对未完成向导的浏览器自动跳转，但所有路由都会复查真实配置状态；已完成用户留在当前页面并通过首页状态修复。
- **回归测试：** `ui/tests/readiness.test.ts` 覆盖全就绪、未发现 Hermes 原生模型、凭据库不可用和连接控制通道不可达的文案与跳转语义，并静态渲染三项状态与 `/setup` 下一步入口。
- **验证命令：** `corepack pnpm --filter @butler/ui exec vitest run --config vitest.config.ts tests/readiness.test.ts tests/troubleshoot-symptoms.test.ts tests/component-render.test.ts --reporter=dot`（20 passed）；`corepack pnpm exec tsc -b ui/tsconfig.json --pretty false`；`corepack pnpm build`；`git diff --check` 均通过。
- **运行验证：** 独立 Vite 预览服务在 `http://127.0.0.1:5175/` 可访问，`GET /dashboard` 返回 HTTP 200。

## 2026-08-30 - 首次场景保留为首页的持续入口

- **问题：** 首次使用最后一步会收集“日常问答、消息提醒、知识库问答、代码协作或定时巡检”，但完成后只跳转一次；用户回到首页后看不到自己选择的用途，也没有明确的重新设置入口。
- **风险/影响：** 用户无法延续首次选择的任务路径，特别是消息通知、知识库和代码协作场景仍需重新理解导航；重新配置时只能依赖记忆找到首次使用路由。
- **修复范围：** 将场景定义抽为向导与首页共用的受控数据源；首页在运行就绪度下持续显示用户选择的用途，为跨页场景提供原有下一步，并始终提供“重新设置”。未完成选择时展示“开始设置”，避免留出空白区块。
- **回归测试：** 新增 `ui/tests/onboarding-continuation.test.ts`，覆盖消息提醒的持续入口、重新设置和无选择场景；原有就绪度、排查与导航静态渲染测试同时运行。
- **验证命令：** `corepack pnpm --filter @butler/ui exec vitest run --config vitest.config.ts tests/onboarding-continuation.test.ts tests/readiness.test.ts tests/troubleshoot-symptoms.test.ts tests/component-render.test.ts --reporter=dot`（23 passed）；`corepack pnpm exec tsc -b ui/tsconfig.json --pretty false`；Vite 生产构建；`git diff --check` 均通过。

## 2026-08-30 - 微信任务终态统一汇报与重复投递收口

- **问题：** 任务执行期间的进度/最终消息可能沿用即时发送路径，导致微信出现发送中断流；重复的 final/failure 结果也可能各自进入投递队列；无 `runId` 的告警和系统通知缺少按聊天批次的稳定汇总。
- **风险/影响：** 用户收到过程噪声或半截消息，无法确认哪个结果是最终结论；重复投递会放大微信限流和失败重试，增加任务完成后的不确定性。
- **修复范围：** 所有微信出站消息先进入 Hermes Bridge Outbox；每个任务最多捕获一条“已收到，任务完成后汇报。”回执；task-progress 仅保留站内时间线；final/failure 在任务进入 done/failed 前保持 `held_pacing` 并记录 `task:awaiting-terminal`；任务终态前调用现有 OpenAI-compatible LLM 生成四段式中文总结（不超过 1500 字），失败时记录脱敏原因并回退原始最终结果；同一 run 只保留首条 canonical 终态，其余吸收；无 runId 的微信系统/告警/主动通知按聊天 120 秒窗口汇总。UI 明示等待终态、生成总结和原始结果回退状态。
- **回归测试：** Gateway 消息策略、协调器和存储测试覆盖非终态等待、终态去重和无 runId 批次；Bridge Outbox 覆盖终态内容更新与重复吸收；LLM 测试覆盖四段式总结与未配置回退；Hermes 生命周期测试覆盖一次性回执和重复入站幂等。
- **验证命令：** `corepack pnpm exec tsc -b --pretty false`；`corepack pnpm exec vitest run --config vitest.focused.config.ts apps/gateway/tests/message-policy.test.ts apps/gateway/tests/message-reconciler.test.ts apps/gateway/tests/message-store.test.ts apps/web/tests/gateway.test.ts --reporter=dot`（57 passed）；`corepack pnpm --filter @butler/ui exec vite build`；`$env:PYTHONPATH='packages/adapters/hermes/bridge'; python -m unittest discover -s packages/adapters/hermes/bridge/tests -p 'test_llm_optimizer.py' -q`（7 passed）；`python -m unittest discover -s packages/adapters/hermes/bridge/tests -p 'test_outbox.py' -q`（31 passed）；Windows 原生 Hermes runtime 测试因无法满足 POSIX `0600` token 权限未运行，需在 WSL 执行。

## 2026-08-30 - 首页恢复路由与就绪状态回归覆盖

- **问题：** 首页新增的恢复入口与持续就绪状态涉及多个用户分支，但先前回归只覆盖实例异常、未发现实例和无检查结果，未覆盖实例降级、控制通道离线与“已发现但尚未连接”的状态。
- **风险/影响：** 这些边界状态一旦发生文案或路由回归，用户可能被送往错误的处理页，或把连接问题误判为模型配置问题。
- **修复范围：** 补齐首页问题卡在降级、控制通道离线时的目标路由断言；补齐就绪度中“已发现实例但未连接”的下一步断言。测试保持在纯推导层，不依赖真实服务或凭据。
- **回归测试：** `ui/tests/dashboard-issue-actions.test.ts` 与 `ui/tests/readiness.test.ts` 共同覆盖首次设置、原地检查、安全设置、报错排查、模糊排查和连接未完成的入口。
- **验证命令：** `corepack pnpm --filter @butler/ui exec vitest run --config vitest.config.ts tests/dashboard-issue-actions.test.ts tests/readiness.test.ts tests/onboarding-continuation.test.ts tests/troubleshoot-symptoms.test.ts tests/component-render.test.ts --reporter=dot`（29 passed）；`corepack pnpm exec tsc -b ui/tsconfig.json --pretty false`；`corepack pnpm build`；`git diff --check` 均通过。

## 2026-08-30 - Bridge 终态冲突导致 Gateway 队列头阻塞

- **问题：** Hermes Bridge 已将旧终态消息吸收后，Gateway 重启仍重放该消息的旧 `held_pacing` 决策；Bridge 返回 `409 message is already terminal: absorbed`，Gateway 将幂等冲突误判为 Bridge 不可用，导致队列头持续阻塞，后续微信终态报告停留在 `captured`。
- **风险/影响：** 任务完成后总结无法继续投递，状态页显示连接健康但微信收不到最终结果；旧消息还会反复触发失败重试并掩盖真实故障。
- **修复范围：** `apps/gateway/src/message/reconciler.ts` 识别 Bridge 已终态冲突，将 `delivered/absorbed/dead_letter/cancelled` 同步回本地投影并清除 pending 决策；将已过期 hold 在成功重放后重新计算，避免历史 hold 阻塞后续终态。新增 stale terminal 冲突回归测试。
- **回归测试：** `apps/gateway/tests/message-reconciler.test.ts` 覆盖 Bridge 返回“已吸收”时的本地自愈及后续终态继续投递。
- **验证命令：** `corepack pnpm exec vitest run --config vitest.focused.config.ts apps/gateway/tests/message-reconciler.test.ts --reporter=dot`（16 passed）；`corepack pnpm exec tsc -b --pretty false`；`git diff --check`。

## 2026-08-30 - 自进化页无法直接进入且运行指标缺少可验证口径

- **问题：** “高级工具”使用可折叠菜单承载版本升级、自进化和 GitHub 技能管理，入口容易被隐藏；自进化页主要展示日志和错误，无法回答实例稳定性、进化收益、失败归因和下一步行动，日志耗时的 `ms` 单位还可能被误解析为秒。
- **风险/影响：** 用户可能找不到关键运维入口，也无法区分环境阻断与引擎回归；错误耗时会进一步污染 P50/P95 和稳定性判断。
- **修复范围：** 三个入口改为左侧一级菜单并同步移动端 Drawer；Core SQLite 新增进化观测、每日指标、真实样本和行动事项表；Watch 新增统一 analytics 服务与 `/api/evolution/overview`、`/metrics`、`/failures`、`/datasets`、`/action-items`、`/analyze` 及行动复核接口；前端新增健康分、收益分、趋势、失败归因、内存水位、行动清单、数据资产和运行历史组件；耗时解析按 `ms`/`s` 明确换算，环境失败不进入正式样本集。
- **回归测试：** `apps/watch/tests/evolution-analytics.test.ts` 覆盖样本不足、健康分公式、P50/P95、收益分映射和行动事项重开；`apps/watch/tests/http-evolution.test.ts` 覆盖新接口；`ui/tests/component-render.test.ts` 覆盖三个平铺入口和无 `<details>`。
- **验证命令：** `corepack pnpm exec tsc -b --pretty false`；`corepack pnpm exec vitest run apps/watch/tests/evolution-analytics.test.ts apps/watch/tests/http-evolution.test.ts ui/tests/component-render.test.ts --reporter=dot`；`corepack pnpm build`；`git diff --check`。
- **运行验证：** focused 进化与 UI 测试通过；全量测试 114 个测试文件通过，另有 1 个既有 `@butler/updater` 测试因 15 秒超时失败，未发现与本次改动相关的失败。

## 2026-08-30 - Qclaw 借鉴功能的信任与一致性补强

- **问题：** 高风险写操作存在局部非原子 JSON 写入；技能归档/恢复/安装/删除未统一经过备份门禁和实例级互斥；Watch 错误响应仍可能暴露原始错误语义；消息通道只显示状态，不提供不可用原因和修复动作。
- **风险/影响：** 并发操作可能互相覆盖或留下半写文件，技能变更无法稳定回滚，错误信息不一致，普通用户难以判断下一步。
- **修复范围：** 统一使用 Core 原子写入（含文本与 JSON）；自升级、OpenClaw 安装状态、进化状态、技能元数据/趋势缓存改为原子写；技能变更接入 `BackupGate` 与 `withManagedOperationLock`；Watch 错误统一经过脱敏、分类和下一步文案；Gateway 增加通道详情与 `/api/messages/reconnect`，Web/UI 展示不可用原因和修复按钮；README 同步访问口令事实。
- **回归测试：** Core 原子写入/错误分类/操作锁，Watch 备份门禁/诊断，Installer 维护预览/候选发现，Gateway 消息 HTTP 与 Web 状态解析测试。
- **验证命令：** `corepack pnpm exec tsc -b packages/core/tsconfig.json apps/watch/tsconfig.json apps/gateway/tsconfig.json apps/web/tsconfig.json ui/tsconfig.json --pretty false`；`corepack pnpm exec vitest run --config vitest.focused.config.ts apps/watch/tests/backup-gate.test.ts apps/watch/tests/runtime-diagnosis.test.ts apps/watch/tests/diagnostic-summary.test.ts packages/installer/tests/maintenance-preview.test.ts packages/installer/tests/installation-candidates.test.ts --reporter=dot`；`git diff --check`。
## 2026-08-31 - GitHub 技能安装 403 被误报为备份失败

- **问题：** 推荐技能阶段化下载调用 GitHub 公共 API 时，出口 IP 的匿名配额耗尽，返回 `403 API rate limit exceeded`。Watch 只返回 `GitHub tree HTTP 403`，前端又把阶段化失败固定显示在“备份”步骤，用户误以为所有技能或备份服务不可用。
- **风险/影响：** 推荐技能无法完成下载；错误原因不具备可执行下一步，容易重复点击并误操作备份配置。
- **修复范围：** `apps/watch/src/skill-assets.ts` 增加 `User-Agent`、可选 `GITHUB_TOKEN`、GitHub 403/404/网络错误分类和限流重试时间；阶段化失败返回脱敏中文文案。`ui/src/pages/skills/AssetCenter.tsx` 按下载/检查与备份/安装区分失败步骤。新增 GitHub 阶段化回归测试。
- **回归测试：** `apps/watch/tests/skill-assets.test.ts` 覆盖限流 403、请求头和 Token 成功路径。
- **验证命令：** `corepack pnpm exec tsc -b --pretty false`；`corepack pnpm exec vitest run apps/watch/tests/skill-assets.test.ts`。
- **部署/runtime：** GitHub 当前匿名 API 响应为 `x-ratelimit-remaining: 0`；配置 `GITHUB_TOKEN` 后需重启 Watch/Compose 才会生效。

## 2026-08-31 - 自进化图表可读性与侧栏入口收口

- **问题：** 自进化概览把量级差异明显的会话和工具调用画在同一纵轴，小序列难以识别；失败归因使用竖排长标签，密集数据无法扫描；引擎时间线重复列出预检失败，首屏被同类事件占满；内存容量水位既不能表示真实字节使用量，也分散了运行判断。
- **风险/影响：** 用户会把低会话量误解为无数据，难以从失败分布判断优先级，也无法快速确认进化运行是受阻、进行中还是已采用。
- **修复范围：** 自进化概览四个图表统一改由 `@ant-design/charts` 渲染：使用趋势按会话与工具调用分量纲呈现，成功率使用百分比面积趋势，失败归因改为横向 Top 6 条形图并合并其余项，引擎状态改为按阶段压缩的散点时间线与状态汇总；移除内存容量水位卡片及其样式；侧栏移除“排查问题”入口，保留既有深链接路由以避免外部书签失效。
- **回归测试：** 保持自进化总览接口、时间范围、空态和 Watch 数据契约不变；图表组件继续延迟加载，避免增加首屏渲染负担。
- **验证命令：** `corepack pnpm exec tsc -b --pretty false`；`corepack pnpm --filter @butler/ui exec vite build`；`corepack pnpm lint`；`git diff --check`；WSL 无备份 `docker compose up -d --build --wait`。

## 2026-08-31 - 全局控制台视觉层级与响应式统一

- **问题：** 各页面虽然共享主题变量，但侧栏、顶栏、卡片、Ant Design 控件和页面局部面板的圆角、阴影、间距与交互反馈不完全一致；移动端内容密度和标题层级也缺少统一基线。
- **风险/影响：** 用户跨页面操作时需要重新适应视觉层级，重要状态与操作按钮的优先级不够清晰；窄屏下部分工具条和面板容易显得拥挤。
- **修复范围：** 新增 `ui/src/styles/taste.css` 作为统一视觉层，收紧冷灰/青绿色控制台的表面、导航 active rail、页面标题、卡片与 Ant Design 控件样式，统一 12px 卡片/8px 控件圆角、按钮按压反馈、表格/折叠/输入焦点态，并覆盖首页、消息、自进化、技能资产、版本、设置、安装、日志、核心文件与排查页面的共有布局和移动端断点；`ui/src/theme/tokens.ts` 同步更新圆角令牌。
- **回归测试：** UI 主题、关键页面组件渲染与趋势图相关测试通过；未改动业务数据契约和交互逻辑。
- **验证命令：** `corepack pnpm --dir ui exec vitest run --config vitest.config.ts tests/theme.test.ts tests/component-render.test.ts tests/usage-trend.test.ts --reporter=dot`（12 passed）；`corepack pnpm --filter @butler/ui exec tsc --noEmit`；`corepack pnpm --filter @butler/ui exec vite build`；`git diff --check`。

## 2026-08-31 - 首次访问免查配置文件

- **问题：** Web 监听在非回环地址并启用访问口令时，首次进入面板会要求普通用户在安装目录中查找 `.env` 和 `BUTLER_ACCESS_TOKEN`，用户不一定知道安装目录或配置项位置。
- **风险/影响：** 首次使用容易卡在登录闸门，用户可能误删配置、重复修改环境文件，或误以为管家没有启动成功。
- **修复范围：** Web 鉴权新增本机浏览器便利通道：访问 `127.0.0.1`/`localhost` 时免输入口令，跨设备地址仍要求口令；跨站来源不会因为本机 Host 而绕过鉴权。AccessGate 在远程地址打开时直接提供“在本机打开”按钮，口令改为面向管理员/跨设备用户的备用路径，不再引导普通用户编辑 `.env`。
- **回归测试：** `apps/web/tests/access-token.test.ts` 覆盖本机免查口令、跨站来源阻断、带端口和 IPv4-mapped IPv6 回环判定；既有 token、CSRF、健康检查和安全基线测试继续覆盖。
- **验证命令：** `corepack pnpm exec vitest run apps/web/tests/access-token.test.ts --reporter=dot`；`corepack pnpm exec tsc -b --pretty false`；`corepack pnpm --filter @butler/ui exec vite build`；`git diff --check`。
