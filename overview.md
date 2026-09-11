# Agent Butler「信任层」升级实施总览（2026-09-11）

> 依据 `docs/trust-layer-upgrade-plan-2026-09-11.md`，在保留全部现有功能的前提下，**全部四个里程碑（M1-M4）已落地**。
> 实施明细见 `docs/trust-layer-implementation-2026-09-11.md`（§1-§12）；逐条变更见 `CHANGELOG.md`。

## 完成内容

### M1 信任基建
1. **成本中枢（M1.1）**：`/api/llm/usage` 成本字段（防御式探测计费列，缺失显式「待接入」）；`/api/llm/cost/summary` 三维聚合 + 最贵会话 TOP10 + `monthToDateCost`。
2. **预算引擎（M1.1）**：月度预算 15 分钟核算，80% warn / 100% critical（防重放）+ 事件；动作首版为建议 + 记录。
3. **行为审计流（M1.2）**：增量解析执行日志 → 6 类结构化动作；高危红标；凭据脱敏；**不存对话正文**。
4. **全局急停（M1.3-面板）**：engage = 快照 → 能力路由停实例 → crash-safe 落库 → 三路留痕；engage 期拒绝重连与升级。
5. **通道口令急停（M1.3-通道）**：通道里发「<口令> 急停/恢复/状态」远程急停。口令未配置即功能关闭；只认显式动词；可配会话白名单；执行桥接到 Watch 既有 killswitch（复用全套留痕）并回执。

### M2 洞察升级
6. **Agent 周报（M2.1）**：周一 08:00 幂等生成 + 推送；零 LLM；留存 12 周；`/report` 页。
7. **事件中心（M2.2）**：统一事件 + 状态机（regressed 回归一等公民）+ R1 升级疑似回归关联规则。
8. **会话追踪（M2.3）**：会话索引 + 四条异常规则 + `/sessions/:id` 时间线回放；数据缺失显式降级不编造。

### M3 省心闭环
9. **通知即操作（M3.1）**：高危动作 → 带按钮卡片 → 批准/拒绝。**超时 15 分钟默认拒绝**（踩点批准也按拒绝）；**同一动作 24h 第 3 次升级**为需面板确认（通道侧放行被拒、拒绝仍放行）；四类动作全留痕。Telegram inline_keyboard + webhook 回执桥接；不支持内联按钮的通道降级为 Web 确认链接。
10. **升级金丝雀（M3.2）**：真实会话抽样（10 常规 + 全部失败）→ 影子验证 → 三指标准入（成功率 ≤5pp / token ≤15% / 无新增 error 指纹，**缺数据一律不通过**）→ 观察窗（24h/48h）内检出回归自动回滚（成败按子步骤判定）。策略三档：激进跳过 / 标准（未验证放行 + 告警）/ 保守（未验证拦截）。影子执行器为注入端口，**绝不伪造「验证通过」**。
11. **假进度检测（M3.3，差异化王牌）**：进度声明与同会话副作用动作对账 → verified / suspect / **unverifiable**（显式「无法验证」，绝不猜）。连续 ≥3 次 suspect → 事件点名；终态 ok 零副作用 → `unverified-completion`。**可信度分母只含 verified+suspect**。`/progress` 页 + 会话时间线 ✓/？ 节点 + 周报点名。

### M4 触达扩张
12. **移动端（M4.1）**：PWA manifest + 添加到主屏；≤600px 底部 Tab（周报/事件/成本/急停，急停红底强化）；单列重排 + 安全区。
13. **安装医生（M4.2）**：`node scripts/doctor.mjs` 十项只读体检（环境/端口/网关/Bridge/.env 安全自检），三态结论 + 修复命令 + 脱敏可分享。本机实测 0 失败 / 3 注意。
14. **记忆可视化（M4.3）**：`/memory-diff` 本周 added/modified/forgotten（删除后未再写=遗忘）；口径与边界显式声明；周报「本周它记住了什么 TOP5」。
15. **多实例联邦（M4.4）**：`/federation` 实例级成本/token/会话聚合 + 分组（工作/实验/沙箱）+ **急停覆盖性**（覆盖不全显式警示）+ 孤儿会话单列不摊派。

### 数据模型
butler 库累计新增 10 表：`budget_state` / `killswitch_log` / `action_events` / `trust_events` / `report_history` / `session_index` / `action_approvals` / `canary_runs` / `runtime_settings` / `progress_claims`；gateway `alerts` 补 `actions_json`。全部幂等 DDL + 老库 ALTER 兼容。

### 前端与代理
信任层导航组 10 页：`/cost` `/audit` `/events` `/report` `/sessions(/:id)` `/approvals(/:id)` `/canary` `/progress` `/memory-diff` `/federation` + 顶栏急停 + 移动端底部 Tab；BFF 全量透传。

## 质量验证
- `tsc -b` 全仓 **0 错误**；UI `vite build` 通过。
- 信任层测试全绿（本日累计）：`trust-layer` 20/20、`weekly-report` 8/8、`session-index` 13/13、`approvals` 25/25、`canary` 31/31、`shadow-runner` 9/9、`progress-integrity` 22/22、`m4-outreach` 11/11、gateway `killswitch-command` 25/25（含 M1.3 口令解析与 M3.1 卡片契约）——合计 **164/164**；gateway `queue/channels/loop/http` 回归通过。
- 全仓回归的存量失败（`createWatchApp` 组装 15s 超时——本机实测 17.7s 耗时来自 wslpath/git 子进程、`self-upgrade` 依赖真实 git）与本批次无关：M1 基线即为同类 26 失败，相关测试文件本批次未改动。
- `doctor.mjs` 本机实测通过（0 失败 / 3 注意，正确识别 WSL 挂载路径差异）。

## 关键修复（本批次发现）
1. `insertCanaryRun` 漏写 `rollbackSnapshotId` → 观察窗守卫永远走「无快照」分支（已补字段）。
2. 金丝雀抽样任务以字符串落库但视图按对象解析 → UI 显示恒空（改为完整对象）。
3. 口令急停中文动词正则误用 `\b`（中文非 `\w`，永不匹配）→ 恢复指令全部失效（词边界只加拉丁分支）。
4. （此前批次）生产装配漏注信任层服务导致 503；M3.1 指纹兜底误用 actionId 致升级规则失效——均已修。

## 已知事项
1. **影子执行器已接线（`shadow-runner.ts`）**：隔离 venv + 真实端点冒烟回放；模型端点未配置时仍按策略诚实降级。回放为等价冒烟任务（历史 prompt 不存档是隐私红线），口径写入 `metrics.source`。
2. **Telegram webhook 需公网可达**；未配置时审批卡片与口令急停走降级路径（Web 确认页 / 面板）。
3. M2.3 两条工具级异常规则与全量回放仍**未实现**（Hermes 无源数据；隐私红线禁采正文）。
4. git 仓库对象库损坏依旧：无法提交，建议 `git fsck` 或重克隆。
5. 移动端布局与 Telegram 真机链路属人工验收项（构建与逻辑测试已覆盖）。

## 关键文件
- 实施记录：`docs/trust-layer-implementation-2026-09-11.md`（§10 M3.1、§11 M3.2/M3.3/M1.3、§12 M4）
- 变更记录：`CHANGELOG.md`
- 新增服务：`apps/watch/src/{budget,action-audit,killswitch,trust-events,weekly-report,session-index,approvals,canary,progress-integrity,memory-diff,federation}.ts`
- 新增页面：`ui/src/pages/{cost,audit,events,report,sessions,approvals,canary,progress,memory,federation}/`、`ui/src/components/{KillSwitchButton,MobileTabBar}.tsx`
- 新增工具：`scripts/doctor.mjs`
