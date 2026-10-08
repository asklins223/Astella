import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import type { AgentTurnRequest } from "@astella/shared";
import type { CompanionRecentHistoryMessage } from "../handlers/companion-context-handoff.ts";
import { observedProvider, platform, outputDir, save, safeFailure, type WireReceipt } from "./acceptance-common.ts";
import { buildDialogueExperimentRequest, hashDialogueValue, snapshotDialogueRequest,
  snapshotDialogueWireBody } from "./dialogue-experiment.ts";
import { contrastDialogueGuidance, dialogueContrastGuidance } from "./dialogue-contrast-guidance.ts";
import { finalizeCompanionReplyText, sanitizeCompanionVisibleText,
  validateCompanionOutput } from "../handlers/companion-dialogue-content.ts";

const suffix = process.env.LIVE_DIALOGUE_CONTINUOUS_SUFFIX;
if (!suffix || !/^[a-z0-9-]{1,40}$/.test(suffix)) throw new Error("Unique diagnostic suffix required");
const name = `deepseek-continuous-${suffix}`;
const manifestPath = `${outputDir}/${name}-manifest.json`;
if (existsSync(manifestPath) || existsSync(`${outputDir}/${name}.json`)) throw new Error("No evidence overwrite");
const route = platform("agent_turn");
if (route.model !== "deepseek-v4.1-flash") throw new Error("Human fixed-model instruction");
const maxTokens = route.modelProfile?.maxOutputTokens;
if (!maxTokens) throw new Error("Declared output ceiling required");
type Script = { id: string; seed: string[]; turns: { text: string; intent: "conversation" | "question"; criteria: string[] }[] };
const scripts: Script[] = [
  { id: "shelf-sparrow", seed: ["架子的背板装好了。", "抽屉也装完了，这个架子算齐活了。"], turns: [
    { text: "我只装了背板，抽屉还在箱子里。", intent: "conversation", criteria: ["撤回抽屉装好的误会，采用更正，不催促或分析用户。"] },
    { text: "螺丝刀先找不到了，搁着吧。刚刚窗台上来了一只麻雀。", intent: "conversation", criteria: ["接麻雀，不继续架子任务，不把未装的抽屉写成完成。"] },
    { text: "它一直对着玻璃上的影子歪头。", intent: "conversation", criteria: ["接具体画面，不声称自己看见，不把动物心理当已知。"] },
    { text: "我倒觉得像是在认对手。", intent: "conversation", criteria: ["可以参与想象或不同看法，不借机教育或诊断。"] },
    { text: "说回那个架子，怎么区分抽屉滑轨的左右？", intent: "question", criteria: ["提供辨认办法，未知型号不假定结构，不宣称抽屉已装。"] },
    { text: "找到标记了，一边L一边R，抽屉这次也装上了。", intent: "conversation", criteria: ["采用现在才完成的更新，不编测试/摆物/整体质量。"] },
    { text: "我刚把那只麻雀画在便签上了，脑袋画得特别大。", intent: "conversation", criteria: ["接画上的细节，不复活装架子，不评价绘画能力。"] },
    { text: "嗯，这张就留在窗台上。", intent: "conversation", criteria: ["承接此段收尾，不布置新任务，不强行续问。"] },
  ] },
  { id: "bead-noodles", seed: ["写一个钥匙串在火车站迷路的小故事。", "钥匙串跟着广播找站台，最后在红色行李箱旁找到了它的主人。这是故事的结尾。"], turns: [
    { text: "我包上的挂件换成一颗玻璃珠了。", intent: "conversation", criteria: ["跟随挂件新话题，故事不归入用户经历，不续写故事。"] },
    { text: "那颗珠子是蓝的，一照就像里面有条小河。", intent: "conversation", criteria: ["可以联想，不声称实见或补珠子成分/用户心情。"] },
    { text: "昨天那颗黄色的倒没这个感觉。", intent: "conversation", criteria: ["昨天旧挂件与今天蓝色挂件分开，时钟不充当事情发生时间。"] },
    { text: "黄色那颗已经换下来放抽屉了，包上现在就蓝色这颗。", intent: "conversation", criteria: ["采用范围更正，不编同时悬挂或收藏用途。"] },
    { text: "顺便问一下，挂件的环有个口一直合不上，怎么弄牢一点？", intent: "question", criteria: ["给可用办法，区分结构或必要澄清，不退化为空泛安慰。"] },
    { text: "是那种普通开口环，两头没对齐，包倒不是它承重。", intent: "question", criteria: ["沿用更正结构解释操作，不按分体钥匙圈结构瞎指挥。"] },
    { text: "弄好了。我看了眼午饭的面条，都坨成一团了。", intent: "conversation", criteria: ["接面条，不追问环，不猜冷了多久或安排进食。"] },
    { text: "已经拌开了，居然还挺好吃。", intent: "conversation", criteria: ["接意外味道，不宣称自己尝到，不布置下次步骤。"] },
  ] },
];
const conditions = ["baseline", "contrast"] as const;
type Condition = typeof conditions[number];
const frozen = { frozenAt: new Date().toISOString(), batchId: randomUUID(), maxCalls: 32,
  model: route.model, profile: route.modelProfile, candidate: dialogueContrastGuidance, scripts,
  conditions, scope: "Offline production request builders, two eight-turn synthetic dialogues per condition. Each branch replays its own actual visible replies. Fixed user script; no evaluator/criteria in requests; no HTTP/queue/Electron claim. Not an independent human rating.",
  change: "Only replace the casual execution guidance. Question requests use the identical original production guidance in both branches. Native histories diverge after first actual response, so later branch comparisons are trajectory diagnostics, not identical-prefix causal comparisons.",
};
writeFileSync(manifestPath, JSON.stringify(frozen, null, 2), { flag: "wx" });
type Row = { id: string; turn: number; condition: Condition; userText: string;
  request: ReturnType<typeof snapshotDialogueRequest>; wireSnapshots: ReturnType<typeof snapshotDialogueWireBody>[];
  rawAnswer?: string; answer?: string; validation?: ReturnType<typeof validateCompanionOutput>;
  finishReason?: string; completedMatchesDeltas?: boolean; rawDelta?: string;
  error?: ReturnType<typeof safeFailure>; elapsedMs?: number; firstVisibleMs?: number | null };
const rows: Row[] = [], wire: WireReceipt[] = [];
const persist = () => save(name, { manifestHash: hashDialogueValue(frozen), rows, wire });
const histories = new Map<string, CompanionRecentHistoryMessage[]>();
const blocked = new Set<string>();
const message = (role: "user" | "assistant", text: string, seq: number): CompanionRecentHistoryMessage =>
  ({ role, text, seq: String(seq), createdAt: new Date(Date.UTC(2026, 9, 7, 8, seq)).toISOString() });
for (const script of scripts) for (const condition of conditions)
  histories.set(`${script.id}/${condition}`, script.seed.map((text, i) => message(i % 2 ? "assistant" : "user", text, i + 1)));
persist();
for (let index = 0; index < 8; index++) for (const [scriptIndex, script] of scripts.entries()) {
  const order = (index + scriptIndex) % 2 ? [...conditions].reverse() : conditions;
  for (const condition of order) {
    const key = `${script.id}/${condition}`;
    if (blocked.has(key)) continue;
    const history = histories.get(key)!;
    const turn = script.turns[index]!;
    const built = buildDialogueExperimentRequest({ id: `${key}/${index + 1}`, userText: turn.text,
      history, intent: turn.intent }, "full", maxTokens);
    const request: AgentTurnRequest = condition === "contrast" && turn.intent === "conversation"
      ? contrastDialogueGuidance(built.request) : built.request;
    const row: Row = { id: script.id, turn: index + 1, condition, userText: turn.text,
      request: snapshotDialogueRequest(request), wireSnapshots: [] };
    rows.push(row);
    const provider = observedProvider(route, `${frozen.batchId}/${key}/${index + 1}`, wire,
      undefined, undefined, undefined, body => {
        if (wire.length >= frozen.maxCalls) throw new Error("Physical call budget reached");
        row.wireSnapshots.push(snapshotDialogueWireBody(body));
      });
    let rawDelta = "", firstVisibleMs: number | null = null;
    const started = Date.now();
    try {
      if (!provider.chatCompletionStream) throw new Error("Streaming route required");
      const native = request.messages.map(item => {
        if ((item.role !== "user" && item.role !== "assistant") || typeof item.content !== "string" || item.reasoning?.length)
          throw new Error("Only native visible text is replayed");
        return { role: item.role, content: item.content };
      });
      const result = await provider.chatCompletionStream([{ role: "system", content: request.systemPrompt }, ...native],
        { maxTokens: request.maxTokens, temperature: request.temperature,
          disableThinking: request.disableThinking, responseFormat: "text" }, AbortSignal.timeout(45000), delta => {
          rawDelta += delta;
          if (firstVisibleMs === null && sanitizeCompanionVisibleText(rawDelta).trim()) firstVisibleMs = Date.now() - started;
        });
      const answer = finalizeCompanionReplyText({ text: result.content, runId: key }).text;
      const validation = validateCompanionOutput(answer);
      Object.assign(row, { rawAnswer: result.content, answer: validation.ok ? validation.text : answer,
        validation, finishReason: result.finishReason, completedMatchesDeltas: result.content === rawDelta });
      if (!validation.ok || result.finishReason !== "stop" || !row.completedMatchesDeltas || !row.answer?.trim()) blocked.add(key);
      else history.push(message("user", turn.text, history.length + 1), message("assistant", row.answer, history.length + 2));
    } catch (error) { row.error = safeFailure(error); blocked.add(key); }
    Object.assign(row, { rawDelta, firstVisibleMs, elapsedMs: Date.now() - started });
    persist();
    console.log(JSON.stringify({ completed: rows.length, physical: wire.length, id: row.id,
      condition, turn: index + 1, elapsedMs: row.elapsedMs, error: row.error ?? null, blocked: blocked.has(key) }));
  }
}
