# 伴星语音的中英语种（2026-10-28）

## 现象

iOS 伴星连续通话里，说话带英文词会被识别成中文近似音；纯英文句子会被改写成中文开头。用户要求“中英文能自动适应”。

## 根因

语言标签在三处被写死成中文，最后 MiMo 收到的是 `zh`：

- iOS `MobileAPI.transcribeWAV`：`field("language", "zh-CN")`
- Android `MobileApi.transcribe`：`addFormDataPart("language", "zh-CN")`
- 服务端 `parseCompanionMultipartFields`：要求 `language` 必须等于 `zh-CN`，再原样传给 `mimoTranscribe`

`mimoAsrLanguage` 把 `zh-CN` 夹成上游认的 `zh`，于是每次识别都用中文模型。

## 实测：哪一档语言才正确

用真实 MiMo 接口（`mimo-v2.5-asr`）对四段 16 kHz 单声道 wav 各跑 `auto` / `zh` / `en`：

| 录音 | `auto` | `zh` | `en` |
| --- | --- | --- | --- |
| 纯英文长句 | 原样正确 | `请你 summarize the key points…` | `<chinese> Can you summarize…` |
| 纯英文短句 | 原样正确 | `1. I went to the store…` | `1. I went to the store…` |
| 中英混说 | 原样正确 | 原样正确 | 多出空格 |
| 纯中文 | 原样正确 | 原样正确 | 原样正确 |

结论：`auto` 是唯一在四类输入上都干净的取值。

## 改动

`apps/api/src/modules/learning-sessions/voice-routes.ts` 的伴星分支把交给 MiMo 的 `language` 固定为 `"auto"`：

```ts
() => mimoTranscribe(buf, fn, {
  scope: scopeOfSession(req.session),
  currentActiveTransaction: currentApiWorkspaceTransaction,
  signal: aborted.signal,
  language: "auto",
})
```

只在服务端收口，不改客户端申报值，理由：

- 已装机的客户端仍在发 `zh-CN`，服务端这一行对旧客户端立即生效。
- 若反过来让新客户端发 `auto`，在服务端校验仍是“只接受 zh-CN”的窗口期里，每次识别都会被 400 拒绝，发布顺序变成硬约束。
- `companion_voice_artifacts.language` 继续记录客户端申报值，保留作为溯源字段；它不参与识别。

`mimo-asr.ts` 的 `mimoAsrLanguage` 注释补充了这次实测结论，说明为什么不该把标签往 `zh`/`en` 收窄。

## 验证

本地 Compose API（`astella-dev-api`，源码卷挂载 + restart），真实 owner 账号登录，真实 MiMo：

- 修前，英文长句返回 `请你 summarize the key points of this article and…`
- 修后，同一段音频返回原文 `Can you summarize the key points of this article and…`
- 中英混说修前修后都正确，`帮我把这个meeting改到明天下午三点。`

命令与结果：

- `apps/api` 下 `npx tsc --noEmit` 通过。
- `node --import tsx --test src/modules/learning-sessions/__tests__/voice-routes.test.ts src/modules/learning-sessions/voice-providers/__tests__/mimo-asr.test.ts`：10 项通过。

## 未完成

远程服务 `https://103.106.191.159` 仍是旧版本，手机安装包连的是它。这一行要随下次 `s-v*` 发布才在真机上生效；真机复测中英文尚未进行。iOS 包本身不需要改动，也不需要配合发版。
