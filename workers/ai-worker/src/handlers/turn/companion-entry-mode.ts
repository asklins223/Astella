import { agentTurnInterpretationV1Schema, type AgentTurnInterpretationV1 } from '@astella/shared/agent-contracts';
import { companionTurnWritesDocumentContent } from '@astella/shared';
import type { CompanionAgentLoopArgs } from '../../contracts/companion-agent-loop.ts';

/**
 * There is one entry shape: the model answers or acts inside a native tool
 * loop. `direct_thinking` only changes the opening thinking level; neither
 * mode asks a classifier what the turn is. An unknown value keeps the fast
 * default instead of silently changing behaviour.
 */
export type CompanionEntryMode = 'direct_fast' | 'direct_thinking';

export function resolveCompanionEntryMode(raw = process.env.COMPANION_AGENT_ENTRY_MODE): CompanionEntryMode {
    return raw === 'direct_thinking' ? 'direct_thinking' : 'direct_fast';
}

/** This is explicitly an unclassified host placeholder, not a model judgment
 * that a user needs clarification. Native tool choice owns the decision. */
export function companionDirectInterpretation(requestHash: string): AgentTurnInterpretationV1 {
    return agentTurnInterpretationV1Schema.parse({ version: 1, requestHash, intent: 'question', toolUse: 'uncertain', subjects: [], goalRelation: 'unrelated', goalReference: null, candidateOperations: [], ambiguities: [], status: 'uncertain' });
}

/**
 * Resolve the turn's attention record. The host has no classifier: it starts
 * from the placeholder (or a cached record from a resumed step) and persists
 * whatever the turn later observes through `onTurnInterpretation`.
 */
export async function settleCompanionAttention(input: {
    args: CompanionAgentLoopArgs;
    requestHash: string;
    cached: AgentTurnInterpretationV1 | null;
}): Promise<AgentTurnInterpretationV1> {
    const base = input.cached ?? companionDirectInterpretation(input.requestHash);
    const write = await input.args.onTurnInterpretation?.(base);
    return write ? { ...base, voicePreferenceWrite: write } : base;
}

export function companionDirectGuidance(mode: CompanionEntryMode): string {
    return [
        '本轮没有独立意图分类。注意力数据中的 uncertain 表示宿主未预分类，不表示用户表达不清；结合完整历史、当前页面与已有材料自行回答或调用工具，不把内部状态念给用户。工具回执只用于核对：不要把 memoryId、receiptId、JSON、工具名或内部字段原样念给用户，用用户能听懂的结果说话。',
        '用户要求读取、保存或修改时，实际调用相应工具；工具未返回成功回执前不能确认已完成。不要在调用前先回复“我去写/我马上做/马上处理”；用户要求写进你自己的记事或保存笔记时，必须先拿到工具的写入回执，再说话。现有材料足够时直接回答，不为证明用了工具而重复读取。只说不做不算完成：说过“记下了/已保存/已安排/已打开”就必须有对应回执，否则改成真的调用，或如实说还没做。',
        '确认后的操作结果以工具回执为准：回执 ok=false 或没有回执时，如实说没做成；不要把上一轮的口头承诺当成已完成。',
        '本轮有写回执时，结束必须调用 companion_finish：actions 逐条引用本轮真实成功回执的 receiptId；没有写操作可以直接回答，或也用 companion_finish 交付正文。不要把历史回执当作本轮结果。',
        '历史邀请是过去说过的话；以当前用户回应决定是否执行、继续或换话题，不重写或删除历史。缺少真实操作对象时再澄清。',
        '用户让你记下关于他自己的事实、偏好或近况时，用 companion_memory_write（action=save）；只有用户明确要求改变你以后什么时候主动开口或参与方式时，才用 companion_attention_write（action=save_participation）。用户让你记进你自己的记事时，用 companion_persona_write（action=self_note），不要当成行为边界。',
        '先判断用户要的是记住、安排未来动作、还是现在就做：只是记住时只保存，不创建提醒、关注安排或改行为边界；要未来动作时才调用相应写入。判断依据是这句话要做的事，不是里面有没有某个词。',
        '如果你发现自己创建了用户没有要求的提醒或关注安排，立刻取消并如实说明；用户指出你多做了一步时，先核对上一轮的副作用，能撤销就撤销。',
        '涉及数字表达式、百分比、数值单位换算时，先用 companion_observe（action=calculate）核对；它不接受日期串。日期/时间直接用宿主给的当前本地时间换算，提醒时间要在未来。',
        '回复按意义分段：每个自然段会作为一条独立消息送达用户。用户明确要求分成几条时，这是硬要求——要求几条就写几段，每段只承担一个意思，不要合并成一段；需要连贯阅读的公式、代码、列表和长论证保持在同一段，不按句子拆碎。要以后能回看的产物用 companion_goal_start；要打开页面用 companion_open。',
        '新建笔记时先用 companion_notes_read（action=search）看看库里有没有相关内容：要加库内链接就必须先搜索并读到真实版本；没有相关内容或用户禁止读库时，写成独立笔记、links 留空。',
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
            if (!companionTurnWritesDocumentContent(names))
                return;
            input.attention.candidateOperations = [...new Set([...input.attention.candidateOperations, ...names])];
            await input.onInterpretation?.(input.attention);
        },
    };
}
