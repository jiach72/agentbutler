# Agent Butler

Agent Butler 是一个本地优先的 AI Agent 运维控制台。目前重点支持 Hermes，提供巡检、日志与诊断、版本升级与回滚、补丁管理、技能/插件/记忆只读盘点，以及消息队列治理。

当前版本：`0.1.0-dev.1`。这是开发预览版，默认只监听本机回环地址，管理面尚未提供公网鉴权，请勿直接暴露到不可信网络。

## 快速安装

要求：

- Git
- Node.js 22 或更高版本
- Corepack / pnpm 10.20.0
- Hermes 集成需要 Python 3.11+；Bridge 运行时依赖见 `packages/adapters/hermes/bridge/requirements.txt`

```bash
git clone https://github.com/jiach72/agentbutler.git
cd agentbutler
git checkout v0.1.0-dev.1
corepack enable
corepack prepare pnpm@10.20.0 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm start
```

启动后访问 `http://127.0.0.1:7531`。默认服务端口：Web `7531`、Gateway `7532`、Watch `7533`。

`pnpm start` 会以前台并行方式启动三个服务，适合首次体验和 Agent 自动化安装。生产或长期运行建议为三个应用分别配置进程守护：

```bash
corepack pnpm --filter @butler/gateway start
corepack pnpm --filter @butler/watch start
corepack pnpm --filter @butler/web start
```

## Docker

Docker Compose 会构建并启动三个服务：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f
```

Compose 默认把 `${HOME}/.hermes` 以只读方式挂载到 Watch 容器，并只将 Web 的 `7531` 端口发布到宿主机回环地址。Linux 上访问 Docker socket 时，可按宿主 Docker 组 ID 设置 `DOCKER_GID`。

## 开发与验证

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm version:check
corepack pnpm lint
corepack pnpm test
corepack pnpm build
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
corepack pnpm version:set 0.1.0-dev.2
```

## 文档

- 产品定义：`PRODUCT.md`
- PRD：`docs/agent-butler-prd.html`
- PRD 符合性审计：`docs/prd-audit-report.md`
- 缺陷与修复记录：`docs/bug-fixes.md`
- 发布流程：`docs/releasing.md`

## License

MIT
