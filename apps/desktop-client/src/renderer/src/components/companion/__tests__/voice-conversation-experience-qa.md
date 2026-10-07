# 伴星实时语音体验修复 · 2026-10-07

用户反馈：实时语音的界面与操作不连贯，伴星回复没有声音。

## 根因与改动

实时输入全程调用 `holdCompanionMicrophone()`，而音频宿主在可听判断、播放前、恢复 AudioContext 后都以「任一麦克风占用」拒绝回复。这使实时会话的正常回复只能走文字。占用现分为 `recording` 与 `conversation`：单段录音继续独占音频；实时会话只压住通知、讲解和手边念想，允许回复播放。开始会话保留正在念的回复，背景音让路。

收音按轮次让路：本机切段识别 → 送出并等待真实发送 Promise → 回复/播放 → 自动恢复。扬声器尾声另丢弃 300ms。撤下仅凭音量的自动插话判定，大音量回声不会打断回复或变成新指令；「我想说」同步停播放并走已有会话取消路径，迟到的旧轮回执不修改新轮。

短停顿 450ms 推进字幕，结束停顿 1400ms 送出整轮；「说好了」可以提前送出，主动操作也能发送低于自动杂响门槛的短词。一次识别失败时不发送残缺指令。最新说过的话在等待期间保留，失败有说明。

结束、X 和 Escape 均立即交还麦克风并丢弃未发送内容；暂停实际关闭设备，恢复重开。隐藏窗口暂停，正式作答或语音关闭时结束；实时流不再因任意五分钟上限退出。迟到授权、建图失败和设备断开均释放资源；电平按采样窗口求 RMS，而非只取某一小帧。

独立 `CompanionVoiceConversation` 呈现收音、识别、等待、说话和暂停，以及改用文字、暂停/继续、插话与说好了。音量条来自实际订阅，取消假循环波形。样式通过既有 `styles.ts` 接入，继承 Off 与系统减少动态。

## 已通过的验证

桌面包 `npm run typecheck` 成功，包含 node 与 web 两个实际 tsconfig。

以下 11 个相关测试文件共 **112 项通过**，使用 `npm run test -- --maxWorkers=2`：

- `use-companion-voice-input.test.tsx`
- `companion-notification-voice.test.ts`
- `companion-voice-vad.test.ts`
- `voice-recorder.test.ts`
- `voice-recorder-lifecycle.test.ts`
- `home-audio-idle.test.tsx`
- `CompanionVoiceConversation.test.tsx`
- `CompanionHud.interaction.test.tsx`
- `CompanionHistoryComposer.test.tsx`
- `companion-voice-playback.test.ts`
- `companion-voice-segmenter.test.ts`

覆盖实际音频宿主的可听判断、resume 后判断与音源启动；实时开麦不打断当前回复，普通录音仍拒绝并打断播放。外部声卡、麦克风与合成结果使用可控替身，不能视为设备听感验证。还覆盖大音量回声、发送等待、自动恢复、手动插话、短词发送、暂停/恢复、丢弃半句、迟到识别、迟到授权、建图失败、断开设备与草稿保留。

## 窗口检查与限制

使用原生 Electron 窗口实际打开了新语音面板，检查准备状态、纸面/角色的相对位置、状态层级与控制区。当前共享窗口同时被其他任务使用，后续页面和焦点会被切换；因此没有将这一轮窗口操作当作完整的多轮 ASR→TTS 连续验收，也没有声称真人麦克风识别、扬声器听感或所有设备上的回声消除已经通过。

待设备体验验收：真人说一句 → 停顿 → 发出回复声音 → 自动恢复；随后连续再聊、回复中点击插话、暂停恢复和结束。现有静音与 AI 使用同意边界保持生效。
