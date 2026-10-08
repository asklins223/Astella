import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import type { CompanionRecentHistoryMessage } from "../handlers/companion-context-handoff.ts";
import { observedProvider, platform, outputDir, save, safeFailure, type WireReceipt } from "./acceptance-common.ts";
import { buildDialogueExperimentRequest, hashDialogueValue, snapshotDialogueRequest, snapshotDialogueWireBody } from "./dialogue-experiment.ts";
import { correctionDialogueGuidance, dialogueCorrectionGuidance } from "./dialogue-correction-guidance.ts";
import { finalizeCompanionReplyText, sanitizeCompanionVisibleText, validateCompanionOutput } from "../handlers/companion-dialogue-content.ts";

const suffix = process.env.LIVE_DIALOGUE_CORRECTION_SUFFIX;
if (!suffix || !/^[a-z0-9-]{1,40}$/.test(suffix)) throw new Error("Unique diagnostic suffix required");
const name = `deepseek-correction-${suffix}`;
if (existsSync(`${outputDir}/${name}-manifest.json`) || existsSync(`${outputDir}/${name}.json`)) throw new Error("No evidence overwrite");
const route = platform("agent_turn");
if (route.model !== "deepseek-v4.1-flash") throw new Error("Human fixed-model instruction");
const maxTokens = route.modelProfile?.maxOutputTokens;
if (!maxTokens) throw new Error("Declared output ceiling required");
const cases = [
  { id: "recording", seed: ["录音处理完了。", "重新录了一遍，终于能用了。"], correction: "录音只剪了开头那段空白，没有重新录。", next: "原来后面那段停顿反而挺自然的。" },
  { id: "label", seed: ["花盆弄好了。", "换了新土，植物这回能舒服些。"], correction: "不是换土，只给花盆换了张标签。", next: "那张旧标签写了个错别字。" },
  { id: "alarm", seed: ["闹钟那块调了一下。", "时间改好就不怕起晚了。"], correction: "我只把闹钟图标挪了个位置，响铃时间没改。", next: "原来的位置被一张小猫照片占了。" },
  { id: "figures", seed: ["那组数字弄到表上了。", "结果算出来了，这下踏实了。"], correction: "只是把数字抄到表上，结果还没算。", next: "有一行我用红笔圈起来了。" },
  { id: "kettle", seed: ["壶收拾好了。", "水烧上了，等着就行。"], correction: "壶刷干净了而已，里面还没放水。", next: "壶盖倒比壶身亮得多。" },
  { id: "laces", seed: ["鞋子那点小事弄好了。", "鞋底修好了，又能穿一阵。"], correction: "换的是鞋带，鞋底还是原来那块。", next: "旧鞋带有一段磨毛了。" },
];
const frozen = { frozenAt: new Date().toISOString(), batchId: randomUUID(), maxCalls: 24,
  model: route.model, profile: route.modelProfile, candidate: dialogueCorrectionGuidance, cases,
  criteria: ["撤回具体误会并采用用户更正，不辩解。", "更正和随后分享不被转成新建议/安排。", "后续不复活旧状态，不补不存在的完成阶段、能力或操作。"],
  scope: "Six new targeted synthetic correction prefixes and one follow-up each, baseline/component candidate. First prefixes identical; follow-ups replay branch actual answers. Offline production builders only; fixed conversation interpretation, not full HTTP/UI or independent human acceptance.",
  change: "Replace only the single casual correction paragraph; all persona, other execution guidance, native text, automatic thinking and output parameters retained. The broad 32-call contrast candidate is not adopted or silently retuned.",
};
writeFileSync(`${outputDir}/${name}-manifest.json`, JSON.stringify(frozen, null, 2), { flag: "wx" });
const conditions = ["baseline", "correction"] as const;
type Row = { id: string; condition: typeof conditions[number]; turn: number; userText: string;
  request: ReturnType<typeof snapshotDialogueRequest>; wireSnapshots: ReturnType<typeof snapshotDialogueWireBody>[];
  answer?: string; rawAnswer?: string; validation?: ReturnType<typeof validateCompanionOutput>; finishReason?: string;
  completedMatchesDeltas?: boolean; rawDelta?: string; firstVisibleMs?: number | null; elapsedMs?: number; error?: ReturnType<typeof safeFailure> };
const rows: Row[] = [], wire: WireReceipt[] = [];
const persist = () => save(name, { manifestHash: hashDialogueValue(frozen), rows, wire });
const histories = new Map<string, CompanionRecentHistoryMessage[]>(), blocked = new Set<string>();
const message = (role: "user" | "assistant", text: string, seq: number): CompanionRecentHistoryMessage =>
  ({ role, text, seq: String(seq), createdAt: new Date(Date.UTC(2026, 9, 7, 8, seq)).toISOString() });
for (const item of cases) for (const condition of conditions)
  histories.set(`${item.id}/${condition}`, item.seed.map((text, i) => message(i % 2 ? "assistant" : "user", text, i + 1)));
persist();
for (let turn = 1; turn <= 2; turn++) for (const [index, item] of cases.entries()) {
  const order = (index + turn) % 2 ? [...conditions].reverse() : conditions;
  for (const condition of order) {
    const key = `${item.id}/${condition}`;
    if (blocked.has(key)) continue;
    const history = histories.get(key)!;
    const userText = turn === 1 ? item.correction : item.next;
    const built = buildDialogueExperimentRequest({ id: key, userText, history, intent: "conversation" }, "full", maxTokens);
    const request = condition === "correction" ? correctionDialogueGuidance(built.request) : built.request;
    const row: Row = { id: item.id, condition, turn, userText, request: snapshotDialogueRequest(request), wireSnapshots: [] };
    rows.push(row);
    const provider = observedProvider(route, `${frozen.batchId}/${key}/${turn}`, wire, undefined, undefined, undefined, body => {
      if (wire.length >= frozen.maxCalls) throw new Error("Physical call budget reached");
      row.wireSnapshots.push(snapshotDialogueWireBody(body));
    });
    let rawDelta = "", firstVisibleMs: number | null = null;
    const started = Date.now();
    try {
      if (!provider.chatCompletionStream) throw new Error("Streaming route required");
      const native = request.messages.map(m => {
        if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || m.reasoning?.length)
          throw new Error("Only native visible text is replayed");
        return { role: m.role, content: m.content };
      });
      const result = await provider.chatCompletionStream([{ role: "system", content: request.systemPrompt }, ...native],
        { maxTokens: request.maxTokens, temperature: request.temperature, disableThinking: request.disableThinking,
          responseFormat: "text" }, AbortSignal.timeout(30000), delta => {
          rawDelta += delta;
          if (firstVisibleMs === null && sanitizeCompanionVisibleText(rawDelta).trim()) firstVisibleMs = Date.now() - started;
        });
      const answer = finalizeCompanionReplyText({ text: result.content, runId: key }).text;
      const validation = validateCompanionOutput(answer);
      Object.assign(row, { answer: validation.ok ? validation.text : answer, rawAnswer: result.content, validation,
        finishReason: result.finishReason, completedMatchesDeltas: result.content === rawDelta });
      if (!validation.ok || result.finishReason !== "stop" || !row.completedMatchesDeltas || !row.answer?.trim()) blocked.add(key);
      else history.push(message("user", userText, history.length + 1), message("assistant", row.answer, history.length + 2));
    } catch (error) { row.error = safeFailure(error); blocked.add(key); }
    Object.assign(row, { rawDelta, firstVisibleMs, elapsedMs: Date.now() - started });
    persist();
    console.log(JSON.stringify({ completed: rows.length, physical: wire.length, id: row.id, condition, turn,
      elapsedMs: row.elapsedMs, error: row.error ?? null }));
  }
}
