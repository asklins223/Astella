# 手机端（apps/mobile-client）

拾星笔记的随身客户端。React 19 + Vite + TypeScript 的网页工程，直接打 `apps/api`。

**视觉以 `prototype/` 为唯一设计基线**（2026-10-12 拍板）：那四张 CSS（layout → centers →
scene → theme）整份抄进 `src/styles/demo/` 按同一顺序 import，组件 DOM 用它的类名与层级，
不另起第二套观感。原型自己跑在 `prototype/mobile-companion-layout.html`。

```
div.app.phone
  ├ header.topbar          对话屏放 .dialogue-modes，其余屏放 .identity（她的半身像 + 状态签）
  ├ div.viewport
  │   └ div.page-layer     整屏推进/退回的动画层
  │       └ section.page-scroll   每一屏自己的滚动容器
  ├ div.bottom-area        对话屏 .composer-tray，详情屏 .detail-dock，tab 屏 .navigation-tray
  └ .companion-flow        脚下那层光（挂在整屏上，不随页面重排）
```


## 跑起来

```bash
cd apps/mobile-client
npm install
npm run dev            # 本机 http://127.0.0.1:5173
```

前置是本机 API 在 4000 上（`docker compose -f docker-compose.dev.yml up -d` 那一套）。
开发时**同源代理**：`vite.config.ts` 里 `DEV_API_PATHS` 那份路径表把 `/auth`、`/me`、
`/companion`、`/notes`、`/v2`、`/voice`、`/uploads` 转发到 `http://127.0.0.1:4000`，所以不用改 API 的
`CORS_ORIGIN`。要连别的后端就设 `VITE_API_ORIGIN`，同时把这一格来源加进服务端的
`CORS_ORIGIN`（那一项留空 = 不发 CORS 头，浏览器会挡掉）。

伴星的 Live2D 资源与静帧不提交进这个目录（模型作者登记的是 `redistributionAllowed:false`）。
`npm run dev` 前会自动从桌面端那一份**已批准**的同机副本同步过来（增量、按 mtime），
落在 `public/assets/`，已在 `.gitignore` 里。

```bash
npm run typecheck      # web + node 两份 tsconfig
npm test               # vitest：锚点偏移、WebSocket 游标恢复、增量归位、脑图布局、事件合同、提议卡形状
npm run build          # 生产构建，顺带证明 node-only 模块不在运行时图里
node scripts/probe-baseline.mjs   # 按基线逐屏走查（真手机 390×844，量计算样式与盒子）
```

走查证据落 `../../outputs/mobile-client-shell-2026-10-12/`（`b01…b20` 加 `baseline-log.txt`）。
每屏看的是**实测的盒子与计算样式**：登录卡 380×366 / radius 29px、阅读 `.paper` 374 宽、
`.setting-field` 行高 93、`--text-scale` 改 1.25 之后标题真的变 33.75px、`overflowX=0`。

## 这一屏做什么

| 屏 | 接口 |
| --- | --- |
| 开屏 | 无网络，纯时间线；关掉动效就直接位 |
| 伴星舞台 | `PIXI` + Cubism 加载 `companion-live2d-whale-v3`（四道许可闸门），口型与脚下流光同源 |
| 登录 / 注册 | `POST /auth/login`、`/auth/email-code` + `/auth/register-v2`（强制两步）、`/auth/login-with-code` |
| 对话 | `POST /companion/inbox/ensure` 取**唯一那条**会话；鉴权 WebSocket `/companion/realtime` 订阅事件并发送回合，断线时同 `clientMessageId` 回退 HTTP；照片经 `POST /uploads/companion-images` 上传；打断与提案确认仍走现有 HTTP |
| 笔记 | `GET /notes`、`GET /v2/notes/:id`（投影里已带 blocks，不在浏览器跑 Yjs） |
| 速看 / 思维导图 / 动态讲解 / 标注 | `…/overview-tasks`、`…/mind-map-tasks`、`…/learning-artifact-tasks`、`…/annotations`，都是后台作业，1600ms 轮询 |

## 笔记在手机上是只读的

人不能手动改正文，伴星可以。这条不只是界面上没给入口：

- 签发给手机端的会话在 `sessions.client_kind` 上写着 `mobile`（迁移 0413），
  `POST /v2/notes/:id/doc-update` 与版本还原对这种会话回 403 `mobile_note_edit_forbidden`，
  实时协同那条 WS 也强制 `readOnly`。判据跟着**凭据**走，拿着 token 直接调接口也改不了。
- 伴星改笔记没有 HTTP 入口（`apps/api/src/modules/note/companion-edit-dispatch.ts` 走内部
  工具调用），所以这道闸不影响她。
- 她能做的：读、选一段问她、把一句批注留在原句上（批注不是正文）。改动前后可以在提议卡上
  核对（guided 档），改完阅读屏会出现「伴星刚改了这一篇」并给到版本时间线。

## 还没做

移动端朗读（TTS）、手边/复习/空间切换、星图，以及账号中心里的人格／记忆／日记。
聊天照片已接入相机/相册选择、真实上传、同回合提问和带鉴权的历史展示。语音输入已接小米 MiMo：浏览器录音转成 16 kHz 单声道 WAV，经服务端 `/voice/transcribe` 整段识别后填入可编辑输入框；它不是流式识别，也不会在浏览器直连小米接口。
手机服务端必须启用 `COMPANION_VOICE_DIALOGUE_V1_ENABLED=true`、用户允许语音识别，并配置 MiMo `mimo-v2.5-asr`，否则接口会按权限或能力开关拒绝。其他能力按方案 51 的排期继续实现，不在这一版里冒充完成。

## 2026-10-12 交流重设计

真实交流页默认见伴星，通过顶部“记录”展开同一段交流；两种视图不换 inbox、不丢草稿。
记录获得完整阅读空间，取消角色固定占 37vh 与重复的底部导航留白。文字增量不再驱动口型。
输入区跟随 visualViewport，中文输入法选字回车不发送。

开发服务器的 `/demos/companion-realtime.html` 仍是独立的语音状态示意，使用本机角色资源，
其中转写与回复明确标为样例；真实录音入口在正式对话输入区，当前只做整段 ASR，没有声音播放。
可体验开始、说好了、暂停、继续、我想说、结束与同一份记录切换。

[方案 55](../../docs/plans/learning-companion/55-mobile-redesign-and-companion-realtime-2026-10-12.md)
记录了手机 MiMo ASR 和移动端 WebSocket 的实现边界。桌面尚未迁移 WebSocket，仍使用 SSE 和本机 ASR；两端 TTS、音频投递与播放也尚未接入。
