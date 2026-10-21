import { agentTurnInterpretationV1Schema, type AgentTurnInterpretationV1 } from '@astella/shared/agent-contracts';
import { companionTurnWritesDocumentContent, COMPANION_DIRECT_ENTRY_TOOL_NAMES, type AgentTurnRequest } from '@astella/shared';
import type { CompanionAgentLoopArgs } from '../../contracts/companion-agent-loop.ts';
import { COMPANION_TOOL_INTENT_TIMEOUT_MS, interpretCompanionTurn, explicitCompanionProductRequest } from '../tools/companion-tool-intent.ts';
import { companionAttentionObjects } from '../proactive/companion-attention.ts';
import { companionClassifierCapabilities } from './companion-classifier-surface.ts';
import { currentWorkerWorkspaceTransaction } from '../../db.ts';
import { isJobLeaseActive } from '../../lib/job-lease.ts';
import type { createCompanionRouteRecorder } from '../agent/companion-route-record.ts';
import { runCompanionHybridEntry, companionHybridReplyInterpretation, type CompanionHybridEntry } from './companion-hybrid-entry.ts';
import { companionNamedNoteReadTitle } from '../note/companion-note-prefetch.ts';
import { emitCompanionAssistantStatus } from './companion-dialogue-store.ts';
export type CompanionEntryMode = 'classified' | 'direct_fast' | 'direct_thinking' | 'hybrid';
export const usesCompanionDirectControls = (mode: CompanionEntryMode) => mode === 'direct_fast' || mode === 'direct_thinking';
export const DIRECT_ENTRY_TOOLS: ReadonlySet<string> = new Set(COMPANION_DIRECT_ENTRY_TOOL_NAMES);
/** A named saved note needs application evidence. The classifier and existing
 * permission checks still decide how to read it; a casual preflight cannot. */
export function companionNamedNoteReadRequest(text: string | undefined, messages: AgentTurnRequest['messages']): boolean {
    return Boolean(companionNamedNoteReadTitle(text)
        && !messages.some(message => message.role === 'system' && message.hostObservation
            && typeof message.content === 'string' && message.content.startsWith('<prefetched_note>')));
}
/**
 * 2026-10-18 用户裁决：hybrid 为默认入口。未知取值仍退回 classified——
 * 配错一个值不该把整条链路切成未验证的入口。
 */
export function resolveCompanionEntryMode(raw = process.env.COMPANION_AGENT_ENTRY_MODE): CompanionEntryMode {
    if (raw === 'direct_fast' || raw === 'direct_thinking' || raw === 'hybrid')
        return raw;
    return 'classified';
}
/** This is explicitly an unclassified host placeholder, not a model judgment
 * that a user needs clarification. Native tool choice owns the decision. */
export function companionDirectInterpretation(requestHash: string): AgentTurnInterpretationV1 {
    return agentTurnInterpretationV1Schema.parse({ version: 1, requestHash, intent: 'question', toolUse: 'uncertain', subjects: [], goalRelation: 'unrelated', goalReference: null, candidateOperations: [], ambiguities: [], status: 'uncertain' });
}
/** A clear, fresh note request already names its operation. Keep ambiguous
 * follow-ups, navigation, participation and voice preferences on the normal
 * interpreter; a host preparation never grants execution permissions. */
export function companionExplicitNoteInterpretation(requestHash: string, text: string | undefined,
    availableNames: readonly string[]): AgentTurnInterpretationV1 | null {
    const value = text?.normalize('NFKC').trim() ?? '';
    if (!availableNames.includes('companion_create_note') || !explicitCompanionProductRequest(value).newNote
        || !/^(?:请|帮我|给我|麻烦)?\s*(?:生成|新建|创建|写|整理)/u.test(value)
        || /(?:^|[，,。；;\n])\s*(?:不要|别|不必|不用|无需|请勿)/u.test(value)
        || /(?:刚才|之前|继续|恢复|暂停|停止|取消|提醒|定时|以后|记住|口音|方言|普通话|粤语|四川话|语速|朗读|声音|说话|打开|跳转|查看|带我|如何|怎么|为什么|是否|能否|吗|[？?])/u.test(value)) return null;
    return agentTurnInterpretationV1Schema.parse({ version: 1, requestHash, intent: 'task', toolUse: 'act',
        subjects: [], goalRelation: 'new', goalReference: null, candidateOperations: ['companion_create_note'],
        ambiguities: [], status: 'interpreted' });
}
export function startCompanionEntry(input: {
    args: CompanionAgentLoopArgs;
    mode: CompanionEntryMode;
    requestHash: string;
    cached: AgentTurnInterpretationV1 | null;
    relatedGoals: Parameters<typeof companionAttentionObjects>[1];
    names: string[];
    pageKind: string | null | undefined;
    permissionLevel: string;
    deadlineAt: number;
    recorder: ReturnType<typeof createCompanionRouteRecorder>;
    messages?: AgentTurnRequest['messages'];
    skipHybrid?: boolean;
}) {
    const { args, mode, recorder } = input;
    let hybrid: CompanionHybridEntry | null = null;
    const classify = () => interpretCompanionTurn(args.provider, args.baseMessages, {
        requestHash: input.requestHash, objects: companionAttentionObjects(args.read, input.relatedGoals),
        capabilities: companionClassifierCapabilities({ availableToolNames: input.names, pageKind: input.pageKind, userText: args.read.userText }),
        recentMessages: args.read.recentMessages, conversationClock: args.read.conversationClock,
        job: args.ctx, runId: args.read.runId, userId: args.read.userId, permissionLevel: input.permissionLevel,
        stepTimeoutMs: Math.min(COMPANION_TOOL_INTENT_TIMEOUT_MS, input.deadlineAt - Date.now()),
        currentActiveTransaction: currentWorkerWorkspaceTransaction,
        verifyAttempt: attempt => isJobLeaseActive({ ...args.ctx, leaseToken: attempt.leaseToken }),
        onReceipt: receipt => recorder.onReceipt(receipt, { runId: args.read.runId, providerId: args.provider.id, modelId: args.provider.modelId }),
    });
    const prepared = !usesCompanionDirectControls(mode)
        ? companionExplicitNoteInterpretation(input.requestHash, args.read.userText, input.names) : null;
    const cached = input.cached ?? prepared ?? (mode === 'classified' ? null : companionDirectInterpretation(input.requestHash));
    const resolve = async () => {
        if (mode === 'hybrid' && !input.cached && !prepared) {
            const explicit = explicitCompanionProductRequest(args.read.userText);
            if (input.skipHybrid || explicit.artifact || explicit.newNote
                || companionNamedNoteReadRequest(args.read.userText, input.messages ?? args.baseMessages)) return classify();
            await args.onTurnInterpretation?.(companionDirectInterpretation(input.requestHash));
            hybrid = await runCompanionHybridEntry({ provider: args.provider, fallbackProvider: args.fallbackProvider,
                turnPolicy: typeof args.baseMessages[0]?.content === 'string' ? args.baseMessages[0].content : '',
                messages: input.messages ?? args.baseMessages.filter(m => m.role !== 'system'), signal: args.ctx.signal,
                deadlineAt: input.deadlineAt, onProviderDelta: args.onProviderDelta, onReasoningDelta: args.onReasoningDelta,
                onRecovery: async () => { await emitCompanionAssistantStatus({ workspaceId: args.ctx.workspaceId, read: args.read, expiresAt: args.expiresAt,
                    status: 'acting', safeLabel: '当前服务的输出等待较久，正在用备用服务接续这次回复。' }); } });
            return hybrid.facts.decision === 'reply' ? companionHybridReplyInterpretation(input.requestHash) : classify();
        }
        return cached ?? classify();
    };
    const result = resolve();
    return { cached, promise: recorder.track(result.then(async (attention) => {
            const write = await args.onTurnInterpretation?.(attention);
            return write ? { ...attention, voicePreferenceWrite: write } : attention;
        })), hybrid: () => hybrid };
}
export function companionDirectGuidance(mode: CompanionEntryMode): string {
    if (!usesCompanionDirectControls(mode))
        return '';
    return [
        '本轮没有独立意图分类。注意力数据中的 uncertain 表示宿主未预分类，不表示用户表达不清；结合完整历史、当前页面与已有材料自行回答或调用工具，不把内部状态念给用户。',
        '用户要求读取、保存或修改时，实际调用相应工具；工具未返回成功回执前不能确认已完成。现有材料足够时直接回答，不为证明用了工具而重复读取。',
        '历史邀请是过去说过的话；以当前用户回应决定是否执行、继续或换话题，不重写或删除历史。缺少真实操作对象时再澄清。',
        '用户要求本轮口音、语速或表达风格，或明确更改以后默认方言时，先调用 companion_configure_turn，再输出要朗读的正文；临时请求保持 persistentPreference.action=keep。只谈地区或方言含义不切换声音。',
        '明确要求以后默认某方言才 set 并填 dialect；以后普通话或停止固定方言用 clear、dialect=null。本轮明确要求普通话时 apply 普通话。要求方言但没说哪种时 clarify 并问清楚。',
        '用户明确禁止定时、只允许事件触发时，先用 companion_configure_turn 记录当前原话并设置 forbidTimeBasedWakeups=true，再调用任何安排工具。',
        ...(mode === 'direct_fast' ? ['当前使用快速档；需要更充分的多步推理或严格证明且快速档不足时，先调用 companion_deepen，再继续处理。简单问答直接回答。'] : []),
    ].join('\n');
}
/** Mutable state belongs to one runtime invocation and is checkpointed by its
 * owner. Control calls cannot add capabilities or bypass any execution fence. */
type DirectControlState = {
    mode: CompanionEntryMode;
    attention: AgentTurnInterpretationV1;
    userText: string;
    deepened?: boolean;
    onInterpretation?: (interpretation: AgentTurnInterpretationV1) => unknown;
};
type ControlOutcome = {
    ok: boolean;
    summary: string;
};
export async function executeCompanionEntryControl(input: DirectControlState, name: string, args: Record<string, unknown>): Promise<ControlOutcome | null> {
    if (!usesCompanionDirectControls(input.mode))
        return null;
    switch (name) {
        case "companion_deepen":
            input.deepened = true;
            return { ok: true, summary: '本轮后续使用深度思考，请继续完成原始请求。' };
        case "companion_configure_turn": {
            const source = typeof args.sourceQuote === 'string' ? args.sourceQuote : '';
            if (!source.trim() || !input.userText.includes(source))
                return { ok: false, summary: '设置未执行：sourceQuote 必须逐字来自当前用户请求，不能沿用历史。' };
            if (args.voiceStyle) {
                // Callers validate the registered tool schema before entering this branch.
                input.attention.voiceStyle = args.voiceStyle as AgentTurnInterpretationV1['voiceStyle'];
            }
            if (input.attention.voiceStyle.persistentPreference.action !== 'keep' && !input.onInterpretation)
                return { ok: false, summary: '长期声音偏好未保存：当前没有可用的偏好写入接口。' };
            if (args.forbidTimeBasedWakeups === true)
                input.attention.executionConstraints = { timeBasedWakeups: 'forbid', sourceQuote: source };
            const status = await input.onInterpretation?.(input.attention);
            if (status === 'saved' || status === 'unchanged' || status === 'failed' || status === 'not_requested')
                input.attention.voicePreferenceWrite = status;
            if (status === 'failed')
                return { ok: false, summary: '长期声音偏好未保存；不要确认已记住。本轮表达设置仍适用。' };
            return { ok: true, summary: '本轮表达设置已应用，后续正文可以开始。' };
        }
        default: return null;
    }
}
export function createCompanionDirectControls(input: DirectControlState) {
    const state = { ...input, deepened: input.deepened ?? false };
    return {
        deepened: () => state.deepened,
        disableThinking: () => state.mode === 'direct_fast' && !state.deepened,
        apply: (name: string, args: Record<string, unknown>) => executeCompanionEntryControl(state, name, args),
        async observeDocumentWork(names: readonly string[]) {
            if (!usesCompanionDirectControls(input.mode) || !companionTurnWritesDocumentContent(names))
                return;
            input.attention.candidateOperations = [...new Set([...input.attention.candidateOperations, ...names])];
            await input.onInterpretation?.(input.attention);
        },
    };
}
