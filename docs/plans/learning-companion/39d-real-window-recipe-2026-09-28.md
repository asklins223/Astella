# 真窗口验收：可复跑的配方与本轮实测（39d W6-3 的前置）

> 日期：2026-09-28　｜　对应：[39d 台账](./39d-implementation-task-breakdown-2026-09-24.md) W6-3
>
> **这份文档取代的是「本机没有真窗口会话」那条结论。那条结论是错的。**
> 本轮真的把窗口起起来了、真的登进��、真的截了图。
> 下面每一段都是**本轮实跑出来的**，不是照文档推的。

---

## 0. 一分钟配方（本轮实测走通）

```bash
cd apps/desktop-client
set -a; . ../../.env; set +a          # ① 必须：不加载它，登录页会报「本机服务校验」
env -u ELECTRON_RUN_AS_NODE \        # ② 必须：不摘掉它，electron 退化成纯 node
  ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  ./out/main/index.js --remote-debugging-port=9336
```

**四个必须，一个都不能少**——每一处缺了之后的症状都**不指向自己**：

| 缺哪一处 | 症状 | 为什么不像自己 |
| --- | --- | --- |
| `set -a; . .env` | 登录页写「桌面端尚未通过本机服务校验，当前不能读取真实学习数据」 | 那句话谈的是**信任**，而真因是 `AILEARN_DESKTOP_PAIRING_*` 根本没进环境 |
| `env -u ELECTRON_RUN_AS_NODE` | 进程即退、**日志一个字都没有** | 无输出读起来像"环境坏了"，而真因是这个变量让 `electron.protocol` 变 undefined |
| `--remote-debugging-port`（**连字符**） | 窗口起得来、**9222/933x 全无监听** | 写成等号形式 `--remoteDebuggingPort=` 是**静默失效**的，不报错 |
| 直接跑 `out/main/index.js` | `./node_modules/.bin/electron .` 会即退 | 两条路的失败**长得一模一样**（空日志），而 shim 那条我试了两次都没成 |

**不要抢端口。** 5173 上有并行会话的 vite；`ELECTRON_RENDERER_URL` 指向自己的端口也对，
但本轮**没有用**它——默认加载 `out/renderer/index.html` 就够了，而那个产物是 09-27 21:57 的。
**驱动陈旧产物会照出假问题**（队友那一轮就照出过"W7-4 两个面被压成 23px 细条"，
真因是 `.home-recovery` 是一个默认折叠的 `<details>`，**不是**布局缺陷）。

**API 侧**：`apps/api` 默认 `127.0.0.1:4000`。本轮 4000 上**已经有另一个会话的 API**，
我这份起成了 `EADDRINUSE`——**不需要再起一个**，`/health` 返回 ok 就够了。

---

## 1. 怎么驱动（CDP，两行）

```bash
# 列出窗口
curl -s http://127.0.0.1:9336/json/list
# 读 DOM：Runtime.evaluate + returnByValue
# 截图：Page.captureScreenshot（png，本轮一张 ~4.2MB）
```

**填表单要动原生 setter**，直接给 `input.value` 赋值 React 收不到：

```js
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
el.dispatchEvent(new Event('input', {bubbles: true}));
```

---

## 2. 本轮真的看见了什么

![书桌](attachment://desk)　![星窗](attachment://star)

| AGENTS.md 那一条 | 实测 | 证据 |
| --- | --- | --- |
| 暖木书房、奶油纸面、不规则柔圆角 | ✅ | 暖木地板、拱窗、书架、地毯；无任何后台面板语言 |
| **伴星常驻** | ✅ | Live2D 画布 **265×367**、`display:block`、`visibility:visible`、`opacity:1`；麦克风／键盘／「…」三颗动作钮在她手边 |
| 不得挤出窗口／不得只留导航钮 | ✅ | 1440×810 视口下伴星完整在画面内 |
| 不是表格优先的管理侧栏 | ✅ | 四个空间入口（书桌／书架／星窗／休息角）折叠成**左下角一颗圆钮**（`aria-label=学习空间目录`，54×54），不是常驻分栏 |

**导航的形状要记下来，免得下一个人误判**：它**默认收着**。DOM 里 `nav` 有三个——
一个 44×148 是伴星那三颗动作钮，一个是 `display:none` 的文字目录（给读屏用的），
一个 54×54 是左下角那颗圆钮。**"看不见导航"不是缺陷，是收着。**

**内容面也是抽屉**：星窗点开之后，底部一条横排是「当前学习卡／理解星图／小屋可用」，
**星图本身没有在房间里展开**——那是另一个动作。
所以「截到图里只有房间」**不能**读成"页面没内容"。

---

## 3. 本轮**没有**验到的（不许算通过）

- **W8-1 星图三层**：`w8-layers` 仍在做，而且我驱动的是 **09-27 的陈旧产物**——即使它做完了，
  我这张截图也不能用来判它。等产物重建之后再验。
- **W8-2 关系纸签的乐观更新与 ETag 旁注**：同上。
- **真模型产出的动态演示在窗口里的样子**：产物没重建。
- **作答页那条提示词约束在屏上的效果**（"现在不提供标准答案，但可以陪您一起分析这个问题"）：
  需要真的进一次作答页并让她回答，本轮没走到。
- **紧凑视口／减少动效下的座位预算**：只测了 1440×810 一档。

---

## 4. 给 codex 的验收剧本怎么改

原先 [39d-w64-real-window-acceptance-script-2026-09-27.md](./39d-w64-real-window-acceptance-script-2026-09-27.md)
里有一条"前置：需要一台能起真窗口的机器"——**删掉它**，按本文第 0 节走。
其余八条（精确选择器、期望文案、阳性对照）原样保留。

**加一条通用前置判据**（每条用例都要先过它，否则后面读到的都是假象）：

> 先量三样：① 伴星画布的 `getBoundingClientRect()` 与 `display/visibility/opacity`；
> ② `out/renderer/index.html` 的 **mtime**（陈旧产物 ⇒ 所有视觉结论作废）；
> ③ 导航是收着的（`学习空间目录` 那颗圆钮）——找不到导航先展开它，不要记成"没有导航"。

---

## 5. 一次只改一个变量

队友那一轮的教训，原话照抄：**「两个都改就又变成『我以为我量的是我以为的那个东西』」。**
本轮四次失败（`electron .` 两次、`--remoteDebuggingPort=` 一次、不加载 `.env` 一次）
**症状两两相同**——都是"空日志／进程即退／读不到数据"。
只有一次只改一个变量，才量得出"到底缺哪一样"。
