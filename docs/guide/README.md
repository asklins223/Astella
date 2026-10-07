# Astella 手册 · User & Engineer Guide

中文默认；English pages live in [`en/`](./en/overview.md)，逐页对应同一批小节。

**拾星笔记（Astella）** 是面向个人学习的 AI 原生知识系统：桌面端是一间有 Live2D 伴星坐着的书房，本地跑一套 Fastify + PostgreSQL + AI Worker 栈。这份手册写的是**这条链路上真实存在的东西**——每条命令、每个端口、每个变量名都从仓库里的文件当场核对过；写不确定的地方会直接说不确定。

## 分册

| 分册 | 讲什么 | 适合谁 |
| --- | --- | --- |
| [产品总览](./zh/overview.md) | 它解决什么问题、今天真实存在的能力、运行形态与权限边界、刻意不做的几件事 | 先读这页 |
| [系统架构](./zh/architecture.md) | 进程与包怎么分工、一次请求与一次 AI 回合走过的路、数据分组与合同 | 要动结构、要判断改动落在哪一层 |
| [开发环境](./zh/development.md) | 从干净检出到窗口跑起来：`make up` 到底做了什么、热重载、端口、卷、日常命令 | 第一次跑，或跑不起来 |
| [桌面客户端](./zh/desktop-client.md) | 单窗口书房：无路由的页面机器、目录栏与房间控制岛、Live2D 伴星、笔记与协同、设置册、源码守卫 | 改界面与交互 |
| [统一 Agent 运行时（技术）](./zh/agent-runtime.md) | 回合内核、能力目录与工具面、权限档与提案往返、上下文治理、持久化与状态词表、已接通 vs 只有后端、排障入口 | 改 Agent 与伴星的执行体 |
| [伴星体验（产品设计）](./zh/companion-experience.md) | 她为什么在、四处入口的分工、能力清单、在场与静音、持续身份、记忆与日记、成长闭环、诚实与边界 | 改她的行为与文案 |
| [API 与数据](./zh/api-and-data.md) | 模块与路由清单、会话与 CSRF 与限流、RLS 与三角色、迁移与作业队列、SSE、运维面板 | 改后端与数据 |
| [模型与 Worker 链路](./zh/ai-and-companion.md) | Worker 与作业类型、模型档案配置（`config/ai-platforms.json`）、provider 协议、思考与识图、证据封缄、语音、质量层 | 改模型链路 |
| [测试与质量](./zh/testing-and-quality.md) | 各包怎么跑测试、真库集成测试的分界、源码守卫各守什么、CI 实际跑什么与不跑什么 | 提交前 |
| [运行与发布](./zh/operations.md) | 三份 compose 的职责、变量分组、统一版本与桌面端发布、Alpha 巡检与备份恢复、监控告警口径 | 要部署或发版 |
| [常见问题与排障](./zh/faq-and-troubleshooting.md) | 现象 → 原因 → 处理，覆盖登录、端口、语音、迁移、限流、模型调用、星图空、测试跑不动 | 卡住了 |

英文对应：[overview](./en/overview.md) · [architecture](./en/architecture.md) · [development](./en/development.md) · [desktop-client](./en/desktop-client.md) · [agent-runtime](./en/agent-runtime.md) · [companion-experience](./en/companion-experience.md) · [api-and-data](./en/api-and-data.md) · [ai-and-companion](./en/ai-and-companion.md) · [testing-and-quality](./en/testing-and-quality.md) · [operations](./en/operations.md) · [faq-and-troubleshooting](./en/faq-and-troubleshooting.md)

## 三条阅读路径

- **只想跑起来自己用**：[开发环境](./zh/development.md) → [常见问题](./zh/faq-and-troubleshooting.md)。产品能力看 [总览](./zh/overview.md)，界面细节看 [桌面客户端](./zh/desktop-client.md)。
- **要改代码**：[系统架构](./zh/architecture.md) 的「想改哪儿，先看哪里」表 → 对应分册（客户端 / API / 模型链路）→ 涉及 Agent 或伴星时必读 [统一 Agent 运行时](./zh/agent-runtime.md) 与 [伴星体验](./zh/companion-experience.md) → [测试与质量](./zh/testing-and-quality.md) 的守卫与 `make verify`。
- **要部署或发版**：[运行与发布](./zh/operations.md) → [API 与数据](./zh/api-and-data.md) 的角色与迁移一节 → [模型与 Worker 链路](./zh/ai-and-companion.md) 的模型档案与同意一节。

## 这份手册与仓库根文档的关系

| 文件 | 职责 |
| --- | --- |
| [README.md](../../README.md) | 入口：是什么、怎么跑起来、手册地图 |
| [PRODUCT.md](../../PRODUCT.md) | 产品边界、用户与权限、已确认与未决定的能力 |
| [DESIGN.md](../../DESIGN.md) | 视觉方向、版面与动效原则、token 与实现参考 |
| [AGENTS.md](../../AGENTS.md) | 协作入口与工程分层约定 |
| [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) | 随包分发的第三方与 Live2D 素材许可 |
| [docs/plans/learning-companion/README.md](../plans/learning-companion/README.md) | 现行方案合同索引——「为什么这样设计」与验收状态在那里，不在本手册 |

本手册描述**现状**，不派活、不定义目标。方案文档描述**要去哪儿**。两边冲突时，以方案与 `PRODUCT.md` 的最新用户决定为准，然后回来改这份手册。

## 名称与标识

产品名 2026-10-06 定为 **Astella**，中文名 **拾星笔记**（第三次定名：`AI Learn` → 理解引擎 → Astella／拾星笔记）。两层不要混：包名、可执行文件、安装目录与产物名用 ASCII 的 `Astella`（`appId: com.asklins.astella`），窗口标题、Dock 与开始菜单显示「拾星笔记」。同日又做了两轮：第二轮换内部标识（npm scope `@astella/`、preload 桥 `window.astella`、IPC 通道 `astella.v1.`、环境变量 `ASTELLA_*`、自定义协议 `astella-app://`、Docker 项目名与派生容器/卷名、桌面包名），第三轮换存储层名字（Postgres 库名／角色／函数、MinIO 桶、Prometheus 指标名），dev 库删卷重建验过。**全仓只剩两个串仍写着 `ailearn`**：`ailearn-hash-canonical-v2` 与 `ailearn:invitation-token-hint:v1`，它们是逐字进摘要的域前缀，换它等于作废全部存量哈希。细节见 [assets/brand/README.md](../../assets/brand/README.md) 与 [运维分册](./zh/operations.md)。

## 图片

`assets/` 下的四张图由运行中的真实窗口截取（用仓库自带的 `apps/desktop-client/scripts/capture-pages-v3.mjs` 挂 CDP 驱动当前窗口），不是设计稿：首页书房、来源库、今日学习、伴星轻聊。图里出现的是本机开发库里的真实标题，换环境时它们会变。
