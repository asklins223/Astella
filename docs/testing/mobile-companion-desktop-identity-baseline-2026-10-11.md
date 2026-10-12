# 桌面端身份基线（供手机端对照）

> 路径更新：本原型已于 2026-10-12 迁至 `apps/mobile-client/prototype/`。下方正文中的 `apps/desktop-client/demos/...` 路径是 2026-10-11 记录时点的对照，按原样保留。

日期：2026-10-11。本记录建立"桌面端当前真实体验"的事实基线，用途是判断手机端前端原型是否延续了同一产品身份。**只读核对，未修改任何文件。**

产品依据：`AGENTS.md`「温暖、有物件感的纸面与**旁边的** Live2D 伴星构成身份」；`DESIGN.md`「有生命的纸上书房……伴星**在身旁**」「让文字、操作与伴星**共同进入构图**」。

---

## 一、桌面端是什么

**主窗口结构**（[App.tsx:121-146](../../apps/desktop-client/src/renderer/src/App.tsx)，z 序自下而上）：全出血书房房间（`.scene-stage`）→ 伴星常驻叠加层（`.companion-presence`，`inset:0`、`pointer-events:none`，在 App 里挂载一次，页面切换不重挂）→ 房间 chrome（左栏 + 顶部控件）→ 纸面（`TaskSurface`）。

**页面注册表是单一真理源**：[hud-pages.ts](../../apps/desktop-client/src/renderer/src/components/hud/hud-pages.ts)，22 个 `HudPageId`，每页声明伴星策略（mode / seat / framing / interaction / proactive / draggable）。

**主导航**：[DirectoryRail.tsx:47-70](../../apps/desktop-client/src/renderer/src/components/DirectoryRail.tsx) 十项（首页/来源/笔记/学习卡/星图/今日学习/复习/搜索/伴星/设置）。

**输入模型**：读、问、写、复习。笔记阅读页是主体（一张纸占满版心，四页纸 + 三视图）；"问"是一条贴在右缘的 **288px 窄栏**（`outputs/audit-20261011/interactions.md` 实测 `x:1122,y:436,w:288,h:40`），**不是全屏对话页**。

---

## 二、伴星"在纸面旁边"是有硬代码证据的

- **常驻叠加层，不占布局流**：[CompanionPresence.tsx:84-93](../../apps/desktop-client/src/renderer/src/components/companion/CompanionPresence.tsx) 注释明写 "a single persistent overlay mounted once in App, never remounted by page switches"。
- **三档小人尺寸**（不是主体）：首页全身 `clamp(214px,17vw,286px) × clamp(300px,42vh,400px)`（[home-v2.css:30-34](../../apps/desktop-client/src/renderer/src/components/home-v2/home-v2.css)）；任务页半身 `clamp(184px,17vw,252px) × clamp(246px,40vh,350px)`（[companion-root.css:30-35](../../apps/desktop-client/src/renderer/src/components/companion/companion-root.css)）；笔记全屏 `clamp(130px,14vw,205px) × clamp(140px,30vh,250px)`。
- **版心反过来给她让位**：[use-companion-seat-budget.ts](../../apps/desktop-client/src/renderer/src/components/companion/use-companion-seat-budget.ts) 实测角色 + 控制列包围盒，把 `--companion-seat-right/left/...` 写到根上；[hud-surface.css:205-255](../../apps/desktop-client/src/renderer/src/components/hud/hud-surface.css) 消费这些变量：右座页 `right: var(--companion-seat-right, 245px)`、左座页 `left: var(--companion-seat-left, 365px)`、伴星缺席回到 88px 基线，让位有 420ms 过渡。
- **交互台从不接管正文**：[CompanionHud.tsx](../../apps/desktop-client/src/renderer/src/components/companion/CompanionHud.tsx) 四个 44×44 圆钮贴角色身侧（基础 `left:-48px`，任务页收进 `left:12px`），展开面板最大宽 `min(340px, calc(100vw - 28px))`，始终是一张小纸。

**结论：桌面端"纸面为主 + 伴星在旁 + 版心让位"是已实现的机制，不是文案。**

---

## 三、视觉语言

母本 = [hud-pages.css:31-52](../../apps/desktop-client/src/renderer/src/components/hud/hud-pages.css) 的 `:root{--hud-*}`：

```
--hud-ink:#30231a   --hud-soft:#705d4d
--hud-paper:#f5ead5 --hud-paper-light:#fff9eb --hud-paper-deep:#e8d4b1
--hud-clay:#bd5a31  ← 主强调色（暖陶土）
--hud-line:rgba(73,47,29,.22)  --hud-line-strong:rgba(66,41,25,.46)
--hud-shadow:0 24px 60px rgba(46,27,16,.28), 0 4px 14px rgba(46,27,16,.18)
```

- **字体**：UI `"Noto Sans SC Variable"`；**纸面/正文/标题 `"Noto Serif SC Variable","Songti SC",serif`**（[hud-pages.css:64,69](../../apps/desktop-client/src/renderer/src/components/hud/hud-pages.css)）；笔记正文默认 `{theme:"paper", font:"serif", size:18, leading:1.9, width:800}`（[note-writing-preferences.ts:14](../../apps/desktop-client/src/renderer/src/components/surfaces/notebook/note-writing-preferences.ts)）。
- **圆角没有统一 token**，是逐处手写的"手撕纸"不规则值：纸面 `31px 42px 29px 38px/35px 30px 43px 31px`、按钮 `17px 21px 16px 19px`。
- **纸 vs 玻璃分工**：纸（`--hud-paper` 暖奶油 + 窗光高光）承载内容；玻璃（深色浮层 `rgba(41,29,22,.88)` + `blur(12px)`）承载操作与 chrome。

---

## 四、真实截图基线

[outputs/audit-20261011/](../../apps/desktop-client/outputs/audit-20261011/)（2026-10-11，2880×1620，经 Playwright CDP 附着真实 Electron dev 窗口，真实登录与真实工作区数据）：`01-home`（全出血书房 + 右侧全身伴星 + 竖排控制钮）、`03-notes`、`04-note-reading`（**伴星在左下、纸面从 365px 起**）、`07-review`、`08-starmap`、`09-settings`、`23-light-chat`（288px 窄聊天纸，纸面仍完整可见），另有 1280×720 / 960×540 / 720×405 窗口档。文字证据：`walk.md`、`interactions.md`。

---

## 五、桌面端与手机端原型共享了什么

| 项 | 结论 |
| --- | --- |
| 字体资源 | **共享**：同一 `@fontsource-variable/noto-sans-sc` |
| Live2D 模型与运行时 | **共享**：同一个 `live2d-v3/whale` 与 manifest，连许可门禁断言都一致 |
| 图标脚本 | 共享 `demos/notebook-icons.js` |
| **设计 token** | **零共享**：4 个 mobile CSS 里 `--hud-*` 出现 **0 次** |
| 组件 | **零复用**：手机端是 vanilla JS 字符串模板，不 import 任何桌面组件/hook |
| 数据契约 | **独立**：`mobile-companion-data.js` 自述 "No account or business API"，自带 `schema:5` 与 localStorage 键，不引用 `@astella/shared` |
| 反向耦合 | 无：`grep -rn "demos/" apps/desktop-client/{src,scripts,package.json}` 零命中 |

**色板对照**（两套是不同色系）：

| | 墨 | 纸 | 强调 | 正文 |
| --- | --- | --- | --- | --- |
| 桌面 | `#30231a` 暖棕 | `#f5ead5` 暖奶油 | `#bd5a31` 暖陶土 | Noto **Serif** SC |
| 手机原型 | `#353d38` 冷灰绿 | `#fffcf6` 近冷白 | `#6b8c7c` 鼠尾草绿 | 全站 sans-serif |

手机端另有一套 `--glass-surface/--glass-shadow`（[mobile-companion-theme.css:2](../../apps/desktop-client/demos/mobile-companion-theme.css)），与桌面玻璃的深色浮层也是两种材质方向。

---

## 六、这份基线用来判断什么

1. **手机首屏的默认态与桌面身份冲突**：桌面是"纸面为主、伴星在旁、版心让位"；手机默认态是伴星占满首屏、正文退到"记录"第二视图。这不是适配，是身份置换。
2. **手机原型无法继承桌面已解决的答案**：桌面那套 `--companion-seat-*` 让位机制与暖纸/衬线体系，在手机端一行都没有被复用。
3. 因此"手机首屏是书房还是角色"是一个**必须显式裁决**的产品决定，不是措辞问题。详见方案 51 §19。
