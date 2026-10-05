#!/usr/bin/env node
/**
 * 文本字段焦点环探针。
 *
 * 按 `styles.ts` 的真实加载顺序把渲染层样式拼起来，铺一份覆盖各功能域的
 * 输入框 DOM，然后**真点 / 真 Tab**，对每个字段量两件事：
 *   1. 指针来源聚焦时，字段自己有没有画出硬环（`outline`）；
 *   2. 键盘来源聚焦时，硬环还在不在。
 *
 * 指针来源的字段环是「点一下凭空长出一个方框」的来源，所以这条判据钉的是
 * `styles.css` 里那条全局输入模态规则，而不是某一个组件的写法。
 *
 * 用法：node apps/desktop-client/scripts/focus-ring-cascade-probe.mjs [--verbose]
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const VERBOSE = process.argv.includes("--verbose");

/** 按 styles.ts 的清单顺序拼出真实层叠，避免探针量的是一份过期构建。 */
function bundleCss() {
  const entry = readFileSync(join(APP, "src/renderer/src/styles.ts"), "utf8");
  const specs = [...entry.matchAll(/import\s+"([^"]*\.css)"/g)].map((m) => m[1]);
  const local = specs.filter((s) => s.startsWith("./"));
  const missing = [];
  const parts = local.map((spec) => {
    const file = join(APP, "src/renderer/src", spec.slice(2));
    if (!existsSync(file)) {
      missing.push(spec);
      return "";
    }
    return `/* ${spec} */\n${readFileSync(file, "utf8")}`;
  });
  if (missing.length) throw new Error(`styles.ts 引用了不存在的样式表：${missing.join(", ")}`);
  return { css: parts.join("\n"), count: local.length };
}

async function launchChromium() {
  try {
    return await chromium.launch();
  } catch {
    const cache = join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
    const revisions = existsSync(cache)
      ? readdirSync(cache).filter((name) => name.startsWith("chromium-")).sort().reverse()
      : [];
    for (const revision of revisions) {
      const binary = join(cache, revision, "chrome-mac/Chromium.app/Contents/MacOS/Chromium");
      if (existsSync(binary)) return await chromium.launch({ executablePath: binary });
    }
    throw new Error("找不到可用的 Chromium");
  }
}

/** 每个字段都带上真实页面上的外壳，量到的才是读者眼睛里的那一圈。 */
const FIELDS = [
  { id: "cc-composer", label: "伴星中心·对话输入", html: `<div class="cc-book"><div class="cc-house-main"><div class="cc-paper"><div class="cc-composer"><textarea placeholder="想说点什么？"></textarea></div></div></div></div>`, note: "textarea 无边框无圆角，靠 .cc-composer 的纸壳" },
  { id: "cc-form", label: "伴星中心·表单输入", html: `<div class="cc-book"><div class="cc-form"><label>标题<input type="text" placeholder="标题"></label></div></div>` },
  { id: "cc-form-area", label: "伴星中心·表单长文", html: `<div class="cc-book"><div class="cc-form"><textarea placeholder="说明"></textarea></div></div>` },
  { id: "cc-search", label: "伴星中心·搜索字段", html: `<div class="cc-book"><div class="cc-search"><input type="search" placeholder="搜索"></div></div>`, note: "已有 :focus-within 纸壳" },
  { id: "hud-field", label: "HUD 设置字段", html: `<div class="settings-hud"><label class="hud-field"><input type="text" placeholder="名称"></label></div>` },
  { id: "settings-companion", label: "伴星设置·裸输入", html: `<div class="settings-companion"><input type="text" placeholder="称呼"></div>`, note: "伴星设置页实际没有裸输入框，真正的字段走 .hud-field" },
  { id: "run-editor", label: "学习运行·作答框", html: `<div class="learning-run-paper"><div class="learning-run-response"><div class="run-text-editor"><textarea placeholder="写下你的理解"></textarea></div></div></div>` },
  { id: "source-capture", label: "资料收录·输入", html: `<div class="source-experience"><form class="capture-form"><input type="text" placeholder="标题或网址"></form></div>` },
  { id: "universe-search", label: "理解星图·搜索", html: `<div class="universe-page"><div class="universe-search-shell"><input type="search" placeholder="搜索"></div></div>`, note: "已有 :focus-within 纸壳" },
  { id: "card-experience", label: "学习卡·输入", html: `<div class="card-experience"><div class="card-collection__search"><input type="search" placeholder="搜索卡"></div></div>`, note: "卡片集合搜索自带纸壳" },
  { id: "note-library", label: "笔记库·搜索", html: `<div class="note-library-desk"><div class="note-shelf-search"><input type="text" placeholder="搜索笔记"></div></div>`, note: "架上搜索纸签" },
  { id: "goal-journal", label: "伴星目标·手记", html: `<div class="companion-goal-journal"><div class="companion-goal-edit"><textarea placeholder="今天做了什么"></textarea></div></div>` },
  { id: "checkbox", label: "裸复选框", html: `<label><input id="keep" type="checkbox">保持登录</label>`, note: "真实复选框都是自绘圆垫，这里只作回归检查" },
  { id: "select", label: "裸下拉", html: `<select><option>甲</option></select>`, note: "真实选择器都是自绘触发钮，这里只作回归检查" },
];

const PAGE = `<!doctype html><meta charset="utf-8"><style>__CSS__</style>
<div class="desktop-app hud-surface">
  <div class="content">
    __FIELDS__
  </div>
</div>`;

const { css, count } = bundleCss();
console.log(`样式：styles.ts 清单 ${count} 份，按真实顺序拼接\n`);

const html = FIELDS.map(
  (f) => `<section class="probe-case" id="case-${f.id}">${f.html}</section>`,
).join("\n");

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.setContent(PAGE.replace("__CSS__", css).replace("__FIELDS__", html));
// `trackInputModality()` 的等价物。
await page.evaluate(() => {
  document.documentElement.dataset.inputModality = "pointer";
});

const describeRing = (handle) =>
  handle.evaluate((el) => {
    const s = getComputedStyle(el);
    const painted = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
    return {
      painted,
      outline: `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor} offset ${s.outlineOffset}`,
      radius: s.borderTopLeftRadius,
    };
  });

/** 聚焦后「除了硬环之外」还有什么变化——壳或字段自己的状态。 */
const describeSkin = (handle) =>
  handle.evaluate((el) => {
    const skin = (node) => {
      const s = getComputedStyle(node);
      return [s.borderTopWidth, s.borderTopColor, s.backgroundColor, s.boxShadow, s.color].join("|");
    };
    // 字段自己，以及它最近的、画了纸壳的祖先（字段板/纸签/输入组）。
    const plate = el.closest(
      '[class*="field"],[class*="plate"],[class*="composer"],[class*="search"],[class*="form"],[class*="input"],[class*="shell"],[class*="control"]',
    );
    return { self: skin(el), plate: plate ? { cls: plate.className, skin: skin(plate) } : null };
  });

const rows = [];
// 基线在**任何一次点击之前**统一取一遍。逐例 blur() 取基线会串味：上一例的焦点
// 还挂在文档上，"未聚焦"读到的其实是上一处的聚焦态。
const baselines = new Map();
for (const field of FIELDS) {
  const handle = page.locator(`#case-${field.id} input, #case-${field.id} textarea, #case-${field.id} select`).first();
  baselines.set(field.id, await describeSkin(handle));
}

for (const field of FIELDS) {
  const input = page.locator(`#case-${field.id} input, #case-${field.id} textarea, #case-${field.id} select`).first();
  const before = baselines.get(field.id);

  await input.scrollIntoViewIfNeeded();
  // 不开 force：force 会跳过命中检查，被上层元素挡住的点击会打到别处去，
  // 量出来的"没有聚焦态"其实是根本没聚焦上。
  await input.click();
  // 聚焦态多半带 160ms 的过渡，刚点完就读会读到过渡起点，报成"没有反馈"。
  await page.waitForTimeout(240);

  const pointer = await describeRing(input);
  const pointerFocusVisible = await input.evaluate((el) => el.matches(":focus-visible"));
  const after = await describeSkin(input);

  // 键盘来源：把输入模态翻回 keyboard，等价于按 Tab 走到这里。
  await page.evaluate(() => {
    document.documentElement.dataset.inputModality = "keyboard";
  });
  const keyboard = await describeRing(input);
  await page.evaluate(() => {
    document.documentElement.dataset.inputModality = "pointer";
  });

  rows.push({
    ...field,
    pointer,
    pointerFocusVisible,
    keyboard,
    selfChanged: before.self !== after.self,
    plateChanged:
      !!after.plate && before.plate ? before.plate.skin !== after.plate.skin : !!after.plate && !!before.plate,
    plateClass: after.plate?.cls ?? "",
  });

  if (VERBOSE) {
    const matched = await input.evaluate((el) => {
      const out = [];
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of rules) {
          if (!rule.selectorText || !rule.style?.outlineWidth) continue;
          try {
            if (el.matches(rule.selectorText) && rule.style.outlineStyle !== "none") {
              out.push(`${rule.selectorText} { ${rule.style.outline} / offset ${rule.style.outlineOffset} }`);
            }
          } catch {
            /* 选择器写错不是这个探针要管的事 */
          }
        }
      }
      return out;
    });
    console.log(`\n▸ ${field.label}\n  ${matched.join("\n  ")}`);
  }
}

await browser.close();

console.log("字段".padEnd(22) + "指针聚焦".padEnd(12) + "键盘聚焦".padEnd(11) + "除硬环外的反馈");
console.log("─".repeat(92));
let failures = 0;
for (const row of rows) {
  const pointerOk = row.pointer.painted ? "✗ 画了硬环" : "✓ 无硬环";
  const keyboardOk = row.keyboard.painted ? "✓ 有环" : "（无环）";
  const skin = [row.selfChanged && "字段自身", row.plateChanged && "纸壳"].filter(Boolean).join("+");
  if (row.pointer.painted) failures += 1;
  console.log(
    row.label.padEnd(20) +
      pointerOk.padEnd(14) +
      keyboardOk.padEnd(13) +
      (skin || "无") + "  [" + row.plateClass.slice(0,28) + "]",
  );
  if (row.note) console.log(" ".repeat(22) + `· ${row.note}`);
}

console.log(`\n指针聚焦仍画硬环的字段：${failures} / ${rows.length}`);
process.exit(failures === 0 ? 0 : 1);