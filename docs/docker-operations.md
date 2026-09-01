# Agent Butler Docker 运维手册

面向已按 `README.md` 或 `scripts/deploy.sh` 完成 Docker 部署的日常运维：更新、回滚、备份、Windows 访问链路维护与消息链路体检。部署当日的历史事故记录见 `deployment-20260825.md`。

## 1. 更新（rebuild）

```bash
bash scripts/deploy.sh
```

脚本内置以下保护：

- **预检**：`~/.hermes/.env` 的 `HERMES_BUTLER_HOST` 若不是 loopback 会提前告警（该配置错误曾导致 Hermes gateway 崩溃循环）；shell 环境里导出的 `BUTLER_*` 变量会告警提示它将覆盖 `.env`（compose 的优先级是 shell > `--env-file`）。
- **配置预检**：检查 Hermes loopback 约束、token 文件和 dirty worktree；WSL Bridge 使用 8755 时自动选择 Compose profile 或现有 systemd 转发器。
- **升级前自动备份数据卷**到 `backups/butler-data-<时间戳>.tgz`；备份失败默认阻断部署，可显式设置 `BUTLER_ALLOW_UNBACKED_DEPLOY=true` 绕过。
- **健康等待**：30 次轮询 Web、Gateway、Watch，并要求 Web 报告 `gateway:true` 后才报告就绪。

无需先 `docker compose down`——`up -d --build` 会滚动重建变更的容器，减少停机。

## 2. 回滚

镜像回滚（推荐，秒级）：

```bash
# 回滚到已构建的不可变版本（不要重新 build）
BUTLER_VERSION=<previous-version> docker compose up -d --no-build --force-recreate

# 若使用 .env，编辑 BUTLER_VERSION 后执行：
docker compose up -d --no-build --force-recreate
```

数据卷恢复（配合第 3 节的备份文件）：

```bash
docker compose down
docker run --rm -v agent-butler-data:/data -v "$PWD/backups":/backup alpine \
  sh -c "find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar xzf /backup/butler-data-<时间戳>.tgz -C /data"
docker compose up -d
```

## 3. 数据备份 / 迁移

手动备份（与 deploy.sh 内置逻辑相同）：

```bash
docker run --rm -v agent-butler-data:/data:ro -v "$PWD/backups":/backup alpine \
  tar czf "/backup/butler-data-$(date +%F).tgz" -C /data .
```

从旧的裸跑目录迁移数据（如 `~/.agent-butler`）：停服后把内容拷入命名卷，再通过 API 和日志校验：

```bash
docker compose down
docker run --rm -v agent-butler-data:/data -v "$HOME/.agent-butler":/src:ro alpine \
  sh -c "cp -a /src/. /data/"
docker compose up -d && curl -s http://127.0.0.1:7531/api/messages/overview
```

## 4. Windows 访问链路（WSL 部署场景）

WSL 重启后 IP 会变化，portproxy 规则随之失效。以管理员 PowerShell 执行：

```powershell
.\scripts\fix-portproxy.ps1            # 默认刷新 127.0.0.1:7531 → 当前 WSL IP
```

根治方案：在 `%UserProfile%\.wslconfig` 中启用镜像网络（Windows 11 22H2+），之后 Windows 的 localhost 直通 WSL，可删除全部 portproxy 规则：

```ini
[wsl2]
networkingMode=mirrored
```

> 注意：切 mirrored 后 WSL 内监听 `0.0.0.0` 的端口可能对局域网可见，转发器等辅助进程应改绑 loopback。

## 5. 消息链路体检

一键检查 token → bridge(8754) → 转发器(8755) → Gateway 容器全链路：

```bash
bash scripts/bridge-healthcheck.sh     # 任一 FAIL 退出码为 1
```

### 转发器的两种形态

Hermes Bridge 保持宿主 loopback，WSL 原生 Docker 必须经转发器接入：

| 形态 | 适用 | 维护方式 |
|---|---|---|
| **Compose socat 服务** | 新部署 | `COMPOSE_PROFILES=bridge-forward` 或 `docker compose --profile bridge-forward up -d` |
| systemd user Python 转发器 | 已有部署 | `systemctl --user status agent-butler-bridge-forward.service`；确保执行过 `loginctl enable-linger` |

使用任一转发器时，Gateway 的 `BUTLER_HERMES_BRIDGE_URL` 设为 `http://host.docker.internal:8755`；不要同时启用两种转发器。`8755` 是 TCP 转发入口，应由宿主防火墙限制访问范围。

### 通道控制面端点

面板「消息通知」页的通道管理经 Gateway/Web 代理到 Bridge 的 `/v1/channels*` 端点（面板调用走 `/api/messages/channels*`；响应永不回显明文凭据）：

| 端点 | 用途 |
|---|---|
| `GET /v1/channels` | 通道目录与运行态（微信/QQ 机器人/腾讯元宝/飞书/钉钉/企业微信） |
| `GET /v1/channels/{channel}/schema` | 通道可配置字段 schema |
| `PUT /v1/channels/{channel}/config` | 首次接入配置写入（仅 `platforms` 白名单子树，原子写） |
| `POST /v1/channels/{channel}/enable`、`/disable` | 通道启停（触发 Hermes 优雅重启，最多一次、失败不自动重试） |
| `POST /v1/channels/weixin/login/start`、`GET .../status`、`POST .../cancel` | 微信扫码登录会话 |

运维要点：

- 一键接管开关（面板或 `POST /api/messages/relay`）持久化在 Gateway 的 `relay_control` 表，位于 `BUTLER_MESSAGE_PROJECTION_DB` 指向的 SQLite（默认 `butler-data` 卷内 `/home/butler/data/messages.sqlite`），随第 3 节数据卷备份一起保留。
- 通道配置写入前会在同目录生成备份 `~/.hermes/config.yaml.bak-butler-<时间戳>`。
- 回滚通道配置：用对应备份覆盖回 `config.yaml`，再重启 `hermes-gateway` 服务生效。

## 6. 常见故障对照

| 症状 | 首查 | 见 |
|---|---|---|
| gateway 日志报 token 文件权限但 stat 正常 | 先 `docker inspect <容器> --format '{{range .Config.Env}}{{println .}}{{end}}' \| grep BRIDGE` 查 env 是否被污染 | deployment-20260825.md 坑6 |
| hermes-gateway 崩溃循环 `Bridge host must remain on loopback` | `~/.hermes/.env` 的 `HERMES_BUTLER_HOST` 必须是 `127.0.0.1` | 坑4 |
| Windows 浏览器打不开但容器 healthy | portproxy 失效（WSL IP 变了），跑 `fix-portproxy.ps1`；系统代理类工具会被拦 | 坑8 |
| UI 连接状态页转圈 | Web→Watch 代理超时降级为 `reachable:false` 属预期；用 bridge-healthcheck 定位真实断点 | 坑9 |
