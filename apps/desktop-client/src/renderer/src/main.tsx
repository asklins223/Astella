import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { trackInputModality } from "./app/input-modality";
import "./styles.css";
import "./components/home-room.css";
import "./components/approved-surfaces.css";
import "./components/hud/hud-pages.css";
import "./components/hud/hud-surface.css";
// 39d W7-4 刀八：书桌上那「一件」的**便签版式**（`.hud-desk-next` / `.hud-desk-elsewhere`
// ＋今日复习那三颗动作）。**它此前一个字节都没进过包**——我把它写在
// `components/hud-surface.css`，而上面导入的是**另一个同名文件**
// `components/hud/hud-surface.css`（278KB 那份，**里面一条 `.hud-desk-next` 都没有**）。
// ⇒ 真窗口里那张便签**没拿到任何版式**：量到 `[0, 23, 1440, 107]`（**整个窗口宽**），
// 而 CSS 写的是 `inline-size: 260px`。
//
// ⚠️ **这是「写了文件但没接线」的第三次**：刀八那次是我编了一个 `invoke` intent；
// 上一轮是挂载点不在那一屏的渲染树上；这次是**样式文件根本没被导入**。
// **三处都过了类型检查、单元测试与静态判据。**
// 「类型过了不等于挂上了」这一族**又长了一支**。
import "./components/hud-surface.css";
import "./components/hud/hud-controls.css";
import "./components/source-intake.css";
// 学习卡链路的修正层，必须排在 hud 层之后：它覆盖的是 hud-surface.css 自己的规则。
import "./components/objective-flow.css";
import "./components/card-generation-flow.css";
import "./components/surfaces/companion-center.css";

const root = document.getElementById("root");

if (!root) throw new Error("Desktop renderer root is missing");

// Document-wide, not per component: every text field shares the same
// `:focus-visible` behaviour, so every surface needs the same modality signal.
trackInputModality();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
