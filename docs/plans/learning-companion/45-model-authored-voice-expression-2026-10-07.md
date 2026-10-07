# 45 · 模型驱动的伴星声音表达

2026-10-07 用户决定：升级情绪与富语言表达，移除关键词匹配判情绪。本文承载声音表达合同；持续身份、权限、正式作答与勿扰继续按 42、40 和 PRODUCT。

## 体验与来源

同一次回复生成决定每句话怎样说。安慰、认真解释、祝贺、轻松打趣可以转换；轻笑、叹息、吸气等声音发生在模型标注的位置。保持用户选择的音色，普通话语可以保持自然语气。模型未标注或标记无效时保持自然，不根据文字里的“棒”“原因”“通过”等词推测，不另加一条情绪模型调用。

显示与历史正文不携带声音标记。模型输出、已提交正文、语音合成文本分别有用途，不能把净化后的正文拿来重猜表达。人格页的「声音表达」沿用账号级 `allowVoiceTags`：关闭后提示词禁用标记，交付层剥掉控制类和富语言类标记。学习提醒、声音总开关、勿扰、权限与正式作答仍由原有边界决定。

## 协议与真实链路

- `COMPANION_HOST_PROTOCOL_V7` 明确声音元数据例外，保留旧版不可变文本；声音合同从 `companion-persona-v11` 引入，后续人格版本继承该协议，审计记录采用现役人格的版本与哈希。`voice_expression` 是必需的独立政策来源，进入上下文预算回执与请求指纹。
- `COMPANION_VOICE_EXPRESSION_PROTOCOL_V1` 指导生成使用官方 23 个控制标签与 7 个富语言标签。每步开头选择控制标签，表达转折处换标签。宿主额外接收 `[neutral]` 复位；它从不发给供应商。
- 流式交付扣住半个标记，完整标记先从显示投影剥离，再判稳定前缀；标签不会把整行压到生成结束。只有通过原有校验、lease/generation fence 且已落库的正文才能生成语音事件。
- `companion-voice-expression.ts` 将模型标记映射到正文的绝对 UTF-16 区间。事实占位符用同一显示变换处理，代码里的标签不参与表达。语气变化处切段；独立合成任务重复当前控制标签，富语言只插入其对应位置。富语言标注放在随后短语前，不生成没有显示正文的独立拟声事件。
- 语音文本净化 Markdown，并通过全文代码区间排除被显示分段切开的代码块。标签留出长度空间；元数据过密时先去掉拟声标记，保留全部朗读正文。哈希与 segmentId 根据实际合成文本生成。
- 正文缓冲、知识审校、投机第一步和工具后终答共用该协议。未公开的投机结果不会进入表达投影；修订后补发的尾部在提交回调前携带最终模型文本。标签不计入短回复的正文放行阈值。
- Qwen provider 在实际外发前按模型能力保留官方标记，剥未知标记与宿主复位；其他模型与 Edge 合成前剥声音标记。每任务只发一次完整 `continue-task`，输出音频流；`streaming: duplex` 保留官方协议要求，不能把它误改成不存在的 single 模式。
- 客户端只接受服务端签发的片段引用。Live2D 在该段音频开始播放时采用对应 cue，优先于提前到达的终态 cue；进度 tick 不重置表情，停止、范围切换、隐藏、总静音与正式作答释放播放表达。

## 官方能力依据

截至本次核对，[实时语音合成](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide#rt_emtag_h3) 的标签支持模型为 `qwen-audio-3.1-tts-flash`、`qwen-audio-3.0-tts-plus`、`qwen-audio-3.0-tts-flash`，限定单向流式。控制类影响后续语气，富语言类在当前位置插入声音。[客户端事件](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-client-events) 将 WebSocket header 的 `streaming` 固定为 `duplex`；单向输入由一次完整文本与立即 finish 表达。

## 验证入口

行为回归在 shared 的 `voice-expression-tags.test.ts`、worker 的 `companion-voice-expression.test.ts`、对话/流式/Agent/知识审校测试、API 的 Qwen provider 测试，以及客户端的 `use-companion-speech-expression.test.tsx` 与播放测试。覆盖关键词反例、表达转折、复位、富语言位置、标签跨增量、未知/未完成标签、表达关闭、事实替换、代码、长回复、补发尾部、打断与旧计划迟到。

真实生成样本由 `workers/ai-worker/src/live-tests/voice-expression-probe.ts` 通过当前真实模型路由运行，需 `REAL_MODEL_BATCH=1`；只发送合成测试话语，不发送账号历史。详细验收记录在同目录测试附近的 `voice-expression-experience-qa.md`。Qwen 合成与客户端播放成功证明链路完成；自然程度、笑声强弱与多轮听感仍需真人评阅，不能以通过测试或播放回执代替。
