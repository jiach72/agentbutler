# AGENTS.md — 面向智能体的 Docker 部署指引

本文档写给**自动化部署的 AI 智能体**（TRAE / Claude Code / Codex 等）。拿到仓库地址后，按本文档从上到下执行即可完成 Docker 部署，并确保 Hermes 消息网关连接稳定。人类用户请阅读 [README.md](README.md)。

## 执行约定

- 逐节执行，**先做环境判定（第 1 节）再选部署分支**，不要跳步。
- 所有命令默认在目标部署机执行；涉及 WSL 的命令必须在 WSL shell 内执行。
- 遇到失败优先查第 6 节故障对照；无法解决时停止并向用户报告实际输出，**不要猜测性重试或绕过安全检查**。
- 部署完成后必须执行第 4 节验证，尤其是消息网关链路。

## 1. 环境判定

```bash
docker --version && docker compose version   # 必须：Docker 20.10+ 且带 compose v2
git --version                                  # 必须
uname -a                                       # 判定平台
ls ~/.hermes/hermes-agent 2>/dev/null && echo HERMES=yes || echo HERMES=no
```

按结果选择分支：

| 平台 | Hermes 集成 | 部署分支 |
|---|---|---|
| Linux / WSL（在 WSL shell 内） | 需要 | A + 2.1（Bridge 转发链路） |
| Linux / WSL | 不需要 | A（默认 `.env` 即可） |
| macOS（Docker Desktop / OrbStack） | 需要 | A + 2.2（直连 `host.docker.internal:8754`，**不要**启用 bridge-forward profile） |
| Windows（PowerShell） | — | A'：`git clone` 后执行 `.\scripts\deploy.ps1`（适合无 Hermes 消息数据面场景）；需要 Hermes 时改为在 WSL 内走分支 A |

> Windows + WSL 注意：仓库与构建必须在 WSL ext4 文件系统内（如 `~/agentbutler`）。**禁止**在 `/mnt/c` 下执行 pnpm install / docker build（NTFS 挂载上有系统性 EACCES 竞态）。

> **macOS 强约束：安装与长期运行只能走 Docker（分支 A + 2.2）。** macOS 宿主上用 `pnpm` / `corepack` 裸跑**仅允许作为一次性本地验证（跑完即弃），禁止作为安装方式或长期运行方式**：裸跑进程簇挂在启动它的终端会话上，会话结束服务即消失；且生产运维路径（数据卷备份、一键升级、技能库 CLI 产物）均按容器设计。Apple Silicon 与 Intel 走同一分支，无需区分。

## 2. 部署前配置

### 分支 A：通用（Linux / WSL / macOS）

```bash
git clone https://github.com/jiach72/agentbutler.git
cd agentbutler
cp -n .env.example .env
bash scripts/deploy.sh
```

`deploy.sh` 自动完成：主密钥生成并写入 `.env`（**后续部署绝不轮换，否则已存凭据无法解密**）、Hermes loopback 预检、数据卷备份、镜像构建、滚动启动与 30 轮健康等待。首次运行会创建 `.env`，按需编辑后再跑一次即可。

### 2.1 WSL + Hermes 消息接入（分支 A 扩展）

编辑 `.env`（Hermes 在 WSL 用户家目录时，deploy.sh 会自动探测 `~/.hermes` 并把探测结果**持久化写入 `.env` 的 `BUTLER_HERMES_HOST_PATH`**，确保后续手动 `docker compose` 命令与 UI 一键升级使用相同挂载源；只需确认以下三项）：

```ini
BUTLER_HERMES_HOST_PATH=/home/<user>/.hermes        # 必须存在 agent-butler/bridge.token
BUTLER_HERMES_BRIDGE_URL=http://host.docker.internal:8755
BUTLER_HERMES_BRIDGE_ALLOW_NON_LOOPBACK=true
```

前提：宿主 Hermes Bridge 已在 `127.0.0.1:8754` 监听（loopback 是代码强制的，不可改成 0.0.0.0）。deploy.sh 会自动选择转发器：已有 systemd `agent-butler-bridge-forward.service` 或 8755 监听则复用，否则启用 Compose 的 socat 转发器 profile（8755 → 8754）。**两种转发器只能存在一种**。

### 2.2 macOS + Hermes 消息接入（分支 A 扩展）

Docker Desktop / OrbStack 的 `host.docker.internal` 可直达宿主 loopback 服务，无需任何转发器：

```ini
BUTLER_HERMES_HOST_PATH=/Users/<user>/.hermes
BUTLER_HERMES_BRIDGE_URL=http://host.docker.internal:8754
BUTLER_HERMES_BRIDGE_ALLOW_NON_LOOPBACK=true
```

**不要**设置 `COMPOSE_PROFILES=bridge-forward`（该 profile 的 `network_mode: host` 在 Docker Desktop for Mac 指向的是 VM，不是 macOS 宿主）。

### 2.2.1 macOS + Ollama 本地模型接入（分支 A 扩展）

- **方案 1（Compose 容器自托管，零配置）**：默认启动内置 `ollama` 容器。镜像自动兼容 Apple Silicon（`linux/arm64`）和 Intel Mac（`linux/amd64`），模型持久化于 `ollama-data` 命名卷中，自适应硬件阶梯推荐。
- **方案 2（推荐：宿主机原生 Metal GPU 加速）**：若 Mac 宿主已运行原生 Ollama（`brew install ollama` 或 Ollama.app，享 Apple Silicon Metal 硬件加速）：
  ```ini
  BUTLER_OLLAMA_URL=http://host.docker.internal:11434
  BUTLER_OLLAMA_PORT=11435   # 避免容器映射与宿主 11434 端口冲突
  ```
  `butler-web` 已内建 `host.docker.internal` 解析，可无缝直连 Mac 宿主 Metal 加速引擎。

### 2.3 跨设备访问（可选）

默认仅本机可访问（Web 绑定 `127.0.0.1:7531`）。需要局域网访问时，在 `.env` 同时设置 `BUTLER_WEB_PUBLISH_HOST=<非回环地址>` 与强随机 `BUTLER_ACCESS_TOKEN`。**未配置口令时禁止把端口暴露到不可信网络。**

## 3. 消息网关的连接保障机制（务必了解）

部署后 Gateway 到 Hermes Bridge 的连接**不会因断线而失效**，这是代码保证的：

- Bridge 不可达时，Gateway **只标记离线、不崩溃不退出**（`apps/gateway/src/message/service.ts` 的 reconcile 循环），每秒自动重试；
- Bridge 恢复后自动重装策略并从上次 cursor 续传 Outbox，无需人工干预；
- 所有容器（含 bridge 转发器）均为 `restart: unless-stopped`；
- Gateway 的容器 healthcheck 只探测自身 `/healthz` 的 `ok` 字段，**不**依赖 Bridge 状态——Bridge 短暂离线不会被误判为容器不健康，也就不会触发重启风暴。

因此正确的心智模型是：**「连接断开会自愈」**。你的验证职责是确认自愈机制在跑（见 4.2），而不是保证 Bridge 永远在线。

- 消息链路支持运行时「一键接管」切换（面板或 `POST /api/messages/relay`）：关闭后 Hermes 原通道直发（Bridge 仍捕获审计，不聚合不限速），开启后恢复 Butler 策略管线；Bridge 离线时切换保持「待生效」，重连后自动装策略生效。
- 通道控制端点（`/v1/channels*`）仅读写 `~/.hermes/config.yaml` 的 `platforms` 白名单子树并自动备份；启停通过 Hermes 优雅重启生效，不触碰 systemd。

## 4. 部署后验证（必做）

### 4.1 基础就绪

```bash
docker compose ps                                  # gateway / watch / web 均 healthy
curl -s http://127.0.0.1:7531/api/health           # 必须包含 "gateway":true
```

### 4.2 消息网关链路（启用了 Hermes 时必做）

```bash
bash scripts/bridge-healthcheck.sh                 # token → bridge → 转发器 → Gateway 全链路，任一 FAIL 退出码为 1
curl -s http://127.0.0.1:7531/api/messages/overview # 消息总览正常返回
curl -s http://127.0.0.1:7531/api/health | grep -o '"connected":[a-z]*'  # 消息运行时连接状态
```

自愈机制验证（可选但推荐）：`docker restart butler-bridge-forwarder`（WSL 场景）后等 5 秒再查 `/api/health`，`connected` 应从 `false` 自动回到 `true`。

### 4.3 升级 / 回滚（交付后运维）

- 更新：`bash scripts/deploy.sh`（滚动重建，升级前自动备份数据卷），或在 UI「设置 → 关于」一键升级（内部 updater sidecar 执行，失败自动回滚）。旧版 updater 若仍内置 `docker-compose` v1，先拉取本修复并在宿主机一次性执行 `docker compose up -d --build --force-recreate butler-updater`，再使用 UI 升级；
- 回滚：`BUTLER_VERSION=<旧版本> docker compose up -d --no-build --force-recreate`。

## 5. 安全红线

1. 不要把 `BUTLER_SECRET_MASTER_KEY`、`BUTLER_ACCESS_TOKEN`、`bridge.token` 打印到日志或提交到仓库。
2. 不要删除或轮换 `.env` 中的 `BUTLER_SECRET_MASTER_KEY`（历史模型 API Key 将无法解密）。
3. 不要为「方便容器直连」把 Hermes Bridge 改为监听非 loopback（代码会拒绝启动并崩溃循环）。
4. 不要同时启用 socat 转发器与 systemd 转发器（8755 端口冲突）。
5. 未配置 `BUTLER_ACCESS_TOKEN` 时，不要把 Web 端口发布到回环以外。
6. Docker Socket 默认关闭（挂载 `/dev/null`）；只有用户明确要求受管容器控制时才设置 `DOCKER_SOCKET_PATH`。

## 6. 故障对照

| 症状 | 处置 |
|---|---|
| `docker compose ps` 有容器非 healthy | `docker compose logs --tail=200 <服务名>` 定位；deploy.sh 健康等待超时时会自动打印未就绪服务的日志尾部 |
| 部署失败提示 token missing | `BUTLER_HERMES_HOST_PATH` 指向的目录缺 `agent-butler/bridge.token`，检查路径 |
| butler-gateway 崩溃循环 `cannot access BUTLER_HERMES_BRIDGE_TOKEN_FILE` | `.env` 的 `BUTLER_HERMES_HOST_PATH` 仍是默认 `./.runtime/hermes`（deploy.sh 会自动持久化探测路径；手动改过 `.env` 或换机迁移后需修正） |
| hermes-gateway 崩溃循环 `Bridge host must remain on loopback` | `~/.hermes/.env` 的 `HERMES_BUTLER_HOST` 必须是 `127.0.0.1`（改回后等 systemd 自动重启） |
| butler-web 崩溃循环「面板监听地址不是本机地址…没有设置访问口令」 | 非回环发布（如 `0.0.0.0`，WSL portproxy 场景需要）必须配套强随机 `BUTLER_ACCESS_TOKEN`；或改回 `BUTLER_WEB_PUBLISH_HOST=127.0.0.1` |
| Windows 浏览器打不开 7531 但容器 healthy | WSL IP 变化致 portproxy 失效：管理员 PowerShell 执行 `scripts/fix-portproxy.ps1`；或启用 mirrored networking |
| `/api/messages/overview` 显示 bridge 不可达 | 先跑 `bash scripts/bridge-healthcheck.sh` 定位断点；Gateway 侧无需处理（自愈中） |
| pnpm install EACCES（在 /mnt/c） | 迁移仓库到 WSL ext4 后重来，禁止在 NTFS 挂载上构建 |
| 面板切换接管后一直显示「待生效」 | Bridge 离线（`bash scripts/bridge-healthcheck.sh` 定位）；恢复后下一轮 reconcile 自动生效，无需人工处理 |
| 通道启停后 60 秒仍「应用中」 | Hermes 网关重启失败：查 hermes-gateway 服务日志；Bridge 不会自动反复重启 |
| UI 一键升级提示 Compose 不认识顶层 `name` | updater 仍在运行旧的 `docker-compose` v1；拉取修复后执行一次 `docker compose up -d --build --force-recreate butler-updater`，随后从 UI 重试 |

更多细节见 `docs/docker-operations.md` 与 `docs/deployment-20260825.md`（含完整踩坑记录）。

## 7. 已踩坑实录（agent 易复发，处置已固化）

以下坑来自真实客户部署日志，均已修复或给出固化处置。遇到同类症状直接按表执行，不要重新排查：

| # | 坑 | 症状 | 状态 / 处置 |
|---|---|---|---|
| 1 | main 曾漏提交 4 个文件（85241b9） | 干净克隆后 `tsc -b` 报 `summary.js` / `onboardingDismiss.js` / `MemoryProbeConfigCard.js` 找不到；README 引用的 `scripts/install.sh` 不存在 | 已修复（d5a05df 补提交 4 文件 + 6 测试）。再遇到构建缺文件：先 `git log --stat` 核对引用方与被引用文件是否同一提交，不要怀疑本机环境 |
| 2 | skills-manager CLI 下载产物曾硬编码 `Linux-x64` | Apple Silicon（darwin+arm64）上技能库 502，日志有 `spawn ENOEXEC`（Linux ELF 在 mac 不可执行） | 已修复（d5a05df 改为按 `process.platform`+`process.arch` 映射产物，并新增落位前 `--version` 冒烟：错平台二进制不再落位，降级为 unavailable 提示不中断服务）。老版本镜像升级后技能库自动恢复，无需手动下载 CLI |
| 3 | pnpm 会话子进程随父会话死亡 | 客户 agent 用 `pnpm start` 裸跑部署，终端会话结束/SSH 断开后服务全部消失，误判为「安装失败」 | 裸跑仅限一次性验证。长期运行必须走 Docker（`restart: unless-stopped`）；验证完执行 `corepack pnpm` 相关进程清理后改走分支 A |
| 4 | Bridge 注入后需外部重启网关才激活 | 部署中向 Hermes 注入 Bridge 配置后，Gateway 侧连接一直 `connected:false`（注入不触发运行中的 Hermes 重载） | 注入完成后在宿主执行 `systemctl --user restart hermes-gateway`（或等价方式重启网关进程），再跑 `bash scripts/bridge-healthcheck.sh` 验证 |
| 5 | 数据库锁定瞬态自愈 | 日志偶见 `SQLITE_BUSY` / `database is locked` | 瞬态：写路径带重试，通常自愈。仅在错误**持续**出现且面板数据停更时，`docker compose restart butler-watch`，并检查是否存在跨容器共享同一 SQLite 文件的非常规挂载 |
| 6 | LLM 端点 401 预检建议 | 首次部署后探针/记忆写入整片失败，日志大量 401（`.env` 里模型 API Key 抄错或端点不通，部署时无校验） | 部署前用一条最小 `curl`（或等价请求）带 `.env` 中的 Key 打一次目标端点 `/models`（或最便宜端点）预检 200 再继续；避免带着坏 Key 走完全程再返工 |
| 7 | macOS 控制桥 launchctl bootstrap 瞬态 EIO | macOS 下 `install-hermes-control-bridge.sh` 报 `Bootstrap failed: 5: Input/output error`，导致控制桥停留在卸载态 | 已修复（加入 1s 缓冲、bootstrap 重试、kickstart 唤醒与 launchctl print 回读断言；且优先锁定 Hermes 自带 node 运行时并收敛 plist PATH） |
| 8 | UI / 容器查看 `/api/health` 时 `gitCommit` 为 null | 过去只在当前 shell export `BUTLER_GIT_COMMIT`，未落盘到 `.env`，导致 compose 启动容器无法注入 commit SHA | 已修复（`deploy.sh`、`deploy.ps1` 及 `apps/updater` 升级时均自动持久化 `BUTLER_GIT_COMMIT` 到 `.env`） |
