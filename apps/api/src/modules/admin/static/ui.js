/* ============================================================
   运维面板 · UI 基元
   ------------------------------------------------------------
   没有框架。这里的每个函数只做一件事：把数据与结构拼成 DOM。

   ## 注入防线（与第一版相同，且不打折）
   - `el()` 没有 `html` 属性：一切文本走 textContent。
   - `style` 走 CSSOM（element.style.cssText / setProperty）。面板的 CSP 是
     `style-src 'self'`，它管的是样式属性与 <style> 块；CSSOM 写入不在管辖
     范围内。直接 setAttribute("style", …) 会被浏览器静默丢弃——表现为
     "样式莫名其妙没生效"，很难查，所以那条路在这里被显式堵死。
   ============================================================ */

export const SVG_NS = "http://www.w3.org/2000/svg";

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") throw new Error("el(): 不允许 html 属性（注入防线）");
    else if (key === "style") node.style.cssText = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset") {
      for (const [dataKey, dataValue] of Object.entries(value)) node.dataset[dataKey] = dataValue;
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 用 DOM 构造 SVG（与 el() 的注入防线一致，不用 innerHTML）。 */
export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** 描边风格图标（24 viewBox，stroke=currentColor）。 */
export function icon(paths, { size = 18, strokeWidth = 1.8 } = {}) {
  return svg("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    "aria-hidden": "true",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": strokeWidth,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  }, ...paths.map((d) => svg("path", { d })));
}

export const ICONS = {
  overview: ["M12 3l7.5 4.3v8.6L12 20.2 4.5 15.9V7.3z", "M12 8.2l3.6 2.1v4.2L12 16.6l-3.6-2.1v-4.2z"],
  metrics: ["M3 12h3.4l2.2-6 3.2 12 2.6-8 1.8 4h4.8"],
  logs: ["M5 5.5h14M5 10.5h9M5 15.5h14M5 20h7", "M17.5 9.5l2.5 2.5-2.5 2.5"],
  queues: ["M4 6.5h16v4H4zM4 14h16v4H4z", "M7.5 8.5h.01M7.5 16h.01"],
  config: ["M5 7h14M5 12h14M5 17h14", "M9.5 5v4M15 10v4M11 15v4"],
  refresh: ["M20 12a8 8 0 1 1-2.34-5.66", "M20 4v4h-4"],
  lock: ["M7 10V8a5 5 0 0 1 10 0v2", "M6 10h12v9H6z"],
  bolt: ["M13 3L5 13.5h5L11 21l8-10.5h-5z"],
  alert: ["M12 4l9 16H3z", "M12 10v4.2", "M12 17.2h.01"],
  check: ["M4.5 12.5l5 5L19.5 7"],
  clock: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "M12 8v4.4l3 1.8"],
  search: ["M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z", "M19.5 19.5L15.6 15.6"],
  down: ["M12 5v12", "M6.5 12.5L12 18l5.5-5.5"],
  pause: ["M9 6v12M15 6v12"],
  play: ["M8 5.5l11 6.5-11 6.5z"],
  copy: ["M9 9h10v10H9z", "M6 15H5V5h10v1"],
  export: ["M12 4v11", "M8 11.5l4 4 4-4", "M5 19.5h14"],
  save: ["M5 4h11l3 3v13H5z", "M8 4v5h7V4", "M8 20v-6h8v6"],
  rotate: ["M4.5 12a7.5 7.5 0 0 1 12.6-5.4", "M20 4v4h-4", "M19.5 12a7.5 7.5 0 0 1-12.6 5.4", "M4 20v-4h4"],
  zap: ["M13 3L5 13.5h5L11 21l8-10.5h-5z"],
  layers: ["M12 4l8 4-8 4-8-4z", "M4.5 12.5L12 16l7.5-3.5", "M4.5 16.5L12 20l7.5-3.5"],
  flame: ["M12 3.5s5.5 4.6 5.5 9.2a5.5 5.5 0 0 1-11 0C6.5 8.1 12 3.5 12 3.5z", "M12 17.5c1.7 0 3-1.3 3-3 0-1.9-3-3.8-3-3.8s-3 1.9-3 3.8c0 1.7 1.3 3 3 3z"],
};

/* ── 布局片段 ──────────────────────────────────────────── */

/** 段落标题：小号大写字距 + 右侧注脚。 */
export function section(title, note, ...children) {
  return el("section", { class: "section" },
    el("header", { class: "section__head" },
      el("h2", { class: "section__title", text: title }),
      note ? el("span", { class: "section__note", text: note }) : null,
    ),
    ...children,
  );
}

export function badge(text, tone = "") {
  return el("span", { class: `badge${tone ? ` badge--${tone}` : ""}`, text });
}

/** 内部代号：次要信息，悬停显示全名。 */
export function codeTag(text) {
  if (!text) return null;
  return el("span", { class: "code", text, title: `内部标识：${text}` });
}

/** 空状态。`tone="good"` 时给一个绿色勾，读作「这是好消息」。 */
export function emptyState(title, detail, tone = "") {
  return el("div", { class: `empty${tone ? ` empty--${tone}` : ""}` },
    el("strong", { text: title }),
    detail ? el("span", { class: "empty__detail", text: detail }) : null,
  );
}

/** 通用表格。numericColumns 右对齐 + 等宽数字。 */
export function table(headers, rows, { numericColumns = [], className = "" } = {}) {
  return el("div", { class: `table ${className}`.trim() },
    el("div", { class: "table__scroll" },
      el("table", {},
        el("thead", {}, el("tr", {}, ...headers.map((h, i) =>
          el("th", { class: numericColumns.includes(i) ? "num" : null, text: h })))),
        el("tbody", {}, ...rows.map((row) =>
          el("tr", {}, ...row.map((cell, i) =>
            el("td", { class: numericColumns.includes(i) ? "num" : null },
              cell instanceof Node ? cell : String(cell)))))),
      ),
    ),
  );
}

/* ── 应用绘制的确认框（替代原生 confirm）───────────────── */

export function confirmDialog({ title, body, confirmLabel = "确定", tone = "primary" }) {
  return new Promise((resolve) => {
    const modal = document.querySelector("#modal");
    const titleNode = document.querySelector("#modal-title");
    const bodyNode = document.querySelector("#modal-body");
    const confirm = document.querySelector("#modal-confirm");
    titleNode.textContent = title;
    bodyNode.textContent = body;
    confirm.className = `btn btn--${tone}`;
    confirm.textContent = confirmLabel;

    function close(result) {
      modal.hidden = true;
      confirm.removeEventListener("click", onConfirm);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    function onConfirm() { close(true); }
    function onKey(event) {
      if (event.key === "Escape") close(false);
    }

    confirm.addEventListener("click", onConfirm);
    // 只有 scrim 与取消键带 data-close；确认键**不能**带——否则它会先被
    // 这条"一律视为取消"的处理器 resolve(false)，再轮到 onConfirm 时 promise
    // 已经定死了，表现就是"点确定没反应"。
    modal.querySelectorAll("[data-close]").forEach((node) => {
      node.onclick = () => close(false);
    });
    document.addEventListener("keydown", onKey);
    modal.hidden = false;
    confirm.focus();
  });
}

/* ── 提示条 ────────────────────────────────────────────── */

let toastTimer = null;
export function toast(message, tone = "ok") {
  const node = document.querySelector("#toast");
  node.textContent = message;
  node.dataset.tone = tone;
  node.dataset.show = "true";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.dataset.show = "false";
  }, 3400);
}

/* ── 数字提亮 ──────────────────────────────────────────── */

/** 跨刷新时给变化过的读数一次提亮。 */
export function tickStats(root) {
  root.querySelectorAll("[data-stat-id]").forEach((node) => {
    const previous = node.dataset.lastValue;
    if (previous !== undefined && previous !== node.textContent) {
      node.classList.remove("is-tick");
      void node.offsetWidth; // 强制重排，让动画可以重播
      node.classList.add("is-tick");
    }
    node.dataset.lastValue = node.textContent;
  });
}
