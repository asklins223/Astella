/** Same-model synthetic HTML comparison; no account data or business writes. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildDynamicArtifactPrompt, dynamicArtifactDocV1Schema, artifactCompletionSatisfiedV1,
  ARTIFACT_COMPLETION_TOKENS_V1, type DynamicArtifactInputV1 } from "@astella/shared/note-dynamic-artifact/round-artifact-model";
import { checkArtifactDocumentV1 } from "@astella/shared/note-dynamic-artifact/round-artifact-doc";
import { extractJsonFromText } from "../lib/providers/json-response.ts";
import { observedProvider, platform, root, safeFailure, type WireReceipt } from "./acceptance-common.ts";

const baseOut = `${root}outputs/audits/2026-10-08-html-motion`;
const extended = process.env.ARTIFACT_PROBE_EXTENDED === "1";
const expandedBudget = process.env.ARTIFACT_PROBE_EXPANDED_BUDGET === "1";
const out = expandedBudget ? `${baseOut}/expanded-budget` : extended ? `${baseOut}/extended` : baseOut;
mkdirSync(out, { recursive: true });
const fixtures: Array<{ id: string; input: DynamicArtifactInputV1 }> = [
  { id: "pendulum", input: { drivingQuestion: "制作一个帮助初学者看懂单摆周期的动态演示。", explanation: "", blocks: [
    { ordinal: 2, type: "paragraph", text: "在摆角很小时，单摆的周期近似为 T=2π√(L/g)，其中 L 是摆长，g 是重力加速度。" },
    { ordinal: 5, type: "paragraph", text: "摆长越长，周期越长；在小角度近似下，周期与摆球质量无关。" },
    { ordinal: 8, type: "paragraph", text: "摆球经过最低点时速度最大，在两端最高点速度为零，重力势能与动能相互转化。" },
  ] } },
  { id: "insertion", input: { drivingQuestion: "用动态演示讲清插入排序为什么稳定。", explanation: "", blocks: [
    { ordinal: 1, type: "paragraph", text: "插入排序从左到右扩展非递减的已排序前缀，每次暂存当前元素，将比它大的元素依次右移，再把暂存元素写入空位。" },
    { ordinal: 4, type: "paragraph", text: "比较时只移动严格大于暂存值的元素，相等元素不移动，因此原本相等元素的相对顺序不变，插入排序是稳定的。" },
    { ordinal: 7, type: "paragraph", text: "例如输入 2a、2b、1c，其中字母表示不会改变的原始身份，排序后得到 1c、2a、2b。" },
  ] } },
];

// Freeze before changing production builders, then run the same saved prompts.
const manifestPath = `${out}/manifest.json`;
if (process.env.ARTIFACT_PROBE_CONNECTIVITY === "1") {
  const wire: WireReceipt[] = [];
  const provider = observedProvider(platform("agent_turn"), "html-connectivity-20261008", wire);
  let outcome: unknown;
  try {
    const result = await provider.chatCompletion([{ role: "user", content: "只回复 OK。" }],
      { maxTokens: 2048, responseFormat: "text" }, AbortSignal.timeout(30_000));
    outcome = { response: result.content, wire };
  } catch (error) { outcome = { failure: safeFailure(error), wire }; }
  writeFileSync(`${out}/connectivity.json`, JSON.stringify(outcome, null, 2), { flag: "wx" });
  console.log(JSON.stringify(outcome));
} else if (process.env.ARTIFACT_PROBE_FREEZE === "1") {
  if (existsSync(manifestPath)) throw new Error("Refusing to overwrite frozen comparison");
  const policySource = readFileSync(`${root}workers/ai-worker/src/agent/execution-context.ts`, "utf8");
  const policy = policySource.match(/\["policy", \{ scope: \{ kind: "policy" \}, content: "([^"]+)"/)?.[1];
  if (!policy) throw new Error("Production generation policy missing");
  const frozenFixtures = extended || expandedBudget
    ? JSON.parse(readFileSync(`${baseOut}/manifest.json`, "utf8")).fixtures.slice(0, 1)
    : fixtures.map(f => ({ ...f, legacy: buildDynamicArtifactPrompt(f.input) }));
  writeFileSync(manifestPath, JSON.stringify({ createdAt: new Date().toISOString(),
    scope: "Two synthetic subjects; same configured model and reasoning; compact vs legacy retains JSON contract and fixed generation policy; direct removes both as a bundled comparison. No historical user sample available.",
    maxCalls: expandedBudget ? 1 : extended ? 2 : 6, timeoutMs: expandedBudget ? 900_000 : extended ? 240_000 : 95_000, system: policy,
    fixtures: frozenFixtures,
  }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ frozen: true, out, promptChars: fixtures.map(f => buildDynamicArtifactPrompt(f.input).length) }));
} else {
  if (existsSync(`${out}/results.json`)) throw new Error("Refusing to rerun completed physical calls");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    system: string; fixtures: Array<{ id: string; input: DynamicArtifactInputV1; legacy: string }> };
  const route = platform("agent_turn");
  const rows: Array<Record<string, unknown>> = [], wire: WireReceipt[] = [];
  const persist = () => writeFileSync(`${out}/results.json`, JSON.stringify({
    route: { type: route.type, model: route.model, profile: route.modelProfile }, rows, wire,
  }, null, 2));
  for (const fixture of manifest.fixtures) {
    for (const condition of (expandedBudget ? ["compact"] : extended ? ["legacy", "compact"] : ["legacy", "compact", "direct"]) as Array<"legacy" | "compact" | "direct">) {
      const prompt = condition === "legacy" ? fixture.legacy : condition === "compact"
        ? buildDynamicArtifactPrompt(fixture.input)
        : `请根据下面的学习内容，制作一个有趣、生动的动态讲解动画网页，帮助读者直观理解。网页的创意、视觉风格、版面、配色、图形、交互和动画由你自由设计。只返回完整自包含的 HTML/CSS/JavaScript，不使用外部资源。\n${JSON.stringify(fixture.input)}`;
      writeFileSync(`${out}/${fixture.id}-${condition}-prompt.txt`, prompt);
      const row: Record<string, unknown> = { subject: fixture.id, condition, promptChars: prompt.length };
      rows.push(row);
      const provider = observedProvider(route, `html-probe-${fixture.id}-${condition}`, wire);
      try {
        const result = await provider.chatCompletion([
          ...(condition === "direct" ? [] : [{ role: "system" as const, content: manifest.system }]),
          { role: "user", content: prompt },
        ], { temperature: 0.4, maxTokens: ARTIFACT_COMPLETION_TOKENS_V1,
          responseFormat: condition === "direct" ? "text" : "json_object" }, AbortSignal.timeout(expandedBudget ? 900_000 : extended ? 240_000 : 95_000));
        writeFileSync(`${out}/${fixture.id}-${condition}-response.txt`, result.content);
        let doc: string;
        if (condition === "direct") doc = result.content.replace(/^\s*```(?:html)?\s*/, "").replace(/\s*```\s*$/, "");
        else {
          const parsed = dynamicArtifactDocV1Schema.safeParse(extractJsonFromText(result.content, ["title", "subject", "caution", "document", "outline"]));
          row.schemaOk = parsed.success;
          if (!parsed.success) { row.schemaIssues = parsed.error.issues.map(i => ({ path: i.path, code: i.code })); persist(); continue; }
          writeFileSync(`${out}/${fixture.id}-${condition}-contract.json`, JSON.stringify(parsed.data, null, 2));
          row.completionOk = artifactCompletionSatisfiedV1(parsed.data, fixture.input.blocks);
          doc = parsed.data.document;
        }
        writeFileSync(`${out}/${fixture.id}-${condition}.html`, doc);
        row.documentChars = doc.length;
        const checked = checkArtifactDocumentV1({ document: doc });
        row.securityOk = checked.ok;
        row.securityReason = checked.verdict.violation?.reason ?? null;
        row.hasMotionHook = doc.includes("setLessonMotion");
        row.motionApis = ["requestAnimationFrame", "@keyframes", ".animate(", "setInterval", "setTimeout"].filter(api => doc.includes(api));
        row.usage = result.usage;
      } catch (error) { row.failure = safeFailure(error); }
      persist();
      console.log(JSON.stringify(row));
    }
  }
}
