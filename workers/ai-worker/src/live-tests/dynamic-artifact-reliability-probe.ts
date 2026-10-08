/** Synthetic single-block regression; no account reads or business writes. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildDynamicArtifactPrompt, dynamicArtifactDocV1Schema, artifactCompletionSatisfiedV1,
  ARTIFACT_COMPLETION_TOKENS_V1, createDynamicArtifactResponseSessionV1, runDynamicArtifactV1,
  type DynamicArtifactInputV1 } from "@astella/shared/note-dynamic-artifact/round-artifact-model";
import { checkArtifactDocumentV1 } from "@astella/shared/note-dynamic-artifact/round-artifact-doc";
import { groundArtifactStepsV1 } from "@astella/shared/note-dynamic-artifact/round-artifact-measure";
import { extractJsonFromText } from "../lib/providers/json-response.ts";
import { observedProvider, platform, root, safeFailure, type WireReceipt } from "./acceptance-common.ts";

const label = process.env.ARTIFACT_PROBE_LABEL ?? "baseline";
if (!/^[a-z0-9-]+$/.test(label)) throw new Error("Invalid probe label");
const out = `${root}outputs/audits/2026-10-08-artifact-reliability/${label}`;
mkdirSync(out, { recursive: true });
const input: DynamicArtifactInputV1 = { drivingQuestion: "请围绕选中的原句，用更直观、有趣或容易理解的方式做一份互动演示：电功率与电阻：固定电压 P∝1/R，固定电流 P∝R", explanation: "", blocks: [
  { ordinal: 0, type: "heading", text: "电功率与电阻：固定电压 P∝1/R，固定电流 P∝R" },
] };
const prompt = buildDynamicArtifactPrompt(input);
writeFileSync(`${out}/prompt.txt`, prompt, { flag: "wx" });
const wire: WireReceipt[] = [];
const provider = observedProvider(platform("agent_turn"), `artifact-reliability-${label}`, wire);
const report: Record<string, unknown> = { label, wire };
try {
  let candidate: unknown;
  if (process.env.ARTIFACT_PROBE_REPAIR === "1") {
    const original = dynamicArtifactDocV1Schema.parse(JSON.parse(readFileSync(
      `${root}outputs/audits/2026-10-08-artifact-reliability/baseline/contract.json`, "utf8")));
    const session = createDynamicArtifactResponseSessionV1();
    let calls = 0;
    const run = await runDynamicArtifactV1({ input, scope: { workspaceId: "synthetic", userId: "synthetic" },
      source: { idempotencyKey: label, leaseToken: "synthetic", noteVersionId: "synthetic", sourceContentHash: "synthetic" },
      currentActiveTransaction: () => undefined, modelId: provider.modelId,
      provider: async material => {
        calls++;
        if (calls === 1) return session.accept({ ...original, title: "长".repeat(41),
          outline: original.outline.map(beat => ({ ...beat, evidenceOrdinal: 999 })) }, material);
        const repairPrompt = session.prompt(material);
        writeFileSync(`${out}/repair-prompt.txt`, repairPrompt, { flag: "wx" });
        const result = await provider.chatCompletion([{ role: "user", content: repairPrompt }],
          { maxTokens: ARTIFACT_COMPLETION_TOKENS_V1, responseFormat: "json_object" }, AbortSignal.timeout(900_000));
        writeFileSync(`${out}/response.txt`, result.content, { flag: "wx" });
        return session.accept(extractJsonFromText(result.content, ["title", "subject", "caution", "outline"]), material);
      },
    });
    report.kernelOk = run.ok;
    report.kernelModelSteps = run.modelCalls;
    report.htmlPreserved = run.ok && run.doc.document === original.document;
    if (!run.ok) throw new Error(run.detail);
    candidate = run.doc;
  } else {
    const result = await provider.chatCompletion([{ role: "user", content: prompt }],
      { temperature: 0.4, maxTokens: ARTIFACT_COMPLETION_TOKENS_V1, responseFormat: "json_object" }, AbortSignal.timeout(900_000));
    writeFileSync(`${out}/response.txt`, result.content, { flag: "wx" });
    candidate = extractJsonFromText(result.content, ["title", "subject", "caution", "document", "outline"]);
  }
  const parsed = dynamicArtifactDocV1Schema.safeParse(candidate);
  report.schemaOk = parsed.success;
  if (parsed.success) {
    writeFileSync(`${out}/contract.json`, JSON.stringify(parsed.data, null, 2), { flag: "wx" });
    writeFileSync(`${out}/candidate.html`, parsed.data.document, { flag: "wx" });
    report.completionOk = artifactCompletionSatisfiedV1(parsed.data, input.blocks);
    report.grounding = groundArtifactStepsV1({ steps: parsed.data.outline, blocks: input.blocks });
    report.documentCheck = checkArtifactDocumentV1({ document: parsed.data.document });
    // Visible text lives in the synthetic candidate, not the compact receipt.
    delete (report.documentCheck as Record<string, unknown>).text;
    report.documentChars = parsed.data.document.length;
  } else report.schemaIssues = parsed.error.issues.map(i => ({ path: i.path, code: i.code }));
} catch (error) { report.failure = safeFailure(error); }
writeFileSync(`${out}/results.json`, JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify(report));
