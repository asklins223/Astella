/**
 * 模型自写页面的**三道服务端闸**（39 §6.1／§6.3；D4 §3；2026-09-28 用户裁决）。
 *
 * ## 职责对调：谁画、谁核
 *
 * 上一版是「服务端把知识步骤裁成节点 → 塞进三张固定模板」。那套骨架的毛病不是画得丑，
 * 是**产物根本不是教具**：真实样本《提取练习四步走》长成「讲解、例子、计划第 1–4 步」
 * 六格（39f DEMO-1）。给同一套骨架换 HUD 油漆只解决了第二个问题。
 *
 * 现在**页面由模型整份写**——`<style>` ＋ 标记 ＋ `<svg>` ＋ `<script>`，布局、图形与
 * 交互都是它为**这一个知识点**现画的。服务端不再决定画面长什么样，只保留三道闸：
 *
 *   1. **安全**（本文件）：不引用任何外部资源、不碰网络、不逃出 frame、不写 cookie 与
 *      存储；超配额整份拒绝。隔离本身由不透明 origin ＋ `sandbox="allow-scripts"`
 *      单能力 ＋ CSP 三路分流承担（D4 §3），这里是内容一侧的同一条边界。
 *   2. **依据**（`round-artifact-measure.ts` 与服务端渲染器）：`outline` 里每一条引文都要在
 *      冻结正文那一块里**逐字找得到**；核过的原句由服务端在动态页面外展示。AI 页面可以
 *      自由解释或画出知识关系，不必重复粘贴引用。
 *   3. **可用**：文字等价与依据回执由服务端用真实 DOM 渲染，**在 frame 之外**、永远
 *      在屏上。所以脚本不跑、动效关掉、frame 降级时，讲解内容一条不少地读得到。
 *
 * ## 为什么「不外链」逐个字符串扫，而不是上 sanitizer
 *
 * 产物跑在不透明 origin 上，没有同源、没有 `connect-src`，**即使**它想外链也发不出去；
 * 扫字符串是为了让"这一份不该出现的东西"在**生成时就红**，而不是在真窗口里静默失效。
 * 判据宁可宽一点：宁可毙掉一份其实无害的页面，也不要让"外链"这一类靠模型自觉。
 */

/** 页面正文的字符上界。配额挡的是"一份写飞了的页面"，不是"一份画得细的页面"。 */
export const ARTIFACT_DOCUMENT_MAX_CHARS_V1 = 120_000;

/** 页面至少要有这么多字，否则它不是一份教具，是一张空壳。 */
export const ARTIFACT_DOCUMENT_MIN_CHARS_V1 = 400;

export type ArtifactDocumentViolationV1 =
  | "external_reference"
  | "escape_hatch"
  | "too_small"
  | "too_large"
  | "unbalanced_script";

export interface ArtifactDocumentVerdictV1 {
  readonly ok: boolean;
  /** 第一条命中的判据与它的证据片段（进留痕，不上屏）。 */
  readonly violation?: { readonly reason: ArtifactDocumentViolationV1; readonly evidence: string; readonly rule?: string };
}

/**
 * 外部引用与逃逸口。**这一份是"内容一侧的 CSP"**：与 D4 §3 的三路分流同一条边界，
 * 只是从"文档里不许出现"这一侧再钉一次。
 *
 * 逐条都写清**为什么**——将来有人想放宽某一条时，这里必须能回答"这条在防什么"：
 *
 *   - `http(s)://` 与协议相对 `//`：命名空间声明与 DOM 命名空间参数不是请求地址；
 *     除这些明确位置的标准标识符外，`connect-src 'none'` 下外链发不出去，但协议相对
 *     地址还会让相对路径解析到别处，字体与图片的失败路径很难查。宁可一开始就没有。
 *   - `@import` / `<link>` / `<base>`：同上，且 `<base>` 能改掉相对路径的基准。
 *   - `<iframe>` / `<object>` / `<embed>`：子文档不在本 frame 的沙箱判据里。
 *   - `<form>`：能把这一页变成一次导航提交，父侧只认 `astella-app://artifact` 的
 *     source，任何一次顶层导航都是错的。
 *   - `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `sendBeacon`：网络。
 *   - `import(` / `importScripts`：动态加载，绕过"页面自带脚本"这一层的可读性。
 *   - `localStorage` / `sessionStorage` / `indexedDB` / `caches` / `document.cookie`：
 *     在不透明 origin 里本来就没东西可存，但"能写就能读"是另一回事，写进去等于
 *     给这一份开了一条它不该有的持久化通道。
 *   - `postMessage` / `parent.` / `top.` / `opener` / `window.open` / `location.`：
 *     产物与父侧唯一的通道是模板脚本里的 `parent.postMessage`（带 channel 与阶段白名单）。
 *     模型自己发消息就等于绕过那道白名单，父侧只按 `source` 认 frame，不认内容。
 *   - `<script … src=`：外部脚本，上面第一条的特例，写出来是为了让留痕更可读。
 *
 * **不拦**的：`<script>`（本产品的教具就是要能动手）、`requestAnimationFrame`、
 * `setTimeout` / `setInterval`、CSS 动画与 SVG SMIL、`matchMedia`、`alert`/`confirm`
 * 之外的任何交互。这些正是"教具"与"填好的表格"的分界线。
 */
const FORBIDDEN_DOCUMENT_PATTERNS_V1: ReadonlyArray<{
  readonly reason: Extract<ArtifactDocumentViolationV1, "external_reference" | "escape_hatch">;
  readonly pattern: RegExp;
  readonly label: string;
}> = [
  { reason: "external_reference", pattern: /https?:\/\//i, label: "http(s) 外链" },
  // 协议相对地址。文件头承诺了这一条，判据表里就必须真的有它——注释与实现分家
  // 正是这个文件要防的那件事（"渲染器注释里的判据与实现同源"是同一条纪律）。
  // 只在**属性值**与 `url()` 里找：JS 注释里的 `//` 不是外链，判据宁可只拦真正
  // 会发起请求的那几种写法。
  { reason: "external_reference", pattern: /(?:src|href|srcset|action)\s*=\s*["']?\s*\/\//i, label: "协议相对地址" },
  { reason: "external_reference", pattern: /url\(\s*["']?\s*\/\//i, label: "url() 里的协议相对地址" },
  { reason: "external_reference", pattern: /<link\b/i, label: "<link>" },
  { reason: "external_reference", pattern: /@import\b/i, label: "CSS @import" },
  { reason: "external_reference", pattern: /<base\b/i, label: "<base>" },
  { reason: "external_reference", pattern: /<iframe\b/i, label: "子 frame" },
  { reason: "external_reference", pattern: /<(object|embed)\b/i, label: "插件元素" },
  { reason: "external_reference", pattern: /<form\b/i, label: "表单提交" },
  { reason: "external_reference", pattern: /<script\b[^>]*\bsrc\s*=/i, label: "外部脚本" },
  { reason: "external_reference", pattern: /@font-face/i, label: "外部字体" },
  { reason: "escape_hatch", pattern: /\bfetch\s*\(/, label: "fetch" },
  { reason: "escape_hatch", pattern: /\bXMLHttpRequest\b/, label: "XHR" },
  { reason: "escape_hatch", pattern: /\bWebSocket\b/, label: "WebSocket" },
  { reason: "escape_hatch", pattern: /\bEventSource\b/, label: "EventSource" },
  { reason: "escape_hatch", pattern: /sendBeacon\b/, label: "sendBeacon" },
  { reason: "escape_hatch", pattern: /\bimport\s*\(/, label: "动态 import" },
  { reason: "escape_hatch", pattern: /\bimportScripts\b/, label: "importScripts" },
  { reason: "escape_hatch", pattern: /\b(localStorage|sessionStorage|indexedDB|caches)\b/, label: "本地存储" },
  { reason: "escape_hatch", pattern: /document\s*\.\s*cookie\b/i, label: "cookie" },
  { reason: "escape_hatch", pattern: /\bpostMessage\b/, label: "postMessage" },
  // 刻意**不拦** `top.`：`-` 是词边界，所以 `.card-top.hover{}`、`.note-top.x{}` 这类
  // BEM 风格的类名会被整份毙掉，而模型写这种类名是常事。真正想拦的顶层导航
  // （`top.location=`）已经被下面那条 `location` 盖住，`window.open(` 也一样，
  // 所以少拦这一处并没有放松边界，只是不再误伤。
  { reason: "escape_hatch", pattern: /\b(parent|opener)\s*\./, label: "父窗口句柄" },
  { reason: "escape_hatch", pattern: /window\s*\.\s*open\s*\(/, label: "window.open" },
  { reason: "escape_hatch", pattern: /\blocation\s*[.=]/, label: "location" },
];

/** Standard namespace identifiers do not load resources. Keep scan offsets intact. */
function maskDocumentNamespacesV1(html: string): string {
  const namespace = "http:\\/\\/www\\.w3\\.org\\/(?:2000\\/svg|1999\\/xlink|1998\\/Math\\/MathML|1999\\/xhtml)";
  const declarations = new RegExp(`\\bxmlns(?::[\\w-]+)?\\s*=\\s*(["'])(${namespace})\\1`, "g");
  const domArguments = new RegExp(`\\b(?:createElementNS|setAttributeNS)\\s*\\(\\s*(["'])(${namespace})\\1`, "g");
  const mask = (whole: string, _quote: string, identifier: string) => whole.replace(identifier, " ".repeat(identifier.length));
  let scan = html.replace(declarations, mask).replace(domArguments, mask);
  // Models commonly reuse a namespace constant for many SVG nodes. Only mask
  // bindings whose every reference is a namespace API's first arg;
  // a binding used as src/href, reassigned or passed elsewhere stays rejected.
  scan = scan.replace(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi, (script: string, body: string) => {
    const bindings = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(["'])(${namespace})\\2\\s*;`, "g");
    return script.replace(bindings, (declaration: string, name: string, _quote: string, identifier: string) => {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const uses = body.replace(declaration, " ".repeat(declaration.length));
      const namespaceUses = new RegExp(`\\b(?:createElementNS|setAttributeNS)\\s*\\(\\s*${escapedName}\\s*,`, "g");
      const remaining = uses.replace(namespaceUses, "");
      if (!namespaceUses.test(uses) || new RegExp(`(?<![\\w$])${escapedName}(?![\\w$])`).test(remaining)) return declaration;
      return declaration.replace(identifier, " ".repeat(identifier.length));
    });
  });
  return scan;
}

/** 截一段证据出来进留痕；这一段会进日志，所以先压长度、不留换行。 */
function evidenceAroundV1(text: string, at: number, label: string): string {
  const from = Math.max(0, at - 24);
  return `${label}：…${text.slice(from, at + 40).replace(/\s+/g, " ")}…`;
}

/** 去掉 `<script>` 与 `<style>` 的**内容**，再拆标记，得到"眼睛读得到的那部分文字"。 */
export function artifactDocumentTextV1(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** 页面里 `<script>` 开合是否配平。少一个闭合标签，脚本会连着后面的标记一起被吞掉。 */
function scriptTagsBalancedV1(html: string): boolean {
  const opens = html.match(/<script\b[^>]*>/gi)?.length ?? 0;
  const closes = html.match(/<\/script\s*>/gi)?.length ?? 0;
  return opens === closes;
}

export interface CheckArtifactDocumentV1Input {
  readonly document: string;
}

export interface CheckArtifactDocumentV1Result {
  readonly ok: boolean;
  readonly verdict: ArtifactDocumentVerdictV1;
  /** 页面里的纯文本（供依据核对与测量话术扫描复用）。 */
  readonly text: string;
}

/**
 * 安全闸。只看页面自身，不看依据（那是 `groundArtifactStepsV1` 的事）。
 *
 * 返回 `text` 供诊断与后续展示层使用；来源核对在 `groundArtifactStepsV1`，准确引文由
 * 服务端渲染到 AI 页面之外，避免把固定引用块塞进模型自创布局。
 */
export function checkArtifactDocumentV1(
  input: CheckArtifactDocumentV1Input,
): CheckArtifactDocumentV1Result {
  const html = input.document;
  const fail = (reason: ArtifactDocumentViolationV1, evidence: string, rule?: string) => ({
    ok: false,
    text: "",
    verdict: { ok: false, violation: { reason, evidence, ...(rule ? { rule } : {}) } } as ArtifactDocumentVerdictV1,
  });

  if (html.length < ARTIFACT_DOCUMENT_MIN_CHARS_V1) {
    return fail("too_small", `${html.length} 字符，低于 ${ARTIFACT_DOCUMENT_MIN_CHARS_V1}`);
  }
  if (html.length > ARTIFACT_DOCUMENT_MAX_CHARS_V1) {
    return fail("too_large", `${html.length} 字符，超过 ${ARTIFACT_DOCUMENT_MAX_CHARS_V1}`);
  }
  const referenceScan = maskDocumentNamespacesV1(html);
  for (const rule of FORBIDDEN_DOCUMENT_PATTERNS_V1) {
    const match = rule.pattern.exec(referenceScan);
    if (match) return fail(rule.reason, evidenceAroundV1(html, match.index, rule.label), rule.label);
  }
  if (!scriptTagsBalancedV1(html)) {
    return fail("unbalanced_script", "`<script>` 开合不配平");
  }

  const text = artifactDocumentTextV1(html);
  return { ok: true, text, verdict: { ok: true } as ArtifactDocumentVerdictV1 };
}

/**
 * 把模型写的那份文档拆成**样式／标记／脚本**三段。
 *
 * 为什么要拆：`<style>` 与 `<script>` 放在 body 中间时，脚本会在它前面的标记还没排完时
 * 就跑，而样式在 body 里虽然浏览器认，位置却不统一。拆开之后组装这一步是**确定性的**：
 * 样式进 `<head>`、标记进内容落点、脚本进 `</body>` 前。模型想控制顺序就在自己的脚本里
 * 用 `DOMContentLoaded`，不必依赖注入位置。
 */
export interface SplitArtifactDocumentV1 {
  readonly styles: readonly string[];
  readonly scripts: readonly string[];
  readonly markup: string;
}

export function splitArtifactDocumentV1(html: string): SplitArtifactDocumentV1 {
  const styles: string[] = [];
  const scripts: string[] = [];
  // 先摘脚本再摘样式：否则 `<style>` 的正则会先吃到脚本里出现的字符串字面量。
  const withoutScripts = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi, (_whole, body: string) => {
    scripts.push(body);
    return " ";
  });
  const markup = withoutScripts.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_whole, body: string) => {
    styles.push(body);
    return " ";
  });
  return { styles, scripts, markup };
}
