# 音色试听录音 voice-preview-v1

设置 → 语音与伴星 里「试听」放的音频。它们是**预生成的资产**，不是用户点下去时现合成的：
挑声音天然要把同一句话反复听几遍，每听一遍都打一次上游合成接口是白花钱。

## Qwen 试听生成参数

- 引擎 / 模型：`qwen-audio-3.1-tts-flash`（阿里百炼 Qwen-Audio-TTS，北京地域）
- 待合成文本（Qwen 条目同句）：你好呀，我是伴星。今天想一起学点什么？我在这儿陪你慢慢来。
- 指令控制 instruction：青年女性声音，音调中等偏柔，音色甜美圆润，语速自然适中，情感温柔明亮，适合学习陪伴对话
- 音频：mp3 / 22050 Hz / 单声道
- 生成日期：2026-10-12

`zh-CN-XiaoxiaoNeural.mp3` 是 Edge TTS 音色试听，不使用上面的 Qwen 指令，生成日期仍为 2026-09-22。

## 过期条件

Qwen 的 `model`、`voice` 或 `instruction` 任何一个改了，三条 Qwen 录音就不再代表实际合成效果，
必须一起重新生成；Edge 音色按自己的引擎和 `voice` 更新。文件名就是 `voice` 参数值，界面按
`tts-voice-catalog.ts` 里的 `previewAsset` 取用，缺一行会在 `tts-voice-catalog.test.ts` 里红。

## 清单

| 文件 | 时长 | 字节 |
| --- | --- | --- |
| `longanhuan_v3.1.mp3` | 5.98 s | 95803 |
| `longanlingxi_v3.1.mp3` | 5.59 s | 89534 |
| `longhua_v3.1.mp3` | 6.06 s | 97057 |
| `zh-CN-XiaoxiaoNeural.mp3` | 6.53 s | 39168 |
