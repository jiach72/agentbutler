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

### 2.3 跨设备访问（可选）

默认仅本机可访问（Web 绑定 `127.0.0.1:7531`）。需要局域网访问时，在 `.env` 同时设置 `BUTLER_WEB_PUBLISH_HOST=<非回环地址>` 与强随机 `BUTLER_ACCESS_TOKEN`。**未配置口令时禁止把端口暴露到不可信网络。**

## 3. 消息网关的连接保障机制（务必了解）

部署后 Gateway 到 Hermes Bridge 的连接**不会因断线而失效**，这是代码保证的：

- Bridge 不可达时，Gateway **只标记离线、不崩溃不退出**（`apps/gateway/src/message/service.ts` 的 reconcile 循环），每秒自动重试；
- Bridge 恢复后自动重装策略并从上次 cursor 续传 Outbox，无需人工干预；
- 所有容器（含 bridge 转发器）均为 `restart: unless-stopped`；
- Gateway 的容器 healthcheck 只探测自身 `/healthz` 的 `ok` 字段，**不**依赖 Bridge 状态——Bridge 短暂离线不会被误判为容器不健康，也就不会触发重启风暴。

因此正确的心智模型是：**「连接断开会自愈」**。你的验证职责是确认自愈机制在跑（见 4.2），而不是保证 Bridge 永远在线。

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

- 更新：`bash scripts/deploy.sh`（滚动重建，升级前自动备份数据卷），或在 UI「设置 → 关于」一键升级（内部 updater sidecar 执行，失败自动回滚）；
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

更多细节见 `docs/docker-operations.md` 与 `docs/deployment-20260825.md`（含完整踩坑记录）。
