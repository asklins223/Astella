# iOS SSE 与语音的本地 Docker 联调（2026-10-24～25）

## 范围与环境

用户要求先用本地 Docker 跑通，服务端问题同步修复，向量模型不启动。手机已断开，用户选择模拟器。当前服务为 Compose project `astella-dev` 的 `api`、`worker`、`postgres`、`minio`、`edge-tts`，五个服务均健康；没有启动 `embedding` 容器。使用既有数据库、既有对象存储和真实本地账号，不清库或重置笔记。

本轮 API 监听 `127.0.0.1:4000`。iOS 仅通过 Debug 进程变量覆盖 origin；安装包默认线上地址与线上部署没有因本次本地联调改动。没有把本地修改部署到远程实例。

首次启动包含 `minio-init` 时，镜像仓库拒绝拉取指定的 `minio/mc` 镜像，3.85 秒后失败。复用现有对象存储及缓存核心镜像后，12.16 秒启动完成；Edge TTS 另按仓库 Dockerfile 构建。本机 `/health`、`/ready`、真实登录、模型 manifest 均成功；模型清单已有 64 个文件。

## 发现的问题与修复

### 1. iOS 没有交付收到的 SSE 帧

原生客户端用 `URLSession.AsyncBytes.lines`，实际流中空行被跳过，解析器等不到帧边界。手工逐行喂入测试没有揭示该差别。改为原始字节解析，覆盖 LF／CRLF／CR、跨字节 UTF-8、心跳和帧大小，保留游标、幂等、generation 及鉴权语义。EOF 后按最后 seq 重新订阅，不把持久事件重复追加成第二条回复。

### 2. 正常上游间隔被过早判为无输出

原首输出等待 20 秒不足以覆盖当前真实模型的输出间隔。默认首输出改为 60 秒、活动后空闲间隔改为 45 秒，并把两个变量接入 dev／生产 Compose 与 `.env.example`。这些是上游无活动的看门狗，不是界面通话倒计时，也不伪造思考内容。实际账号、模型与整轮生命周期约束继续保留。

### 3. 读取最新手记沿用旧证据与重复正文

实际请求“读取书房最新手记”被混合入口当成无工具闲聊，随后纠正又把同义完整回答接在已发布段落后；另一次即使进入读取路径，模型仍把历史工具结果当成本轮刚读到的资料。

- 明确的已保存笔记读取进入证据路径，不再先发布闲聊投机稿。
- 尚无必要读取回执的草稿暂缓发布；被拒绝的未发布读取草稿不再作为可信 assistant 内容回灌，避免自述“我已经读过”被下一步引用。
- 纠正后仍没有读取回执不再算成功，没有真实正文的失败记录由 iOS 过滤，业务失败与连接失败分开。
- `companion_search_notes` 支持 `order=updated` 且省略关键词，按当前空间可见权限列出最新候选；原关键词查询仍要求非空，避免空搜索误命中全库。
- 对明确的“最新／最近更新的 N 篇”请求，沿用已有宿主预读机制，按当前 `updated_at` 排序取回实际可见笔记及版本，再用原分页读取器取得正文。所有读取都在工作空间／用户事务和笔记可见边界内；命名笔记优先按唯一标题读取。预读只处理可确定的选择器，不猜测含糊目标。
- 每篇仍有原有首屏正文预算，`truncated`、固定版本与续读游标交给模型；未读完不解除必要读取条件。完整预读后不再强迫一轮多余工具调用，正文可以正常流式输出。

两次无读取的真实请求在纠正后仍失败（`AGENT_NO_PROGRESS`），这属于保留的失败证据，不计为通过；最后的宿主新鲜正文路径已完成真实回归。

## 实测结果

早期带工具的真实读取回放：346 个事件，其中 219 次思考增量、65 次正文增量、23 个工具事件、34 个语音段。背压造成连接 EOF 后用 `Last-Event-ID` 恢复；这是同一个回合的续接。

最终“最新三篇”回归由 HTTP 受理，按当前排序预读三篇真实正文，日志确认 `requestedCount=3`、`readCount=3`、`truncated=false`。SSE 收到：

| 事件 | 数量 |
| --- | ---: |
| `turn.accepted` | 1 |
| `assistant.status` | 2 |
| `character.cue` | 1 |
| `assistant.thinking` | 134 |
| `assistant.delta` | 64 |
| `voice.segment.ready` | 22 |
| `assistant.final` | 1 |

相对 HTTP 受理，首个思考约 3.26 秒、首正文约 29.07 秒、最终回复约 37.47 秒。正文不是整段等结束再交付；思考期间仍在实际等待模型。最终持久消息只保存**一条**正常 assistant 回复（716 字），三个手记标题全部与 `/notes?limit=3` 的当前排序一致，并包含先读顺序的建议。宿主预读不冒充模型工具调用，这一回合的资料读取由宿主准备完成；工具事件的传输另由上述带工具回合证明。

发送新问题抢占旧生成的独立检查也通过：旧 generation 为 `superseded`，新 generation 成功，客户端不展示空的旧回复。

语音接口检查使用本次自制短音频：`/voice/tts/stream` 200 `audio/mpeg`，首音频约 472 毫秒，总计约 681 毫秒、41,468 字节；转成 16 kHz 单声道 WAV 后，`/voice/transcribe` 201，约 927 毫秒，返回真实 voice artifact。有一处“手记／手机”同音识别误差。它证明本地 TTS／ASR 接口可用，不证明模拟器采集或双向通话已经验收。

## 验证命令与日志

- 宿主按包执行 `npm run typecheck`：`workers/ai-worker`、`apps/api`、`apps/desktop-client` 通过；shared 包在 worker 容器内执行对应脚本通过。
- 运行 `companion-agent-runtime`、`companion-agent-step-assembly`、`companion-quote-evidence`、`companion-entry-mode`、`companion-output-watchdog` 五组相关测试，96 项通过。另行步进装配／投机入口测试通过。
- shared 能力目录、参数注册与描述预算测试 19 项通过，确认新增更新时间检索仍保留参数校验与工具面预算。
- 首次在仓库根目录运行测试时缺少根级 `tsx`；在单服务容器跑跨包完整类型检查又缺少未挂载的兄弟源码。随后改为正确的宿主包目录进行检查，相关完整类型检查通过；没有为检查问题修改业务代码或安装额外依赖。
- `git diff --check` 通过。没有运行无关全量回归，也没有创建提交或推送。

原始日志与不含正文的流事件统计在 `/tmp/astella-ios-dev/`：`local-agent-combined-final-tests.log`、`local-shared-capability-tests.log`、`local-worker-final-host-typecheck.log`、`local-api-final-host-typecheck.log`、`local-shared-final-typecheck.log`、`local-desktop-final-typecheck.log`、`local-sse-final-summary.json`、`local-read-final-validation.json`。会话凭据仅在权限 600 的本地临时文件中，不写入仓库与文档。

## 客户端与未验证项

手机仓库的对应实现与窗口检查见 [iOS 记录](../../../astella-mobile/docs/testing/ios-sse-call-local-2026-10-25.md)。本轮已检查真实长历史气泡、消息头部播放控制、接续问题浮层、书房标题行、阅读返回底栏及原生抽屉展开和滚动。最后 Mac 锁屏，后续窗口验收暂停；只继续 API、自动化与构建。

Mac mini 当时没有音频输入设备，模拟器不能真实采集语音；相机与声学打断、回声、蓝牙、长时间采集和真机帧率仍需硬件验证。没有将截图描述为 60／120 fps 证据，也没有宣称最新代码已安装到断开的 iPhone。
