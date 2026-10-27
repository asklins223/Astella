import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { sha256Utf8V1 } from '@astella/shared/content-hash';
import { stripVoiceExpressionTags } from '@astella/shared/voice-expression-tags';
import { resolveAgentTurnInterpretation, calculateAgentExpression } from '@astella/agent-core';
import { resolveAllCompanionAgentTools, validateCompanionAgentToolArguments, type AgentTurnRequest, type AgentTurnResult, type ChatOptions, type ChatMessage } from '@astella/shared';
import { agentTurnInterpretationProposalV1Schema, type AgentTurnInterpretationV1 } from '@astella/shared/agent-contracts';
import type { AIProvider } from '../../src/lib/ai-provider.ts';
import { runHedgedCall } from '../../src/lib/hedged-call.ts';
import { buildCompanionPersonaMessages } from '../../src/handlers/turn/companion-dialogue-content.ts';
import { buildCompanionTurnInterpretationMessages, companionOfferCandidates } from '../../src/handlers/tools/companion-tool-intent.ts';
import { companionClassifierCapabilities } from '../../src/handlers/turn/companion-classifier-surface.ts';
import { createCompanionToolSurface, loadCompanionToolGroups } from '../../src/handlers/tools/companion-tool-surface.ts';
import { startCompanionSpeculativeFirstSteps } from '../../src/handlers/agent/companion-speculative-flights.ts';
import { buildQuestionFirstStepRequest } from '../../src/handlers/agent/companion-speculative-first-step.ts';
import { assembleCompanionStepRequest, companionStepPolicyText } from '../../src/handlers/agent/companion-agent-step-assembly.ts';
import { runStreamingAgentStep } from '../../src/handlers/agent/companion-agent-streaming-step.ts';
import { companionStepRequiresTool } from '../../src/handlers/tools/companion-tool-call-ledger.ts';
import { companionTurnThinking } from '../../src/handlers/turn/companion-turn-thinking.ts';
import { companionResponseStrategy } from '../../src/handlers/turn/companion-response-strategy.ts';
import { renderPendingOffersAsRecords } from '../../src/handlers/context/companion-context-handoff.ts';
import { stepHoldChars } from '../../src/handlers/turn/companion-step-plan.ts';
import { NOTE_BODY, NOTE_ID, VERSION_ID, type Fixture } from './fixtures.ts';
import { DIRECT_ENTRY_TOOLS } from '../../src/handlers/turn/companion-entry-mode.ts';
import { runCompanionHybridEntry, companionHybridReplyInterpretation, type CompanionHybridFacts } from '../../src/handlers/turn/companion-hybrid-entry.ts';
export type Arm = 'classified' | 'direct_fast' | 'direct_thinking' | 'hybrid';
export interface CallTrace {
    kind: 'classifier' | 'generation';
    startedMs: number;
    durationMs: number | null;
    firstContentMs: number | null;
    contentChars: number;
    reasoningChars: number;
    disableThinking: boolean | null;
    toolChoice: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    outcome: string;
    /** Synthetic experiment output only; production route metadata stores no text. */
    outputText?: string | null;
}
export interface TrialResult {
    fixture: string;
    category: string;
    arm: Arm;
    elapsedMs: number;
    firstPublishedMs: number | null;
    answerStartMs: number | null;
    classifierMs: number | null;
    keptDraft: boolean;
    escalated: boolean;
    completed: boolean;
    checksPassed: boolean;
    missingTools: string[];
    unexpectedWrites: string[];
    toolCalls: {
        name: string;
        valid: boolean;
        succeeded: boolean;
        arguments: Record<string, unknown>;
    }[];
    text: string;
    calls: CallTrace[];
    error: string | null;
    hybrid?: CompanionHybridFacts;
    hostReadNote?: boolean;
}
const DEEPEN = { name: 'companion_deepen', description: '快速档不足以可靠完成多步推理或严格证明时调用，切换本轮后续为深度思考。无需查资料，简单问答不要调用。', parameters: { type: 'object', properties: {}, additionalProperties: false } };
const DEEP_GUIDANCE = '你现在使用快速档。能可靠回答就直接回答；需要更充分的多步推理或严格证明且快速档不足时，先调用 companion_deepen，再继续处理。不要用“我先想一想”替代实际调用。';
/** Instrument the actual provider, including discarded/aborted requests. Missing
 * usage stays null; observed tokens are a lower bound, never a billing total. */
export function traceProvider(raw: AIProvider, zero: number, traces: CallTrace[]): AIProvider {
    return new Proxy(raw, { get(target, key) {
            if (key === 'chatCompletion' || key === 'chatCompletionStream')
                return async (...args: unknown[]) => {
                    const options = args[1] as ChatOptions;
                    const trace: CallTrace = { kind: options.responseFormat === 'json_object' && !options.nativeAgentRequest ? 'classifier' : 'generation', startedMs: performance.now() - zero, durationMs: null, firstContentMs: null, contentChars: 0, reasoningChars: 0, disableThinking: options.disableThinking ?? null, toolChoice: options.toolChoice ?? null, promptTokens: null, completionTokens: null, outcome: 'pending' };
                    traces.push(trace);
                    const begin = performance.now();
                    if (key === 'chatCompletionStream') {
                        const delta = args[3] as (text: string) => void;
                        args[3] = (text: string) => { if (text.trim() && trace.firstContentMs === null)
                            trace.firstContentMs = performance.now() - zero; trace.contentChars += text.length; delta(text); };
                        const reason = options.onReasoningDelta;
                        args[1] = { ...options, onReasoningDelta: (text: string) => { trace.reasoningChars += text.length; reason?.(text); } };
                    }
                    try {
                        const result = await (target[key] as Function).apply(target, args);
                        trace.outputText = result.content ?? null;
                        if (key === 'chatCompletion')
                            trace.contentChars = result.content?.length ?? 0;
                        trace.promptTokens = result.usage?.promptTokens ?? null;
                        trace.completionTokens = result.usage?.completionTokens ?? null;
                        trace.outcome = 'ok';
                        return result;
                    }
                    catch (err) {
                        trace.outcome = (args[2] as AbortSignal | undefined)?.aborted ? 'aborted' : err instanceof Error ? err.name : 'error';
                        throw err;
                    }
                    finally {
                        trace.durationMs = performance.now() - begin;
                    }
                };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
}
function baseMessages(f: Fixture): AgentTurnRequest['messages'] {
    const recent = (f.history ?? []).filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role as 'user' | 'assistant', text: typeof m.content === 'string' ? m.content : m.content.filter(p => p.type === 'text').map(p => p.text).join(' ') }));
    return buildCompanionPersonaMessages({ userText: f.text, recentMessages: recent, pageContext: f.pageKind ? { version: 1, context: { pageKind: f.pageKind, noteId: NOTE_ID, noteVersionId: VERSION_ID, contextRevision: 'entry-benchmark' } } : null }) as AgentTurnRequest['messages'];
}
async function classify(provider: AIProvider, messages: AgentTurnRequest['messages'], f: Fixture, signal: AbortSignal): Promise<AgentTurnInterpretationV1> {
    const definitions = resolveAllCompanionAgentTools('full', { visionEnabled: false, webSearchEnabled: false }).filter(d => !DIRECT_ENTRY_TOOLS.has(d.name));
    const capabilities = companionClassifierCapabilities({ availableToolNames: definitions.map(d => d.name), pageKind: f.pageKind });
    const dialogue: ChatMessage[] = messages.filter(m => m.role !== 'tool').map(m => ({ role: m.role as ChatMessage['role'], content: m.content }));
    const binding = { requestHash: sha256Utf8V1(f.text), objects: f.objects ?? [], capabilities, offerCandidates: companionOfferCandidates(dialogue), currentUserText: f.text };
    const prompt = buildCompanionTurnInterpretationMessages(dialogue, { objects: binding.objects, capabilities, recentMessages: [] })!;
    try {
        const result = await runHedgedCall(s => provider.chatCompletion(prompt, { temperature: 0, responseFormat: 'json_object', disableThinking: true }, s), { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), hedgeDelayMs: 0 });
        const parsed = agentTurnInterpretationProposalV1Schema.safeParse(JSON.parse(result.value.content));
        return resolveAgentTurnInterpretation(parsed.success ? parsed.data : null, binding);
    }
    catch {
        return resolveAgentTurnInterpretation(null, binding);
    }
}
export async function runTrial(raw: AIProvider, f: Fixture, arm: Arm, timeoutMs = 90000, entryOnly = false): Promise<TrialResult> {
    const zero = performance.now(), traces: CallTrace[] = [];
    const provider = traceProvider(raw, zero, traces), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('trial deadline')), timeoutMs);
    const trial: TrialResult = { fixture: f.id, category: f.category, arm, elapsedMs: 0, firstPublishedMs: null, answerStartMs: null, classifierMs: null, keptDraft: false, escalated: false, completed: false, checksPassed: false, missingTools: [], unexpectedWrites: [], toolCalls: [], text: '', calls: traces, error: null };
    const definitions = resolveAllCompanionAgentTools('full', { visionEnabled: false, webSearchEnabled: false }).filter(d => !DIRECT_ENTRY_TOOLS.has(d.name));
    const messages = baseMessages(f);
    const turnPolicy = typeof messages[0]?.content === 'string' ? messages[0].content : '';
    const surface = createCompanionToolSurface({ definitions, pageKind: f.pageKind ?? null, candidateOperations: [] });
    let stepFirstPublished: number | null = null;
    const onDelta = async (text: string) => { if (text.trim()) {
        const now = performance.now() - zero;
        stepFirstPublished ??= now;
        trial.firstPublishedMs ??= now;
    } return true; };
    let attention: AgentTurnInterpretationV1 | null = null;
    let first: Awaited<ReturnType<ReturnType<typeof startCompanionSpeculativeFirstSteps>['settle']>> = null;
    let firstDone = false;
    try {
        if (arm === 'hybrid') {
            const entryMessages = messages.filter(m => m.role !== 'system' || m.hostObservation);
            if (!entryOnly && f.pageKind === 'note') {
                trial.hostReadNote = true;
                entryMessages.push({ role: 'system', hostObservation: true, content: '<prefetched_note>\n《间隔复习实验》（共 1 块）\n'+NOTE_BODY+'\n</prefetched_note>\n这是宿主在本轮读到的当前笔记正文。' });
            }
            const entry = await runCompanionHybridEntry({ provider, turnPolicy, messages: entryMessages, signal: controller.signal,
                deadlineAt: Date.now() + timeoutMs, onProviderDelta: onDelta });
            trial.hybrid = entry.facts;
            if (entryOnly) {
                trial.completed = true;
                trial.text = entry.prefetched?.result.content ?? '';
                trial.answerStartMs = entry.prefetched ? stepFirstPublished ?? performance.now() - zero : null;
                trial.checksPassed = entry.facts.decision === f.expectedEntry;
                return trial;
            }
            first = entry.prefetched;
            if (entry.facts.decision === 'reply') attention = companionHybridReplyInterpretation(sha256Utf8V1(f.text));
            else {
                const before = performance.now();
                attention = await classify(provider, messages, f, controller.signal);
                trial.classifierMs = performance.now() - before;
                const rendered = renderPendingOffersAsRecords(messages, attention.pendingOfferIndexes);
                messages.splice(0, messages.length, ...rendered);
                if (trial.hostReadNote) messages.push(entryMessages.at(-1)!);
                const expanded = createCompanionToolSurface({ definitions, pageKind: f.pageKind ?? null, candidateOperations: attention.candidateOperations });
                for (const name of expanded.initialToolNames) surface.loadedToolNames.add(name);
            }
        }
        if (arm === 'classified') {
            const promise = classify(provider, messages, f, controller.signal).then(value => { trial.classifierMs = performance.now() - zero; return value; });
            const flights = startCompanionSpeculativeFirstSteps({ provider, ctxSignal: controller.signal, onProviderDelta: onDelta, attention: promise, cachedInterpretation: null, turnPolicy, permissionLevel: 'full', stepBudget: Infinity, messages, deadlineAt: Date.now() + timeoutMs, availableTools: surface.offered(), toolCallCount: 0 });
            attention = await promise;
            const before = performance.now();
            first = await flights.settle({ attention, runId: randomUUID(), deadlineAt: Date.now() + timeoutMs, handlerStartedAtMs: Date.now() - Math.round(before - zero) });
            trial.keptDraft = first !== null;
            const rendered = renderPendingOffersAsRecords(messages, attention.pendingOfferIndexes);
            messages.splice(0, messages.length, ...rendered);
            // Same declaration-based candidate expansion as the formal runtime.
            const expanded = createCompanionToolSurface({ definitions, pageKind: f.pageKind ?? null, candidateOperations: attention.candidateOperations });
            for (const name of expanded.initialToolNames)
                surface.loadedToolNames.add(name);
        }
        for (let step = 0; step < 8; step++) {
            controller.signal.throwIfAborted();
            const tools = surface.offered();
            const think = arm === 'direct_thinking' || trial.escalated;
            const direct = buildQuestionFirstStepRequest({ turnPolicy, permissionLevel: 'full', stepBudget: Infinity, messages, maxTokens: provider.resolveOutputTokenLimit?.() ?? 32000, tools: arm === 'direct_fast' && !trial.escalated ? [...tools, DEEPEN] : tools });
            let request: AgentTurnRequest = { ...direct, disableThinking: !think };
            if (arm === 'direct_fast' && !trial.escalated)
                request = { ...request, systemPrompt: request.systemPrompt + '\n' + DEEP_GUIDANCE };
            if (attention) {
                const decision = attention.toolUse === 'none' ? false : attention.toolUse === 'uncertain' ? null : true;
                const required = companionStepRequiresTool(decision, attention.toolUse === 'read' ? attention.candidateOperations : undefined);
                const strategy = companionResponseStrategy(attention);
                request = assembleCompanionStepRequest({ turnPolicy, runtimePolicy: companionStepPolicyText({ permissionLevel: 'full', toolCount: tools.length, stepBudget: Infinity, finalAnswerOnly: false, attentionIntent: attention.intent, offeredToolNames: tools.map(t => t.name), writingAnnotation: false, completeNoteReply: false }), executionGuidance: strategy.guidance, attention, messages, tools, toolChoice: required && trial.toolCalls.length === 0 ? 'required' : 'auto', disableThinking: companionTurnThinking(attention).disableThinking || (required && attention.toolUse !== 'act' && step === 0), provider, temperature: strategy.temperature });
            }
            if (!first || firstDone)
                stepFirstPublished = null;
            let result: AgentTurnResult;
            if (first && !firstDone) {
                result = first.result;
                firstDone = true;
            }
            else
                result = await runStreamingAgentStep({ provider, stepRequest: request, ctxSignal: controller.signal, timeoutMs: Math.max(1, timeoutMs - (performance.now() - zero)), onProviderDelta: onDelta, holdUntilChars: stepHoldChars({ userAskedForAction: attention?.toolUse === 'act' }), separatorBefore: trial.text ? '\n\n' : '' });
            if (result.content?.trim())
                trial.text += (trial.text ? '\n\n' : '') + result.content;
            if (result.finishReason === 'length')
                throw new Error('model output truncated');
            if (result.toolCalls.length === 0) {
                trial.completed = true;
                // Use the same decoder/hold gate in every arm. A short final result still
                // buffered below the hold threshold is delivered in full after validation,
                // just as the runtime's final checkpoint delivery does.
                trial.answerStartMs = stripVoiceExpressionTags(result.content ?? '').trim()
                    ? stepFirstPublished ?? performance.now() - zero : null;
                trial.firstPublishedMs ??= trial.answerStartMs;
                break;
            }
            messages.push({ role: 'assistant', content: result.content ?? '', toolCalls: result.toolCalls, ...(result.reasoning ? { reasoning: result.reasoning } : {}) });
            for (const call of result.toolCalls) {
                let receipt: unknown;
                if (call.name === DEEPEN.name && arm === 'direct_fast' && !trial.escalated) {
                    trial.escalated = true;
                    receipt = { ok: true, summary: '本轮已切换深度思考，请继续完成原始问题。' };
                }
                else if (call.name === 'companion_load_tools') {
                    const groups = Array.isArray(call.arguments.groups) ? call.arguments.groups.filter((v): v is string => typeof v === 'string') : [];
                    const names = loadCompanionToolGroups(surface, { groups, definitions });
                    receipt = { ok: true, data: { loadedGroups: groups, tools: names } };
                }
                else {
                    const valid = validateCompanionAgentToolArguments(call.name, call.arguments).success;
                    const recorded = { name: call.name, valid, succeeded: false, arguments: call.arguments };
                    trial.toolCalls.push(recorded);
                    const definition = definitions.find(d => d.name === call.name);
                    if (definition?.riskClass !== 'read' && f.forbiddenWrites)
                        trial.unexpectedWrites.push(call.name);
                    if (!valid)
                        receipt = { ok: false, summary: '参数未通过实际工具 schema，请核对参数后再试。' };
                    else if (call.name === 'companion_read_note' && call.arguments.noteId === NOTE_ID) {
                        recorded.succeeded = true;
                        receipt = { ok: true, data: { noteId: NOTE_ID, noteVersionId: VERSION_ID, title: '间隔复习实验', body: NOTE_BODY, truncated: false, nextOffset: null, blocks: [{ blockIndex: 0, ordinal: 1, type: 'markdown', content: NOTE_BODY, complete: true }] }, summary: '已读取当前笔记全文。' };
                    }
                    else if (call.name === 'companion_edit_note' && !f.forbiddenWrites) {
                        const a = call.arguments;
                        const readBefore = trial.hostReadNote || trial.toolCalls.some(c => c.name === 'companion_read_note' && c.succeeded);
                        const exactEdit = a.noteId === NOTE_ID && a.noteVersionId === VERSION_ID && a.operation === 'replace_blocks' && a.startBlock === 0 && a.endBlock === 0 && Array.isArray(a.expectedBlocks) && a.expectedBlocks.length === 1 && a.expectedBlocks[0] === NOTE_BODY && typeof a.markdown === 'string' && a.markdown.trim() === NOTE_BODY.replace('72', '75').trim();
                        if (readBefore && exactEdit) {
                            recorded.succeeded = true;
                            receipt = { ok: true, data: { noteId: NOTE_ID, noteVersionId: '33333333-3333-4333-8333-333333333333', saved: true }, summary: '已保存：实验组得分75分，其他内容未改动。' };
                        }
                        else
                            receipt = { ok: false, summary: '未保存：须先读取当前笔记，以返回的版本、blockIndex和完整expectedBlocks只替换72为75，保留其他内容。' };
                    }
                    else if (call.name === 'agent_calculate') {
                        try {
                            const computed = calculateAgentExpression(String(call.arguments.expression), call.arguments.variables as {
                                name: string;
                                value: number;
                            }[] | undefined);
                            recorded.succeeded = true;
                            receipt = { ok: true, data: computed };
                        }
                        catch (err) {
                            receipt = { ok: false, summary: err instanceof Error ? err.message : 'calculation rejected' };
                        }
                    }
                    else
                        receipt = { ok: false, summary: '此为隔离测试工具，当前夹具未提供该操作，请使用已有材料或明确说明无法完成。' };
                }
                messages.push({ role: 'tool', content: JSON.stringify(receipt), toolCallId: call.id });
            }
        }
        trial.missingTools = (f.expectedTools ?? []).filter(name => !(trial.hostReadNote && name === 'companion_read_note') && !trial.toolCalls.some(c => c.name === name && c.valid && c.succeeded));
        trial.checksPassed = trial.completed && stripVoiceExpressionTags(trial.text).trim().length > 0 && trial.missingTools.length === 0 && trial.unexpectedWrites.length === 0 && (!f.expectedText || f.expectedText.test(trial.text));
    }
    catch (err) {
        trial.error = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 180) : 'unknown';
    }
    finally {
        controller.abort();
        clearTimeout(timer);
        // Aborted duplicate/speculative requests can report no final usage. Keep the
        // record and give cancellation a turn to finish rather than silently dropping it.
        await new Promise(resolve => setTimeout(resolve, 30));
        trial.elapsedMs = performance.now() - zero;
    }
    return trial;
}
