/**
 * 动态讲解产物的**服务端渲染器**（39 §6.1／§6.3；D4 §3）。
 *
 * ## 这一版渲染的是**纸**，不是画面
 *
 * v2 之前，这一层画的是画面：服务端从「讲解／例子／计划第 N 步」裁出节点，塞进三张固定
 * 模板。真实样本《提取练习四步走》于是长成六格教学栏目（39f DEMO-1）——给这套骨架换
 * HUD 油漆，只解决了"不像书房"，没解决"不是教具"。
 *
 * 现在**画面由模型整份写**（`document`：`<style>` ＋ 标记 ＋ `<svg>` ＋ `<script>`），
 * 这一层只负责它真正该负责的三件事：
 *
 *   1. **纸**：示意声明、标题、概念、补充说明、一块凹槽——模型写的那一页落在凹槽里。
 *      母本的取值在这里写死（产物跑在不透明 origin 上，取不到宿主的 `--hud-*`），
 *      同时把同一组值以 `--lesson-*` 声明在落点上，模型直接 `var(--lesson-mint)`。
 *   2. **依据**：每一条已核对过的引文，配上它**在笔记里哪一节**。这句话是服务端在冻结
 *      正文里逐字找到的，不是模型写的。
 *   3. **文字等价**：`outline` 渲染成真实 DOM，**在 frame 之外、永远在屏上**。脚本
 *      不跑、动效关掉、frame 降级时，讲解内容一条不少地读得到（§6.3）。
 *
 * 动效由展示宿主管理（`artifact-template.ts`）；保存成果只保留模型自己的页面脚本。
 * 不再附第二份动效转发器，避免重复通知和过期 load 回调覆盖用户最新的档位。
 */
import { escapeArtifactTextV1, ROUND_ARTIFACT_MAX_CHARS_V1 } from "./round-artifact.ts";
import {
  ARTIFACT_ILLUSTRATION_NOTICE_V1,
  type ArtifactNodeV1,
} from "./round-artifact-measure.ts";
import { splitArtifactDocumentV1 } from "./round-artifact-doc.ts";
import {
  DYNAMIC_ARTIFACT_TASK_ID,
  DYNAMIC_ARTIFACT_TASK_VERSION,
  type DynamicArtifactDocV1,
} from "./round-artifact-model.ts";

export type RoundArtifactRenderFailureV1 = "empty" | "over_quota";

export interface BuildDynamicArtifactInputV1 {
  readonly doc: DynamicArtifactDocV1;
  /** 已经**核对过**的引文（`groundArtifactStepsV1` 的产物），与 `doc.outline` 一一对应。 */
  readonly nodes: readonly ArtifactNodeV1[];
  /** 生成时刻那一版正文的哈希（与 0285 的 `snapshot_hash` 同一个值）。 */
  readonly snapshotHash: string;
  /** 实际使用的生成器版本，如 `note_round_dynamic_artifact_v1@v3 (qwen-plus)`。 */
  readonly generatorRef: string;
}

export type BuildDynamicArtifactResultV1 =
  | { ok: true; html: string }
  | { ok: false; reason: RoundArtifactRenderFailureV1; detail: string };

function artifactCodepointCountV1(text: string): number {
  let length = 0;
  for (const _codePoint of text) length += 1;
  return length;
}

/**
 * 纸的样式。全部内联（产物是自包含的一小片 HTML，不引用任何外部资源）。
 *
 * 颜色、圆角、阴影、控件形状逐条抄 V3.1 母本（`components/hud/hud-pages.css`），
 * 讲内容的字用衬线、读数与操作说明用无衬线（母本的「双声部」）。同一组值在
 * `--lesson-*` 上再声明一次给模型用：`artifact-hud-palette.test.ts` 钉住两份同源。
 */
const ARTIFACT_STYLE_V1 = `<style>
.astella-art{
  --ink:#30231a;--soft:#705d4d;--paper:#f5ead5;--paper-light:#fff9eb;--paper-deep:#e8d4b1;
  --cream:#fff2cf;--butter:#f3d678;--mint:#b9d3ad;--green:#66816a;
  --peach:#e89568;--clay:#bd5a31;--line:rgba(73,47,29,.22);--line-strong:rgba(66,41,25,.46);
  --edge:rgba(255,252,235,.78);
  --shadow:0 3px 8px rgba(43,27,17,.16);
  font:16px/1.85 "Songti SC","STSong","Noto Serif CJK SC","Source Han Serif SC",serif;
  color:var(--ink);
}
.astella-art *{box-sizing:border-box}
.astella-art__sans{font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif}
/* 示意声明：服务端无条件加的一句，暖黄便签底。它在标题**之前**，模型写的那句替代不了它。 */
.astella-art__notice{
  margin:0 0 12px;padding:7px 11px;border:1px solid var(--line);
  border-left:4px solid var(--green);border-radius:11px 14px 10px 13px;
  background:color-mix(in srgb,var(--butter) 26%,var(--paper-light));
  font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif;
  font-size:12px;line-height:1.7;color:var(--soft);
}
.astella-art__title{margin:0 0 4px;font-size:23px;line-height:1.4;font-weight:680;letter-spacing:-.02em}
.astella-art__subject{margin:0 0 14px;color:var(--soft);font-size:14px;line-height:1.7}
.astella-art__caution{
  margin:0 0 14px;padding-left:11px;border-left:3px solid var(--line-strong);
  color:var(--soft);font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif;
  font-size:12px;line-height:1.7;
}
/* 画面：纸面上的一个凹槽——粗奶油边 + 不等圆角。模型写的那一页落在里面。 */
.astella-art__scene{
  --lesson-paper:#fff9eb;--lesson-paper-deep:#e8d4b1;--lesson-ink:#30231a;--lesson-soft:#705d4d;
  --lesson-mint:#b9d3ad;--lesson-green:#66816a;--lesson-peach:#e89568;--lesson-clay:#bd5a31;
  --lesson-butter:#f3d678;--lesson-cream:#fff2cf;--lesson-edge:rgba(255,252,235,.78);
  --lesson-shadow:0 3px 8px rgba(43,27,17,.16);
  padding:16px 18px;border:4px solid var(--edge);
  border-radius:27px 36px 25px 33px/31px 26px 38px 28px;background:var(--paper-light);
  box-shadow:0 12px 28px rgba(43,27,17,.22),0 3px 8px rgba(43,27,17,.14);
}
.astella-art__scene>*{max-width:100%}
/* ── 依据回执：那句话真的在这篇笔记里，不是模型写的 ──────────────────── */
.astella-art__evidence{
  margin:16px 0 0;padding:12px 15px;border:2px solid var(--cream);
  border-left:5px solid var(--peach);border-radius:16px 22px 17px 20px;background:var(--paper);
}
.astella-art__evidence-head{
  margin:0 0 9px;color:var(--green);font-size:12px;font-weight:800;letter-spacing:.04em;
  font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif;
}
.astella-art__evidence-item{margin:0 0 10px;padding:0 0 10px;border-bottom:1px dashed var(--line)}
.astella-art__evidence-item:last-child{margin-bottom:0;padding-bottom:0;border-bottom:0}
.astella-art__evidence-what{display:block;margin-bottom:3px;font-size:14px;font-weight:650;line-height:1.6}
.astella-art__evidence-where{
  display:block;margin-bottom:5px;color:var(--soft);font-size:12px;line-height:1.6;
  font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif;
}
.astella-art__evidence-quote{
  margin:0;padding:8px 12px;border-left:3px solid var(--peach);border-radius:10px 14px 11px 13px;
  background:var(--cream);font-size:14px;line-height:1.8;overflow-wrap:anywhere;
}
/* ── 文字等价：frame 之外的真实 DOM，永远在屏上（§6.3）───────────────── */
.astella-art__list{margin:16px 0 0;padding:14px 16px 14px 34px;border:2px solid var(--cream);
  border-radius:17px 24px 16px 22px;background:var(--paper)}
.astella-art__list li{margin:0 0 11px;line-height:1.85;overflow-wrap:anywhere}
.astella-art__list li:last-child{margin-bottom:0}
.astella-art__list b{font-weight:700}
.astella-art__list span{display:block;margin-top:2px;color:var(--soft);font-size:13px;line-height:1.7;
  font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif}
</style>`;

function renderEvidenceV1(nodes: readonly ArtifactNodeV1[]): string {
  if (nodes.length === 0) return "";
  const items = nodes.map((node) => (
    `<div class="astella-art__evidence-item">`
    + `<b class="astella-art__evidence-what">${escapeArtifactTextV1(node.title)}</b>`
    + `<span class="astella-art__evidence-where">笔记依据 · ${escapeArtifactTextV1(node.sectionLabel)}</span>`
    + `<p class="astella-art__evidence-quote">${escapeArtifactTextV1(node.quote)}</p>`
    + `</div>`
  )).join("");
  return `<section class="astella-art__evidence" aria-label="这一页依据的笔记原句">`
    + `<p class="astella-art__evidence-head">这一页画的是这几句话</p>${items}</section>`;
}

function renderTextEquivalentV1(nodes: readonly ArtifactNodeV1[]): string {
  const items = nodes.map((node) => (
    `<li><b>${escapeArtifactTextV1(node.title)}</b>：${escapeArtifactTextV1(node.narration)}`
    + `<span class="astella-art__sans">笔记依据：${escapeArtifactTextV1(node.quote)}</span></li>`
  )).join("");
  return `<ol class="astella-art__list" aria-label="这一页讲的每一步（文字版）">${items}</ol>`;
}

/**
 * 把模型写的那份文档编译成产物 HTML（纯函数，确定性）。
 *
 * 确定性口径与 `buildDeterministicArtifactHtmlV1` 同宽：不写时间戳、不写随机 id、
 * 同输入逐字节相同。超配额**整份拒绝**——截出来的半份在 frame 里只会画成怪东西。
 */
export function buildDynamicArtifactHtmlV1(
  input: BuildDynamicArtifactInputV1,
): BuildDynamicArtifactResultV1 {
  const { doc, nodes } = input;
  if (nodes.length === 0) {
    return { ok: false, reason: "empty", detail: "这一轮没有核对通过的依据" };
  }
  if (doc.outline.length !== nodes.length) {
    // 走不到这里（核对一步就裁好了），但渲染这一层仍自己核一遍：判据在别处、这里只负责
    // "我拿到什么就画什么"，两者不能互相当作对方的理由。
    return { ok: false, reason: "empty", detail: "核对通过的依据与模型给的讲解条数对不上" };
  }

  // 模型写的三段拆开组装：样式、标记、脚本。顺序是确定的，模型不必管注入位置。
  const { styles, scripts, markup } = splitArtifactDocumentV1(doc.document);
  const styleTags = styles.map((css) => `<style data-lesson>${css}</style>`).join("");
  const scriptTags = scripts.map((js) => `<script data-lesson>${js}</script>`).join("");

  // 顺序是**纸面在后、模型在前**：模型写的那份样式可以排在自己的标记前面，但不能压过
  // 纸面外壳——示意声明、标题、依据回执与文字等价是服务端无条件给的，它们被
  // `.astella-art__notice{display:none}` 藏掉的话，「示意声明无条件上屏」就只剩标记
  // 层面成立，屏幕上那一行不见了。（模型那一侧的内容在 `data-stage` 里，纸面规则不
  // 碰它，所以"纸面赢"不会把教具的样式也一起赢走。）
  const html = styleTags
    + ARTIFACT_STYLE_V1
    + `<div class="astella-art" data-artifact-root`
    + ` data-generator-ref="${escapeArtifactTextV1(input.generatorRef)}"`
    + ` data-snapshot-hash="${escapeArtifactTextV1(input.snapshotHash)}"`
    + ` data-outline-count="${nodes.length}">`
    // 示意声明**无条件**在最前面：模型写的那一句只能跟在后面补充，替代不了它。
    + `<p class="astella-art__notice">${escapeArtifactTextV1(ARTIFACT_ILLUSTRATION_NOTICE_V1)}</p>`
    + `<h2 class="astella-art__title">${escapeArtifactTextV1(doc.title)}</h2>`
    + `<p class="astella-art__subject">${escapeArtifactTextV1(doc.subject)}</p>`
    + `<p class="astella-art__caution">${escapeArtifactTextV1(doc.caution)}</p>`
    + `<div class="astella-art__scene" data-stage>${markup}</div>`
    + renderEvidenceV1(nodes)
    + renderTextEquivalentV1(nodes)
    + `</div>`
    + scriptTags;

  const length = artifactCodepointCountV1(html);
  if (length > ROUND_ARTIFACT_MAX_CHARS_V1) {
    return {
      ok: false,
      reason: "over_quota",
      detail: `产物 ${length} 字符，超过上限 ${ROUND_ARTIFACT_MAX_CHARS_V1}（整份拒绝，不截断）`,
    };
  }
  return { ok: true, html };
}

/** 生成器版本（落进 0285 那一列；与提示词版本分开：前者是合同，后者是措辞）。 */
export const DYNAMIC_ARTIFACT_GENERATOR_VERSION_V1 =
  `${DYNAMIC_ARTIFACT_TASK_ID}@v${DYNAMIC_ARTIFACT_TASK_VERSION}`;
