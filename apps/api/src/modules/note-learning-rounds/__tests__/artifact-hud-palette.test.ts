/**
 * 动态产物的**纸面配色**与 V3.1 母本不漂移（39f UI-3；`round-artifact-render.ts` 第 1 件事）。
 *
 * ## 为什么这一份要单独立一个文件
 *
 * v3 之后，产物文档里有了**两处**颜色，两处的来路必须钉死：
 *
 *  1. **服务端那圈纸**（`ARTIFACT_STYLE_V1`）：示意声明、标题、凹槽、依据回执、文字等价。
 *     产物跑在 `ailearn-app://artifact` 那个不透明 origin 的 iframe 里，取不到宿主的
 *     `--hud-*`，所以母本的取值是**直接写死**在这一份 `<style>` 里的。
 *  2. **模型那一页**（`.ailearn-art__scene` 上的 `--lesson-*`）：画面整份由模型写，它没法
 *     取到宿主变量，于是同一组取值在**内容落点**上再声明一遍给模型 `var(--lesson-mint)` 用。
 *
 * 这两处一旦各改各的，同一间书房里就会出现两种奶油纸，而且**没有一处会红**：产物自己完全
 * 合法、也能正常跑。所以这一份文件钉的就是下面这三句话：
 *
 *  - 纸面那一圈还带着母本的书房语汇（粗奶油边、不等圆角、带偏移的柔影、衬线+无衬线双声部、
 *    桃/陶土/薄荷/深苔/奶黄/奶油六枚强调色）；
 *  - **同一个颜色只有一个来源**：纸面 token 与给模型的 `--lesson-*` 逐个相等；
 *  - 提示词交给模型的那份取色名单，与落点上真声明的那一份**同宽同名同值**——少一个名字，
 *    模型就只能自己发明颜色（这正是 39f 判死的"深色霓虹仪表盘"那一路）。
 *
 * ## 为什么不逐个 token 去对 `hud-pages.css`
 *
 * 上一版是把产物的每个字面值与母本 `--hud-*` 逐字符对。v3 换掉了四个取值（墨色、淡墨、
 * 压深的纸、深苔），那套对法会整片变红，而"红"里没有任何信息量：它只说明有人改过一边，
 * 不说明该往哪边改。于是这里改成钉**产物内部**的三方同源（纸面 ↔ 落点 ↔ 提示词），
 * 母本那一侧的对齐交回给改母本的那一刀。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDynamicArtifactHtmlV1, type BuildDynamicArtifactInputV1 } from "@ailearn/shared/note-dynamic-artifact/round-artifact-render";
import { buildDynamicArtifactPrompt, dynamicArtifactDocV1Schema } from "@ailearn/shared/note-dynamic-artifact/round-artifact-model";
import { groundArtifactStepsV1, type ArtifactEvidenceBlockV1, type ArtifactNodeV1 } from "@ailearn/shared/note-dynamic-artifact/round-artifact-measure";
import { checkArtifactDocumentV1 } from "@ailearn/shared/note-dynamic-artifact/round-artifact-doc";

const BLOCKS: readonly ArtifactEvidenceBlockV1[] = [
  { ordinal: 1, type: "heading", text: "提取练习四步走" },
  { ordinal: 2, type: "paragraph", text: "提取练习不是重读一遍，是先合上材料，凭记忆把这一节讲一遍。" },
  { ordinal: 3, type: "paragraph", text: "讲不下去的地方就是没真懂的地方，先记下来，不要急着翻回去。" },
];
const OUTLINE = [
  { title: "合上书先讲一遍", narration: "不是重读，是先合上材料凭记忆讲一遍。", evidenceOrdinal: 2, evidenceQuote: "先合上材料，凭记忆把这一节讲一遍" },
  { title: "卡住的地方先记下", narration: "讲不下去的地方就是没真懂的地方。", evidenceOrdinal: 3, evidenceQuote: "讲不下去的地方就是没真懂的地方" },
] as const;

const GROUNDED = groundArtifactStepsV1({ steps: OUTLINE, blocks: BLOCKS });
assert.ok(GROUNDED.ok, "基准材料自己核不过：那下面每一条用例都在测一个不成立的前提");
const NODES: readonly ArtifactNodeV1[] = GROUNDED.nodes;

const SNAPSHOT_HASH = "726f6b03d3d48cc646abd3b370ce97e8";
const GENERATOR_REF = "note_round_dynamic_artifact_v1@v3 (qwen-plus)";

/** 一份真的模型页面：样式 + 标记 + 脚本三段俱全（少一段，拆分那几条判据就空转了）。 */
const PAGE = [
  "<style>",
  "  .q{font-size:13px;color:var(--lesson-soft)}",
  "  .n{cursor:pointer}",
  "</style>",
  "<div class=\"w\">",
  "<svg viewBox=\"0 0 320 120\" role=\"img\" aria-label=\"提取练习的推进顺序\">",
  "<rect width=\"320\" height=\"120\" rx=\"12\" fill=\"var(--lesson-paper-deep)\"/>",
  "<text x=\"20\" y=\"44\" font-size=\"16\" fill=\"var(--lesson-ink)\">先合上材料，凭记忆把这一节讲一遍</text>",
  "</svg>",
  "<p class=\"q\">先合上材料，凭记忆把这一节讲一遍</p>",
  "<p class=\"q\">讲不下去的地方就是没真懂的地方</p>",
  "<p>这一段是页面里给读者看的说明，讲清这一页在做什么、用什么方式动手，以及看完之后应该能自己说出哪一步。</p>".repeat(4),
  "</div>",
  "<script>document.querySelectorAll('.q').forEach(function (el) { el.dataset.seen = '1'; });</script>",
].join("");

const DOC = dynamicArtifactDocV1Schema.parse({
  title: "提取练习的两步",
  subject: "为什么提取练习要合上书再讲",
  caution: "只按这一轮材料示意。",
  document: PAGE,
  outline: OUTLINE.map((beat) => ({ ...beat })),
});

const BUILT = buildDynamicArtifactHtmlV1({
  doc: DOC,
  nodes: NODES,
  snapshotHash: SNAPSHOT_HASH,
  generatorRef: GENERATOR_REF,
} satisfies BuildDynamicArtifactInputV1);
assert.ok(BUILT.ok, "基准 doc 自己渲染不出来：下面每一条都在测一个不成立的前提");
const HTML = BUILT.html;

/** 服务端那一圈纸的样式（第一段 `<style>`，没有 `data-lesson`）。 */
const SHELL_STYLE = /<style>([\s\S]*?)<\/style>/.exec(HTML)?.[1] ?? "";
assert.ok(SHELL_STYLE.length > 0, "产物里找不到服务端那一段样式：下面每一条都在测一段不存在的 CSS");
/** 同一段样式剥掉注释：判"哪一条规则声明了什么"时，注释会混进选择器里。 */
const SHELL_CSS = SHELL_STYLE.replace(/\/\*[\s\S]*?\*\//g, "");

/** 纸面上那些 token 的声明块（`.ailearn-art{…}`）。 */
const SHELL_TOKENS = (): ReadonlyMap<string, string> => tokenMap(/\.ailearn-art\{([^}]*)\}/.exec(SHELL_STYLE)?.[1] ?? "");

/** 凹槽那一条规则的 body——给模型的那组 `--lesson-*` 就声明在这里。 */
const SCENE_RULE = (): string => /\.ailearn-art__scene\{([^}]*)\}/.exec(SHELL_STYLE)?.[1] ?? "";
const LESSON_TOKENS = (): ReadonlyMap<string, string> => tokenMap(SCENE_RULE());

function tokenMap(css: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of css.matchAll(/(--[a-z-]+):([^;]+);?/g)) out.set(name!, value!.trim());
  return out;
}

/**
 * 纸面 token 与给模型的 `--lesson-*` 之间的对应表。
 *
 * **写成表而不是按名字自动推**，是因为名字本来就不同名（纸面叫 `--paper-light`，给模型的那份
 * 叫 `--lesson-paper`）。这里要钉的正是"这两套名字说的是同一个颜色"——将来有人把其中一个
 * 改名而忘了改另一个，模型就会 `var(--lesson-paper)` 拿到空值，页面的主底色静默变成透明。
 */
const TOKEN_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["--ink", "--lesson-ink"],
  ["--soft", "--lesson-soft"],
  ["--paper-light", "--lesson-paper"],
  ["--paper-deep", "--lesson-paper-deep"],
  ["--cream", "--lesson-cream"],
  ["--butter", "--lesson-butter"],
  ["--mint", "--lesson-mint"],
  ["--green", "--lesson-green"],
  ["--peach", "--lesson-peach"],
  ["--clay", "--lesson-clay"],
  ["--edge", "--lesson-edge"],
  ["--shadow", "--lesson-shadow"],
];

test("凹槽是母本那一块纸：4px 粗奶油边 ＋ 四角不等的圆角 ＋ 带偏移的双层柔影", () => {
  const scene = SCENE_RULE();
  assert.ok(scene.length > 0, "样式里没有 `.ailearn-art__scene` 这一条：模型的页面落在哪儿无从对照");
  assert.equal(SHELL_TOKENS().get("--edge"), "rgba(255,252,235,.78)",
    "奶油边那一道不是母本那个半透明暖白：产物里会显出第二种纸的边");
  assert.match(scene, /border:4px solid var\(--edge\)/, "凹槽外面不是母本那道 4px 粗奶油边");

  // 不等圆角：横向四个值必须**真的**不相等，而且差得出来。母本的味道就在这里——
  // 一旦有人"顺手"改成 `border-radius:24px`，这件纸就变成了后台面板里的一个圆角矩形。
  const radius = /border-radius:([\d.]+px) ([\d.]+px) ([\d.]+px) ([\d.]+px)(?:\/([\d.]+px) ([\d.]+px) ([\d.]+px) ([\d.]+px))?/.exec(scene);
  assert.ok(radius, `凹槽的圆角不是母本那种四角不等的写法：${scene}`);
  const corners = radius.slice(1, 5).map((value) => Number.parseFloat(value!));
  assert.equal(new Set(corners).size, 4, `圆角四个值里有重复的（${corners.join(" ")}）：母本是"手撕纸"，不是圆角矩形`);
  const spread = Math.max(...corners) - Math.min(...corners);
  assert.ok(spread >= 6, `圆角四个值只差了 ${spread}px（${corners.join(" ")}）：那已经看不出是手撕的了`);

  // 柔影**带偏移**：x、y 都得非零。居中的大模糊是光晕，不是母本那种"这张纸浮起来一点"的影。
  const shadow = /box-shadow:([^;]+);/.exec(scene)?.[1] ?? "";
  const layers = shadow.split(/,(?![^(]*\))/).map((layer) => layer.trim()).filter(Boolean);
  assert.ok(layers.length >= 2, `凹槽只有 ${layers.length} 层影：母本那对小浮层影没了，纸就贴死在桌面上`);
  for (const layer of layers) {
    const [x, y] = /(-?[\d.]+)px (-?[\d.]+)px/.exec(layer)?.slice(1) ?? [];
    assert.ok(Number.parseFloat(x ?? "0") !== 0 && Number.parseFloat(y ?? "0") !== 0,
      `有一层影没有偏移（${layer}）：那是光晕，母本用的是带方向的柔影`);
  }
  assert.ok(shadow.includes("rgba(43,27,17,.22)") && shadow.includes("rgba(43,27,17,.14)"),
    `柔影的墨色不对：${shadow}`);
});

test("字体是母本的双声部：讲内容的字走衬线，读数与操作说明走无衬线", () => {
  assert.match(SHELL_STYLE, /"Songti SC","STSong"[^\n]*serif/,
    "讲内容的字没落到衬线上：整份产物会读成一块工具面板的说明文字");
  assert.match(SHELL_STYLE, /\.ailearn-art__sans\{font-family:"PingFang SC","Microsoft YaHei"[^\n]*sans-serif\}/,
    "读数与操作说明那一路没有单独的无衬线：母本是双声部，这里被压成了单声部");
  // 两路都要有中文回退名：产物被复制到别的机器/别的系统时，中文不许掉回默认字形。
  assert.ok(SHELL_STYLE.includes('"Noto Serif CJK SC"'), "衬线那一路没有中文回退");
  assert.ok(SHELL_STYLE.includes('"Noto Sans CJK SC"'), "无衬线那一路没有中文回退");
});

test("母本的六枚强调色一个都不少：桃、陶土、薄荷、深苔、奶黄、奶油", () => {
  const tokens = SHELL_TOKENS();
  // 取值是母本 V3.1 的字面量。少一枚，凹槽与两张回执里就有一处要退化成灰阶。
  for (const [token, expected] of [
    ["--peach", "#e89568"],
    ["--clay", "#bd5a31"],
    ["--mint", "#b9d3ad"],
    ["--green", "#66816a"],
    ["--butter", "#f3d678"],
    ["--cream", "#fff2cf"],
  ] as const) {
    assert.equal(tokens.get(token), expected,
      `${token} 在产物里是 ${tokens.get(token) ?? "（没有）"}，母本现在是 ${expected}：iframe 里会显出第二种奶油纸`);
  }
  // 而它们真的被用上了（不是声明了却没人引，那等于白留一份会漂移的取值）。
  for (const token of ["--peach", "--green", "--butter", "--cream"]) {
    assert.ok(new RegExp(`var\\(${token}\\)`).test(SHELL_STYLE), `${token} 声明了却没被任何一条规则引用`);
  }
  // 剩下的几枚（`--mint`/`--clay`/`--paper-deep`/`--shadow`）在纸面上没有落点，它们的**唯一**
  // 职责就是给模型的那份 `--lesson-*` 当来源。所以 token 块里允许有"只当来源"的格子，
  // 但**既不当来源、也没人用**的格子不允许有：它是一份会漂移却没有任何东西会红的取值。
  const orphans = [...tokens.keys()].filter((name) =>
    !new RegExp(`var\\(${name}\\)`).test(SHELL_STYLE)
    && !TOKEN_PAIRS.some(([paper]) => paper === name));
  // 曾经允许的唯一一个是 `--ease`：它记着母本那条缓出曲线，可产物里没有任何一条规则
  // 用它。2026-09-28 把它**删掉**了——纸面外壳本来就不该有动画（教具的动效在模型写
  // 的那一页里，在 `data-stage` 里），留着它只是一份没人会红的副本。于是这里从"允许一个"
  // 变成"一个都不许有"：再有人加进一个既没人用、也不给模型当来源的取值，这条会红。
  assert.deepEqual(orphans, [],
    `token 块里多出了既没人用、也不给模型当来源的格子：${orphans.join("、")}。`
    + "要么哪条规则该用上它（那么它是活的），要么它该被删掉（那么它只是一份没人会红的副本）");
});

test("同一个颜色只有一个来源：纸面 token 与给模型的 `--lesson-*` 逐个相等", () => {
  const shell = SHELL_TOKENS();
  const lesson = LESSON_TOKENS();
  for (const [paper, exposed] of TOKEN_PAIRS) {
    assert.ok(shell.has(paper), `纸面上没有 ${paper}：凹槽那一圈少了一个来源`);
    assert.ok(lesson.has(exposed), `落点上没有 ${exposed}：模型写 \`var(${exposed})\` 拿到的是空值，`
      + "那一处颜色会静默变成透明（CSS 自定义属性取不到值时不是报错，是没有）");
    assert.equal(lesson.get(exposed), shell.get(paper),
      `${exposed}（${lesson.get(exposed) ?? "（没有）"}）与 ${paper}（${shell.get(paper) ?? "（没有）"}）不是同一个取值：`
      + "同一个颜色于是有了两个来源，改一边就会显出第二种纸");
  }
  // 两边的**个数**也要一样：多出来的那一个同样是第二个来源（而且没有任何东西会用到它）。
  assert.equal(lesson.size, TOKEN_PAIRS.length, `落点上声明了 ${lesson.size} 个 --lesson-*，对得上的是 ${TOKEN_PAIRS.length} 个`);
  const extraPaper = [...shell.keys()].filter((name) => !name.startsWith("--lesson-") && !TOKEN_PAIRS.some(([p]) => p === name));
  assert.deepEqual(extraPaper, ["--paper", "--line", "--line-strong"],
    `纸面上多出了没对上的 token：${extraPaper.join("、")}。`
    + "其中 `--paper`/`--line*` 是**只给纸面自己**用的（它们的活是画回执与便签边），"
    + "不属于给模型的那一组；多一个就说明两份清单开始分家了");
});

test("给模型的那组 `--lesson-*` 只声明在**落点那一条规则**上（不是全局，也不是纸面上）", () => {
  // 规则选择器：谁身上声明了 `--lesson-mint`。
  const selectors = [...SHELL_CSS.matchAll(/([^{}]+)\{([^{}]*--lesson-mint:[^{}]*)\}/g)].map((match) => match[1]!.trim());
  assert.deepEqual(selectors, [".ailearn-art__scene"],
    `声明 --lesson-* 的规则是 ${selectors.join("、")}：它得是落点那一条，`
    + "否则要么模型在自己的脚本里读不到（作用域在它之下），要么纸面自己被模型改掉了");
  // 落点就是那个带 data-stage 的元素，模型的标记落在它里面。
  assert.equal((HTML.match(/class="ailearn-art__scene"/g) ?? []).length, 1, "凹槽不止一个：模型那一页不知道落进哪一块");
  assert.match(HTML, /<div class="ailearn-art__scene" data-stage>/, "带 --lesson-* 的那个元素上没有 data-stage：落点与声明对不上");
  // 变量会向下继承给模型写的标记（声明在凹槽上、模型的内容在凹槽里）。
  const stageAt = HTML.indexOf('<div class="ailearn-art__scene" data-stage>');
  const stageEnd = HTML.indexOf("</div><section class=\"ailearn-art__evidence\"");
  assert.ok(stageAt > 0 && stageEnd > stageAt, "凹槽的开合找不到了：继承关系无从核对");
  assert.ok(HTML.slice(stageAt, stageEnd).includes("<svg"), "模型那一页没落进凹槽里");
});

test("网页创作不受书房外壳的配色名单约束", () => {
  const prompt = buildDynamicArtifactPrompt({
    drivingQuestion: "先弄懂提取练习为什么要合上书再讲",
    blocks: BLOCKS,
    explanation: "提取练习的关键在「合上」这一步。",
  });
  assert.ok(prompt.includes("配色、图形、交互和动画由你自由设计"));
  assert.equal(prompt.includes("--lesson-"), false);
  assert.equal(prompt.includes("奶油纸"), false);
  assert.equal(LESSON_TOKENS().size, TOKEN_PAIRS.length);
});

test("产物样式里不许出现 `var(--hud-*)`：frame 跑在不透明 origin 上，那一格会静默取不到值", () => {
  const used = [...SHELL_CSS.matchAll(/var\((--hud-[a-z-]+)\)/g)].map((match) => match[1]!);
  assert.deepEqual([...new Set(used)], [],
    `产物样式引用了 ${[...new Set(used)].join("、")}：产物文档不继承宿主的 :root，`
    + "这些格子取不到值时会**静默**退回无声明（不是报错），于是那一处样式悄悄消失");
});

test("生成器版本与材料哈希只许出现在 `data-*` 上，学习画面上读不到它们（39f UI-3）", () => {
  assert.match(HTML, new RegExp(`data-snapshot-hash="${SNAPSHOT_HASH}"`), "快照哈希没有落进属性：事后读不出这一份是哪一版正文做的");
  assert.match(HTML, /data-generator-ref="[^"]*qwen-plus[^"]*"/, "生成器版本没有落进属性：0285 那一列无从查起");
  // 屏幕上真正读得到的那部分：去掉样式、脚本与 data-* 属性。
  const visible = HTML
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/data-[a-z-]+="[^"]*"/g, "");
  assert.equal(visible.includes(SNAPSHOT_HASH.slice(0, 12)), false, "材料哈希又被印回画面上了：它抢的是本该讲概念的位置");
  assert.equal(visible.includes("qwen-plus"), false, "生成器版本又被印回画面上了");
  assert.equal(visible.includes("生成器"), false);
  // 反过来也不许换个说法印上去。
  assert.equal(/@v3|note_round_dynamic_artifact/.test(visible), false, "生成器版本换了个写法印回画面上了");
});

test("不再是上一版那套 iframe 里另起的小工具：不是 system-ui 打头的细灰线小圆角白底", () => {
  assert.ok(!/font:\d+px\/[\d.]+ system-ui/.test(SHELL_STYLE), "产物又退回 system-ui 打头的小工具外观了");
  assert.ok(!/border-radius:8px;border:1px solid rgba\(120,96,72,0\.4\);background:rgba\(255,255,255,0\.9\)/.test(SHELL_STYLE),
    "还是上一版那种细灰线小圆角白底按钮");
  // 粗奶油边是母本"可点物件"的统一语言：便签、回执、文字版三块都得有它。
  const creamBorders = (SHELL_STYLE.match(/border:\d+px solid var\(--edge\)/g) ?? []).length;
  assert.ok(creamBorders >= 1, "纸面上找不到那道粗奶油边：物件感是从这条边开始的");
});

test("模型那一页自己过得了安全闸（这一份是「一份真的能上屏的模型页面」，不是示意图）", () => {
  const checked = checkArtifactDocumentV1({ document: DOC.document });
  assert.equal(checked.ok, true,
    `基准页面过不了安全闸（${JSON.stringify(checked.verdict.violation)}）：这一份是「一份真的能上屏的模型页面」，不是示意图`);
});
