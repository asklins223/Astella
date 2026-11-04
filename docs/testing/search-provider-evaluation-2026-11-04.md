# 免费搜索方案与 Tavily 接入

2026-11-04。用户确认 GLM 搜索已达额度上限，要求寻找免费方案，随后提供 Tavily Key 并授权接入。聊天模型保持 MiMo + DeepSeek。

## 调研与实测

| 方案 | 官方免费条件 | 本次结论 |
| --- | --- | --- |
| Tavily | 每月 1,000 积分，无需绑卡；basic 为 1 积分 / 请求 | 实际 Key 账户为 Researcher，额度 1,000。选为正式搜索源。 |
| SearXNG 自建 | 自由软件，支持 HTTP / JSON 搜索；仍需服务器与上游可用性维护 | 本地三次查询无结果；服务器单次 NASA 查询 1.286 秒、36 条结果，Google 源仍拒绝访问。仅做可用性探针，未当成长期稳定性验收，临时服务已移除。 |
| Serper | 官网提供 2,500 免费查询，无需绑卡 | 可作试用备选，未视为可持续每月免费额度，本次未开通或调用。 |

来源：[Tavily 额度](https://docs.tavily.com/documentation/api-credits)、[Tavily 定价](https://www.tavily.com/pricing)、[SearXNG](https://docs.searxng.org/user/about.html)、[JSON API](https://docs.searxng.org/dev/search_api.html)、[自建与公开实例限制](https://docs.searxng.org/own-instance.html)、[Serper](https://serper.dev/)。

Tavily 单接口初次探针：本地 3.434 秒、服务器 0.824 秒，均返回 5 条 NASA 来源，响应 usage 为 1 积分。它们只是搜索接口测量，不等于完整 Agent 回复耗时。SearXNG 的本地与服务器语言参数、出口环境不同，也不作为同条件速度比较；未破解验证码或切换代理绕过上游限制。

## 接入约束

- 搜索与聊天模型配置独立；Tavily Key 只保存于私有服务端环境，未写入代码、版本说明、前端或验收数据。
- 使用 `basic`，显式关闭 `auto_parameters`、生成答案与原文抽取选项；现有宿主继续并发读取真实网页，不新增额外计费接口。
- 保留用户开关、外发授权、来源身份、域名限制、网页读取边界和取消机制。搜索摘要只是定位材料，必须有真实读取回执才能引用。
- 432 / 433 额度错误按凭据冷却；429 临时限流不误判为半小时额度耗尽。不会自动改用另一账号或付费后备服务。
- Compose 显式传递 `WEB_SEARCH_PROVIDER` 与 `TAVILY_API_KEY`；现有 BigModel 配置仍可显式选择，但本次运行配置选择 Tavily。

验证覆盖配置缺失时不借用其他账号、端点与基础请求、禁止自动升档、稳定引用与域名过滤、摘要不冒充原文、密钥不进审计、额度与临时限流区分、取消和禁止自动跨账号回退。

完整链路测量与部署状态见 [Agent 验收](agent-source-review-performance-2026-11-04.md)。
