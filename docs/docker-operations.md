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

### Updater 首次引导

当前 updater 使用 Docker CLI 的 Compose v2 插件，以支持 Compose 文件顶层的 `name:`。如果部署仍在运行旧版、内置 `docker-compose` v1 的 updater，旧容器无法在自己的 UI 升级流程中先替换该二进制。先拉取本修复，然后在宿主机执行一次：

```bash
docker compose up -d --build --force-recreate butler-updater
```

该命令只重建 updater sidecar；成功后再从 UI 发起一键升级即可。

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

> **形态切换的残留陷阱**：从 Compose socat 切到 systemd（或反过来）后，旧形态的容器/服务若带 `restart: unless-stopped`，会在每次 WSL 重启时与新形态抢占 8755，抢输的一方永久崩溃循环（日志 `bind: Address in use`）。deploy.sh 已在复用 systemd/既有监听时自动清理 Compose 转发容器；手动处置用 `docker compose rm -sf butler-bridge-forwarder`。消息链路在此噪音下仍正常（healthcheck 照常通过），但会掩盖真正的转发故障，看到就清。

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
| 技能库 502，watch 日志 `spawn ENOEXEC` | 旧镜像把 CLI 下载产物硬编码为 Linux-x64，Apple Silicon 上拿到不可执行的 ELF。升级到含平台映射修复的版本（d5a05df+）后重启即自愈；CLI 会重新按平台下载并通过 `--version` 冒烟后才落位 | AGENTS.md 第 7 节坑 2 |
| 干净克隆后构建报 `summary.js` 等模块找不到 | 旧提交曾漏 add 4 个源文件；拉取 d5a05df+ 后消失。若在新提交再现，用 `git log --stat` 核对引用方与被引用文件是否同提交 | AGENTS.md 第 7 节坑 1 |
| macOS 容器连不上宿主 Hermes Bridge | `BUTLER_HERMES_BRIDGE_URL` 应为 `http://host.docker.internal:8754` 且**不要**设 `COMPOSE_PROFILES=bridge-forward`（Mac 的 host 网络指向 VM） | AGENTS.md 2.2 |
| 容器内调试 watch/gateway 写端点 401 | 1.0.3 起服务间调用需带 `x-butler-internal-token`；web 代理已自动附加，手动 curl 才需要带 | 本文第 7 节 |
| 知识库批量上传/冒烟脚本收 429 | 大载荷写端点已限流（upload* 30/min、markdown/files 60/min、memory 300/min）；脚本加间隔，非故障 | 本文第 7 节 |
| 模型探针报「公网探测端点必须使用 https」 | 探针携带 Bearer Key，公网明文 http 拒发；改 https，本机/内网 http 不受限 | 本文第 7 节 |

## 7. 1.0.3 安全加固后的行为变更（agent 与运维必读）

以下变更来自 2026-09-28 深度审计（见 `docs/audit-20260928.md`），均为**预期行为**，排障时不要当故障处理，更不要改回去：

### 7.1 服务间调用零信任（原 RFC1918 旁路已拆除）

- watch 不再把 `172./10./192.168.` 源 IP 视作回环；gateway 的内部口令（`BUTLER_INTERNAL_TOKEN`）覆盖**全部**状态变更路由（豁免 `/internal/hermes/*` 与 telegram webhook——前者是宿主 wake 提示另有限速，后者自带 secret 校验）。
- **面板功能不受影响**：web 代理对 watch/gateway 的所有调用已自动附加 `x-butler-internal-token`（`apps/web/src/proxy-helpers.ts` 的 `watchAuthHeaders`），`deploy.sh` 默认生成并注入该口令。
- 容器内手动 `curl` 调试写端点时需要带上：

  ```bash
  docker compose exec butler-web sh -c 'curl -s -X POST http://butler-watch:7533/api/<写端点> \
    -H "x-butler-internal-token: $BUTLER_INTERNAL_TOKEN" -H "content-type: application/json" -d "{}"'
  ```

### 7.2 面板 Host 白名单（DNS rebinding 防线）

- Host 必须落在：回环名 / `BUTLER_WEB_PUBLISH_HOST` / `BUTLER_ALLOWED_HOSTS`（新增，逗号分隔，反向代理场景用）。
- 发布地址为 `0.0.0.0` 通配时无法枚举，白名单按设计放行，由访问口令兜底——**通配发布必须配 `BUTLER_ACCESS_TOKEN`**。安全测试时伪造 Host 得到 200，先查发布配置再下结论。
- 反向代理改写 Host 的部署：把对外域名加进 `BUTLER_ALLOWED_HOSTS`。

### 7.3 凭据投递与写端点限流

- 模型探针携带 Bearer API Key：公网端点强制 https（明文 http 拒发，防链路窃听）；`127.0.0.1`、容器网、RFC1918 内网的 http 不受限（本地 Ollama / oneapi 正常用）。
- 大载荷写端点限流：`/api/knowledge/upload*`（含 upload-vault）30/min、`/api/markdown/files` 60/min、`/api/memory` 300/min。Obsidian 整库同步按批打包在单请求内，正常使用不会触顶。

### 7.4 文件落盘的边界断言（写代码前必读）

凡接受外部路径（上传文件名、manifest 回读、同步清单）并在服务端写/读/删文件的代码，一律复用 `apps/web/src/path-safety.ts`：

```ts
const cleanRel = sanitizeRelativePath(item.path);   // 拒绝 .. 段/盘符/绝对路径，null 即拒绝
const full = resolve(targetBase, cleanRel);
if (!isInsideRoot(full, targetBase)) return reply.code(400).send({ ok: false, error: "路径不合法" });
```

历史漏洞 K-1（路径穿越任意文件写/删/读）源于手写半截清洗（只剥开头斜杠不处理 `..`）。watch 侧同款语义见 `apps/watch/src/markdown-files.ts`。

### 7.5 updater 降权（可选）

updater 默认 root（需写宿主 bind 挂载的 `/workspace`）。`.env` 设置 `BUTLER_UPDATER_UID/GID` 为宿主仓库属主的 `id -u`/`id -g` 即可降权，docker socket 组访问由 `DOCKER_GID` 提供。

### 7.6 发布自检清单（agent 执行发版时逐项过）

1. `pnpm lint && pnpm test`——**push 前必跑**；本地 main 积压不超过一周/20 个提交（历史教训：积压 126 提交期间 lint 红灯潜伏，CI 门禁失效）。
2. 改版本号走 `node scripts/version.mjs set <x.y.z>` + `version:check`，并同步 `CHANGELOG.md`。
3. push 后 `gh run watch <run-id> --exit-status` 等 CI 四道门禁全绿；红了我方修复重推，**CI 未绿严禁更新 WSL**。
4. WSL 内 `git pull --ff-only && bash scripts/deploy.sh`（自动备份 → 构建 → 滚动 → 健康等待）。
5. 部署后验证：`docker compose ps` 全 healthy → `/api/health` 含 `"gateway":true` 且 `gitCommit` 为新 SHA → `bash scripts/bridge-healthcheck.sh` 0 FAIL → `connected:true`。
