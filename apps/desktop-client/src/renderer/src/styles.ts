/**
 * 渲染层样式表的**唯一加载入口**。
 *
 * ## 为什么要有这一个文件
 *
 * 2026-09-29 之前，24 份样式表里有 13 份是从**组件模块**里 import 的
 * （`note-hud.css` 在 `notebook-surface.tsx:8`、`understanding-universe.css` 在
 * `graph-surface.tsx:71` 与 `companion-center-surface.tsx:24` 各一份、`home-v2.css` 在
 * `HomeV2Experience.tsx:41`……）。注入顺序因此由 **ES 模块求值顺序**决定：ESM 会把
 * `main.tsx` 里的 `import { App }` 整棵子树先求值完，于是**组件样式反而排在
 * `main.tsx` 那十一行之前**——和「母本在前、修正层在后」的设计意图正好相反，
 * 而且没人能从代码上看出真实顺序。
 *
 * 后果是「新增一个组件就可能冲掉别人的样式」：谁先被 import 谁赢，取决于 import 图的
 * 形状，不是取决于谁写在最后。本文件把顺序收成一张有理由的清单，
 * `renderer-style-order-guard.test.ts` 钉住「清单完整 + 组件模块不再 import CSS」。
 *
 * ## 顺序的四层
 *
 * 1. **基底** `styles.css` —— reset、旧 token 的别名、全局 `button/input` 的
 *    `font: inherit` 与那条唯一的焦点环。它含裸元素选择器，**必须最先**。
 * 2. **母本** `hud/hud-pages.css` —— V3.1 视觉母本：`.button`、`.tag`、`.task-title`、
 *    纸面与圆角配方。`DESIGN.md` 指定的「唯一视觉依据」。
 * 3. **集成层** `hud/hud-surface.css` 等 —— 逐轮追加的宿主级规则，**排在母本之后**
 *    （它就是靠这个顺序覆盖母本的）。
 * 4. **修正层与功能层** —— 各自覆盖集成层；`objective-flow.css` 与母本的关系由
 *    `objective-flow-css-guard.test.ts` 单独钉着（「排在 hud-surface.css 之后」）。
 *
 * 每层内部按「谁覆盖谁」排；跨层不靠巧合，靠本文件的注释。
 */

/* ── 1. 基底 ────────────────────────────────────────────────────────────── */
import "./styles.css";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "./components/home-room.css";

/* ── 2. 视觉母本 ────────────────────────────────────────────────────────── */
import "./components/approved-surfaces.css";
import "./components/hud/hud-pages.css";

/* ── 3. 集成层（逐轮追加，排在母本之后）─────────────────────────────────── */
import "./components/hud/hud-surface.css";
import "./components/hud-surface.css";
import "./components/hud/hud-controls.css";
import "./components/source-intake.css";

/* ── 4a. 修正层：覆盖集成层 ─────────────────────────────────────────────
   `objective-flow.css` 排在 `hud-surface.css` 之后是被单独钉着的契约
   （`objective-flow-css-guard.test.ts` 的「修正层的加载顺序」）——它覆盖的正是
   `hud-surface.css` 自己更早处的规则。 */
import "./components/objective-flow.css";
import "./components/card-generation-flow.css";
import "./components/surfaces/review/candidate-review.css";
import "./components/surfaces/companion-center.css";

/* ── 4b. 功能层：各页面自己的版式 ───────────────────────────────────────── */
import "./components/surfaces/note-hud.css";
import "./components/surfaces/notebook/note-document.css";
import "./components/surfaces/notebook/notebook-desk.css";
import "./components/surfaces/notebook/notebook-learning-pages.css";
import "./components/surfaces/understanding-universe.css";
import "./components/surfaces/study-surface.css";
import "./components/home-v2/home-v2.css";
import "./components/desktop-access-gate.css";
import "./components/render-error-boundary.css";

/* ── 4c. 伴星：交互台在浮层里，带自己的局部 token 表 ─────────────────────── */
import "./components/companion/companion-root.css";
import "./components/companion/companion-bubble.css";
import "./components/companion/companion-chat-record.css";
import "./components/companion/companion-hud.css";
import "./components/companion/companion-feed.css";
import "./components/companion/companion-proposal-choice.css";
import "./components/companion/companion-run-trace.css";
import "./components/companion/companion-interaction.css";

/**
 * 本文件刻意不导出任何东西：它唯一的作用是「被 import 时按上面那张单子把 CSS 注入」。
 * `main.tsx` 写 `import "./styles";` 即可。
 */
export {};
