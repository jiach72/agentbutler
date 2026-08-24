# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)；开发预览版本可能包含不兼容调整。

## [Unreleased]

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

[Unreleased]: https://github.com/jiach72/agentbutler/compare/v0.1.0-dev.2...HEAD
[0.1.0-dev.2]: https://github.com/jiach72/agentbutler/releases/tag/v0.1.0-dev.2
[0.1.0-dev.1]: https://github.com/jiach72/agentbutler/releases/tag/v0.1.0-dev.1
