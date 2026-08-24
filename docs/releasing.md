# 发布规范

## 版本规则

- 使用 SemVer：`MAJOR.MINOR.PATCH`。
- 开发预览：`MAJOR.MINOR.PATCH-dev.N`，例如 `0.1.0-dev.2`。
- 候选版本：`MAJOR.MINOR.PATCH-rc.N`。
- Git 标签始终添加 `v` 前缀，例如 `v0.1.0-dev.2`。
- `main` 只接收通过发布检查的提交；不得强推已发布标签。

## 发布步骤

1. 确认工作区只包含本次发布内容，检查 `.gitignore` 与秘密扫描结果。
2. 运行 `corepack pnpm version:set <version>`，同步所有 workspace、运行时和适配器版本。
3. 把版本变化写入 `CHANGELOG.md`，日期使用实际发布日期。
4. 运行 `corepack pnpm release:check`。
5. 在 Linux/WSL 运行 Hermes Bridge Python 测试；该测试会校验 POSIX `0600` 权限。
6. 提交发布变更：`git commit -m "chore(release): v<version>"`。
7. 创建带说明的标签：`git tag -a v<version> -m "Agent Butler v<version>"`。
8. 推送 `main` 和标签，再创建 GitHub Release；`dev`、`alpha`、`beta`、`rc` 标签标记为 prerelease。
9. 从全新目录按 README 的 tag 安装命令复验一次。

## 回滚原则

- 不移动或复用已发布标签；修复后发布新的补丁号或预发布序号。
- 产品页面只显示一个“上一版本”恢复点，降低误操作面。
- 自升级前必须完成全量备份；构建、重启或健康验收失败时自动切回升级前提交。

## 发布检查清单

```bash
corepack pnpm version:check
corepack pnpm lint
corepack pnpm test
corepack pnpm build
git diff --check
```

Bridge 测试：

```bash
python -m pip install -r packages/adapters/hermes/bridge/requirements.txt
PYTHONPATH=packages/adapters/hermes/bridge python -m unittest discover -s packages/adapters/hermes/bridge/tests -q
```
