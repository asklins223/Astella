import { agentTurnInterpretationV1Schema, type AgentTurnInterpretationV1 } from '@astella/shared/agent-contracts';
import { companionTurnWritesDocumentContent, COMPANION_DIRECT_ENTRY_TOOL_NAMES, type AgentTurnRequest } from '@astella/shared';
import type { CompanionAgentLoopArgs } from '../../contracts/companion-agent-loop.ts';
import { COMPANION_TOOL_INTENT_TIMEOUT_MS, interpretCompanionTurn, explicitCompanionProductRequest, reconcileCompanionInterpretation } from '../tools/companion-tool-intent.ts';
import { companionAttentionObjects } from '../proactive/companion-attention.ts';
import { companionClassifierCapabilities } from './companion-classifier-surface.ts';
import { currentWorkerWorkspaceTransaction } from '../../db.ts';
import { isJobLeaseActive } from '../../lib/job-lease.ts';
import type { createCompanionRouteRecorder } from '../agent/companion-route-record.ts';
import { runCompanionHybridEntry, companionHybridReplyInterpretation, companionPendingOfferIndexes, type CompanionHybridEntry } from './companion-hybrid-entry.ts';
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
 * 默认直接进入原生工具 Agent：没有独立分类，也没有无工具预生成分支。
 * 模型在同一个工具循环里回答或行动，需要更深推理时调用 companion_deepen。
 * 显式配置仍然可以切回旧入口；未知取值退回 classified，避免错配静默改变行为。
 */
export function resolveCompanionEntryMode(raw = process.env.COMPANION_AGENT_ENTRY_MODE): CompanionEntryMode {
    if (raw === undefined) return 'direct_fast';
    if (raw === 'direct_fast' || raw === 'direct_thinking' || raw === 'hybrid' || raw === 'classified') return raw;
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
    if (!availableNames.includes('companion_notes_write') || !explicitCompanionProductRequest(value).newNote
        || !/^(?:请|帮我|给我|麻烦)?\s*(?:生成|新建|创建|写|整理)/u.test(value)
        || /(?:^|[，,。；;\n])\s*(?:不要|别|不必|不用|无需|请勿)/u.test(value)
        || /(?:刚才|之前|继续|恢复|暂停|停止|取消|提醒|定时|以后|记住|口音|方言|普通话|粤语|四川话|语速|朗读|声音|说话|打开|跳转|查看|带我|如何|怎么|为什么|是否|能否|吗|[？?])/u.test(value)) return null;
    return agentTurnInterpretationV1Schema.parse({ version: 1, requestHash, intent: 'task', toolUse: 'act',
        subjects: [], goalRelation: 'new', goalReference: null, candidateOperations: ['companion_notes_write'],
        ambiguities: [], status: 'interpreted' });
}
/** 显式读取已保存内容必须先走证据路径，不能由闲聊预生成直接声称读完。 */
export function companionExplicitNoteReadInterpretation(requestHash: string, text: string | undefined,
    availableNames: readonly string[]): AgentTurnInterpretationV1 | null {
    const value = text?.normalize('NFKC').trim() ?? '';
    if (!/^(?:请|帮我|麻烦|给我)?\s*(?:只|先)?\s*(?:读取|查阅|查看|核对|读一下)/u.test(value)
        || !/(?:手记|笔记)/u.test(value)
        || !/(?:最新|最近|书房|我的|已保存|《[^》]+》)/u.test(value)) return null;
    const operations = ['companion_notes_read'].filter(name => availableNames.includes(name));
    if (operations.length === 0) return null;
    return agentTurnInterpretationV1Schema.parse({ version: 1, requestHash, intent: 'question', toolUse: 'read',
        subjects: [], goalRelation: 'unrelated', goalReference: null, candidateOperations: operations,
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
        capabilities: companionClassifierCapabilities({ availableToolNames: input.names, pageKind: input.pageKind, userText: args.read.userText, hasImageAttachments: Boolean(args.read.userImageAttachments?.length) }),
        recentMessages: args.read.recentMessages, conversationClock: args.read.conversationClock,
        job: args.ctx, runId: args.read.runId, userId: args.read.userId, permissionLevel: input.permissionLevel,
        semanticOnly: mode === 'hybrid',
        stepTimeoutMs: Math.min(COMPANION_TOOL_INTENT_TIMEOUT_MS, input.deadlineAt - Date.now()),
        currentActiveTransaction: currentWorkerWorkspaceTransaction,
        verifyAttempt: attempt => isJobLeaseActive({ ...args.ctx, leaseToken: attempt.leaseToken }),
        onReceipt: receipt => recorder.onReceipt(receipt, { runId: args.read.runId, providerId: args.provider.id, modelId: args.provider.modelId }),
    });
    const explicit = mode !== 'classified' ? null : reconcileCompanionInterpretation(
        companionDirectInterpretation(input.requestHash), args.read.userText, input.names, input.permissionLevel);
    const preparedEdit = explicit?.toolUse === 'act' && explicit.candidateOperations.includes('companion_notes_write') ? explicit : null;
    const preparedExplicit = mode !== 'classified' ? null
        : companionExplicitNoteReadInterpretation(input.requestHash, args.read.userText, input.names)
            ?? companionExplicitNoteInterpretation(input.requestHash, args.read.userText, input.names) ?? preparedEdit;
    const prepared = mode === 'classified' ? preparedExplicit : null;
    const cached = input.cached ?? prepared ?? (mode === 'classified' ? null : companionDirectInterpretation(input.requestHash));
    const resolve = async () => {
        if (mode === 'hybrid' && !input.cached && !prepared) {
            // The fast generation owns the branch decision. A safe casual reply
            // is published without waiting for a second classifier; task work
            // pays for the interpreter only when it is actually needed.
            if (input.skipHybrid || Boolean(args.read.userImageAttachments?.length)) return classify();
            hybrid = await runCompanionHybridEntry({ provider: args.provider, fallbackProvider: args.fallbackProvider,
                turnPolicy: typeof args.baseMessages[0]?.content === 'string' ? args.baseMessages[0].content : '',
                messages: input.messages ?? args.baseMessages.filter(m => m.role !== 'system'), signal: args.ctx.signal,
                deadlineAt: input.deadlineAt, onProviderDelta: args.onProviderDelta, onReasoningDelta: args.onReasoningDelta,
                availableToolNames: input.names,
                onRecovery: async () => { await emitCompanionAssistantStatus({ workspaceId: args.ctx.workspaceId, read: args.read, expiresAt: args.expiresAt,
                    status: 'acting', safeLabel: '当前服务的输出等待较久，正在用备用服务接续这次回复。' }); } });
            const scope = input.messages ?? args.baseMessages.filter(m => m.role !== 'system');
            const pendingOfferIndexes = companionPendingOfferIndexes(scope);
            if (hybrid.facts.decision === 'reply') {
                return companionHybridReplyInterpretation(input.requestHash, pendingOfferIndexes);
            }
            // Application work needs semantic subjects and candidate operations.
            // A failed interpretation remains uncertain; vocabulary alone cannot
            // promote a reading question to an authorized editing task.
            return classify();
        }
        return cached ?? classify();
    };
    return { cached, promise: recorder.track(resolve().then(async (attention) => {
            const write = await args.onTurnInterpretation?.(attention);
            return write ? { ...attention, voicePreferenceWrite: write } : attention;
        })), hybrid: () => hybrid };
}
export function companionDirectGuidance(mode: CompanionEntryMode): string {
    if (!usesCompanionDirectControls(mode))
        return '';
    return [
        '本轮没有独立意图分类。注意力数据中的 uncertain 表示宿主未预分类，不表示用户表达不清；结合完整历史、当前页面与已有材料自行回答或调用工具，不把内部状态念给用户。工具回执只用于核对：不要把 memoryId、receiptId、JSON、工具名或内部字段原样念给用户，用用户能听懂的结果说话。',
        '用户要求读取、保存或修改时，实际调用相应工具；工具未返回成功回执前不能确认已完成。现有材料足够时直接回答，不为证明用了工具而重复读取。只说不做不算完成：说过“记下了/已保存/已安排/已打开”就必须有对应回执，否则改成真的调用，或如实说还没做。',
        '确认后的操作结果以工具回执为准：回执 ok=false 或没有回执时，如实说没做成；不要把上一轮的口头承诺当成已完成。',
        '本轮有写回执时，结束必须调用 companion_finish：actions 逐条引用本轮真实成功回执的 receiptId；没有写操作可以直接回答，或也用 companion_finish 交付正文。不要把历史回执当作本轮结果。',
        '历史邀请是过去说过的话；以当前用户回应决定是否执行、继续或换话题，不重写或删除历史。缺少真实操作对象时再澄清。',
        '用户让你记下关于他自己的事实、偏好或近况时，用 companion_memory_write（action=save）；只有用户明确要求改变你以后什么时候主动开口或参与方式时，才用 companion_attention_write（action=save_participation）。用户让你记进你自己的记事时，用 companion_persona_write（action=self_note），不要当成行为边界。',
        '先判断用户要的是记住、安排未来动作、还是现在就做：只是记住时只保存，不创建提醒、关注安排或改行为边界；要未来动作时才调用相应写入。判断依据是这句话要做的事，不是里面有没有某个词。',
        '如果你发现自己创建了用户没有要求的提醒或关注安排，立刻取消并如实说明；用户指出你多做了一步时，先核对上一轮的副作用，能撤销就撤销。',
        '涉及数字表达式、百分比、数值单位换算时，先用 companion_observe（action=calculate）核对；它不接受日期串。日期/时间直接用宿主给的当前本地时间换算，提醒时间要在未来。',
        '用户要求分条/多条消息时，就用自然段把他要的几条分别写出来，每条一段、段间空一行；宿主会按段投递成多条消息，不需要调用发言工具。要以后能回看的产物用 companion_goal_start；要打开页面用 companion_open。',
        '结束前自检：要的动作、计算、分条消息、产物是否都有本轮真实回执；没有就继续调用工具。',
        '用户要求忘掉某条记忆时，先用 companion_memory_read（action=recall）找到真实 memoryId，再用 companion_memory_write（action=forget）；没有真实 id 就先说明没找到，不要凭印象声称已忘掉。',
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
