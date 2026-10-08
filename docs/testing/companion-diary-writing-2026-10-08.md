# 伴星日记生成与校订回归

用户反馈：日记像 AI 小结、篇幅短。以本机另一账号的实际记录核对，33 篇平均 233 字、中位数 172 字，19 篇不到 200 字，23 篇只有两段。

## 这次改变的行为

- 选中片段保留完整往返和后续更正，按会话分组，再附上附近笔记事件。候选最多 16 条来源、软预算 12,000 字，保留连续的结尾，单条来源不截尾。
- 材料明确标记用户与日记作者；聊天台词不能自动扩写成亲历。素材另放在 user 消息，不混入系统指令。
- 普通片段目标 400–800 字，稀疏片段 160–320 字。聊天活跃度不再控制段落数；成稿不删尾部段落。最后一次短稿仍失败。
- 成稿内部新增对照原始片段的校订。只发布合格校订稿，原始素材派生的事实备忘不由校订正文改写。
- 选择、草稿、校订分别有检查点；提示词身份参与恢复核对。总模型调用上限七次，沿用原任务截止时间与取消机制。

## 自动验证

在 `workers/ai-worker` 运行相关单元测试：

```sh
node --import tsx --test src/handlers/__tests__/companion-daily-summary.test.ts src/handlers/__tests__/companion-diary-writing.test.ts src/lib/providers/__tests__/mock-diary-script.test.ts
npm run typecheck
```

50 个单元测试通过。覆盖茶种的提问与回答、昵称后续接受、交错会话、笔记片段的时间顺序、长来源最后的限定、完整段落与校订输入的来源隔离。图片校订只传引用编号，不传存储地址，图注标题不重复。

配置显式测试数据库环境变量后运行：

```sh
node --import tsx --test --test-concurrency=1 src/integration-tests/companion-diary-array-parameter-postgres.integration.ts src/integration-tests/companion-diary-material-original-postgres.integration.ts src/integration-tests/companion-diary-writing-postgres.integration.ts
node --import tsx --test --test-name-pattern=§6c src/integration-tests/cross-module-same-process-drill.postgres.integration.ts
```

10 个数据库测试与 1 个检查点恢复测试通过。模型返回夹具，其余沿真实数据库链路：第二次短稿失败、安静人格的五段完整保存、发布校订稿、两次短校订不退回未校订草稿、校订期间来源变化不发布也不存校订检查点、发布失败后复用三个阶段的检查点。层边界与文件体积相关 13 个守卫通过。

## 真实模型抽检及限制

用同一账号 10 月 2–5 日四个原始片段复写，当前配置为 `opencode_go / deepseek-v4.1-flash`，草稿 `diary-draft-v3`、温度 0.6，校订 `diary-revision-v2`、温度 0.3，沿用平台模型档案。最终四篇 503、590、741、640 字，各四到五段；校订一次通过篇幅与结构核对。

这轮纠正了茶的归属、昵称接受过程和后续解释被裁掉的问题。人工阅读仍发现部分措辞分析过多，以及角色台词被当作亲历的模糊表达；不能据此宣称“AI 味”或事实错误已完全消失。校订也由模型完成，不替代真实素材抽检。

实际素材、历史正文及新稿对照放在被忽略的 `outputs/companion-diary-20261008/`，不将账号 ID、邮箱、原始对话或凭据提交进仓库。来源库以只读副本调查，历史日记没有覆盖。已确认开发 Worker 挂载并读取新版本；本次未在真实日记窗口发布这四篇复写作品，也未做整周文风验收。
