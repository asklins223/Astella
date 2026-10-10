import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { trackInputModality } from "./app/input-modality";
// 全部 24 份样式表按「基底 → 母本 → 集成层 → 修正层/功能层」的顺序在这里注入。
// 顺序、分层理由与「组件模块不再 import CSS」的守卫见 `styles.ts` 与
// `src/main/renderer-style-order-guard.test.ts`。
import "./styles";

const root = document.getElementById("root");

if (!root) throw new Error("Desktop renderer root is missing");

// Document-wide, not per component: every text field shares the same
// `:focus-visible` behaviour, so every surface needs the same modality signal.
trackInputModality();

// 窗口本体的圆角写在文档根上（html 的 overflow 才裁得到视口）。这一行必须在首帧之前，
// 否则窗口显示的那一帧还是直角；平台来自 preload，渲染前就能读到。
document.documentElement.dataset.platform = window.astellaDesktop?.platform ?? "unknown";

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
