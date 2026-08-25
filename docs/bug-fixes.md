# Bug Fixes

## 2026-08-25 · Beta 1.0 页面可用性与分级恢复

- 问题：技能/记忆列表随数据量无限拉长；Dashboard 一键处理只暴露重启/重连；升级候选为空或请求失败时反馈不充分；进化页依赖手填指标，客户只能看到失败而无法完成真实评估闭环。
- 风险/影响：大量技能时页面难以扫描；误把不同根因归为重启，增加中断风险；升级点击可能被误认为无反应；进化结果不可验证，客户无法判断是否真的变好。
- 改动范围：技能和插件按分类折叠并限制内部滚动，记忆预览独立滚动；Watch/Web 新增 `/api/recovery/diagnose` 与 `/api/recovery/actions/:id/execute`，支持探测、索引重建、消息重连、网关清理和实例重启的风险分级；Dashboard 增加根因、探针、影响范围和动作确认面板；版本页按目标实例比较版本并在无候选时展示具体原因和重新检查入口；Evolution 增加标准外部评估接口，自动返回样本数、指标、置信度和门禁结果；Ant Design `Collapse`、`Select`、`Input`、`Alert`、`Steps`、`Card` 等组件用于关键操作反馈。
- 回归测试：Watch HTTP 恢复诊断/动作确认用例；现有 Watch HTTP、Evolution、Web Server 定向测试保持通过；TypeScript 构建通过。
- 验证命令：`corepack pnpm exec vitest run apps/watch/tests/http.test.ts apps/watch/tests/evolution.test.ts apps/web/tests/server.test.ts --reporter=dot`；`corepack pnpm exec tsc -b --pretty false`；`git diff --check`。
- 部署/运行验证：尚未重启生产/宿主服务；当前工作区此前 7531/7532/7533 健康探测超时，发布前必须执行 `/healthz`、`/api/connections`、`/api/versions`、`/api/evolution`、`/api/prompt-optimization` 和 `/ws` smoke test。

## 2026-08-25 · 部署后连接管理 404 与 Hermes Bridge 消息断线

- 问题：Web 已声明 `/api/connections`，但部署环境中旧产物/错误入口会把请求落到 404；默认 Gateway 只启动告警队列，Hermes 消息运行时仍被实验 launcher 隔离，Compose/宿主服务也没有注入 Bridge URL、token 和投影库，导致管家服务与消息通道无法持续连接。
- 风险/影响：Dashboard 无法读取 Hermes/OpenClaw 实时连接；消息状态页只能显示离线，Bridge 重启或短暂网络抖动后不会自动恢复。
- 改动范围：Gateway 在配置齐全时自动装配 Hermes 消息运行时；Bridge 不可达时保持 7532 与消息 API 在线，策略安装和同步按轮询持续重试，Bridge 恢复后自动接回；`/healthz` 增加消息连接摘要；Compose 与 `.env.example` 补齐 Bridge 配置、投影数据库和超时参数，Docker 默认通过 `host.docker.internal:8754` 访问宿主 Bridge，并把 token 映射为容器内绝对路径；Web 增加 `/api/connections` 代理回归测试；首页连接卡和消息摘要接入 Ant Design `Card/Alert/Badge/Statistic/Button`。
- 回归测试：`apps/gateway/tests/message-runtime.test.ts` 新增 Bridge `E302` 启动断线、下一轮自动重连覆盖；`apps/web/tests/server.test.ts` 覆盖 `/api/connections` 代理不落 404；Gateway message runtime/http、Watch HTTP 共 39 项定向测试通过；TypeScript 与 Vite 构建通过。
- 验证命令：`corepack pnpm exec tsc -b --pretty false`；`corepack pnpm --filter @butler/ui exec vite build`；`corepack pnpm exec vitest run apps/gateway/tests/message-runtime.test.ts apps/gateway/tests/message-launcher.test.ts apps/gateway/tests/message-http.test.ts apps/watch/tests/http.test.ts apps/web/tests/server.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000`；`docker compose config -q`；`git diff --check`。
- 部署/运行验证：重启当前编译后的 Web/Gateway 进程后，`GET http://127.0.0.1:7531/api/connections` 返回 `200 {"reachable":false,"connections":[]}`，`GET /api/health` 返回 `gateway:true`，Gateway `/healthz` 返回 `ok:true`；未向真实 Hermes 通道发送外部消息，目标机器仍需以真实 Bridge/token 复核 `/v1/health` 与消息投影。

## 2026-08-25 · Docker GitHub 一键部署入口与容器探测地址

- 问题：Docker 部署缺少统一环境配置入口，容器探测默认使用回环地址，其他用户从 GitHub 部署时可能挂载错误目录或持续看到服务离线。
- 改动范围：Compose 改为读取 .env；新增 .env.example、scripts/deploy.sh、scripts/deploy.ps1；Hermes/OpenClaw 探测支持可配置主机与端口；Docker Socket 默认关闭；三张 Dockerfile 强制执行 tsc -b --force，避免干净上下文缺少 dist/main.js；CI 增加 Compose 校验和镜像构建。
- 验证命令：docker compose config -q、docker compose build、TypeScript 构建、相关 Vitest、git diff --check。
- 部署/运行验证：2026-08-25 使用临时宿主端口 17531 启动本机 Compose；butler-gateway、butler-watch、butler-web 均为 healthy，Web `/api/health` 返回 `ok/db/gateway=true`，`/api/alerts` 返回 `reachable=true`。验证后已停止容器；保留镜像与命名卷，未触碰宿主机现有 7531 Web 进程。

## 2026-08-24 · 宿主端口复用增加 systemd 进程归属核验

- 问题：宿主安装器在端口已占用时只检查同名 Butler unit 是否 `active`；如果该 unit 仍活跃但端口实际被其它进程抢占，幂等重跑会被错误放行。
- 风险/影响：安装器可能覆盖错误的服务文件并执行重启，造成现有进程中断或三服务半安装；端口冲突门禁失去 fail-closed 语义。
- 改动范围：端口被占用时追加 `systemctl --user show ... -p MainPID --value` 与 `ss -H -ltnp` 监听者 PID 交叉核验；任一证据缺失或 PID 不匹配均视为外部占用，继续阻断 unit 写入和启停。
- 回归测试：`packages/installer/tests/install.test.ts` 覆盖 active unit 且 PID 持有端口的幂等重跑，以及 active unit/端口监听 PID 不匹配时 fail-closed；安装器定向测试 35/35 通过。
- 验证命令：`corepack pnpm exec vitest run --config vitest.focused.config.ts packages/installer/tests/install.test.ts`；后续执行全量 `corepack pnpm test`、`corepack pnpm lint`、`corepack pnpm build`、`git diff --check`。
- 部署/运行验证：未执行真实 user-systemd 写入、服务重启或外部进程终止；真实 WSL 端口归属仍需发布前现场记录。

## 2026-08-24 · L-03 明确区分升级快照与日常备份保留策略

- 问题：设置页把升级恢复点和 M7 日常备份放在同一条备份时间线里，但两者轮转上限不同，用户容易把“升级快照保留 3 份”误解成所有备份都只保留 3 份。
- 风险/影响：用户无法判断历史记录何时会被自动淘汰，也可能错误估计升级回滚和日常恢复的可用范围。
- 改动范围：备份 API 返回日常备份分类型保留上限（full=14、memory=24、event=10）；管家自身状态返回升级快照保留上限（3）；Settings 新增独立的“升级快照 / 日常备份”保留策略区块，并显示当前升级恢复点占用。
- 回归测试：`apps/watch/tests/backup.test.ts` 验证日常备份保留元数据；`apps/watch/tests/self-upgrade.test.ts` 验证升级快照保留元数据；`apps/web/tests/ui-backup-retention.test.ts` 验证设置页两类策略和 API 接线。
- 验证命令：`corepack pnpm exec vitest run apps/watch/tests/backup.test.ts apps/watch/tests/self-upgrade.test.ts apps/web/tests/ui-backup-retention.test.ts`；`corepack pnpm --filter @butler/ui exec vite build`；`corepack pnpm lint`；`git diff --check`。
- 部署/运行验证：未执行真实升级、回滚或清理备份；实际文件轮转与跨重启恢复仍需发布前现场验收。

## 2026-08-24 · L-02 危险操作统一使用应用内确认层

- 问题：Settings 的熔断解除/备份还原和 Gateway 的 Hermes 补丁应用/恢复仍使用浏览器原生 `window.confirm`，无法展示影响范围、备份行为和目标文件，也缺少统一的键盘与焦点语义。
- 风险/影响：危险操作在不同页面表现不一致；用户可能在看不到完整影响说明时确认源码写入、备份还原或解除崩溃保护。
- 改动范围：新增 `ui/src/components/DangerConfirmModal.tsx`，统一对话框、Escape 关闭、Tab 焦点限定、焦点回收、遮罩关闭和忙碌态；Settings 和 Gateway 改为先冻结操作上下文，确认后才调用原有 API。
- 回归测试：`apps/web/tests/ui-confirmation.test.ts` 验证 Settings/Gateway 不再包含 `window.confirm`，并检查对话框/ARIA/Escape/焦点回收语义；定向测试 2/2 通过。
- 验证命令：`corepack pnpm exec vitest run apps/web/tests/ui-confirmation.test.ts`；`corepack pnpm --filter @butler/ui exec vite build`；`corepack pnpm lint`；后续执行全量测试与 `git diff --check`。
- 部署/运行验证：未执行真实补丁写入、备份还原或熔断解除；真实桌面/移动端点击与焦点验收仍需发布前浏览器 smoke。

## 2026-08-24 · L-01 日志 tail 改为固定块读取

- 问题：`packages/core/src/tail.ts` 原先按 `size - offset` 一次性申请 Buffer；大文件增量或长时间无换行日志会造成与增量大小相当的内存峰值。
- 风险/影响：butler-watch 长时间运行时可能因日志突增触发高内存占用或 OOM；部分行还会在下一轮重复分配整段增量。
- 改动范围：改为 64 KiB 固定块扫描最后完整换行，再用 `StringDecoder` 分块解码完整行；保留 handler 成功后提交位点、截断/轮转广播、UTF-8 边界和 JSONL `tsField` 语义，并确保单源部分行不阻塞后续源。
- 回归测试：`packages/core/tests/tail.test.ts` 新增固定块分配上限、多源继续处理、UTF-8 跨块字符和 128 KiB 未换行尾部补全用例；tail 测试 10/10 通过。
- 验证命令：`corepack pnpm exec vitest run packages/core/tests/tail.test.ts`；后续执行 `corepack pnpm test`、`corepack pnpm lint`、`corepack pnpm build`、`git diff --check`。
- 部署/运行验证：未启动真实服务或修改外部日志源；真实长时间日志压测仍需发布前现场验证。

## 2026-08-24 · 宿主形态安装器补齐三服务 user-systemd 闭环

- 问题：installHostForm 完成本仓构建后只生成 services-guide 文案，没有生成、安装或启动 butler-watch、butler-web、butler-gateway 的宿主常驻服务，安装成功无法证明三项服务已运行。
- 风险/影响：PRD M2 的宿主/容器双形态在代码层实际只完成了安装前半段；用户需要手工启动，重启/登录后也不会自动恢复，且含空格的工作区路径容易在服务命令中失效。
- 改动范围：packages/installer/src/install.ts 新增可注入 HostServiceManager；生产默认在 Linux/WSL 真实执行时探测 systemctl --user，生成三项 unit（固定 dist/main.js 入口、7531/7532/7533 回环端口、Gateway/Watch/Web 依赖、~/.agent-butler/env 可选密钥文件），执行 daemon-reload 与 enable --now；dry-run 只打印 unit 内容，非 systemd 平台或测试注入默认退化为明确的手动指引，写入失败 fail-closed。
- 回归测试：packages/installer/tests/install.test.ts 新增 unit 内容、systemd 写入/启停、dry-run 零写入、非 Linux 强制 systemd 安全失败用例；覆盖含空格路径的 POSIX unit 入口。
- 验证命令：corepack pnpm exec tsc -b packages/installer；corepack pnpm exec vitest run packages/installer/tests/install.test.ts packages/installer/tests/openclaw.test.ts packages/installer/tests/main.test.ts（47 项通过）。
- 部署/运行验证：本轮未写入真实 ~/.config/systemd/user、未启动或重启宿主服务；Linux/WSL 全新环境的真实常驻、健康和重启恢复证据仍开放。


## 2026-08-24 · Hermes 消息实验 launcher 增加显式 feature flag

- 问题：Hermes message runtime 虽未接入默认 Gateway/Compose 入口，但独立 launcher 被误启动时仍可能静默截留 `queued-push` 消息；缺少启动级交付边界证明。
- 风险/影响：误接线会把实验性的 Bridge 数据面当成 V1 生产路径，Gateway/Bridge 故障时无法满足 Hermes L2 的原生 fail-open 约束。
- 改动范围：`launchHermesGateway` 现在要求 `BUTLER_ENABLE_HERMES_MESSAGE_RUNTIME=true`（或 `1`），否则在创建 runtime 前 fail-closed；启动日志明确标注实验开关，环境配置透传保持单一来源。默认 `apps/gateway/src/main.ts`、Compose 和 installer 不变。
- 回归测试：`apps/gateway/tests/message-launcher.test.ts` 覆盖缺少开关时拒绝启动，以及显式开关后继续执行正常 runtime 配置校验。
- 验证命令：`corepack pnpm exec vitest run apps/gateway/tests/message-launcher.test.ts apps/gateway/tests/message-runtime.test.ts --testTimeout 30000 --hookTimeout 30000 --maxWorkers=1`；`corepack pnpm lint`；`corepack pnpm build`；`git diff --check`。
- 部署/运行验证：未启动实验 launcher、未发送真实消息；默认生产 Gateway 入口保持不变。

## 2026-08-24 · 自升级 Git E2E 回滚用例超时门禁补齐

- 问题：自升级真实 Git 仓库的“构建失败自动回滚”用例没有显式用例级超时，Windows 上 Git 初始化/checkout 偶发超过 Vitest 默认 5 秒，导致完整测试误报失败。
- 风险/影响：发布门禁会把环境耗时误判为回滚逻辑失败，掩盖真实测试结果。
- 改动范围：为第二条真实 Git E2E 与成功路径统一设置 20 秒用例级超时；不放宽业务等待状态的 15 秒上限。
- 回归测试：apps/watch/tests/self-upgrade.test.ts 两条真实 Git E2E 均通过。
- 验证命令：corepack pnpm exec vitest run --config vitest.focused.config.ts apps/watch/tests/self-upgrade.test.ts；corepack pnpm test。
- 部署/运行验证：仅测试隔离临时仓库，未触碰用户仓库或运行服务。

## 2026-08-24 · M6 资产风险状态贯通 Web/UI

- 问题：技能/插件清单虽然已能读取，但未扫描、解析失败等风险状态没有进入产品契约和页面；来源筛选也缺少独立入口，用户容易把“能列出来”误解成“可信资产”。
- 风险/影响：未经扫描的技能或插件可能被误认为已审核；解析失败的资产如果仍显示为普通条目，会掩盖清单损坏或潜在安全问题，违背 PRD M6 V1.7 的风险标记要求。
- 改动范围：契约增加 AssetRiskStatus；Hermes 驱动保留原始 category，缺失时不再按名称或目录猜测；Watch 为正常资产显式标记 unscanned、解析失败标记 blocked；Web 严格校验并透传风险字段；Skills 页面为技能和插件显示“未扫描/已扫描/受限”状态与原因，并增加独立来源筛选。旧载荷缺少字段时保持兼容，UI 按未扫描展示。
- 回归测试：packages/adapters/hermes/tests/drivers.test.ts 覆盖缺失 category 保持未分类；apps/watch/tests/skills.test.ts 覆盖普通与解析失败资产；apps/web/tests/skills.test.ts 覆盖合法字段透传和非法枚举降级。
- 验证命令：node node_modules/typescript/bin/tsc -b --pretty false；corepack pnpm exec vitest run --config vitest.focused.config.ts apps/watch/tests/skills.test.ts apps/web/tests/skills.test.ts；git diff --check。
- 部署/运行验证：本轮未执行真实技能/插件写入、未扫描或消息外发；M6 V1 仍保持只读，实际 OpenClaw/Hermes 风险扫描结果需在发布验收中补充。

## 2026-08-24 · 根脚本显式固定 Corepack pnpm 版本

- 问题：根 build 脚本外层由 Corepack 使用 pnpm 10.20.0，但脚本内部裸调用 pnpm，Windows PATH 可能解析到 pnpm 11.23.0，触发 packageManager 版本门禁并让完整构建失败。
- 风险/影响：本地与 CI 可能出现“依赖和代码都正常但发布构建失败”的环境差异，阻断 PRD 功能验收。
- 改动范围：package.json 的 UI 构建子命令改为显式 corepack pnpm，沿用仓库声明的 pnpm 10.20.0。
- 回归测试：根 corepack pnpm build；UI 独立 corepack pnpm --filter @butler/ui exec vite build。
- 验证命令：corepack pnpm build；git diff --check。
- 部署/运行验证：仅本地构建验证，未重启服务或执行真实消息外发。

## 2026-08-24 · OpenClaw Compose token 被宿主插值为空且 Docker 验收端口冲突

- 问题：OpenClaw Gateway 以 LAN + token 模式启动时，compose command/healthcheck 中的 `$OPENCLAW_GATEWAY_TOKEN` 会被 Compose 当作宿主变量插值；未设置宿主变量时传入空 token。真实验收还发现本机已有宿主 Web 进程占用 `127.0.0.1:7531`，导致容器 Web 无法绑定。
- 风险/影响：容器可能以错误认证参数启动，healthcheck 与实际 Gateway 凭据不一致；端口冲突会让“一键安装”误报服务未启动。
- 改动范围：安装器生成 `OPENCLAW_GATEWAY_TOKEN`（支持显式传入，缺省随机生成），Gateway/healthcheck 使用 Compose `$$OPENCLAW_GATEWAY_TOKEN` 转义；dry-run 脱敏 token；新增 `web-port-check`，在写 override/启动 Compose 前探测 `127.0.0.1:7531`，冲突时结构化失败并停止。
- 回归测试：`packages/installer/tests/install.test.ts`、`packages/installer/tests/openclaw.test.ts`；覆盖 token 脱敏、端口占用前置失败和 Compose `$` 转义。
- 验证命令：`node node_modules/typescript/bin/tsc -b --pretty false`；`corepack pnpm exec vitest run --config vitest.focused.config.ts packages/installer/tests/install.test.ts packages/installer/tests/openclaw.test.ts packages/installer/tests/platform.test.ts`；`docker compose config --quiet`；真实 CLI `node packages/installer/dist/main.js --framework openclaw --form docker --skip-network --dry-run`。
- 部署/运行验证：2026-08-24 在 Node 24.15 Bookworm + OpenClaw latest 容器中 `openclaw`、`butler-gateway`、`butler-watch`、`butler-web` 均为 `healthy`；Web `http://127.0.0.1:17531/api/health` 返回 `{"ok":true,"db":true,"gateway":true,...}`；Watch 诊断报告检出 `openclaw-main`，OpenClaw `/home/openclaw/.openclaw/openclaw.json` 存在。随后在本机真实占用 `7531` 的状态下，安装器在 `web-port-check` 提前失败，未执行 Compose；占用进程 PID 40740 未被本轮终止。

## 2026-08-24 · OpenClaw 一键安装误把诊断警告当作失败

- 问题：`openclaw doctor --lint --json` 在存在可修复配置警告时会以退出码 1 结束；安装器初版只按退出码判断，导致真实 OpenClaw 安装被错误中断。
- 风险/影响：全新 Node 24 容器虽然已完成 OpenClaw 安装、配置校验和状态检查，仍会被报告为失败，破坏一键安装的可重复验收。
- 改动范围：安装器对 `doctor --lint --json` 解析合法结构化输出；记录 warning 并继续后续步骤，只有命令失败且输出不是合法 JSON 时才阻断安装。
- 回归测试：`packages/installer/tests/openclaw.test.ts` 覆盖 doctor warning 非阻断、非法输出阻断和正常 JSON 三条路径。
- 验证命令：`node node_modules/typescript/bin/tsc -b --pretty false`；`pnpm exec vitest run packages/installer/tests/install.test.ts packages/installer/tests/openclaw.test.ts`；Node 24.15 Bookworm 容器真实执行 `node packages/installer/dist/main.js --framework openclaw --form host --skip-network`。
- 部署/运行验证：隔离 HOME 的 Node 24.15 容器中 `openclaw@2026.7.1-2` 安装、setup、config validate、doctor、status、Corepack、仓库依赖安装和构建均完成，安装器最终退出码为 0。

## 2026-08-24 · 干净 Node 容器缺少 pnpm shim 导致安装构建失败

- 问题：部分干净 Node 24 基础镜像只启用了 Corepack 管理器但没有可执行的 `pnpm` shim；安装器随后直接调用 `pnpm install/build` 会在依赖已满足时仍失败。
- 风险/影响：宿主和容器形态的真实验收依赖基础镜像细节，出现“环境可用但安装失败”的非确定性结果。
- 改动范围：在仓库依赖安装前显式执行 `corepack enable`，并统一通过可解析的 Corepack pnpm 命令运行安装与构建；错误信息保留命令和 stderr 便于定位。
- 回归测试：安装器 host 流程断言 Corepack 步骤先于 pnpm 安装/构建；OpenClaw 安装测试覆盖 Node 版本门禁和命令顺序。
- 验证命令：`node node_modules/typescript/bin/tsc -b --pretty false`；安装器定向 Vitest；Node 24.15 容器真实安装回归。
- 部署/运行验证：Node 24.15 Bookworm 容器中 Corepack shim 生效，仓库依赖安装和 TypeScript/UI 构建成功。

## 2026-08-24 · Docker 干净上下文的增量 TypeScript 构建未发射入口文件

- 问题：三服务 Dockerfile 使用普通 `tsc -b`；在不带既有 `dist/` 的干净构建上下文中，增量构建可能只生成 `tsconfig.tsbuildinfo`，没有发射 `apps/*/dist/main.js`，容器随即以 `MODULE_NOT_FOUND` 循环重启。
- 风险/影响：OpenClaw Docker 一键安装无法启动 Gateway/Watch/Web，健康检查永远失败。
- 改动范围：Watch、Gateway、Web 三个 Dockerfile 的构建步骤改为 `tsc -b --force`，再单独执行 Vite 构建，确保每次镜像都产生完整运行时产物。
- 回归测试：重新执行三镜像 `docker compose build`，检查镜像内三个 `dist/main.js` 存在；随后执行 Compose 启动和健康检查。
- 验证命令：`docker compose -f docker-compose.yml -f .tmp-openclaw-compose.override.yml up -d --build`；`docker compose ps`；容器内 `test -f /app/apps/gateway/dist/main.js` 等。
- 部署/运行验证：修复前 Gateway 日志为 `Cannot find module '/app/apps/gateway/dist/main.js'`；2026-08-24 修复后在 OpenClaw Compose 真实验收中 `butler-gateway`、`butler-watch`、`butler-web` 均为 `healthy`，容器内入口文件存在。

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

## 2026-08-24 · 首次公开发布的干净环境 CI 修复

- 问题：GitHub Actions 在全新检出中先运行 `pnpm test`，而工作区包入口指向未生成的 `dist/`，导致 52 个测试文件无法解析 `@butler/contract`/`@butler/core`；Bridge 的自定义 provider 解析依赖 PyYAML，但 `requirements.txt` 只声明 `aiohttp`，干净 Python 环境会退回不支持 `custom_providers` 的简化解析器。
- 风险/影响：本地遗留构建产物和 Hermes 既有环境掩盖了发布包的安装缺陷，外部 Agent 按仓库说明全新安装时会得到失败的测试或缺失的模型 provider 配置。
- 改动范围：根 `test` 脚本改为先执行 `tsc -b` 再运行 Vitest；Bridge `requirements.txt` 正式加入 `PyYAML>=6.0,<7`；同步更新发布说明、README、Changelog 与版本号 `0.1.0-dev.2`，保留既有 `v0.1.0-dev.1` 标签不动。
- 回归测试：无 `dist/` 的独立 worktree 使用新测试入口构建后，原先失败的 Web/Adapter 代表性用例共 49 项通过；仅按 Bridge requirements 安装的全新 WSL venv 全量 113 项通过，其中原失败的自定义 provider 用例恢复通过。
- 验证命令：`corepack pnpm version:check`；WSL ESLint；`tsc -b --pretty false`；WSL Vitest 全量 `750 passed / 3 skipped`；WSL Vite build（53 modules transformed）；全新 WSL venv Bridge `113 passed`；`docker compose config --quiet`；Semgrep secrets（0 findings）；`git diff --check`。
- 部署/运行验证：本次只修复发布与 CI 可复现性，不升级或重启本机运行服务，不执行消息外发；推送后以 GitHub Actions 的全新 Ubuntu runner 结果作为最终发布门禁。

## 2026-08-24 · 熔断跨重启恢复与能力路由执行门禁

- 问题：熔断跳闸事实虽然写入 events，但 watch 重启后活动状态会丢失；`CapabilityRouter` 只被单测直接调用，业务 `core.invoke` 路径可绕过 `not-implemented`/运行期降级裁决。
- 风险/影响：重启后可能再次自动触发已进入崩溃循环的 runbook；不支持的技能/记忆驱动可能从 UI/API 继续执行，能力降级也不会沉淀运行态信号。
- 改动范围：`apps/watch/src/runbook/breaker.ts` 增加 `initialTrips` 恢复与显式 `reset`；`apps/watch/src/watch.ts` 启动时从 `circuit-breaker-tripped` 事件恢复每个 key 最近跳闸；`packages/core/src/executor.ts`/`index.ts` 为 `core.invoke` 增加可选 `capability` 路由，调用前检查、调用后记录结果；`apps/watch/src/skills.ts` 为主要 skill/memory 驱动调用补齐能力位。
- 回归测试：熔断器恢复/reset、Core capability invoke 门禁与运行结果记录测试；定向执行 3 个测试文件共 22 项通过；TypeScript build 通过。
- 验证命令：`node node_modules/typescript/bin/tsc -b --pretty false`；`corepack pnpm exec vitest run --config vitest.focused.config.ts apps/watch/tests/runbook-breaker.test.ts packages/core/tests/core.test.ts apps/watch/tests/watch.test.ts`；`git diff --check`。
- 部署/运行验证：未重启用户现有服务，未执行消息外发；持久化恢复逻辑通过隔离 SQLite/events 单测验证。

## 2026-08-24 · 熔断状态真实展示、人工解除审计与 OpenClaw 启动校验

- 问题：Settings 将崩溃循环保护硬编码为“已满足”，无法识别真实跳闸状态；即使根因已处理也没有产品化的人工解除入口。OpenClaw 的 `start/restart` 还可绕过 `validateConfig` 直接执行 gateway 命令。
- 风险/影响：用户可能误以为自动修复仍在运行，重复触发已暂停的修复；配置不满足安全不变式时启动 OpenClaw，可能进入无限重启或不安全运行状态。
- 改动范围：新增 Watch `POST /api/runbooks/:id/reset` 与 Web 代理；Settings 消费 `/api/runbooks` 的真实 `breakerTripped`，只对已跳闸方案显示确认解除按钮；解除前读取跳闸事实、清除对应 key，并追加 `circuit-breaker-reset` 审计。Watch 将 `validateConfig` 统一经 `core.invoke({ capability: "config-driver" })` 接入补丁与升级预检；OpenClaw `start/restart` 在 gateway 命令前强制配置校验，block 违例 fail-closed。
- 回归测试：新增 Watch/Web reset 代理契约和 OpenClaw 配置失败时不执行 gateway 的 smoke；共 5 个定向文件 44 项通过；TypeScript build 与 `git diff --check` 通过。
- 验证命令：`node node_modules/typescript/bin/tsc -b --pretty false`；`corepack pnpm exec vitest run --config vitest.focused.config.ts packages/adapters/openclaw/tests/smoke.test.ts apps/watch/tests/watch.test.ts apps/watch/tests/http-gateway.test.ts apps/watch/tests/http-upgrade.test.ts apps/watch/tests/http.test.ts`；`git diff --check`。
- 部署/运行验证：未重启现有服务，未执行真实消息发送；真实 OpenClaw 消息通道、宿主安装和升级回滚仍需发布前验收。

## 2026-08-24 · M4 进化前备份与技能替换门禁 fail-closed

- 问题：`apps/watch/src/watch.ts` 的进化前事件备份失败后仍继续调用真实 `evolution.preflight`，造成备份不可用时仍可能进入进化流程；通用 M4 结果接口也只有 `allowWrite` 布尔值，没有唯一的技能候选替换入口。
- 风险/影响：没有可回滚快照时可能启动进化；调用方可忽略 `allowWrite` 或把未经 hash 校验的候选写入 `skills/`，破坏 baseline 保留和“负优化不落盘”承诺。
- 改动范围：新增 `withEvolutionBackup`，备份失败返回 `rejected-preflight`、写审计且不调用底层预检；`recordResult` 仅对显著正增益且目标/候选均位于实例 `skills/` 根目录并可读取 hash 时签发一次性授权令牌；新增 `promoteArtifact` 与 `/api/evolution/runs/:runId/promote`，固定路径、复验 baseline/candidate hash、原子替换、登记失败恢复旧文件，并记录采用审计。
- 回归测试：`apps/watch/tests/evolution.test.ts` 覆盖令牌签发、路径/hash 漂移、一次性消费；`apps/watch/tests/http-evolution.test.ts` 覆盖 promote 路由和冲突映射；`apps/watch/tests/watch.test.ts` 覆盖备份失败不调用底层预检。
- 验证命令：`node node_modules/vitest/vitest.mjs run apps/watch/tests/evolution.test.ts apps/watch/tests/http-evolution.test.ts apps/watch/tests/watch.test.ts --testTimeout 30000 --hookTimeout 30000`（3 文件、21 项通过）；`node node_modules/typescript/bin/tsc -b --pretty false`；`git diff --check`。
- 部署/运行验证：仅隔离测试与静态验证，未对真实 Hermes/OpenClaw 技能文件执行替换，未重启服务，未外发消息。

## 2026-08-24 · Watch 控制业务统一能力路由

- 问题：`CapabilityRouter` 已接入 `core.invoke` 和 Skills/Memory 路径，但 Runbook、升级流水线、进化快照/回滚等 watch 业务通过原始 control 门面调用，可能绕过 `not-implemented` 与运行期降级裁决。
- 风险/影响：实例未声明控制能力或已进入运行期降级时，自动修复、升级或回滚仍可能触发底层适配器；这会破坏 V1 的 fail-closed 能力边界。
- 改动范围：新增 `apps/watch/src/watch.ts:createRoutedControl`，将 start/stop/restart/upgrade/snapshot/rollback 统一映射到 `core.invoke({ capability: "control" })`，`validateConfig` 映射到 `config-driver`；Runbook、升级、进化与 Gateway 统一注入该门面。detect/capabilityScan/logSources 保持发现阶段只读直连。
- 回归测试：新增 `apps/watch/tests/capability-routing.test.ts`，覆盖 control/config-driver 未实现时底层零调用、已实现时 snapshot/validateConfig 透传与审计。
- 验证命令：`corepack pnpm exec vitest run --config vitest.focused.config.ts apps/watch/tests/capability-routing.test.ts`（3 项通过）；`corepack pnpm exec tsc -p apps/watch/tsconfig.json --noEmit`；`git diff --check`。
- 部署/运行验证：仅隔离 Core/Watch 单测与类型检查，未对真实 Hermes/OpenClaw 执行控制、升级、回滚或消息外发；真实双形态控制面验收仍是 V1 No-Go 项。

## 2026-08-24 · Hermes 宿主控制禁止猜测 systemd unit

- 问题：`ProcessExecutor` 未配置 `process.unitName` 时默认探测并操作 `systemctl --user` 的 `hermes` unit；真实宿主服务可能叫 `hermes-gateway.service` 或使用其他 unit，导致 start/stop/kill 可能作用于错误服务。
- 风险/影响：管家控制面可能误停其他 Hermes/网关服务，或把错误服务标记为已启动，破坏实例隔离和升级/回滚安全边界。
- 改动范围：`packages/adapters/hermes/src/control/executor.ts` 将 unit 改为可选配置；只有显式、非空 `process.unitName` 才执行 `systemctl --user cat/start/stop/kill`，未配置时不调用 systemd，回退到实例 `rootPath` 下的 venv/pgrep 路径。同步更新 Hermes control 测试与回滚夹具，显式验证 `hermes-gateway.service`，并锁定默认 systemd 零调用。
- 回归测试：`packages/adapters/hermes/tests/control.test.ts` 46/46 通过，覆盖显式 unit 的 start/stop/restart、未配置 unit 的启动回退、运行中回滚和错误 unit 旁路防护。
- 验证命令：`corepack pnpm exec vitest run packages/adapters/hermes/tests/control.test.ts --testTimeout 30000 --hookTimeout 30000 --maxWorkers=1`；`corepack pnpm test`；`corepack pnpm lint`；`corepack pnpm build`；`git diff --check`。
- 部署/运行验证：仅使用隔离临时 Hermes fixture 与 fake command executor；未对真实 Hermes、systemd unit 或消息通道执行控制，未外发任何消息。真实宿主安装仍需显式提供正确 unit 并完成现场 smoke。

## 2026-08-24 · 巡检进程探针禁止裸匹配 hermes

- 问题：`apps/watch/src/pipeline.ts` 的 `process-alive` 阶段曾以 `pgrep -f hermes` 作为第二匹配模式，可能把同机其他 Hermes 进程误判为当前实例。
- 风险/影响：错误的存活信号会跳过重启 runbook、污染升级健康验收，并破坏多实例隔离。
- 改动范围：进程探针改为只匹配 `rootPath/venv/bin/python` 与 `rootPath/hermes-agent`；同步更新 Watch HTTP/Watch 集成测试夹具与诊断文案。
- 回归测试：`apps/watch/tests/pipeline.test.ts`、`apps/watch/tests/http.test.ts`、`apps/watch/tests/watch.test.ts` 覆盖实例路径命中与无关进程不命中。
- 验证命令：`corepack pnpm test`；`corepack pnpm lint`；`corepack pnpm build`；`git diff --check`。
- 部署/运行验证：仅隔离测试夹具验证，未对真实 Hermes 进程执行 pgrep、重启或消息外发；真实多实例现场探针仍需发布验收。

## 2026-08-24 · M-04 消息轨迹 7 天保留与重试上限收口

- 问题：接管实验路径虽然声明 `delivery.maxAttempts=5`，但重试状态可能继续被消费；Gateway 本地投影和 Hermes Bridge Outbox 也缺少统一的 7 天终态历史清理，长期运行会造成永久重试或无界增长风险。
- 风险/影响：消息发送超过策略上限仍可能重复触达；旧决策、delivery attempt、状态事件和附件 spool 长期堆积，增加隐私暴露、磁盘耗尽和恢复成本。该路径仍属于 Hermes L2 之外的实验能力，不能因此接入默认生产入口。
- 改动范围：`apps/gateway/src/message/reconciler.ts` 在投递前达到 `maxAttempts` 时写入 `cancelled` 并阻止再次发送；`MessagePolicyStore.pruneMessageHistory` 默认清理 7 天前的本地终态投影，保留活动状态与 Bridge 权威 Outbox。`packages/adapters/hermes/bridge/agent_butler_bridge/outbox.py` 清理 7 天前终态 outbound 消息及 decisions、delivery attempts、state events、attachments，并回收附件 spool；`BridgeRuntime` 启动时执行一次、运行中每小时执行一次，health 暴露 `retention` 状态。默认 Gateway/Compose/Installer 仍未装配消息 launcher，Hermes V1 继续保持 L2。
- 回归测试：Gateway message store/reconciler 定向测试 25/25 通过，覆盖达到上限不发送、本地仅清理终态和保留 `retry_wait`；Bridge Outbox/runtime 定向测试通过，覆盖子记录与 spool 清理、health retention 和 runtime 生命周期。
 - 验证命令：Gateway message store/reconciler 定向测试；Ubuntu-24.04 Hermes venv Bridge `unittest discover`（114 passed）；Bridge `compileall`；`corepack pnpm test`、`corepack pnpm lint`、`corepack pnpm build`；`git diff --check`。
- 部署/运行验证：未执行真实消息外发、真实 Hermes 写入或外部系统修改；Windows 默认 WSL 发行版缺少 `aiohttp`，验证使用仓库既有 Ubuntu-24.04 Hermes venv。真实 Bridge 长时间运行、重启、升级后的保留计时和生产消息验收仍是发布前门槛。

## 2026-08-24 · M1 关键记忆探针独立 SLA 调度

- 问题：完整巡检虽然默认每 5 分钟执行，但整轮阶段在飞时会跳过下一次 tick；仅凭整轮调度无法证明“故障刚错过轮询边界后仍在 10 分钟内发现并触发修复”。
- 风险/影响：记忆嵌入停止或写入失败可能等待整轮巡检结束，缺少可复核的发现、修复、告警时间线；长时间巡检还可能拖延下一轮。
- 改动范围：`apps/watch/src/scheduler.ts` 新增独立 `CriticalProbeScheduler`，默认每 1 分钟运行关键 memory probe，SLA deadline 固定 10 分钟；与完整巡检使用独立 `inFlight`，记录 `lastStartedAt/lastCompletedAt/deadlineAt/durationMs/withinSla/overdue/missedTicks`。`apps/watch/src/config.ts` 新增 `BUTLER_CRITICAL_PROBE_INTERVAL_MIN`，允许 1-5 分钟并默认 1 分钟。`apps/watch/src/watch.ts` 将关键探针接入即时清理、`rb-restart` 自动处置、审计时间线；`GET /api/inspect/status` 暴露关键探针状态，Dashboard“管家最近检查”展示探针状态、频率、SLA 和最近耗时。
- 回归测试：`apps/watch/tests/scheduler.test.ts` 新增完整巡检阻塞时关键探针独立运行、最坏 deadline 逾期与 `missedTicks` 故障注入；`apps/watch/tests/config.test.ts` 覆盖默认值和上限；`apps/watch/tests/http.test.ts` 覆盖 HTTP 状态和 SLA 审计。定向测试 24 项通过，TypeScript build 通过。
- 验证命令：`corepack pnpm exec vitest run apps/watch/tests/http.test.ts apps/watch/tests/scheduler.test.ts apps/watch/tests/config.test.ts`；`corepack pnpm exec tsc -b`。
- 部署/运行验证：仅隔离 fake timer、临时 Hermes fixture 和本地 HTTP 验证；未对真实 Hermes 记忆库执行写入、未执行真实 runbook 或消息外发。真实“刚错过轮询边界”的现场故障注入、发现/告警/修复时间戳仍是 V1 发布前门槛。

## 2026-08-24 · H-04 Hermes 升级流水线内部能力路由收口

- 问题：watch 顶层控制调用已通过 `createRoutedControl`/`core.invoke`，但 Hermes 升级流水线内部构造的 `UpgradeControl` 仍直接调用适配器的 `stop/start/snapshot/rollback/validateConfig`，可绕过能力未实现与运行期降级裁决。
- 风险/影响：实例未声明控制或配置驱动能力时，升级预检、升级前快照、停止/启动和自动回滚仍可能触发底层执行器，破坏 H-04 fail-closed 边界。
- 改动范围：`packages/adapters/hermes/src/control/index.ts` 新增可选 `controlInvoker`，升级流水线五类内部调用统一携带方法名、实例和能力位；`apps/watch/src/watch.ts` 将 `core.invoke` 注入 Hermes 适配器，同时保留顶层 `createRoutedControl` 门面。缺省 invoker 直通，独立适配器调用保持兼容。
- 回归测试：`packages/adapters/hermes/tests/control.test.ts` 新增能力拒绝时升级流水线在 snapshot 阶段 fail-closed、底层 fake executor 零调用；Hermes control 47 项与 Watch capability-routing 3 项通过。
- 验证命令：`corepack pnpm exec vitest run packages/adapters/hermes/tests/control.test.ts apps/watch/tests/capability-routing.test.ts`；后续执行全量 `corepack pnpm test`、`corepack pnpm lint`、`corepack pnpm build` 与 `git diff --check`。
- 部署/运行验证：仅隔离 fixture 与 fake executor；未执行真实 Hermes 升级、回滚、systemd/Docker 控制或消息外发。H-01/H-02/H-03 真实验收缺口仍保持开放。

## 2026-08-24 · M1 关键探针告警与 SLA 时间线收口

- 问题：独立关键记忆探针失败时会触发自动修复，但失败本身没有直接进入 Gateway 持久告警队列；当整轮巡检阻塞或 `runbookAuto=false` 时，可能只留下审计而没有 10 分钟内的告警外发。
- 风险/影响：记忆写入/召回已失效时，用户可能看不到及时告警；自动修复与告警时间线也无法区分发现、排队和修复起点。
- 改动范围：`apps/watch/src/watch.ts` 在每个关键探针 fail 时无条件调用共享 `alertPoster`，使用 `critical-memory-probe:<instanceId>` 去重键；新增 `critical-memory-alert-queued` 审计，并在 `critical-memory-probe`/`critical-memory-remediation` 审计中记录 `observedAt`、告警排队和修复起止时间。自动 runbook 仍受 `runbookAuto` 与熔断/防抖规则控制。
- 回归测试：`apps/watch/tests/watch.test.ts` 验证自动修复开启和关闭两种模式均产生 critical 告警；`apps/watch/tests/scheduler.test.ts` 新增“刚错过 1 分钟边界、600001ms 完成”的确定性时间线，锁定 `deadlineAt`、`withinSla=false`、`missedTicks=1`。
- 验证命令：`corepack pnpm exec vitest run apps/watch/tests/watch.test.ts apps/watch/tests/scheduler.test.ts --testTimeout 30000 --hookTimeout 30000 --maxWorkers=1`（2 文件、19 项通过）；随后执行 TypeScript build、全量测试、lint、Vite build 与 `git diff --check`。
- 部署/运行验证：仅隔离临时 Hermes fixture、fake timer 和本地 Gateway stub；未对真实 Hermes 记忆库执行写入、未执行真实 runbook 或消息外发。WSL Ubuntu-24.04 已确认 user-systemd 可用，但缺少 Node/pnpm，宿主安装现场验收仍未关闭。

## 2026-08-24 · M2 宿主安装健康门禁与失败回滚

- 问题：宿主安装器写入 unit 并执行 `systemctl --user enable --now` 后即视为成功，没有确认三项服务保持 active，也没有检查 Web/Watch/Gateway 健康接口；启动失败可能留下部分服务运行的半安装状态。
- 风险/影响：用户会得到“安装成功”但面板或巡检服务实际不可用；部分启动状态还会污染后续重试和端口占用，违背新机安装后可健康运行的 P0 验收。
- 改动范围：`packages/installer/src/install.ts` 在宿主启动后增加三项 `systemctl --user is-active --quiet` 检查和三个 loopback HTTP 健康检查（Web `/api/health` 要求 `ok/db/gateway=true`，Watch/Gateway 要求 `/healthz.ok=true`），每项最多重试 5 次；任一检查失败则执行 `systemctl --user stop` 停止三项服务并返回失败。成功指引明确包含 active 与健康接口通过。
- 回归测试：`packages/installer/tests/install.test.ts` 覆盖健康成功调用序列和健康失败后的服务停止；宿主 unit dry-run、非 Linux fail-closed、Docker 形态回归保持通过。
- 验证命令：`corepack pnpm exec vitest run packages/installer/tests/install.test.ts --testTimeout 30000 --hookTimeout 30000 --maxWorkers=1`（本轮端口门禁加入后 34 项通过）；随后执行 `corepack pnpm exec tsc -b --pretty false`、`corepack pnpm lint`、`corepack pnpm build`、`corepack pnpm test`（93 个文件通过、1 个跳过；801 通过、3 跳过）与 `git diff --check`，全部通过。
- 部署/运行验证：仅使用注入式 Exec 与临时 serviceDir，未写入真实用户 unit、未启动现有宿主服务；Ubuntu-24.04 只读复核确认 Node `v24.14.1`、Corepack pnpm `10.20.0` 和 user-systemd 可用，但三项 Butler unit 均为 `inactive`，既有 Hermes 进程占用 `127.0.0.1:7532`，因此真实宿主常驻/健康/重启恢复仍需在无冲突、获授权的现场验收中完成。

## 2026-08-24 · M2 宿主端口冲突前置门禁

- 问题：宿主 user-systemd 安装路径此前只在写入 unit、启动服务后才暴露端口冲突；当既有 Hermes 或其它进程占用 7531/7532/7533 时，可能留下已写入但未健康的半安装状态。
- 风险/影响：重复安装或新机迁移失败时会污染用户服务目录，后续重试还可能误判为 Butler 自身故障；这直接阻断 M2 的可复核安装闭环。
- 改动范围：`packages/installer/src/install.ts` 新增 `services-port-check`，真实执行时在写 unit 前探测 Watch/Gateway/Web loopback 端口；若占用端口已由对应 active Butler unit 托管则允许幂等重跑，否则 fail-closed，不写 unit、不执行 daemon-reload/enable。dry-run 与注入式 Exec 保持无 socket 副作用；Docker 既有 `web-port-check` 不变。
- 回归测试：`packages/installer/tests/install.test.ts` 新增外部进程占用时不写 unit、已由 Butler unit 托管时允许继续两项回归；安装器定向测试 34/34 通过。
- 验证命令：`corepack pnpm exec vitest run packages/installer/tests/install.test.ts --testTimeout 30000 --hookTimeout 30000 --maxWorkers=1`；`corepack pnpm exec tsc -b --pretty false`；`corepack pnpm exec eslint packages/installer/src/install.ts packages/installer/tests/install.test.ts`；`git diff --check`。
- 部署/运行验证：未写入真实用户 unit、未启动或停止现有服务；WSL 只读复核仍显示 7532 被既有 Hermes 占用，真实宿主安装需在无冲突且获授权的现场完成。

## 2026-08-24 · OpenClaw 升级失败自动回滚与配置校验门禁

- 问题：OpenClaw `upgrade()` 虽然会创建升级前快照，但丢弃了 `snapshotId`；npm 安装失败或升级后配置校验失败时直接返回错误，没有恢复快照文件和升级前 npm 包版本；升级后校验只看进程退出码，无法阻断 `valid:false` 或损坏 JSON。
- 风险/影响：升级失败可能留下新旧配置、workspace/state 与全局 OpenClaw 包版本不一致；用户会得到“升级失败”但实例仍处于半升级状态，破坏 M2 自动回滚和数据完好承诺。
- 改动范围：`packages/adapters/openclaw/src/control.ts` 新增升级前配置校验、`openclaw --version` 版本记录、内部快照捕获与 snapshotId 传递；npm 安装失败、升级后非零/损坏 JSON/`valid:false` 均进入自动恢复，恢复 OpenClaw 配置/workspace/state 并尝试安装旧包版本；`skipSnapshot=true` 明确不声称自动回滚；任一恢复环节失败返回 E204 并提示人工介入；公开 `snapshot/rollback` 契约保持兼容。
- 回归测试：`packages/adapters/openclaw/tests/smoke.test.ts` 10 项通过，覆盖升级成功与幂等、安装失败文件/包回滚、`valid:false`、损坏 JSON、skipSnapshot、回滚失败人工介入，以及既有配置校验/快照/回滚行为。
- 验证命令：`corepack pnpm exec vitest run packages/adapters/openclaw/tests/smoke.test.ts --testTimeout 30000 --hookTimeout 30000 --maxWorkers=1`；`corepack pnpm exec tsc -b --pretty false`；后续执行全量 `corepack pnpm test`、`corepack pnpm lint`、`corepack pnpm build` 与 `git diff --check`。
- 部署/运行验证：仅使用临时 OpenClaw fixture、注入式 executor 和临时快照目录；未执行真实全局 npm 安装、未连接真实 OpenClaw 通道、未启动/停止现有服务。真实已知回归版本升级、数据对账和现场回滚仍是发布前门槛。

## 2026-08-24 · M4 OpenClaw 快照登记与资产回滚闭环

- 问题：OpenClaw 控制适配器原先只把快照复制到磁盘，不登记 Core store；M4 预检无法绑定本次 `snapshotId`。同时，回滚入口只恢复 `config/workspace/state`，对 `skills + memory` 快照可能返回成功但不恢复资产；预检还可能误拾取历史同标签快照。
- 风险/影响：进化可能在没有本次可回滚快照时被误判为 ready；失败恢复后技能或 Markdown 记忆仍可能保留候选/损坏版本，破坏 M4/M2 的 fail-closed 与数据完好承诺。
- 改动范围：`packages/adapters/openclaw/src/control.ts` 增加受控 `snapshotRecorder`、随机唯一快照 ID、真实 OpenClaw workspace 的 `skills/memory` 映射、manifest 相对路径校验与按 manifest 回滚；快照含 skipped/failed 步骤时升级拒绝执行 npm。`apps/watch/src/watch.ts` 将快照登记接入 Core store；`apps/watch/src/evolution.ts` 只接受本次新增的 `pre-evolution` 登记。
- 回归测试：`packages/adapters/openclaw/tests/smoke.test.ts` 13 项通过，覆盖 M4 资产登记、manifest 回滚和升级缺资产阻断；`apps/watch/tests/evolution.test.ts` 覆盖历史快照不可冒充本次快照；HTTP M4 接线测试保持通过。
- 验证命令：`corepack pnpm exec vitest run packages/adapters/openclaw/tests/smoke.test.ts apps/watch/tests/evolution.test.ts apps/watch/tests/http-evolution.test.ts --maxWorkers=1`；`corepack pnpm exec tsc -b --pretty false`；全量测试、lint、build 与 `git diff --check`。
- 部署/运行验证：仅使用临时 OpenClaw/Hermes fixture、注入式快照登记和本地回滚；未启动/停止现有服务、未执行真实 npm 安装、未发送真实消息。真实快照回滚、数据对账与进化引擎端到端验收仍未关闭。

## 2026-08-24 · 开发期 WebSocket 卸载噪声

- 问题：React `StrictMode` 在开发环境会短暂执行 WebSocket effect 的清理与重建；`EventTicker`、Dashboard、Versions 直接对仍处于 `CONNECTING` 的 `/ws` 连接调用 `close()`，浏览器控制台出现 `WebSocket is closed before the connection is established`，容易被误判为 Web 服务或 Vite 代理故障。
- 风险/影响：不影响后端 `/ws` 协议本身，但会污染开发诊断信号，并在页面切换/热更新时制造虚假的连接失败提示。
- 改动范围：新增 `ui/src/lib/websocket.ts` 的 `disposeWebSocket`，卸载时先解绑回调；连接尚未建立则等 `open` 后以正常关闭码释放，已建立连接才立即关闭。三个 `/ws` 消费页面统一使用该 helper。
- 回归测试：`corepack pnpm exec tsc -b --pretty false`；`corepack pnpm --filter @butler/ui exec vite build`；本地 `ws://127.0.0.1:7531/ws` 与 `ws://127.0.0.1:5173/ws` 均可建立连接。
- 部署/运行验证：未重启或停止现有服务；当前开发服务继续使用 `http://127.0.0.1:5173/`，Web 后端使用 `http://127.0.0.1:7531/`。

## 2026-08-24 · Hermes/OpenClaw 连接状态与手动控制

- 问题：Dashboard 只显示“管家服务是否在线”，用户无法区分 Hermes/OpenClaw 实例本身的连接状态，也无法手动检查、连接或断开实例；连接失败原因、响应耗时和能力降级信息不可见。
- 风险/影响：用户可能把控制通道在线误判为 AI 服务在线，重复重试或直接修改配置；断开动作也缺少可验证的终态反馈。
- 改动范围：`apps/watch/src/watch.ts` 增加连接状态内存、能力探针结果、延迟、最近动作/错误和 Hermes/OpenClaw 启停接线；`apps/watch/src/http.ts` 增加 `/api/connections` 查询、`/check` 手动探测和 `/:id/connect|disconnect` 控制端点；`apps/web/src/server.ts` 增加安全代理与不可达降级载荷；`ui/src/pages/Dashboard.tsx` 增加实时连接卡片、手动检查、连接/断开按钮和探针明细；`ui/src/styles.css` 增加响应式状态面板样式。
- 回归测试：`apps/watch/tests/http.test.ts` 新增连接查询、手动检查、连接和断开端点覆盖；既有 Dashboard/Web 与 Watch HTTP 测试保持通过。
- 验证命令：`pnpm exec tsc -b --pretty false`；`pnpm vitest run apps/watch/tests/http.test.ts apps/web/tests/dashboard.test.ts`；`pnpm build`；`git diff --check`。
- 部署/运行验证：仅使用本地 HTTP、临时 fixture 和注入式执行器验证；未启动/停止真实 Hermes 或 OpenClaw，也未触碰外部系统。真实服务启停、端口探活和断开后的现场复核仍需在用户明确授权的环境执行。
## 2026-08-25 · Beta.3 版本源、版本识别与 OpenClaw 状态入口

- 问题：Hermes 版本源默认地址写成 `NousResearch/hermes-agent`，与实际 Hermes Releases/Docker 源不一致；管家以 dist/cwd 启动时可能把错误目录当成源码，导致版本显示为 `0.0.0-dev`、无法读取 origin，升级页只能显示“没有更新”。Dashboard 未发现 OpenClaw 时也没有明确的未安装状态或可执行入口；技能/插件、备份/诊断页面纵向堆叠过长。
- 风险/影响：用户无法判断版本源是否可达，也无法区分未安装、未连接和服务离线；错误的源码根目录会阻断管家自升级；长页面降低技能、备份与诊断的可发现性。
- 改动范围：`apps/watch/src/config.ts` 将默认 Hermes 源改为 `hermes-agent/hermes`；`apps/watch/src/self-upgrade.ts` 与 `apps/watch/src/watch.ts` 向上解析项目根、规范化 Git remote；Hermes/OpenClaw 适配器增加实际安装目录的版本 fallback；新增 Watch/Web `/api/openclaw/status` 与确认后的 `/api/openclaw/install`，安装步骤、错误和审计可见；UI 将技能库/插件库改为 Tabs，设置页备份与诊断并排，实例高级信息直接展开，Dashboard 增加 OpenClaw 未安装/未连接状态卡与 Ant Design 确认弹窗。
- 回归测试：Watch 配置、Watch HTTP、Web 代理、Hermes 版本源定向测试通过；TypeScript 与 UI Vite 构建通过。OpenClaw 安装真实 npm/system 环境未在本机执行，仅验证接线与审计路径。
- 验证命令：`corepack pnpm exec tsc -b --pretty false`；`corepack pnpm --filter @butler/ui exec vite build`；`corepack pnpm exec vitest run apps/watch/tests/config.test.ts packages/adapters/hermes/tests/version-source.test.ts apps/watch/tests/http.test.ts apps/web/tests/server.test.ts --maxWorkers=1`；`git diff --check`。
- 部署/运行验证：本轮未停止占用 `127.0.0.1:7531` 的既有进程；发布后需重启 Watch/Web，使 `/api/connections`、`/api/openclaw/status`、`/api/versions` 走新产物，并在授权环境验证 OpenClaw 安装及 Hermes/管家版本号。

## 2026-08-25 · Beta.4 连接卡片、源码仓库与安全设置布局

- 问题：Dashboard 的 Hermes/OpenClaw 卡片不在同一网格且宽度不一致；部署目录没有 Git origin 时，管家版本页显示“尚未配置源码仓库”，实际项目仓库应为 `https://github.com/jiach72/agentbutler`；版本页实例信息层级粗糙，安全设置中的备份与诊断内容纵向过长。
- 风险/影响：用户无法快速区分两个运行框架的安装/连接状态，误以为源码位置就是仓库地址；版本识别和升级入口缺少可信上下文，备份/诊断操作在长页面中难以发现。
- 改动范围：Watch `/api/butler/version` 增加默认仓库地址、`repositoryConfigured` 与来源字段，Web 降级载荷同步字段；Dashboard 固定 Hermes/OpenClaw 双槽位并使用绿色/橙色品牌色；Versions 将仓库、源码目录、Git 绑定状态和受管实例事实改为紧凑信息网格；Settings 将备份与诊断拆为等宽工具面板，备份记录/诊断报告内部滚动并压缩保留策略。
- 回归测试：`apps/watch/tests/http-logs.test.ts`、`apps/watch/tests/http.test.ts`（22 项通过）；`corepack pnpm exec tsc -b --pretty false`；`corepack pnpm --filter @butler/ui exec vite build`；`git diff --check`。
- 验证命令：同上；Vite 构建仅有既有大 chunk 警告，无编译错误。
- 部署/运行验证：未停止或重启现有 `127.0.0.1:7531` 服务，未执行真实 OpenClaw 安装或升级；需在部署后验证 `/api/butler/version`、`/api/connections`、`/api/versions` 与浏览器响应式布局。

## 2026-08-25 · Beta.5 WSL 运行环境、Hermes 多源更新与 OpenClaw 安装任务

- 问题：版本页把运行目录笼统显示为源码目录；Windows 启动的 Watch 在读取 OpenClaw 版本时可能调用宿主机命令；Hermes 更新失败被压缩成无上下文的空列表；Dashboard 的 OpenClaw 一键安装没有任务进度、默认路径、日志或取消入口。
- 风险/影响：用户无法判断实际 WSL 发行版、数据目录和 npm 包位置；版本检查可能误报；安装按钮点击后无反馈，失败时也无法定位是 WSL、npm、Gateway 还是健康检查问题。
- 改动范围：新增 `apps/watch/src/runtime.ts` 统一探测 WSL 发行版、Linux 用户、源码/Butler/Hermes/OpenClaw/npm 路径，并让 Hermes/OpenClaw 控制命令统一经过 WSL executor；Hermes 版本源改为 `NousResearch/hermes-agent`，按 GitHub、可选镜像、PyPI、Docker Hub 顺序回退并返回逐源 attempts/耗时；OpenClaw 安装持久化 job、步骤、日志、取消状态，自动启动 Gateway 并重试健康检查；Web/Watch 增加运行时与安装状态代理；Dashboard 增加 Ant Design Modal、Steps、Progress、Alert、Drawer 任务面板；Versions 显示管家代码目录、运行环境和版本源时间线。
- 回归测试：`packages/adapters/hermes/tests/version-source.test.ts`、`apps/watch/tests/upgrade.test.ts` 定向测试 29 项通过；`corepack pnpm exec tsc -b --pretty false`；`corepack pnpm --filter @butler/ui exec vite build`。
- 验证命令：上述定向 Vitest、TypeScript 构建、Vite 构建；发布前继续执行全量 Vitest、`git diff --check`、版本一致性检查。
- 部署/运行验证：未在 Ubuntu-24.04 WSL 中执行真实 npm 安装或 Gateway 启动；未停止现有服务。部署后必须验证 `/api/runtime`、`/api/upgrade/versions`、`/api/openclaw/status`、`/api/openclaw/install/status` 和 `/ws`，并记录真实安装日志与健康复验结果。
