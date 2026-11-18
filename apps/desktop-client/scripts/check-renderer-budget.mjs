import { readdirSync, statSync } from "node:fs";

// Guard the renderer entry budget. The app is a local Electron window, so the
// number that matters is parse/compile time on first paint, not transfer size.
// Current baseline: ~9.4 MB JS and ~1.3 MB CSS; budgets leave ~10% headroom so
// a new heavy dependency needs an explicit decision rather than silently
// landing on every launch.
const assets = new URL("../out/renderer/assets/", import.meta.url);
const JS_BUDGET_BYTES = 10.5 * 1024 * 1024;
const CSS_BUDGET_BYTES = 1.5 * 1024 * 1024;

const files = readdirSync(assets).filter((name) => /\.(js|css)$/.test(name));
if (files.length === 0) {
  throw new Error(`renderer assets are empty: ${assets.pathname}`);
}

function largestByExtension(extension) {
  return files
    .filter((name) => name.endsWith(extension))
    .map((name) => ({ name, bytes: statSync(new URL(name, assets)).size }))
    .sort((a, b) => b.bytes - a.bytes)[0] ?? null;
}

const largestJs = largestByExtension(".js");
const largestCss = largestByExtension(".css");

function format(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

console.log(
  `renderer budget: JS ${largestJs.name} ${format(largestJs.bytes)} / ${format(JS_BUDGET_BYTES)}; ` +
  `CSS ${largestCss.name} ${format(largestCss.bytes)} / ${format(CSS_BUDGET_BYTES)}`,
);

if (largestJs.bytes > JS_BUDGET_BYTES) {
  throw new Error(
    `largest renderer JS chunk exceeds budget (${format(largestJs.bytes)} > ${format(JS_BUDGET_BYTES)}). ` +
    "Split the new import or raise the budget deliberately.",
  );
}
if (largestCss.bytes > CSS_BUDGET_BYTES) {
  throw new Error(
    `largest renderer CSS chunk exceeds budget (${format(largestCss.bytes)} > ${format(CSS_BUDGET_BYTES)}).`,
  );
}