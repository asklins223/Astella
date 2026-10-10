/** Frozen synthetic cases. Same production model/builders; no account data or DB writes. */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveAllCompanionAgentTools } from "@astella/shared";
import type { CompanionRecentHistoryMessage } from "../handlers/companion-context-handoff.ts";
import { buildCompanionPersonaMessages, sanitizeCompanionVisibleText } from "../handlers/companion-dialogue-content.ts";
import { resolveCompanionPersonaContext } from "../handlers/companion-identity-context.ts";
import { renderHereAndNow, type HereAndNowSnapshot } from "../handlers/companion-here-and-now.ts";
import { buildCasualFirstStepRequest } from "../handlers/companion-speculative-first-step.ts";
import { runStreamingAgentStep } from "../handlers/companion-agent-streaming-step.ts";
import { interpretCompanionTurn } from "../handlers/companion-tool-intent.ts";
import { closeDatabase } from "../db.ts";
import { platform, observedProvider, root, safeFailure, type WireReceipt } from "./acceptance-common.ts";

const dir = `${root}outputs/companion-persona-audit-20261010/synthetic-probe`;
mkdirSync(dir, { recursive: true });
const route = platform("agent_turn"), wire: WireReceipt[] = [], results: unknown[] = [];
const clock = { observedAt: "2026-10-09T22:46:00.000Z", timezone: "Asia/Shanghai",
  currentMessageCreatedAt: "2026-10-09T22:46:00.000Z" };
const history: CompanionRecentHistoryMessage[] = [
  { role: "user", text: "先写一篇中国朝代历程的笔记。", seq: "1", createdAt: "2026-10-09T03:00:00.000Z" },
  { role: "assistant", text: "中国朝代历程总览已保存到笔记库。", seq: "2", createdAt: "2026-10-09T03:01:00.000Z" },
  { role: "user", text: "中国古代史和中国近代史也各写一篇。", seq: "3", createdAt: "2026-10-09T10:00:00.000Z" },
  { role: "assistant", text: "中国古代史总览与中国近代史总览都写好了，已经在库里。", seq: "4", createdAt: "2026-10-09T10:03:00.000Z" },
];
const greeting = "嗨。三篇都在库里排好了，今天想翻哪篇，还是先打个招呼。";
const correctionHistory = [...history,
  { role: "user" as const, text: "hi", seq: "5", createdAt: "2026-10-09T22:39:00.000Z" },
  { role: "assistant" as const, text: greeting, seq: "6", createdAt: "2026-10-09T22:39:05.000Z" }];
const cases = [
  { id: "hi", text: "hi", history },
  { id: "greeting", text: "早啊", history },
  { id: "yesterday", text: "这不是昨天的吗", history: correctionHistory },
  { id: "unasked-recap", text: "我就是打声招呼，你怎么又开始报进度了", history: correctionHistory },
] as const;
const snapshot: HereAndNowSnapshot = { localTime: "2026-10-10 06:46", weekday: "周六", partOfDay: "早上",
  minutesSinceLastSeen: 7, pet: { name: "爱吃白饭的大肥鱼", activeness: "active", interactionCount: 9 },
  activeRun: null, dueReviews: 0, today: { studySeconds: 0, runs: 0 }, noteCount: 3,
  pendingProposals: 0,
  currentPage: { kind: "笔记库", title: null, statusLine: null }, livePageView: null,
  nextReminder: null, noteReference: null, imagesReadable: false, imagesUnreadableReason: "policy_off",
  learningStats: null, factSpans: null, boundaryFacts: null };
const currentBlock = renderHereAndNow(snapshot)!;
const oldBlock = currentBlock.replace("用户正在看", "最近笔记：中国近代史总览（12小时前）、中国古代史总览（12小时前）、中国朝代历程总览（19小时前）\n用户正在看");
const criteria = { frozenBeforeCalls: true,
  greeting: "回应招呼，不复述无请求的笔记/旧任务，不把普通招呼转成学习安排。",
  correction: "承认眼前纠正并回应，短到一次自然接话（最多90个可见字符），不重报三篇标题、解释内部机制或追加下一步学习邀请。",
  limitations: "四个合成样本，每条件一次；固定闲聊解释的表达诊断，不是线上 HTTP/队列/窗口验收，不能证明普遍拟人或长期成长。" };
const save = () => writeFileSync(`${dir}/results.json`, JSON.stringify({ model: route.model, criteria, results, wire }, null, 2));
save();
try {
  for (const sample of cases) {
    for (const condition of ["old-inventory", "current"] as const) {
      const messages = buildCompanionPersonaMessages({ userText: sample.text, recentMessages: [...sample.history],
        pageContext: { pageType: "notebook_library", activeNoteId: null }, conversationClock: clock,
        petProfile: resolveCompanionPersonaContext(null), hereAndNow: condition === "current" ? currentBlock : oldBlock,
        continuationData: '<continuation_data>合成旧回执：三篇笔记均已保存；这是上一轮已完成的动作。</continuation_data>' });
      const request = buildCasualFirstStepRequest({ turnPolicy: String(messages[0]!.content), permissionLevel: "full",
        stepBudget: 3, messages: messages.slice(1), maxTokens: route.modelProfile?.maxOutputTokens ?? 131072 });
      console.log(JSON.stringify({ starting: sample.id, condition }));
      try {
        const provider = observedProvider(route, `greeting-correction-${randomUUID()}`, wire);
        const result = await runStreamingAgentStep({ provider, stepRequest: request, ctxSignal: AbortSignal.timeout(90000),
          timeoutMs: 90000, onProviderDelta: async () => true });
        const raw = String(result.content ?? ""), visible = sanitizeCompanionVisibleText(raw);
        const row = { id: sample.id, condition, kind: "expression", raw, visible, visibleCharacters: [...visible].length,
          finishReason: result.finishReason };
        results.push(row); console.log(JSON.stringify(row));
      } catch (error) { results.push({ id: sample.id, condition, error: safeFailure(error) }); }
      save();
    }
  }
  const routingCases = [
    { text: "hi", history, toolUse: "none" },
    { text: "这不是昨天的吗", history: correctionHistory, toolUse: "none" },
    { text: "查一下，这三篇笔记到底是哪天创建的？", history: correctionHistory, toolUse: "read" },
    { text: "以后和我说话别老复述笔记清单，直接接我眼前说的话。请把说话方式改过来。", history: correctionHistory,
      toolUse: "act", operation: "companion_revise_own_style" },
  ] as const;
  for (const sample of routingCases) {
    const provider = observedProvider(route, `correction-intent-${randomUUID()}`, wire);
    const result = await interpretCompanionTurn(provider, [...sample.history.map(message => ({ role: message.role, content: message.text })),
      { role: "user", content: sample.text }], {
      job: { id: randomUUID(), workspaceId: randomUUID(), requestedBy: randomUUID(), leaseToken: "synthetic",
        signal: AbortSignal.timeout(90000) }, runId: randomUUID(), userId: randomUUID(), permissionLevel: "full",
      recentMessages: [...sample.history], conversationClock: clock,
      capabilities: resolveAllCompanionAgentTools("full").map(tool => tool.name),
      currentActiveTransaction: () => undefined, verifyAttempt: async () => true });
    const ok = result.toolUse === sample.toolUse && (!("operation" in sample) || result.candidateOperations.includes(sample.operation));
    const row = { kind: "classification", text: sample.text, expectedToolUse: sample.toolUse, ok, result };
    results.push(row); console.log(JSON.stringify(row)); save();
  }
} finally { await closeDatabase(); }
