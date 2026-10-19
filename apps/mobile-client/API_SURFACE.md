# 移动端 API 面清单（契约漂移防线之一）

日期：2026-10-15 建立。服务端契约变更（新增字段/收紧校验/改语义）时**必须同步更新本表**并核对两端调用点；本表不是机读合同，机读合同在 `packages/shared/src/contracts/`（zod）。DTO 字段旁的注释互指 zod schema 是第二道防线；shared zod 测试是第三道。

状态列：✅ 已接线（客户端真实调用）｜🟡 服务端已有、客户端待接（阶段见备注）｜🆕 2026-10-15 新增。

## 鉴权与账户

| 方法 | 路径 | 用途 | 备注 |
| --- | --- | --- | --- |
| POST | /auth/login | 密码登录（clientKind:"mobile"） | ✅ |
| POST | /auth/login-with-code | 邮箱验证码登录 | ✅ |
| POST | /auth/register-v2 | 注册（emailCode 必填） | ✅ |
| POST | /auth/email-code | 验证码（purpose: register/login/reset） | ✅ |
| POST | /auth/reset-password | 重置密码 | ✅ |
| GET | /auth/me | 当前用户与空间 | ✅ |
| GET/POST | /auth/workspaces、/auth/switch-workspace | 书房列表/切换（**重签 token 须保存**） | ✅ |
| PUT | /auth/profile | 资料 | ✅ |
| GET/PUT | /me/ai-settings、/me/ai-consent、/me/ai-data-policy | AI 授权与数据策略 | ✅（移动端将做成进入门槛） |

## 伴星会话与实时

| 方法 | 路径 | 用途 | 备注 |
| --- | --- | --- | --- |
| WS | GET /companion/realtime | auth→subscribe→event/turn.submit | ✅ 契约 `companion-realtime-contracts.ts` |
| POST | /companion/inbox/ensure | 幂等取 inbox | ✅ |
| GET | …/messages、…/run-nodes | 历史/过程留痕 | ✅ |
| POST | …/turns | HTTP 回合回退（同 clientMessageId） | ✅ |
| GET/POST | /companion/proposals/:id/decision、/companion/tool-proposals | 提案确认 | 🟡 阶段 5（选段改写确认走这里） |
| POST | /me/companion/awareness | 方案 56 观察端口（前台/启动/页面到达/安静） | 🟡 阶段 5（扩展 F） |

### 回合合同（2026-10-15 扩展 A/C，`companion-conversation-contracts.ts`）

- `blocks`：1–2 块；附件（image|file）**至多一个**；text 起头或**仅附件**均可（仅附件由服务端登记显式意图，客户端不伪造文案）；voice_transcript 仍必须唯一文字块、不带附件。
- file 块（`companion-file-contracts.ts`）：`{type:"file", url(站内 /api/uploads/ 回执), name, mime(pdf|docx|txt|md), byteLength(≤20MiB), text(客户端本机抽取, ≤100k chars)}`。
- `clientSurface: "desktop"|"mobile"`（可选，扩展 C）：mobile 发起的回合中 `companion_edit_note` 一律出 before_execute 确认提案，确认后经伴星通道写回正文；桌面行为不变。

## 语音

| 方法 | 路径 | 用途 | 备注 |
| --- | --- | --- | --- |
| POST | /voice/transcribe | 16kHz WAV 整段 MiMo 转写 | ✅ 双门控：AI 同意 + `COMPANION_VOICE_DIALOGUE_V1_ENABLED` |
| POST | /voice/tts、/voice/tts/stream | 文本→audio/mpeg | 🟡 阶段 5（粒子波动+口型） |
| POST | /voice/prewarm、/voice/tts/playback-outcome | 预热/播放回执 | 🟡 阶段 5 视需要 |

## 上传

| 方法 | 路径 | 用途 | 备注 |
| --- | --- | --- | --- |
| POST | /uploads/companion-images | 对话图片（requireOwner，≤10MB） | ✅ |
| POST | /uploads/companion-files | **🆕** 对话文件（requireOwner，pdf/docx/txt/md，≤20MiB，魔数校验；返回 {url,name,mimeType,byteLength,sha256}） | 🟡 阶段 5 |
| POST | /uploads/avatars | 头像 | ✅ |
| GET | /uploads/{objectKey} | 鉴权下载；`{ws}/companion-files/{userId}/…` 按上传者隔离 | 🟡 阶段 5 |

## 手记 / 派生 / 复习（现状沿用）

| 方法 | 路径 | 备注 |
| --- | --- | --- |
| GET/POST | /notes、/search | ✅ 游标分页 |
| GET | /v2/notes/:id | ✅ 只读正文投影 |
| GET/POST | /v2/notes/:id/annotations(+tasks)、versions(+restore)、overviews/mind-maps/learning-artifacts(+tasks) | ✅ 四族派生任务 |
| POST | /import/markdown | 🟡 阶段 6（文件导入手记：客户端本机抽取正文后调用，服务端零改动） |
| POST | /v2/notes/:id/doc-update | 手机会话 403（`requireNoteContentWrites`，产品规则「手机上人不改正文，伴星改」）；改写走伴星通道 |
| GET/PUT | /me/companion/participation | ✅ 409 保稿 |

## 星轨 / 日记与伴星记忆

| 方法 | 路径 | 用途 | 备注 |
| --- | --- | --- | --- |
| GET | /companion/daily/month?month=YYYY-MM | 星轨近 14 天星点 | ✅ `days` 按日期聚合；`firstGeneratedDate` 为当前书房最早一篇未删除且成功生成的日记日期，没有时为 `null`，用于显示真实相伴天数 |
| GET | /companion/daily?date=YYYY-MM-DD | 打开某日的日记正文 | ✅ 按当前书房和用户隔离；删除或撤权内容不返回 |
| GET | /companion/memory?includeCandidates=true&includeArchived=false | 星轨中的伴星记忆 | ✅ 展示真实记忆与待确认候选 |

## 模型分发（2026-10-15 扩展 E）

| 方法 | 路径 | 用途 | 备注 |
| --- | --- | --- | --- |
| GET | /companion/model/manifest | 鉴权 → Live2D 模型清单 + 对象存储临时签名下载 URL | 🟡 阶段 4a 客户端实现中；资产入库用 `apps/api/scripts/ingest-companion-model.ts` |
