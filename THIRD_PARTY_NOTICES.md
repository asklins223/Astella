# Third-Party Notices

本应用（AI Learn desktop client）包含以下第三方组件的源码、二进制或素材。
许可证全文见各条目链接；模型/素材的再分发与商用限制见
`apps/desktop-client/src/renderer/public/assets/companion/live2d-v3/whale/manifest.json`。
伴星现在只发布这一个角色模型（大肥鱼），其余形态与资产已删除。

## Yjs（`apps/api`；后续 `apps/desktop-client`）
- 用途：笔记正文的协同内核（headless Y.Doc 是唯一的正文写入路径，`note_blocks` 由它派生）
- 许可：MIT License
- 来源：https://github.com/yjs/yjs
- 引入批次：批次 4（4.0 前置验证已通过，见 `apps/api/src/__tests__/note-doc-collab-kernel.test.ts`）

## Hocuspocus（`@hocuspocus/server` + `@hocuspocus/common` 4.7.0，`apps/api`；`@hocuspocus/provider` 同版本，devDependency 用于协同契约测试，批次 4.3 将由 `apps/desktop-client` 主进程使用）
- 用途：把 Yjs 同步协议接成服务端 WS 通道（`apps/api/src/modules/note/collaboration.ts`）；
  升级仍由 `@fastify/websocket` 完成，本组件只吃 `handleConnection` + 宿主接线的
  `handleMessage`/`handleClose`
- 许可：MIT License（Copyright (c) 2023, Tiptap GmbH；企业版模块不在依赖树里）
- 来源：https://github.com/ueberdosis/hocuspocus

## y-protocols（1.0.7）与 lib0（0.2.117）（`apps/api`；后续 `apps/desktop-client`）
- 用途：Yjs 的同步/awareness 协议编解码与工具库，是 Hocuspocus 的运行时依赖
- 许可：MIT License
- 来源：https://github.com/yjs/y-protocols 、https://github.com/dmonad/lib0

## PIXI.js（`apps/desktop-client`）
- 用途：Live2D 渲染器宿主
- 许可：MIT License
- 来源：https://github.com/pixijs/pixijs

## Live2D Cubism Core（`apps/desktop-client/src/renderer/public/assets/companion/vendor/`）
- 用途：Cubism 模型运行时
- 许可：Live2D Proprietary（Cubism Core SDK License；商用需遵循 Live2D 收入/规模条款）
- 来源：https://www.live2d.com/sdk/download/web/

## Live2D Cubism 4 Web SDK（`apps/desktop-client/src/renderer/public/assets/companion/vendor/`）
- 用途：Cubism 4 模型加载与驱动
- 许可：Live2D Proprietary（Cubism SDK License；商用需遵循 Live2D 条款）
- 来源：https://www.live2d.com/sdk/download/web/

## DS鲸鱼娘（大肥鱼，Live2D 角色模型，`apps/desktop-client/src/renderer/public/assets/companion/live2d-v3/whale/`）
- 用途：书房里的伴星角色模型（唯一在册形态；Owner 批准 2026-09-20）
- 作者：B站 @氵六青（11272072），无偿分享模型；来源为用户提供的 `DS鲸鱼娘/DS鼠控版`
- 模型素材许可：作者《使用须知.txt》——商用直播 √、自印物料 √；
  **禁止任何形式的盗用以及出售**
- 限制：允许随应用使用（`commercialReleaseAllowed=true`），但不得再分发模型文件本身，
  也不得单独出售该资产（`redistributionAllowed=false`）。含此模型的安装包在另行完成
  发布审查前须保持私有。
- 完整 SHA-256 清单与上述要点同记在 `manifest.json`。

## 已删除的 Live2D 角色模型（2026-10-04）
- **Mao PRO**（`live2d-v1/mao-pro/`，源自 EchoBot，锁定 commit
  `08e97a4a33b2ab611d24dd997038c1ec95ac6926`）：模型素材适用 Live2D Free Material
  License Agreement and Terms of Use，随附的 EchoBot 仓库 MIT 许可副本也一并删除。
- **Seethrough**（`live2d-v2/seethrough/`）：用户提供的模型，所有权与再分发范围始终
  未确认，manifest 一直是 `commercialReleaseAllowed=false` / `redistributionAllowed=false`。
- 两者连同资产整包删除后不再随应用分发，本节仅为追溯来由与许可状态而保留。

## sherpa-onnx WASM 运行时（随应用分发）
- 用途：本地 SenseVoice ASR（渲染进程内的经典 worker；onnxruntime WASM 推理 +
  sherpa-onnx C API 绑定）
- 许可：Apache-2.0（wasm 胶水由 k2-fsa/sherpa-onnx 官方构建产出；onnxruntime
  为 MIT）
- 来源：https://github.com/k2-fsa/sherpa-onnx（`sherpa-onnx-wasm-nodejs` 构建产物）
- 说明：运行时只有十几 MB，随安装包走；它不含任何模型权重，运行时不持有任何
  API Key

## SenseVoice 模型（用户可选下载，不随安装包分发）
- 位置：`<userData>/voice-models/`（`AILEARN_VOICE_ASR_DIR` 可改到别处），
  由用户在「设置 → 伴星 → 声音与显示 → 语音输入」里自己下载
- 用途：本地 ASR。**这是语音输入唯一的识别路径**（2026-10：取消了 SiliconFlow
  云端转写这条兜底——本地失败时录音不再离开设备，界面改为提示去设置里下载模型）
- 许可：Apache-2.0（模型源自 FunAudioLLM/SenseVoice，经 sherpa-onnx 转换为
  ONNX int8；sherpa-onnx 官方模型页以 Apache-2.0 分发）
- 来源：https://github.com/FunAudioLLM/SenseVoice ；
  https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 ；
  https://modelscope.cn/models/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue
- 下载源：**按顺序回退**——先魔搭社区的 sherpa-onnx 导出，备用为 `hf-mirror.com` 和
  Hugging Face 官方库。连接超时或传输中断会换源；正式安装前校验文件大小与 SHA-256，
  两个文件的摘要与官方 2024-07-17 版本一致。`AILEARN_VOICE_ASR_SOURCE`
  （逗号分隔）可以整份换成自建镜像或内网制品库。
- 说明：**不随应用分发**（`electron-builder.yml` 显式排除 `out/renderer/models/`，
  打包冒烟有判据）。未下载时语音输入不可用，其余功能一律不受影响。

## SiliconFlow 云端转写（服务端，桌面客户端不再调用）
- 位置：`POST /voice/transcribe`（`apps/api/.../voice-providers/siliconflow-asr.ts`）
- 说明：服务端仍保留这条能力。**桌面客户端 2026-10 起不再调用它**——语音识别
  全部在本机完成，没有任何一条 IPC 能把录音送出去。本节仅为追溯来由而保留。
