# 手机端前端原型工程审计

> 路径更新：本原型已于 2026-10-12 迁至 `apps/mobile-client/prototype/`。下方正文中的 `apps/desktop-client/demos/...` 路径与行号是 2026-10-11 审计时点的记录，按原样保留，不再改写。

日期：2026-10-11。审计对象：[apps/desktop-client/demos/mobile-companion-layout.html](../../apps/desktop-client/demos/mobile-companion-layout.html) 及其同目录源码（`mobile-companion-layout.js` 108KB、`layout/theme/centers/scene.css` 与 `data/account/centers/motion/live2d/scene.js`）。

审计目的：方案 51 的 §14 验收记录目前全部由浏览器走查与 34–35 项本机测试提供。本轮先确认**这些记录能否作为决策依据**，再判断这份原型能否作为移动客户端的工程起点。

方法：只读源码逐行阅读 + jsdom 测试实跑 + 真实 Chromium（Playwright 1.62，本机 chromium-1194）在 `http://127.0.0.1:4196` 实测 DOM 与几何。**未修改任何原型文件。**

本记录中的 H1、H3、H6、M1 与测试结果由本轮独立复现；其余条目来自同一轮独立审计，证据路径已逐条列出。

---

## 一、结论

1. **两条 P0 验收声明与实际不符**（§二）。方案声称已通过的"字体放大 150%／热区 44px"与"键盘态看到上一条回复"，一条被隐藏封顶，一条靠切换视图绕开。
2. **这份原型不可能作为产品入口**（H1）。它硬依赖实验台 DOM，脱离实验台连构造器都跑不起来。
3. **"AI"不存在**（H2）。零业务网络调用，回复是正则 + 定时器 + 写死文案表。
4. **它还有会丢用户数据、会在切后台后永久失去伴星的缺陷**（H3、H4）。
5. 但同时，**若干局部实现是真的**（§五）：Live2D 真渲染、粒子真停、零横向溢出、账号真隔离、减少动态真尊重。
6. **测试环境被桩化到测不出上述缺陷**（§六），且已有测试把缺陷写成期望。

一句话：**问题不是"做得糙"，是"做得像样但不是真的"，而验收记录把这些当成了真的。**

---

## 二、验收声明更正（最需要决策者先看）

| 方案 51 §14.1 原文 | 实测 |
| --- | --- |
| "字体放大 **150%**、320px 宽下正文不被裁切且**关键操作热区不小于 44px**" | 四个 CSS 共 **308 处 `font-size`，仅 14 处**引用 `var(--text-scale)`（4.5%）。切到 150% 后：`.note-block p` 15→22.5px 生效，而 `.paper-subtitle` 12px、`.paper-meta` 10px、`.version-strip` 11px、`.evidence-band` 14px、`.tabbar button` 10px、`.message-meta` 10px 全部不变；`.paper h1` 被 `min(var(--text-scale),1.2)` 封顶在 **120%**（[layout.css:240](../../apps/desktop-client/demos/mobile-companion-layout.css)）。采样 16 个选择器只有 3 个响应。热区实测低于 44px 的有：`.dialogue-modes button` 38×36、`.scene-title button` 62×30、`.voice-side` 43×43、`.account-check` 32、`.key-row button` 36、`.compare-tabs button` 36 |
| "**抬起键盘后仍能看到上一条回复的一行**" | [scene.css:56](../../apps/desktop-client/demos/mobile-companion-scene.css) `.phone.keyboard-on.short[data-dialogue="scene"][data-screen="chat"] .scene-speech { display:none }` —— **默认的伴星视图在 320×640 + 键盘下把回复气泡整个隐藏**。而 [capture-mobile-companion-layout.mjs:96](../../apps/desktop-client/demos/capture-mobile-companion-layout.mjs) 在测这一条之前先 `assert.equal(g.mode,'history')`，只量了记录视图，因此该断言恒绿 |

键盘本身是模拟的：`--keyboard` = 屏高 × 32%（[layout.js:137](../../apps/desktop-client/demos/mobile-companion-layout.js)），全仓库 `visualViewport` **零命中**。320×640 键盘态实测阅读窗口 236px、390×844 为 406px；真机 iOS 640pt 屏键盘（含候选栏）通常 260–300px，比模拟值大 30% 以上。

**影响**：§14 的其余条目同样只由这套载体验证，其"已通过"结论需按同一标准重新分级。**在补上真机与真实链路证据前，§14.1 不应作为发布判断依据。**

---

## 三、高严重度缺陷

### H1 · 整个 App 硬依赖 demo 实验台 DOM，脱离实验台无法启动

构造、渲染、发送三条路径直接查实验台元素且无空值守卫：[layout.js:76](../../apps/desktop-client/demos/mobile-companion-layout.js)（构造器里 `#text-size`）、`:190`（`#metrics`）、`:468`/`:473`/`:794`（`#desktop-mirror`）、`:747`（`#offline-toggle`）、`:798-807`（`syncControls`），以及 **每次 `send()` 都读**的 `#failure-mode`（`:579-580`）。

复现：只保留 `#device`、删除 lab 与 mirror 面板 → `TypeError: Cannot set properties of null (setting 'value')`，栈为 `applyAccountPreferences(:76) ← new MobileApp(:62) ← (:960)`。只删 `#failure-mode` 后调用 `send()` → 抛错、**创建 0 个任务、无 toast、无错误 UI，消息被静默吞掉**。

**影响**：这份代码无法作为产品入口；迁入真实宿主的第一步就是全线崩溃。它现在"能跑"完全来自 [mobile-companion-layout.html](../../apps/desktop-client/demos/mobile-companion-layout.html) 里那套评审实验台。这也意味着 §10 声称的"App 与桌面共用可复用的内容块、附件签、交付回执与对照组件"在原型里没有任何对应实现——手机原型与桌面**零共享设计 token、零共享组件、零共享数据契约**（详见 [桌面基线](mobile-companion-desktop-identity-baseline-2026-10-11.md)）。

### H2 · 发送与执行链路没有任何模型调用

意图靠正则（[layout.js:566](../../apps/desktop-client/demos/mobile-companion-layout.js)），进度靠 `setTimeout(650/1550)`（`:594-600`），回复是写死文案表（`:652-664`）。可执行的"编辑"只有三种，其余一律抛错（`:642`）。业务侧 `fetch`/`XMLHttpRequest`/`EventSource` 命中数为 0，唯一网络调用是读 Live2D 模型清单。

**影响**：方案 §2.1 的闭环 A/B 在本原型中没有任何真实执行。演示能过是因为样例话术被正则覆盖。

### H3 · schema 不匹配时静默销毁用户数据，且测试把该行为写成期望

[data.js:42](../../apps/desktop-client/demos/mobile-companion-data.js) 校验失败即回落 `seed()`，而 [layout.js:86](../../apps/desktop-client/demos/mobile-companion-layout.js) `store.activate(...)` 紧接着 `:90 store.commit()` 把种子写回**同一个键**。

复现：键 `astella-mobile-data-user-realuser` 写入 `{schema:4, 含"我的真实笔记"}` → 重新加载后 `notes: []`、会话为空，**用户内容不可恢复**。

更严重的是 [mobile-companion-data.test.cjs:77-83](../../apps/desktop-client/demos/__tests__/mobile-companion-data.test.cjs) 用例名 `malformed local storage recovers to usable demo facts`，把这个行为固化为期望——**修好反而会让测试变红**。

### H4 · Live2D 在 `pagehide` 后永久死亡；`webglcontextlost` 在 dispose 后抛异常

[layout.js:68](../../apps/desktop-client/demos/mobile-companion-layout.js) 在 `pagehide` 直接 `scene.dispose()`，`disposed=true` 不可逆，且**没有任何 `pageshow` 重建**。[live2d.js:58](../../apps/desktop-client/demos/mobile-companion-live2d.js) 的 `dispose()` 不移除 `webglcontextlost` 监听（`:12`），`fail()`（`:57`）会对已销毁的 PIXI Application 调 `stop()`。

实测：派发 `pagehide(persisted)` → `pageshow(persisted)` 后 600ms → `{state:'unavailable', disposed:true, hostInDom:false}`，座位仍在但 canvas 消失，`data-live2d` 仍是脏的 `"ready"`；同时捕获到真实未捕获异常 `TypeError: Cannot read properties of null (reading 'stop')`，栈为 `pixi.min.js ← Live2D.fail(:57) ← webglcontextlost(:12)`。

**影响**：移动端切后台/切标签/GPU 上下文丢失（Android 常见）后伴星永久消失且无重试。§0 第 17 条把"默认动态 Live2D"写成产品决定，这条缺陷直接决定该决定能否成立。

### H5 · 附件整包同步写入 sessionStorage

[layout.js:96](../../apps/desktop-client/demos/mobile-companion-layout.js) `saveUI()` 把整个 `this.ui`（含附件 data URL）`JSON.stringify` 后写 sessionStorage，而它在 `render()` 末尾被无条件调用（`:189`），每次输入也调（`:770`）。实测 2.8MB 附件 → 单次写入 **2,800,326 字符**；`:547` 允许 2MB 图，base64 后约 2.7M 字符，已逼近 5MB 上限，第二张图必超限；`:96` 的 `catch {}` 静默吞掉 `QuotaExceeded`，草稿从此不再持久化且无提示。

### H6 · 150% 字号只作用于 4.5% 的排版

见 §二。根因是 `--text-scale` 是唯一字号适配机制（无 rem/em 体系），而绝大多数 `font-size` 是硬编码 px。

---

## 四、中严重度（摘要）

| 编号 | 问题 | 证据 |
| --- | --- | --- |
| M1 | 假键盘用屏高 32% 顶替真实键盘，全仓库无 `visualViewport`；320×640 键盘态回复气泡被 `display:none` | [layout.js:137](../../apps/desktop-client/demos/mobile-companion-layout.js)、[scene.css:56](../../apps/desktop-client/demos/mobile-companion-scene.css) |
| M2 | 语音进行中按 Esc 关不掉面板（实测：语音被结束、面板仍开着） | [layout.js:786](../../apps/desktop-client/demos/mobile-companion-layout.js) |
| M3 | `aria-live` 区域每次 render 重写 → 连续 5 次 render 产生 5 条 mutation，读屏重复播报 | [scene.js:62](../../apps/desktop-client/demos/mobile-companion-scene.js) |
| M4 | 用 `role=tablist/tab` 承载整页导航，无 tabpanel；切详情时整个 tablist 被移除 | [layout.js:426](../../apps/desktop-client/demos/mobile-companion-layout.js) |
| M5 | 程序化 focus 让笔记标题被画出 2px 焦点环（把非交互标题画成控件） | [layout.js:187](../../apps/desktop-client/demos/mobile-companion-layout.js) |
| M6 | 每个按过的按钮永久留下 inline `transform: scale(1)`（含层叠上下文副作用） | [motion.js:104-112](../../apps/desktop-client/demos/mobile-companion-motion.js) |
| M7 | `Motion.cancel()` 丢弃 done 回调（WAAPI 取消不触发 finish） | [motion.js:80](../../apps/desktop-client/demos/mobile-companion-motion.js) |
| M8 | CSS 两遍覆盖：单文件内 45 个选择器重复声明，跨文件 176 个；`.glass` 在 4 个文件各写一遍 | [layout.css](../../apps/desktop-client/demos/mobile-companion-layout.css) 等 |
| M9 | 登出不清数据；账号表明文存着可推导数据键的 salt → 共用设备上可读到他人全部笔记 | [account.js:55](../../apps/desktop-client/demos/mobile-companion-account.js) |
| M10 | 本机 Store 的键与真实服务端契约脱节（`schema` 当兼容开关、`revision` 当版本号，无增量与冲突令牌） | [data.js:40-49](../../apps/desktop-client/demos/mobile-companion-data.js) |
| M11 | 每次登出都把空 store 提交到 `-guest` 键 | [layout.js:86](../../apps/desktop-client/demos/mobile-companion-layout.js) |
| M12 | `env(safe-area-*)` 全仓库仅 1 处且在 `≤700px` 媒体查询内；inset 只加在 `height` 而非 padding，状态栏文字仍落在刘海下 | [layout.css:367](../../apps/desktop-client/demos/mobile-companion-layout.css) |
| M13 | 多处点击目标 30–38px（见 §二）；主要控件 44×44 达标 | 各 CSS |

---

## 五、已核实为真实可用的部分（避免误伤）

- **Live2D 确实接入并渲染**：`data-live2d === "ready"`，canvas 实测 49.4% 像素被绘制；模型清单门禁字段（`status:"production"`、`ownerApproved.by:"Owner"`、`modelLicense.commercialReleaseAllowed:true`）与 [live2d.js:48](../../apps/desktop-client/demos/mobile-companion-live2d.js) 的三个条件一致；vendor 为 PIXI 6.5.10 + pixi-live2d-display 0.4.0，API 用法正确。
- **粒子循环在 Off／开面板／隐藏时真的停**：实测 `{activePerSec:144, sheetOpenPerSec:0, motionOffPerSec:0, hiddenPerSec:0}`，且每帧恰好一次绘制、无重复链（[scene.js:18-19](../../apps/desktop-client/demos/mobile-companion-scene.js)）。
- **零横向溢出**：320/360/390 × 100%/150% 下七个页面 `scrollWidth - clientWidth` 全为 0，逐元素扫描无越界。
- **账号之间数据真隔离**：实测 B 看不到 A 的笔记；登出后的 `-guest` 键为空。
- **`prefers-reduced-motion` 被真正尊重**：实测 `motion.off === true` 且开面板时 `motion.running.size === 0`。
- **主要控件点击目标达标**：`.icon-button` 44×44、`.tabbar button` ≥44、`.message-actions button` 44×44、`.password-eye` 44×44。
- **测试实跑结果**：35 通过 / 0 失败 / 0 跳过（data 8、motion 12、account 8、scene 7），约 232 处断言。其中 data 与 account 两组多数是真行为断言（回执重放不重复建笔记、不可变历史、过期替换被拒、只读空间拒写、明文密码不入存储、账号隔离）。

---

## 六、测试真实性：桩把缺陷挡住了

[mobile-companion-test-env.cjs:11-17](../../apps/desktop-client/demos/__tests__/mobile-companion-test-env.cjs) 做了四个关键替换，导致真实失败路径无法被测出：

| 桩 | 后果 |
| --- | --- |
| `ResizeObserver` 空实现 + `#device` 硬编码 390×844 | `updateSizeClasses()` 永不触发，`narrow`/`short` 分支在测试里**从未生效**；320px 与短屏路径 0 覆盖（所以 §二的两条缺陷测不出来） |
| `Element.prototype.animate` 返回永不触发 `onfinish` 的假对象 | 任何"动画结束/被取消"的后果都观察不到，M6/M7 测不出来；`motion.test.cjs:87-90` 直接断言自己刚传进去的关键帧数组——**断言的是输入，不是结果** |
| `matchMedia` 恒返回 `matches:false` | `prefers-reduced-motion` 分支从未被测；测试里的"关闭动效"是手动加 class，与系统偏好路径不同 |
| 测试环境自带完整 lab panel | H1 的耦合被测试环境喂好了，**永远不会被测出来** |

另有两条把缺陷写成期望的断言：`data.test.cjs:77-83`（H3）与 `scene.test.cjs:46-49`（把"每帧 900 次 arc"固化成需求，调小反而失败）。`scene.test.cjs:20-30` 断言的"两个问题"、`account.test.cjs:70-79` 断言的"先复述再核对原文"，都是 `layout.js:659/671` 写死的字符串——只证明拼接逻辑通，不证明 AI 存在。

**结论：35 项通过不能作为质量证据。** 修 §三、§四任何一条之前，先修这四个桩，否则测试会继续为缺陷背书。

---

## 七、复现方式

```sh
# 测试（真实结果 35/0）
cd /Users/asklins/Documents/asklins_workspace/study
node --test apps/desktop-client/demos/__tests__/mobile-companion-data.test.cjs \
  apps/desktop-client/demos/__tests__/mobile-companion-motion.test.cjs \
  apps/desktop-client/demos/__tests__/mobile-companion-account.test.cjs \
  apps/desktop-client/demos/__tests__/mobile-companion-scene.test.cjs

# 可复现浏览器走查（5 项检查全过）
python3 -m http.server 4196 --bind 127.0.0.1 --directory apps/desktop-client
node apps/desktop-client/demos/capture-mobile-companion-layout.mjs
```

环境注记：`capture-mobile-companion-layout.mjs` 在本机**需要兜底才能跑**——playwright 1.62 期望 `chromium_headless_shell-1234`，缓存里只有 1194。用 `ASTELLA_LAYOUT_BROWSER=$HOME/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium` 指向已有二进制后可正常运行，5 项检查全部通过。方案 51 的 [Demo 说明](../plans/learning-companion/assets/51-mobile-companion/README.md) 记的是"本轮仅做语法检查"，本轮补上了实跑。

---

## 八、未确认

- 真机行为全部未验证：原生键盘、安全区真值、Live2D 在移动 GPU 上的帧率与内存、音频中断、后台生命周期、触摸手势。
- 移动宿主、跨端框架、分发形态、拟人化合规归类均未决定（方案 51 §13 阶段 0、§15）。
- 竞品事实未联网复核，§16.5 的待实测项仍开放。
