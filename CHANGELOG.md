# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)；开发预览版本可能包含不兼容调整。

## [Unreleased]

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

[Unreleased]: https://github.com/jiach72/agentbutler/compare/v1.0.0-beta.7...HEAD
[1.0.0-beta.7]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.7
[1.0.0-beta.6]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.6
[1.0.0-beta.2]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.2
[1.0.0-beta.1]: https://github.com/jiach72/agentbutler/releases/tag/v1.0.0-beta.1
[0.1.0-dev.2]: https://github.com/jiach72/agentbutler/releases/tag/v0.1.0-dev.2
[0.1.0-dev.1]: https://github.com/jiach72/agentbutler/releases/tag/v0.1.0-dev.1
