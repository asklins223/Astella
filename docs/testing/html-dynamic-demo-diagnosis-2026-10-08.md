# HTML 动态演示限制排查 · 2026-10-08

后续用户已明确要求放宽全项目后台预算；本文保留首次诊断的原始条件，现行改动与复测见 [执行预算调整](ai-execution-budgets-2026-10-08.md)。

用户反馈：项目生成的 HTML 演示几乎没有动画，同一个 DeepSeek V4.1 Flash 在官方直连中表现更好，希望核对项目是否限制过多。

## 当前结论与证据范围

已经确认项目包含与网页创作无关的累积要求、轻量档误停教学动画、SVG 命名空间误判，以及较短的生成预算。它们分别影响创作目标、实际播放和成果可达性。尚未拿到用户先前的差样本与官方输出，不能把体验差异全部归因于某一句提示，也不能据此判断模型能力上限。

当前默认路由是 `opencode_go / deepseek-v4.1-flash`，任务 `note_dynamic_artifact` 映射 `agent_turn`，没有走轻任务的 GLM 模型。捕获的线上请求为 `reasoning.effort=high`、`max_output_tokens=24000`，没有发送 temperature。这条路由经过 `opencode.ai` 网关，不能把它称为 DeepSeek 官方直连。

## 调用链核对

1. `workers/ai-worker/src/handlers/note-dynamic-artifact-generate.ts`：读取冻结笔记或选区，附加统一 Agent 的目标、人格和偏好，调用共享网页提示。每次真实调用仍核对租约与父目标预算。
2. `packages/shared/src/note-dynamic-artifact/round-artifact-model.ts`：网页与元数据一起作为 JSON 返回。旧 v15 无论什么主题都附带插入排序身份、暂存值、逐帧校验、终点按钮、本地 Off 开关等要求。这些来自特定样本修补，而非每份教具所需的条件。
3. `round-artifact-doc.ts`：页面字符范围 400–120000，来源与安全检查失败时拒绝整份，不会删除脚本后交出静态替代品。允许 CSS 动画、SVG、Canvas、requestAnimationFrame、计时器和 Web Animations。此前泛扫 HTTP 地址会拒绝标准 SVG 命名空间；[SVG 标准的命名空间定义](https://www.w3.org/TR/SVG2/struct.html#Namespace)可以核对这个标识符。
4. `round-artifact-render.ts`、桌面 `artifact-surface.ts`：拆出样式和脚本组装，脚本会执行。展示使用 sandbox allow-scripts；CSP 不允许外部网络和库，但允许内联脚本与样式。应用没有把生成结果重新裁成固定教学模板。
5. `artifact-template.ts`：Full 下没有全局停止动画；reduced 下暂停 CSS、SVG、Web Animations 并调用页面自己的 setLessonMotion。笔记入口原先把 lite 和 off 都映射为 reduced。真实窗口本次观察是完整档，因此 lite 的错误不能独立解释本次用户反馈。
6. Worker 任务是 120 秒租约、110 秒 handler、约 95 秒生成循环预算，所有自动重试共用它；共享模块默认的较长时间会被 Worker 参数缩短。HTTP 出口本身默认允许 300 秒，但外层任务会先中止。

## 本次修改

- 创作提示 v16 删除全部与特定算法和固定播放器有关的细节，保留原文准确性、JSON 保存字段、安全环境和一个宿主动效接口。用画面中的运动、形变、轨迹与关系变化明确教学目标。单摆夹具提示由 2368 字符缩为 1388 字符，素材与元数据合同保留。
- Lite 保留教学动画；Off 与系统减少动态继续发送 reduced。笔记独立演示和旧轮次入口使用同一映射。
- 标准命名空间在 xmlns 声明及 createElementNS/setAttributeNS 的明确参数位置获准。作为实际 img/href 地址、追加路径的地址及其他外链仍拒绝；CSP 与隔离权限没有扩大。
- 未修改默认模型、high 推理设置、父目标预算、任务租约或持久化规则。

## 真实请求对照

使用两份合成素材（单摆、插入排序），不读取私人笔记，不创建学习事实。现有提示与精简提示保持同一生成策略、模型、推理、JSON 合同及 24000 token 上限。接近直连的对照省去系统策略与 JSON 合同，属于组合条件差异，不能单独归因于 JSON。

脚本：`workers/ai-worker/src/live-tests/dynamic-artifact-prompt-probe.ts`。冻结请求与收据在 `outputs/audits/2026-10-08-html-motion/`。不保存任何隐式推理正文或凭据。

95 秒内，两份素材各自的旧提示、精简提示和简短直出请求均超时，共六次。延长到 240 秒观察后，单摆旧提示在约 127.6 秒触及输出上限：输出 23998 token，reasoning_tokens 23998，没有最终网页；精简提示在约 107.9 秒同样触及上限：输出与推理均为 24000 token，没有最终网页。短连通性请求约 23.7 秒正常返回，返回模型仍是 deepseek-v4.1-flash。因此可以确认预算截住了这些整页请求；提示精简本身没有解决这两个样本的可达性。超时与截断样本不能当成静态页面或低创作质量样本评分。

[DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/) 将 max_output_tokens 定义为思考过程与最终回答的合计上限。这与本次收据吻合：项目的 24000 并非“还可以输出 24000 个 HTML token”。进一步扩大额度还要同步处理任务时间与租约，不能单独提高一个常量。当前预算暂未修改，也没有通过关闭思考绕开它。

本次共八次整页请求加一次短连通性请求；没有最终成品，因此不支持“精简后效果已经更好”的声明，也无法用这批样本判断官方直连与网关的质量差异。

## 验证

- 修改前相关 API 64 项、桌面 33 项通过；修改后 API 65 项、桌面 38 项、Worker 入口与锚点 12 项、预算守卫 10 项通过。
- shared、api、desktop-client、ai-worker 对应包 npm run typecheck 通过。
- 已核对真实 Electron 窗口当前完整动效档，收起检查菜单后保持原工作稿。
- 尚无生成成品的真实窗口质量验收。重生成采用新提示；已有 HTML 快照保留，不会自动被改写。
