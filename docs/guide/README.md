# Astella 使用与开发手册

[中文 README](../../README.md) · [English README](../../README.en.md)

本手册介绍拾星笔记的使用路径、工程结构和运行方式。中文与英文按主题对应；功能状态核对于 **2026-10-08**，后续配置、命令与接口以对应源码为准。分册中的历史验证记录只说明当时覆盖的范围，不代表当前构建已经整体验收。

## 按主题阅读

| 主题 | 中文 | English | 内容 |
| --- | --- | --- | --- |
| 产品 | [产品总览](zh/overview.md) | [Overview](en/overview.md) | 学习路径、功能与权限边界 |
| 首次启动 | [开发环境](zh/development.md) | [Development](en/development.md) | 本机配置、开发账号、热重载与端口 |
| 桌面界面 | [桌面客户端](zh/desktop-client.md) | [Desktop client](en/desktop-client.md) | 笔记、全屏、批注、导航与设置 |
| Agent | [统一运行时](zh/agent-runtime.md) | [Agent runtime](en/agent-runtime.md) | 内核、能力、权限、回执与上下文 |
| 伴星 | [伴星体验](zh/companion-experience.md) | [Companion experience](en/companion-experience.md) | 对话、写笔记、联网引用、语音、记忆与日记 |
| 工程结构 | [系统架构](zh/architecture.md) | [Architecture](en/architecture.md) | 进程、包与调用链 |
| 后端与数据 | [API 与数据](zh/api-and-data.md) | [API and data](en/api-and-data.md) | 路由、鉴权、RLS、迁移与存储 |
| 模型链路 | [模型与 Worker](zh/ai-and-companion.md) | [AI and Worker](en/ai-and-companion.md) | 模型档案、搜索、生成预算与续租 |
| 验证 | [测试与质量](zh/testing-and-quality.md) | [Testing and quality](en/testing-and-quality.md) | 单测、实库、守卫、CI 与窗口检查 |
| 运维 | [运行与发布](zh/operations.md) | [Operations](en/operations.md) | 版本、备份、监控与配置 |
| 部署 | [服务器部署](zh/deployment.md) | [Server deployment](en/deployment.md) | Tag、GHCR、HTTPS、远程对象存储与回退 |
| 排障 | [常见问题](zh/faq-and-troubleshooting.md) | [Troubleshooting](en/faq-and-troubleshooting.md) | 现象、定位与处理 |

## 推荐路径

- **先用起来**：总览 → 开发环境 → 桌面客户端，出问题时查排障。
- **修改代码**：架构 → 对应领域分册 → 测试与质量；涉及对话或后台任务时再读 Agent 与模型链路。
- **部署与发版**：服务器部署 → 运行与发布 → API 的角色和迁移说明。

本机开发连接回环 API 并使用 MinIO；安装包也可连接远程 HTTPS API，正式部署使用远程私有 S3。不要将开发默认值直接当作服务器配置。

## 根文档与方案

| 文档 | 用途 |
| --- | --- |
| [README.md](../../README.md) | 项目介绍、快速开始与手册地图 |
| [PRODUCT.md](../../PRODUCT.md) | 最新产品决定、用户与权限边界 |
| [DESIGN.md](../../DESIGN.md) | 视觉、版面与交互方向 |
| [AGENTS.md](../../AGENTS.md) | 项目协作与工程分层约定 |
| [方案索引](../plans/learning-companion/README.md) | 设计依据、实施与验收入口 |
| [第三方声明](../../THIRD_PARTY_NOTICES.md) | SDK、模型与素材许可；源码许可见 [LICENSE](../../LICENSE) |

用户的新决定优先于旧方案。手册描述现有行为，方案说明设计与目标；两者冲突时，先核对最新决定、代码和实际运行结果，再修正相关文档。

## 名称与图片

产品名为 **Astella／拾星笔记**。包名、安装目录和产物使用 ASCII 标识，中文名称用于窗口、Dock 和开始菜单；内部约定包括 `@astella/`、`ASTELLA_*`、`astella.v1.*` 和 `astella-app://`。旧哈希域前缀不应仅为改名而修改，名称与品牌素材见 [品牌说明](../../assets/brand/README.md)。

`assets/` 中的产品截图来自实际开发窗口，可能包含开发库内容。截图展示特定页面与状态，不能替代连续操作、缩放、键盘、减少动态或保存失败路径的验证。
