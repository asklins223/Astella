/**
 * 轮次的动态产物：自包含 HTML 的确定性生产者（39d W4-6 刀五；表 0285）。
 *
 * 这一份产出的是**放进桌面模板里的那份内容**，不是整份文档：模板
 * （`apps/desktop-client/src/main/artifact-template.ts`）把内容注入
 * `#ailearn-artifact-root` 的 `<!--__AILEARN_ARTIFACT__-->`，并给
 * `.ailearn-artifact-pane` 提供分屏框与 `::before` 的「第 N 步」（按
 * `data-artifact-step-display` 打印）。所以这里只产出若干 section：解释一屏、
 * 例子一屏（有才出）、计划步骤逐条一屏。
 *
 * 三条边界钉死在这一层：
 *   1. **不写脚本、不引用外部资源**（D4 §3 的 CSP 里 `connect-src 'none'`）：
 *      产出里不许出现 `<script`／`http(s)://` 这类东西，样式一律内联；
 *   2. **文本一律转义**（`& < > " '`）：解释与计划步骤都是材料与用户内容的延伸，
 *      这是"产物同文档、能改模板 DOM"那条路上的第一道闸；
 *   3. **确定性**：同输入 ⇒ 逐字节相同（不写时间戳、不写随机 id）。真模型那一刀
 *      换的就是这个函数（§6 落地记录第 3 条），外壳与失败策略不动。
 *
 * 超配额（0285 的 `nlra_html_len_chk` 上界 524288 字符）是**整份拒绝**：返回
 * `ok:false`，由调用方决定"这一条教学产物没有动态版本"，**不许截断 HTML 凑数**——
 * 截出来的半份在 frame 里只会画成怪东西（与桌面 `assembleArtifactDocument` 同一条判据）。
 */
import type { RoundTeachingContentV1 } from "@ailearn/shared/note-learning-round-contracts";

/** 今天只有这一档（与 0285 的 `nlra_kind_chk`、线上合同的 enum 同宽）。 */
export const ROUND_ARTIFACT_KIND_V1 = "dynamic_explanation" as const;

/**
 * 整份 HTML 的字符上界：与 0285 的 CHECK 同宽，口径是**字符数**（PG 的
 * `char_length` 数的是码点，下面的计数也数码点，不数 UTF-16 码元）。
 */
export const ROUND_ARTIFACT_MAX_CHARS_V1 = 524_288;

/** 生成用的那一份输入：解释正文 ＋ 可选例子 ＋ 计划步骤（都来自这一轮已冻结的东西）。 */
export type RoundArtifactInputV1 = Pick<RoundTeachingContentV1, "explanation" | "example"> & {
  planSteps: string[];
};

/**
 * 产物来源的两种形状（39d W4-1 尾：产物改由模型生成之后才有的这一种）。
 *
 *   - `rendered`：**服务端已经渲染好的整份 HTML**。模型写讲解、可信播放器执行，读数
 *     由服务端算（§6.1）——渲染在**事务外**做完了，落库这一步只负责把它写进去。
 *   - `material`：原始材料，走本文件的确定性构建（没有配模型、或降级时的那一条路）。
 *
 * 分成两种而不是加一个可选字段：可选字段会让"传了半份 html"成为一条能通过类型检查的
 * 路径，而那种产物在 frame 里只会画成怪东西（与桌面 `assembleArtifactDocument` 同一判据）。
 */
export type RoundArtifactSourceV1 =
  | { readonly kind: "rendered"; readonly html: string; readonly generatorRef: string }
  | { readonly kind: "material"; readonly input: RoundArtifactInputV1 };

/** `generator_ref` 的长度上界（0304）：`note_round_dynamic_artifact_v1@v1 (qwen-plus)` 这一类。 */
export const ROUND_ARTIFACT_GENERATOR_REF_MAX_V1 = 200;

export type RoundArtifactBuildFailureV1 = "empty" | "over_quota";

export type RoundArtifactBuildResultV1 =
  | { ok: true; html: string }
  | { ok: false; reason: RoundArtifactBuildFailureV1; detail: string };

/**
 * 文本转义（属性值与元素文本共用这一个函数）：五个字符都是 HTML 里有特殊含义的，
 * 少转一个都够在模板文档里开出一个注入点。
 */
export function escapeArtifactTextV1(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 分屏框的边框与「第 N 步」由模板的 `.ailearn-artifact-pane` 管；框内文字没有第二处样式，在这里内联。 */
const PANE_TITLE_STYLE = "margin:0 0 6px;font-size:14px;line-height:1.5;font-weight:600";
const PANE_BODY_STYLE = "margin:0;white-space:pre-wrap;overflow-wrap:anywhere";

function paneV1(stepIndex: number, title: string, body: string): string {
  return `<section class="ailearn-artifact-pane" data-artifact-step="${stepIndex}" data-artifact-step-display="${stepIndex + 1}">`
    + `<h2 style="${PANE_TITLE_STYLE}">${escapeArtifactTextV1(title)}</h2>`
    + `<p style="${PANE_BODY_STYLE}">${escapeArtifactTextV1(body)}</p>`
    + "</section>";
}

/** 码点计数（与 PG 的 `char_length` 同一口径：一个 emoji 是 1，不是 2）。 */
export function artifactCharLengthV1(html: string): number {
  let length = 0;
  for (const _codePoint of html) length += 1;
  return length;
}

/**
 * 确定性产物 HTML（纯函数）。文本先 `trim`、空计划步骤整条丢掉：
 * 一屏空白不是"第 N 步"，是画面上多出来的一个空框。
 */
export function buildDeterministicArtifactHtmlV1(
  input: RoundArtifactInputV1,
): RoundArtifactBuildResultV1 {
  const explanation = input.explanation.trim();
  const example = input.example?.trim() ?? "";
  const planSteps = input.planSteps.map((step) => step.trim()).filter((step) => step.length > 0);
  if (explanation.length === 0 && example.length === 0 && planSteps.length === 0) {
    return { ok: false, reason: "empty", detail: "解释、例子与计划步骤都是空的，没有可上屏的内容" };
  }

  const panes: string[] = [];
  if (explanation.length > 0) panes.push(paneV1(panes.length, "讲解", explanation));
  if (example.length > 0) panes.push(paneV1(panes.length, "例子", example));
  for (const step of planSteps) panes.push(paneV1(panes.length, "计划", step));

  const html = panes.join("");
  const length = artifactCharLengthV1(html);
  if (length > ROUND_ARTIFACT_MAX_CHARS_V1) {
    return {
      ok: false,
      reason: "over_quota",
      detail: `产物 ${length} 字符，超过上限 ${ROUND_ARTIFACT_MAX_CHARS_V1}（整份拒绝，不截断）`,
    };
  }
  return { ok: true, html };
}
