# Agent Butler

**本地优先的 AI Agent 运维控制台。**

[![CI](https://github.com/jiach72/agentbutler/actions/workflows/ci.yml/badge.svg)](https://github.com/jiach72/agentbutler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Agent Butler 把 Agent 运行时的健康检查、消息接入、日志诊断、版本管理和数据恢复收进一个可审计的控制面。它适合在个人电脑、家庭服务器或团队内网中运行，让 Agent 保持可见、可维护、可回滚。

> 当前开发版本：`1.0.0-beta.10`（`main`）。这是测试版，默认只监听本机回环地址，管理面尚未提供公网鉴权。请勿将 Web 端口直接暴露到不可信网络。

## 能做什么

- **运行时巡检**：查看 Hermes、OpenClaw 等受管实例的连接、进程、端口和基础健康状态。
- **消息接入治理**：通过 Gateway 接管 Hermes Bridge 消息，支持断线重试、Outbox 同步和状态诊断。
- **版本升级与回滚**：展示当前版本、更新候选和恢复点；升级前自动备份，容器部署则明确引导在宿主机更新。
- **日志与诊断**：集中查看服务状态、部署问题和修复建议，减少在多个终端之间来回切换。
- **技能、插件与记忆盘点**：以只读方式了解 Agent 当前可用能力和数据状态。
- **本地安全边界**：默认不开放 Docker Socket、不暴露公网端口，敏感 token 通过宿主机目录注入。

## 工作方式

```text
+--------------+      +--------------+      +----------------+
| Agent Butler |----->| Gateway      |----->| Hermes Bridge  |
| Web 7531     |      | 消息与策略    |      | 宿主机 loopback |
+------+-------+      +------+-------+      +----------------+
       |                      |
       v                      v
  Watch 7533             持久化数据卷
  巡检/版本/备份
```

Web 是控制台入口，Gateway 负责消息运行时，Watch 负责巡检、版本和后台任务。Docker Compose 默认只发布 Web 的 `127.0.0.1:7531`；Gateway 和 Watch 保持在内部网络中。

## 快速安装

要求：

- Git
- Node.js 22 或更高版本
- Corepack / pnpm 10.20.0
- Hermes 集成需要 Python 3.11+；Bridge 运行时依赖见 `packages/adapters/hermes/bridge/requirements.txt`

```bash
git clone https://github.com/jiach72/agentbutler.git
cd agentbutler
corepack enable
corepack prepare pnpm@10.20.0 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm start
```

启动后访问 `http://127.0.0.1:7531`。默认服务端口：Web `7531`、Gateway `7532`、Watch `7533`。

第一次使用建议先打开 **设置** 检查运行时路径，再进入 **版本** 和 **连接** 页面确认服务状态。

`pnpm start` 会以前台并行方式启动三个服务，适合首次体验和 Agent 自动化安装。生产或长期运行建议为三个应用分别配置进程守护：

```bash
corepack pnpm --filter @butler/gateway start
corepack pnpm --filter @butler/watch start
corepack pnpm --filter @butler/web start
```

## Docker

Docker Compose 会构建并启动三个面板服务和一个内部 updater sidecar：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f
```

Compose 默认从 `.env` 读取运行时目录与通知凭据，使用命名卷 `agent-butler-data` 持久化状态，并只将 Web 的 `7531` 端口发布到宿主机回环地址。内部 updater sidecar 挂载仓库工作树和 Docker Socket，用于从管家内完成 Git 更新、构建、Compose 重启与失败回滚；Watch 对被管实例的 Docker 控制仍默认关闭，需要时才设置 `DOCKER_SOCKET_PATH=/var/run/docker.sock` 和 `DOCKER_GID`。

生产环境可直接在“版本管理”页触发管家自身更新；updater 会先备份，再拉取 Git 标签、重建镜像、重启三个面板服务并做 readiness 检查，失败自动回滚。宿主机脚本仍可用于首次部署或 updater 故障时的人工恢复：

```bash
bash scripts/deploy.sh
bash scripts/bridge-healthcheck.sh  # 启用 Hermes 时
```

容器镜像按设计不携带 `.git`；updater 通过 `BUTLER_REPOSITORY_PATH` 挂载宿主机工作树来执行自更新。默认从仓库根目录启动 Compose 时无需修改该值；如果从其他目录启动，请填写仓库绝对路径。

推荐一键部署：

```bash
git clone https://github.com/jiach72/agentbutler.git
cd agentbutler
bash scripts/deploy.sh
```

Windows PowerShell：

```powershell
git clone https://github.com/jiach72/agentbutler.git
cd agentbutler
.\scripts\deploy.ps1
```

WSL Hermes 部署请在 WSL shell 使用 `bash scripts/deploy.sh`；该路径包含 Hermes token/loopback 预检、数据卷备份门禁和 Bridge 转发器选择。PowerShell 脚本适合 Docker Desktop 或不启用 Hermes 消息数据面的场景。

首次部署前复制并检查 `.env.example` 生成的 `.env`：`BUTLER_FRAMEWORK` 选择 `hermes` 或 `openclaw`；`BUTLER_HERMES_HOST_PATH` / `BUTLER_OPENCLAW_HOST_PATH` 指向宿主机状态目录；UI 默认仅绑定 `127.0.0.1`。通知凭据可选，未配置时提醒仍写入持久化队列。

在 WSL 中使用 `bash scripts/deploy.sh` 时，如果 `BUTLER_HERMES_HOST_PATH` 仍是示例默认值 `./.runtime/hermes`，脚本会自动探测并优先使用当前 Linux 用户的 `~/.hermes`（要求其中存在 `hermes-agent` 目录）。如果 Hermes 安装在其他位置，请在 `.env` 中明确填写该路径；明确配置不会被自动探测覆盖。

### Hermes 消息连接

要让 Gateway 持续接管 Hermes 消息，先确保宿主 Hermes Bridge 已启动并使用同一份 token。Bridge 保持 loopback 监听 `127.0.0.1:8754`；WSL 原生 Docker 通过转发器接入：

- 将 `BUTLER_HERMES_HOST_PATH` 指向 Linux 侧 Hermes 目录（例如 `/home/<user>/.hermes`），其中必须存在 `agent-butler/bridge.token`；
- 设置 `BUTLER_HERMES_BRIDGE_URL=http://host.docker.internal:8755`、`BUTLER_HERMES_BRIDGE_ALLOW_NON_LOOPBACK=true`；
- 启用 `COMPOSE_PROFILES=bridge-forward`，或保留现有 systemd user 转发器，但不要同时启用两种转发器；
- Bridge 短暂离线时 Gateway 保持运行并持续重试，恢复后会自动继续同步 Outbox。部署后用 `bash scripts/bridge-healthcheck.sh` 验证实际容器链路。

```bash
curl http://127.0.0.1:7531/api/health
curl http://127.0.0.1:7531/api/messages/overview
curl http://127.0.0.1:7531/api/connections
```

`/api/connections` 属于 Web 到 Watch 的代理接口；Watch 不可达时返回 `200 {"reachable":false,"connections":[]}`，不会再把已知路由落成 404。

## 开发与验证

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm version:check
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

提交前最小检查：

```bash
docker compose config --quiet
git diff --check
```

Hermes Bridge 测试需在 Linux/WSL 运行，因为安全用例会校验 token 与附件文件的 POSIX `0600` 权限：

```bash
python -m pip install -r packages/adapters/hermes/bridge/requirements.txt
PYTHONPATH=packages/adapters/hermes/bridge python -m unittest discover -s packages/adapters/hermes/bridge/tests -q
```

## 版本管理

- 版本遵循 SemVer。
- 开发预览版使用 `x.y.z-dev.n`，Git 标签使用 `vx.y.z-dev.n`。
- 稳定版使用 `x.y.z`，Git 标签使用 `vx.y.z`。
- 版本页只向用户呈现当前版本、最新可升级版本和上一个可回滚版本。
- 发布前执行 `corepack pnpm release:check`，并按 `docs/releasing.md` 创建提交、标签和 GitHub Release。

统一修改版本号：

```bash
corepack pnpm version:set <version>
```

## 文档

- 产品定义：`PRODUCT.md`
- PRD：`docs/agent-butler-prd.html`
- PRD 符合性审计：`docs/prd-audit-report.md`
- 缺陷与修复记录：`docs/bug-fixes.md`
- 发布流程：`docs/releasing.md`
- Docker 运维手册（更新/回滚/备份/访问链路）：`docs/docker-operations.md`

## 项目状态

Agent Butler 仍处于 Beta 阶段。当前优先保证本地部署、运行时可观测性和恢复路径；公网鉴权、多租户隔离和托管版能力不在本版本承诺范围内。欢迎通过 Issue 提交复现步骤、环境信息和日志片段。

## License

MIT
