# 主动开口「有字没声」的调用链修复与真窗口实测（2026-10-16）

用户反馈：开机后她主动开口（截图里气泡写着「来了，晚上好。今天过得咋样？」）**没有声音**，
并且认为主动能力整体还有问题。本记录只覆盖被证实并可复现的那一半：**主动发言被认领时
声音从没进过这个窗口**——以及它在真窗口里的修后读数。

本轮改的是工作区源码；**装好的 v1.8.8 安装包与线上服务都要重新发布才会带上这些改动。**

## 复现：气泡有字、一次合成请求都没有

用**装好的生产包**（`/Applications/Astella.app`，1.8.8）指向本地 dev 栈，隔离 profile 跑两段：

1. 新 profile 登录（必然带手势）后退出；
2. 同一 profile **再启动一次，全程不碰窗口**。

读数（`voice.speakSegment` 调用数、`AudioBufferSourceNode.start` 次数、本机音频缓存文件数）：

| 轮次 | 气泡文字 | `speakSegment` | 起播 | 本机 mp3 | 服务端 `companion_tts_outcomes` |
| --- | --- | ---: | ---: | ---: | --- |
| 修前：认领一条**窗口之外**产生的投递 | 显示（「早啊，今儿个又见面了。」） | 0 | 0 | 0 | 一行都没有（合成也没有） |
| 修后：同一场景 | 显示 | 合成 2 段 | 起播 2 段 | 2 | `synth/ok` ×2、`playback/played` ×2 |

## 根因

主动正文抵达桌面走的是「认领一条投递」（`receiveInitiative`）。投递落地时那一轮
可能已经结束：客户端用 `eventCursor: 0` 订阅会话事件，服务端直接判游标过期。
真库实测（同一账号的同一条会话）：

```
GET /companion/conversations/331145ad-.../events?after=0&voiceOutput=1
→ {"version":1,"error":"CURSOR_EXPIRED","message":"cursor expired; fetch snapshot and reconnect",...}
```

正文还有两条兜底能把字显示出来——合成器回复的快照轮询、以及跨会话的连续历史读回
（`showInitiativeFromHistory`）——但**语音段只有实时流这一条路**：
`companion-chat-session.tsx` 只在流回调里 `queueCompanionVoiceSegment`。
于是「文字在、声音永久缺席」，而唯一的手动补听入口（`CompanionMessageAudioButton`
的「补听这段」）只挂在对话手记里，气泡上根本没有。修前两条主动路径的注释里
只写了「气泡不出声」的旧症状，没有把声音接回来。

## 修法

- 新增 `companion-run-voice-redrive.ts`：**没在实时流里到场过**的轮次
  （`hasCompanionRunVoiceSegments`，队列模块记账，入队即记、取走也不撤销），用她自己的
  留档接口 `/companion/runs/:id/voice-segments` 取一次段，按同一份身份
  （`segmentId` / `ordinal` / 显示区间）排进常驻队列并唤醒气泡。判据是「到场过就不补」，
  所以不会把同一句念两遍；同一轮只问服务端一次；留档为空（事件过了 TTL）、通道不可用、
  网络失败都只当没补到，不抛错、不影响文字与操作。
- 两个入口都改成**先补后显示**：`showInitiativeFromHistory` 与认领分支在
  `setCurrentLiveReply` 之前 `await redriveCompanionRunVoice(delivery.runId)`。
  顺序是语义的一部分——气泡拿到回复就会喂段并封队，晚到的段只会被丢掉。
- 气泡筛段改用**这条回复自己的 `runId`**（`CompanionChatLiveReply.runId`），取不到才退回
  草稿轮次。主动开口没有草稿，`draftRunIdRef` 还停在上一条用户消息上——用它筛会把刚补
  回来的段全部跳过，又变回有字没声。
- 唤醒事件名收敛成 `COMPANION_VOICE_SEGMENT_READY_EVENT` 一处定义，实时流生产端、
  补声生产端、气泡消费端共用。

## 真窗口读数（修后）

修后把工作区渲染包 **`npm run build`** 产物跑起来，指向本地 dev 栈，隔离 profile，窗口
`show()+focus()`（这样应用自己会发 `app.started`），全程不点不敲。投递先由接口造好、
停在 `queued`，窗口起来才认领——就是用户场景。

| 轮次 | 来源 | 服务端留档段 | 合成 | 起播 | 本机 mp3 |
| --- | --- | ---: | ---: | ---: | ---: |
| `a68d73b5-3215-4f61-abd7-5e2d5e08f992` | 窗口之外产生的投递（本窗口从没收到它的流） | 2 | 2 段 ok | **2 段 played** | 有 |
| `2e148bd7-7aa7-4c0d-ad60-a7c0ed355978` | 本窗口自己那次启动问候（实时流） | 2 | 2 段 ok | **2 段 played** | 有 |

两条都是 `companion_tts_outcomes` 里的 `stage='playback'`、`outcome='ok'`、`error_code='played'`；
`AudioBufferSourceNode.prototype.start` 桩记到 4 次起播（1.57 s / 4.6 s / 1.96 s / 1.38 s），
`AudioContext.resume()` 全部 resolved、当时 state 已是 `running`。
实时那条问候的正文是「哟，来了。这几天你那『这一段』到底看懂没有，我一直憋着没问成。」
——主动正文本身是贴着当前笔记说的，不是模板。

## 验证范围与没验到的

- Desktop：`npm run typecheck` 通过；`vitest run`（全包 **422 文件 / 3656 项**，
  含本轮另外两处改动的用例）通过；新增
  `companion-run-voice-redrive` 6 项、队列守卫 9 项全绿，另有两条接线守卫钉住
  「补声排在显示之前」「气泡按回复自己的 runId 筛段」的顺序。
- 真窗口：上面那张表；用的是工作区渲染包而不是装好的安装包（安装包要重新发布）。
  这条检查已经落成可重跑的脚本：
  `apps/desktop-client/scripts/check-companion-proactive-voice-redrive.mjs`
  （先 `npm run build`，再起 dev 栈跑；落成后自己跑了一遍 **6/6 通过**：
  留档 2 段 → 合成 2 段 → 起播 → 本机 mp3 → 服务端收到 `playback|ok|played`）。
  脚本造的"窗口之外那次开口"用的是 `result.available`（触发式话题）：启动问候现在会被
  下一次真实启动**作废**，拿它当这条链的载体测不出补声（见
  [companion-launch-greeting-supersede-2026-10-16.md](companion-launch-greeting-supersede-2026-10-16.md)）。
  脚本里还显式剔除了 `ELECTRON_RUN_AS_NODE`：这个宿主环境带着它，透传会让 Electron
  以纯 Node 启动，Playwright 只会报 `Process failed to launch!`（第一版就是这么挂的）。
- 用户这台机器上那次 19:26 的问候**仍未解释完**：那一条的音频确实合成过
  （`companion-message-audio` 里 19:26:57 落了 2 个 mp3），说明当时走的是实时链，
  而实时链在上表里两条都起播了。系统输出这一层已经排除——用户确认**别的应用放声音听得到**；
  这次会话里新一轮启动（20:08）**全程没有产生任何音频合成**（缓存最新一条停在 19:30），
  也就是那一句必然没声音，与本次修的那条真因一致。
- 线上服务与安装包本轮的改动都还没发布；线上那条 `/companion/runs/:id/voice-segments`
  路由已存在（未带 token 回 401 而不是 404），所以补声在线上可用。

## 顺带记下的两件主动能力事实（未改）

1. **启动问候会晚一拍**：问候是对 `app.started` 的反应，而它可能在上一次启动的窗口
   关闭之后才落地。那条投递停在 `queued`，下一次启动才被认领——用户看到的是
   「上一次启动的问候」。实测：11:40:48 那一轮问候在 11:41:39 被下一个窗口显示。
2. **`app.started` 只在窗口真的有焦点时发**（`use-companion-awareness.ts`：
   `document.hasFocus() && visibilityState === "visible" && windowState === "visible"`，
   且 `participationAllowed`）。窗口在后台起来的那些启动完全没有启动问候。
