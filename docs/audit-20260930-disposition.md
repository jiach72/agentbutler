# 审计处置记录 — 2026-09-30

对应审计报告：`agentbutler-20260930.md`（严重 2 / 中等 15 / 建议 17）。
全部结论经逐项代码复核后处置；每项一个小步原子提交。

## 一、严重（2/2 已修复）

| # | 结论 | 处置 | 提交 |
|---|---|---|---|
| 严重-1 | 自进化守门器接受调用方自报指标并签发写令牌 | `recordResult`（HTTP 手动通道）一律不签发 `writeAuthority`；删除 `promoteArtifact`，非 WSL `promoteRun` fail-closed。写授权只可能来自受信的 WSL 隔离运行评估链路（服务端读 metrics.json、路径取自台账、python 二次校验、令牌一次性）。新增回归测试与 WSL 受信链路端到端测试 | 6c8eeb8 |
| 严重-2 | 审批升级单 `source` 字段可伪造 | 新增窄凭据 `BUTLER_PANEL_DECISION_TOKEN`（仅注入 butler-web / butler-watch）；watch 端 `allowEscalatedInline` 一律取 `panelDecisionAuthorized(req)`（校验 `x-butler-panel-decision` 头），绝不信任 body；`bulkDecide` 由无条件放行改为显式透传。deploy.sh / deploy.ps1 自动生成，updater 对旧 .env 补生成。未配置凭据时 fail-closed（升级单保持「需面板确认」） | 49c5865 |

## 二、中等（15/15 已修复）

| # | 结论 | 处置 | 提交 |
|---|---|---|---|
| 中等-1 | backups.ts 代理路径漏编码 | 补 `encodeURIComponent`，与其余 40+ 代理路由一致 | ab7533a |
| 中等-2 | .env 同步值未转义 | `saveCredential` 拒绝引号/反斜杠/控制字符；`syncToHermesEnv` 统一 dotenv 转义、存量控制字符值跳过落盘 | 917d734 |
| 中等-3 | 升级链无完整性校验 | watch/updater 升级与回滚记录 checkout 前后 HEAD SHA（状态文件+审计+UI toast/失败提示）；http(s) 源且配置 `BUTLER_REPOSITORY_URL` 时校验 origin 一致，审计 URL 剥离 userinfo。GPG tag 校验因容器无公钥环暂不引入（见文档） | 40a2d0f |
| 中等-4 | self-upgrade target 白名单缺失 | `resolveTarget` 套用与 updater 相同的 `SAFE_TARGET` 白名单（≤200，不以 `-` 开头） | 86bdc01 |
| 中等-5 | openclaw version 未校验 | 升级目标强制 semver 形态，`npm install openclaw@<远程引用>` 入口封死 | ad3a20d |
| 中等-6 | killswitch engage 并发竞态 | engage/release 共用 promise 串行队列，状态迁移排队执行 | 5842c35 |
| 中等-7 | BackupService.run 无互斥 | run/restore 共用 `withManagedOperationLock("backup.run")`（1h 上限）；restore 内部走 `runInternal` 防自锁 | 3c3ce0e |
| 中等-8 | restore TOCTOU | 还原前备份完成、回写前二次检查 Hermes 进程，命中 fail-closed | cf2ab0a |
| 中等-9 | canary blocked 拦不住升级 | `upgradeWithBackup.startUpgrade` 放行前查同实例同版本 blocked run，命中拒绝（`canary-blocked` → HTTP 403），UI 有明确提示与处置指引 | 7d7d569 |
| 中等-10 | 技能扫描只看 SKILL.md | 新增 `inspectSkillBundle`：暂存与复检均扫描包内全部文本/脚本文件（512KB/200 文件上限）；文案改「基础风险初筛（非安全审计）」 | 22cdaa7 |
| 中等-11 | external-evolution 验证文案失实 | 通过文案改「静态关键词初筛（非沙箱执行验证）」；黑名单补 wget 管道/bash -c/eval/管道 python3 | 16678ae |
| 中等-12 | SkillHub 下载无完整性校验 | 先查 Content-Length 再读体；重定向后最终地址必须 https。哈希签名体系属平台侧设计，维持信任平台并已在注释声明 | 32db215 |
| 中等-13 | alerts 队列无界增长 | 30 天保留期清理（构造时清存量 + enqueue 内 6h 节流），kind/title/body/source/dedupeKey 长度上限 | 4986aa2 |
| 中等-14 | 重操作端点缺限流 | `knowledge/start`、`knowledge/embedding/pull`、`ollama/pull` 限 5/min；`butler/self/upgrade` 限 3/min | 0f8379f |
| 中等-15 | RAG 容器 SYS_ADMIN | 默认移除并注释原因与启用条件（上游建议多为其内嵌 Chromium 抓取沙箱；确需再手动开启） | 3ed6280 |

## 三、建议（17 条处置）

**已修复（14）：**

| # | 处置 | 提交 |
|---|---|---|
| S-1 | SQLite 状态库建库后 chmod 0600（父目录 0700） | 1344429 |
| S-2 | `listUpdates` 加 30s TTL 缓存 + 强刷失效，轮询不再每次同步 git；完全异步化留作演进 | 66eff7a |
| S-3 | atomic-write 父目录按 0700 创建 | 1bf49a3 |
| S-4 | 公网 http 模型端点保存时拒绝（insecure-llm-endpoint），内网/loopback/容器名不受限 | 1a767fd |
| S-6 | obsidian/sync 落点补 `isInsideRoot` | bfed314 |
| S-7 | ws ticket 仅 `/ws` 握手路径消费 | bfed314 |
| S-8 | Host 头含 `@`（userinfo）直接拒绝 | bfed314 |
| S-9 | `/api/memory` 代理 query 收敛为 `instanceId` 白名单 | bfed314 |
| S-10 | ollama usage days/limit 非有限值回落默认，不再 500 | bfed314 |
| S-11 | inbox 入库复制前建目标目录，错误不再被静默吞掉 | bfed314 |
| S-12 | 去掉 docker compose spawn 的 `shell: true` | bfed314 |
| S-13 | nvidia-smi 探测改 execFile 异步版 | bfed314 |
| S-14 | 调度器 `nextAt` 钳制到不早于当前时间 | bfed314 |
| S-15 | approvals 并发结算行非空断言改 undefined 回退 | bfed314 |

**处置决定（3）：**

- **S-5 主密钥轮换**：暂不实现。轮换要求全库密文 re-encrypt + keyVersion 迁移，属于需要独立设计与回归的 Feature（且现有红线「严禁轮换」与「不轮换即安全」的当前模型一致）。在实现前，主密钥泄露的处置仍是「按事故流程重建凭据库」。已列入后续演进项。
- **S-16 federation 命名**：不重命名（对外 API/文档已稳定）；已在 `federation.ts` 头部补边界澄清——仅本地聚合视图，无跨实例网络通道。
- **S-17 超大文件拆分**：接受为技术债，不在本次审计修复中做纯重构（会污染安全修复的 diff 可审性）。建议按 knowledge.ts（上传/检索/同步）、gateway/server.ts（路由/通道/循环）分批拆分，每批独立 PR 跑全量回归。

## 四、验证

- 每项修复提交前：`tsc -b` 通过、相关包 vitest 通过、改动文件 eslint 通过。
- 最终验收：`pnpm lint && pnpm test` 全量执行（见 CI）。
- 测试环境备注：Windows 本机全量跑 watch 装配冒烟测试偶发 15s 超时抖动（干净树同样复现，与本次改动无关；CI Linux 环境正常）。
