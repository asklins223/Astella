# iOS 伴星 Live2D 常驻动态与共享模型（2026-10-22）

> 2026-10-23 最新决定已覆盖本文最后的“移除所有身体角度”、7–15 秒轮播、点击随机换表情＋定向视线＋整体缩放。当前实现恢复桌面同款的物理输入，临时参数不再回存，详见 [自然动态与点按归位](ios-companion-motion-parity-2026-10-23.md)。下文作为此前问题的追溯记录，不作为当前实现依据。

## 用户现场

用户在 iPhone 17 / iOS 27 模拟器上验收伴星：

- 首页舞台的伴星不会持续动；只有说话时口型动一下、随后短暂动一下，接着又静止。
- 右下角常驻伴星图标同样不动。
- 用户要求所有「截取的伴星图标」都使用同一个 Live2D 模型，并且一直在动。

## 根因（三处叠加，缺一不可）

1. **本地模型清单一读就失败。** `ModelDownloadManager` 写 `local-manifest.json` 时用
   `JSONEncoder.dateEncodingStrategy = .iso8601`，读回来却是默认的
   `.deferredToDate`。ISO 字符串被当成秒数解码直接 throw，`readLocalManifest`
   永远返回 nil：
   - 示例 / 离线模式找不到完整缓存 → `state = .failed` → 舞台与图标都回落 PNG，
     看起来像「一张不会动的立绘」；
   - 真实账号每次启动都判定版本不完整 → 重新下载整套模型（约 4 MB / 41 个文件）。

2. **whale 模型自带的 Idle motion 不演身体。** 解析 `motions/idle.motion3.json`
   的 89 条曲线：只有道具/贴纸参数（花、星、泡泡、猫手、`Param_Angle_Rotation_*_xk4`
   等），`ParamBreath`、`ParamAngleX/Y/Z`、`ParamBodyAngleX/Y/Z`、眨眼参数一条都没有。
   所以 motion 虽然在循环，角色本体和呼吸是一动不动的——桌面端同样遇到这个问题，
   因此在 `window-live2d-contract.ts` 里自己发 `ParamBreath` 与 `ParamBodyAngleX`
   （`IDLE_BODY_ANGLE_SWAY_DEGREES = 2`）。

3. **首帧 delta 是「整个 Unix 纪元」。** `LAppPal::UpdateTime` 的 `s_lastFrame`
   初值为 0，第一次 `GetDeltaTime()` 得到约 `1.7e9` 秒。循环 motion 的时间回绕、
   呼吸与物理都被这一脚踢飞（日志里 `time=1792682752.00` 就是它）。

## 实现

- `ModelDownloadManager.readLocalManifest` 与写入同构使用 `.iso8601`；缓存可读后
  离线兜底与「不重复下载」同时恢复。
- `LAppModel::ApplyBlendOverrides` 增加常驻微动层（桌面端同款幅度、不同周期错开）：
  - `ParamBreath = 0.5 + sin(t / 0.9s) * 0.25`
  - `ParamBodyAngleX = sin(t / 2.4s) * 2°`
  - `ParamAngleX = sin(t / 3.9s) * 2.5°`，`ParamAngleY = sin(t / 5.3s) * 1.5°`，
    `ParamAngleZ = sin(t / 6.1s) * 1.2°`
  - 微动时钟 `_idleTimeSeconds` 独立从 0 累计；`reduceMotion` 静帧路径把上述参数归中。
- `LAppPal::UpdateTime` 首帧 delta = 0，并把单帧步长夹在 100 ms 内，后台恢复不会瞬移。
- 新增 `CompanionLive2DHost`（`Companion/Cubism/Live2DRenderView.swift`）：
  - 舞台、右下角图标、迷你对话头部共享同一个 `CubismBridge` / `LAppModel`；
  - 宿主按「活跃 + 优先级（迷你对话 > 图标 > 舞台）」选唯一渲染视图，其余视图暂停；
  - 模型只加载一次：切换展示位走 `attachView:` / `detachView:`，不重新解析 moc3
    与纹理，切页不闪烁，也避免每个图标各跑一条 60fps 循环；
  - 视图 `active == false`（离屏、后台、记录页）时释放渲染权，模型停帧。
- `CubismBridge.loadModelAtRoot:entry:` 幂等（同一版本重复调用直接复用）。

## 验证

模拟器：iPhone 17 / iOS 27（`Astella Companion QA`，`simctl` 截图 + 统一日志）。

- **舞台持续动**：同机型连续截图间隔 0.5 s，模型区域变化 **100k+ 像素/帧**
  （修复前同一间隔为 0）。日志每秒打印 `p_body ∈ ±2`、`p_breath ∈ 0.25…0.75`、
  `geom` 每秒变化。
- **右下角图标持续动**：`--ui-review=library` 下图标区域截图间隔 0.5 s 变化
  3k–4k 像素，持续出现。
- **共享同一模型**：整个 App 生命周期内 `[APP]load model setting` 只出现 **1 次**；
  舞台与图标两个展示位由同一个宿主持有，绘制尺寸随展示位切换。
- **构建**：`python3 scripts/ios-dev.py build`（Xcode Debug / 模拟器）通过；
  增量构建约 20–40 s，无新增编译错误。

## 追加修复（2026-10-23）：右下角图标的裁切与可感知度

用户在真机/模拟器复查后反馈：小伴星「截取的不对」，而且看起来还是不会动。

- **裁切不对**：旧裁切参数是把模型放大 4.2 倍再取圆心，58 pt 的图标只截到一张脸——
  呆毛和下巴都被切掉。按舞台渲染实测头部在模型视图里的归一化位置
  （呆毛顶 y≈0.168、下巴 y≈0.541、眼线 x≈0.485、头部宽≈视图宽的 0.472），
  重新计算为：视图 `size×1.584`（高 `×1.584/0.82`），偏移 `(+0.024, +0.281)×size`，
  让整个头部约占图标 72%、头顶留 14%、下巴落到 86%，横向 75%。
- **看起来不会动**：微动本身在跑（同一时间截图可测到 3–6k 像素变化），但 4.2 倍裁切
  只剩一张脸，2° 的摆幅落在这个小区域里只有几个像素，容易被看成静止。除修正裁切外，
  把常驻微动幅度略微调大（body 2.6°、AngleX 3.5°、AngleY 2.0°、AngleZ 2.2°、
  breath ±0.28），小图标也能明显看到起伏。

截图为同一台模拟器、同一套模型：修复前只截到脸，修复后是完整头部。

## 追加（2026-10-23 晚）：动作轮播、触碰反馈与道具归位

用户在真机复查后又提出两点：头部还是不动（只有尾巴动），并明确「应该是动作轮播，默认是
待机动作」，同时要求「触碰伴星要变化表情」。

**为什么只有尾巴动**：whale 的 `Idle` 动作只写道具参数；模型本身也没有把头部/身体旋转
绑到 `ParamAngle*` / `ParamBodyAngle*` 上。用运行时探针把 `ParamAngleX` 拉到 60°、
`ParamEyeLOpen` 设 -1、`ParamMouthOpenY` 设 1 后截图：眼睛和嘴立刻变化，头部完全不旋转
——说明这些角度参数只是物理/发丝的输入，不是头部旋转的驱动参数。客户端看起来「头在
动」，来自同一套**表演轮播**：除待机动作外的全部动作与全部表情按 7–15 秒轮播，表情会
改眼睛/眉毛/嘴/贴纸，`Selfie` 动作还会做一整套动作与手机道具。

**实装**：

- `LAppModel` 新增待机轮播，与桌面端 `WindowLive2DPerformanceRotation` 同一套节奏：
  表演池 = 除 Idle 外的全部动作（Bubble / Spray / Selfie / SelfieQuick）+ 全部表情，
  共 34 条；洗牌袋轮播、不连续重复；新模型上场 4s 后开演，之后每 7–15s 一条；表情停留
  5s、动作让位 3.5s，默认回到 Idle 循环。
- **道具归位层**：轮播动作演完（按 motion3.json 的 Duration）后，把这条动作写过的参数
  在 0.35s 内淡回模型默认值——`phone`、`pengshui`、`chuipaopao` 这类「整活参数」不会
  永久挂在身上（桌面端同样有一层 motionSpecs 归位）。
- **触碰反馈**：点舞台伴星 → `.poke`：立刻换一张随机表情（停留 5s）+ 视线偏移 +
  SwiftUI 0.95 → 1.035 → 1 的轻弹 + 轻触反馈；右下角图标的点按仍是打开迷你对话。
- 交付层表情（事件/段语义）占用表情槽时，轮播会主动让位 2s 再试，不抢同一张脸。

**验证**（iPhone 17 / iOS 27 模拟器）：

- 日志 `performance pool: 34 cues`；实测轮播按 7–15s 出现：`SelfieQuick_0`、`Bubble_0`、
  `glasses-oval`、`cat-paw`、`whale-on-head`、`sun sunglasses`、`starstruck`、`dizzy`、
  `flowers`、`cry` 等，动作与表情交替。
- 截图可见猫爪/星星眼/鲸鱼贴纸/墨镜等表情变化；台词气泡与口型逻辑不变。
- 道具归位层实测：`phone` / `phone3` 等参数在动作结束后回到默认值（顺带确认：角色手里
  那台粉色手机是模型自带的默认艺术，不是动作残留；`Selfie` 动作只是把它举起来）。
- 探针与强制动作入口（`ASTELLA_LIVE2D_PROBE` / `ASTELLA_LIVE2D_FORCE_MOTION`）只用于
  开发验证，验证完已从代码移除。

## 截图

| 截图 | 说明 |
| --- | --- |
| [before-static.png](assets/ios-companion-live2d-2026-10-22/before-static.png) | 修复前：模型能渲染，但本体完全静止（同一间隔 0 像素变化） |
| [after-stage-alive.png](assets/ios-companion-live2d-2026-10-22/after-stage-alive.png) | 修复后：首页舞台持续摆动 / 呼吸 |
| [after-dock-alive.png](assets/ios-companion-live2d-2026-10-22/after-dock-alive.png) | 修复后：右下角图标用同一个共享模型，持续摆动 |
| [before-dock-crop.png](assets/ios-companion-live2d-2026-10-22/before-dock-crop.png) | 修复前的图标裁切：只剩一张脸，呆毛与下巴被切掉，看起来像静止 |
| [after-dock-crop.png](assets/ios-companion-live2d-2026-10-22/after-dock-crop.png) | 修正裁切后的图标：完整头部、留白均匀，并继续共享同一个模型摆动 |
| [after-performance-glasses.png](assets/ios-companion-live2d-2026-10-22/after-performance-glasses.png) | 动作轮播：同一秒内左侧角色戴着「椭圆眼镜」表情，右侧已回到中性脸 |

## 追加（2026-10-23）：与桌面客户端对齐的「摇头晃脑 / 耳朵」验证

用户坚持「桌面客户端的头部和身体都会动」，所以我直接把桌面客户端跑起来对照：

- 用仓库根 `.env` 里的 owner 凭据启动 `apps/desktop-client`（Electron），登录后
  同伴动画状态为 `live2d / ready / idle`；以 200ms 间隔连拍 25 帧，测量头部发丝
  质心位移：**5 秒内 dx ≈ 10–12px、dy ≈ 8–10px**（canvas 宽 490px），即约 2% 模型
  宽度的可见摆动——这就是用户说的「摇头晃脑，耳朵也会动」。
- 逐参数探针确认：桌面端只写 `ParamBreath`（±0.25）与 `ParamBodyAngleX`（±2°），
  头部旋转靠 **physics3**（`ParamBodyAngleX → Param14/Param13`、`ParamAngle* →
  ParamHairFront*`）驱动发丝/耳朵；`ParamAngleX` 直接拉到 60° 反而画面不动（它只是
  物理输入，不是头部旋转绑定）。移动端此前的真正 bug 是：常驻微动层写在
  `SaveParameters()` 之后且没有回存，下一帧 `LoadParameters()` 又把它抹掉——**物理
  层永远收不到身体角度**，于是只剩尾巴/道具在动。
- 修复：`ApplyBlendOverrides` 末尾补一次 `SaveParameters()`，让微动写回成为下一帧
  物理输入。参数幅度**完全对齐桌面端**：只写 `ParamBreath`（0.5±0.25，0.9s 周期）与
  `ParamBodyAngleX`（±2°，2.4s 周期）。
- 回归教训：中途曾把幅度加大到 `ParamAngleX ±4° / BodyAngleZ ±2°` 等，画面出现
  「眼睛歪了、不会眨眼/表情僵住」的现象——physics3 里 `ParamAngleX/Y/Z` 是
  `Param102…109`（眼睛/眉毛部件）与 `ParamHairFront*` 的输入，额外写头部角度会把
  眼睛部件推歪。恢复成桌面端同样的两个参数后眼睛、眉毛、发丝都正常，身体/头部的
  摆动也由物理层算出来。
- 观察：桌面的同款「表演轮播」+ 物理摆动在移动端已复现；额外加了触碰表情反馈。

## 追加（2026-10-23 晚二）：整活道具归位（手机 / 泡泡糖不再一直挂着）

用户复查时指出：手机、泡泡糖这类道具在动作演完后一直挂在身上，切表情也不掉，桌面端不会这样。

桌面端的做法不是「演完清一次」，而是常驻一层**整活参数归位表**：把「除待机动作外的所有动作」
动过、而待机动作不碰的参数收集起来，逐帧写回模型默认值；只有某条动作正在演的那几秒，才把
它的参数临时让出来。我们之前的实现只做了一次淡出，而参数是「上一帧存档、这一帧还原」的，
一次写入撑不过下一次 `LoadParameters()`，所以等于没清。

实装（与桌面端对齐）：

- `SetupModel` 时构建归位表：遍历全部 motion3.json，收集非 Idle 动作的参数，排除 Idle 动作
  自己写的参数，以及眼睛/眉毛/角度/身体角度/呼吸/口型/发丝/嘴型/腮红等逐帧层参数 →
  实测 14 个整活参数（`phone*`、`pengshui`、`chuipaopao*` 等）。
- 每帧在覆写层里把这些参数写回模型默认值；某条动作开始演时，把它动过的参数加入
  「正在播放」集合，按 motion3 的 Duration 让位；演完让位结束，归位层重新拿回控制权。
- 覆写层末尾补一次 `SaveParameters()`（上一轮已加），保证归位值能进入下一帧。

验证：日志 `gag reset layer: 14 parameters`；连拍观察 `SelfieQuick_0`（举手机）与 `Spray_0`
（喷水）演完后的画面：**粉色手机与口香糖气泡都已消失**，之后的轮播表情（鲸鱼贴纸、眼镜、
猫爪等）正常出现和消退。[截图](assets/ios-companion-live2d-2026-10-22/after-gag-reset.png)。

## 最终决定（2026-10-23 晚三）：不要人为的转头

用户验收后明确：「恢复正常，不要再上下左右不自然地转头」。因此常驻微动层最终只保留
模型自带的呼吸起伏：

- 只写 `ParamBreath = 0.5 + sin(t/0.9s) × 0.25`（通过 physics3 带动胸口/尾巴的自然起伏）。
- **不再写任何头部/身体角度**（`ParamAngle*`、`ParamBodyAngle*` 全部移除）。这些参数是
  physics3 里眼睛/眉毛部件（Param102…109）与发丝（ParamHairFront*）的输入，人为写会
  造成「眼睛被推歪、上下左右转头」。
- 眨眼、表情、道具、待机动作仍各自由对应层负责；表演轮播（7–15s）、触碰换表情、
  整活参数归位保持不变。

验证：连续截图里头部与脸的位置基本不动（无转头）；第三帧出现轮播抽到的「椭圆眼镜」
表情，5 秒后自动退掉；尾巴随呼吸轻摆。[截图](assets/ios-companion-live2d-2026-10-22/after-no-artificial-sway.png)。

## 未覆盖 / 限制

- 未上实体 iPhone：帧率、耗电、真实 Metal 表现未验；演示与日志只证明渲染循环、
  几何与画面都在变化。
- 未复跑真实账号后端链路：本机没有可用会话 token，验证使用示例模式 + 本机缓存
  模型；渲染路径与真实账号一致（同一 `CompanionLive2DHost`）。
- 弹窗/迷你对话头部的「优先级接管」只做了静态代码核对与图标/舞台两处实测，
  未在自动化里连续切换「迷你对话打开 → 关闭 → 再开」。
- 消息列表、灵动岛等位置仍是静态头像图：它们是 16–24 pt 的小头像，逐条挂 Metal
  视图成本高且与本次「会动的伴星」目标无关；如需要再单独排期。
- Android 端未改。
