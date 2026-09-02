# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)；开发预览版本可能包含不兼容调整。

## [Unreleased]

## [1.0.0-beta.22] - 2026-09-02

### Added

- 首页「本机运行就绪度」新增两张信息卡：「Agent 主机状态」（CPU/内存/磁盘/uptime，GPU 可选显示，多实例 Tab 切换，含各 agent 进程资源）与「管家运行指标」（巡检耗时与 14 天走势、连接响应延迟、记忆探针耗时、各服务健康检查延迟）。
- 重复问题支持一键处置：「复制求助提示词」与「转发给智能体」（新 `/api/agent-message`，经 Hermes api_server 聊天接口，回复直接展示在面板）。

### Fixed

- 消息整理「对照历史」收敛：单条默认折叠为摘要、按日期快筛、分页显示，不再无限展开；轮询降频。
- 「提示词版本管理」状态去错误化：文件被手动修改等正常状态不再显示为红色错误。
- 首页连接检查项改为一行紧凑排布（悬停查看详情），节省空间。
- `/api/health` 增加各服务健康检查延迟（latencyMs）。

## [1.0.0-beta.21] - 2026-09-02

### Fixed

- 消息网关队头永久阻塞修复：投递尝试超限的消息在取消时若残留旧的待重放决策，会导致每一轮投递循环失败、后续所有回复无法送达。现在取消与任务保持路径会先清理被取代的旧决策。

## [1.0.0-beta.20] - 2026-09-02

### Added

- 消息通知页新增一键接管开关：关闭后 Hermes 原通道直发（记录仍保留），Bridge 离线时切换保持待生效、重连后自动生效。
- 新增国内 IM「通讯工具」卡片，集中展示微信/QQ 机器人/腾讯元宝/飞书/钉钉/企业微信的连接与登录状态。
- 支持微信扫码登录，扫码状态在面板内实时展示。
- 支持通道启停与凭据型通道的首次接入配置：写入前自动备份 Hermes 配置，启停经优雅重启生效。
- 部署备份排除数据卷内备份目录并提供保留策略（`BUTLER_BACKUP_KEEP`，默认 4 份），抑制磁盘增长。

### Fixed

- 通道启停改写 Hermes 实际读取的 `enabled` 键（此前写入的 `disabled` 键不生效），并对齐 QQ 机器人（`client_secret`）与元宝（`app_id`/`app_secret`）凭据字段；通道目录按 env 强制启用判定展示真实状态。
- 原通道（passthrough）直发失败的消息现在正确落 `dead_letter`，不再永久滞留 `delivering`。
- 通道配置写入保持 `config.yaml` 与备份文件的 0600 权限基线。
- 消息策略安装全链路串行化：快速切换接管不再产生状态竞争，Bridge 离线期间的切换在恢复后自动清账生效。
- 网关启动期策略安装失败降级为周期重试，不再进入容器崩溃循环。
- Bridge 投递状态跳变分配新变更序列号，消除面板消息永久停留在「发送中」。
- 编辑消息引发的内容哈希冲突改为对账恢复，不再阻塞整个消息队列处理。
- 消息明细列表与详情两栏固定等高并内部滚动；通道操作与扫码弹窗补充错误提示、断连重试与会话泄漏修复。

## [1.0.0-beta.17] - 2026-08-31

### Added

- 核心 Markdown 文件中心：支持固定文件发现、只读保护、修改前 Diff、版本历史、备份与冲突检测。
- 自进化分析与运维诊断页面，补充技能资产安装、升级兼容性和消息通道重连能力。

### Changed

- 统一控制台视觉层级、响应式布局和图表表现，优化首次使用与跨页面操作体验。
- 本机从 `localhost` / `127.0.0.1` 访问 Web 面板时免查口令；跨设备访问继续要求管理员口令。

### Fixed

- 改善 GitHub 技能下载限流错误分类、备份门禁、原子写入和操作锁，避免错误提示误导或并发覆盖。

## [1.0.0-beta.16] - 2026-08-30

### Fixed

- 修复 Hermes Bridge 已将旧终态消息吸收后，Gateway 重放旧决策返回 `409 already terminal`，导致队列头阻塞、微信最终报告停留在 `captured` 的问题。
- Gateway 现在会自动同步 Bridge 已确认的 `delivered/absorbed/dead_letter/cancelled` 终态，并清理过期 pending 决策，后续消息可继续投递。

## [1.0.0-beta.15] - 2026-08-30

### Added

- 微信任务消息统一进入 Hermes Bridge Outbox，任务执行期间仅发送一次“已收到，任务完成后汇报。”回执，进度消息保留在站内时间线。
- 任务终态前等待 `done/failed`，使用现有 OpenAI-compatible LLM 生成“结论、已完成、异常、下一步”四段式中文报告；总结失败时自动回退原始最终结果并记录脱敏原因。
- 同一任务的重复 final/failure 结果只保留首条 canonical 消息；无 `runId` 的微信系统/告警/主动通知按聊天 120 秒窗口汇总。
- 消息详情新增等待终态、生成总结、原始结果回退与总结失败原因状态展示。

### Fixed

- 修复任务仍在运行时提前写入 `completing`、导致最终结果过早投递的问题。
- 修复微信进度消息和重复终态结果可能直接外发、造成断流与重复通知的问题。

## [1.0.0-beta.12] - 2026-08-28

### Added

- 增加 Hermes 外部协助改进工作台与技能资产中心，支持提案验证、使用统计和隔离安装流程。
- 同步所有服务、适配器、Bridge 与 updater 版本，便于本地验证管家自动更新。

## [1.0.0-beta.10] - 2026-08-28

### Fixed

- 修复统一版本脚本遗漏 Watch/Gateway 运行时版本常量的问题，确保三项服务启动后报告同一版本。

## [1.0.0-beta.8] - 2026-08-28

### Added

- Hermes WSL 自我进化闭环：真实运行时编排、预检、日志诊断、候选评估、人工采用、取消与安全阻断。
- 进化、网关、技能和版本页面统一接入真实图表数据，并增加无数据、接口错误和版本不同步状态。

### Fixed

- 修复 API Key 失效、模型端点错误和任务崩溃无法及时发现的问题；告警脱敏并按去重键合并。
- 修复 Web、Watch、Gateway 实例版本不同步及投递历史图表接口不可用的问题。

## [1.0.0-beta.7] - 2026-08-26

### Added

- 右上角重要通知中心，支持未读徽标、单条/全部标记已读和通知偏好。
- 左侧导航新增常规设置入口，主题与通知偏好会保存在当前浏览器。
- 新增 updater sidecar：生产容器可从管家内拉取 Git、构建、重启 Compose，并在失败后自动回滚。

### Fixed

- 告警队列增加 `read_at` 迁移与已读 API，旧数据库可平滑启动。
- 首页与通知轮询禁用浏览器缓存，手动刷新可读取最新消息网关状态。
- 容器自更新不再提示必须在宿主机手动执行部署脚本。

## [1.0.0-beta.6] - 2026-08-26

### Improved

- Agent Butler UI 支持「纸墨管家」亮色与「墨青夜灯」暗色主题，首屏读取系统偏好并持久化用户选择。
- 重构响应式导航与顶栏：移动端使用 Drawer，桌面端显示当前页面标题和主题切换入口。
- 拆分 UI 样式层，统一主题 token、键盘焦点环、动效时长与 `prefers-reduced-motion` 支持。

### Fixed

- 修复主题入口引用旧 API 导致的 TypeScript/Vite 构建失败。

## [1.0.0-beta.2] - 2026-08-25

### Added

- Dashboard 恢复诊断与分级修复：探测、索引重建、消息重连、网关清理和实例重启按风险执行并复验。
- Evolution 真实外部评估入口，返回样本数、指标、置信度和安全门禁结论。

### Improved

- 技能/插件按分类折叠并限制滚动区域，记忆预览独立滚动。
- 版本页按目标实例比较候选版本，无候选或不可达时显示明确原因和重新检查入口。
- 进化页优先真实评估，手工指标仅保留为旧评估器兼容入口；关键状态统一使用 Ant Design 反馈组件。

## [1.0.0-beta.1] - 2026-08-25

### Added

- Ant Design UI 组件与 Hermes/OpenClaw 连接状态、消息状态面板。
- Gateway 自动接入 Hermes Bridge，Bridge 短暂断线后持续重试并自动恢复。
- Web `/api/connections` 代理、健康检查和消息降级路径。

### Fixed

- 修复部署后 `/api/connections` 落到 Web 404 的问题。
- 修复消息运行时未接入默认 Gateway、Compose 缺少 Bridge 配置的问题。
- Docker 默认配置补齐宿主 Bridge 映射、token 路径和消息投影库路径。

### Known Limitations

- 这是 1.0 测试版，管理面仍未提供公网鉴权。
- 真实 Hermes Bridge/token 和消息通道仍需在目标环境完成现场验收。

## [0.1.0-dev.2] - 2026-08-24

### Fixed

- `pnpm test` 会先构建 TypeScript workspace，干净检出不再依赖本地遗留的 `dist/`。
- Hermes Bridge 正式声明 PyYAML 运行依赖，干净 Python 环境可解析自定义 provider 配置。

## [0.1.0-dev.1] - 2026-08-24

### Added

- 本地 Web 控制台、Watch 巡检服务与持久消息 Gateway。
- Hermes 实例探测、健康检查、日志与诊断、补丁和版本管理。
- 升级前备份、失败自动回滚，以及管家自身升级流程。
- 技能、插件和记忆资产的只读盘点与健康分析。
- 消息节流、聚合、投递状态管理及旧问题回答淘汰机制。
- Dashboard 巡检、页面加载、实例升级与回滚的可见进度反馈。

### Security

- 管理服务默认绑定回环地址；本机状态、浏览器资料、缓存、数据库和密钥文件不进入版本库。
- 记忆写操作在 V1 默认关闭，敏感写动作要求快照与审计。

### Known Limitations

- 当前为开发预览版，管理面没有公网鉴权能力。
- Hermes Bridge 需要在目标 Hermes 环境中单独安装和接线。
- 真实消息通道、升级与回滚应先在隔离环境验证。

[Unreleased]: https://github.com/jiach72/agentbutler/compare/v1.0.0-beta.17...HEAD
[1.0.0-beta.17]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.17
[1.0.0-beta.16]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.16
[1.0.0-beta.15]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.15
[1.0.0-beta.12]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.12
[1.0.0-beta.7]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.7
[1.0.0-beta.6]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.6
[1.0.0-beta.2]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.2
[1.0.0-beta.1]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.1
[0.1.0-dev.2]: https://github.com/jiach72/agentbutler/releases/tag/v0.1.0-dev.2
[0.1.0-dev.1]: https://github.com/jiach72/agentbutler/releases/tag/v0.1.0-dev.1
