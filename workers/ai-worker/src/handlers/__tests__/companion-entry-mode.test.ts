import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentVoiceStyleDecisionV1Schema } from '@astella/shared/agent-contracts';
import { validateCompanionAgentToolArguments, canUseCompanionAgentTool, getCompanionAgentTool } from '@astella/shared';
import { companionDirectInterpretation, companionNamedNoteReadRequest, companionExplicitNoteReadInterpretation, createCompanionDirectControls, resolveCompanionEntryMode, startCompanionEntry } from '../turn/companion-entry-mode.ts';
import { companionLatestNoteReadCount } from '../note/companion-note-prefetch.ts';
const fresh = () => companionDirectInterpretation('a'.repeat(64));
test('explicit newest-note selections resolve counts without guessing broader requests', () => {
    for (const [text, count] of [
        ['请读取最新一篇手记的正文。', 1], ['请读取书房最近更新的三篇手记，概括正文。', 3],
        ['比较最近两篇笔记。', 2], ['查阅最新１０篇笔记。', 10],
    ] as const) assert.equal(companionLatestNoteReadCount(text), count, text);
    for (const text of ['最新三篇手记这个标题怎样？', '概括最新20篇笔记', '读取最新一周的笔记', '读取这些手记']) {
        assert.equal(companionLatestNoteReadCount(text), null, text);
    }
});
test('explicit fresh saved-note reads cannot be treated as no-tool casual replies', () => {
    const names = ['companion_notes_read'];
    for (const text of ['请只读取最新一篇手记的正文，用两句话概括。', '帮我读取书房最近更新的三篇笔记。', '请查阅《秦朝》这篇手记。']) {
        const result = companionExplicitNoteReadInterpretation('a'.repeat(64), text, names);
        assert.equal(result?.toolUse, 'read', text);
        assert.ok(result?.candidateOperations.includes('companion_notes_read'));
    }
    for (const text of ['请不要读取最新笔记。', '最新笔记这个标题怎么写更好？', '今天不想看笔记。']) {
        assert.equal(companionExplicitNoteReadInterpretation('a'.repeat(64), text, names), null);
    }
    assert.equal(companionExplicitNoteReadInterpretation('a'.repeat(64), '读取我的笔记', []), null);
});
test('a named saved-note explanation goes to the evidence path unless its note was already prefetched', () => {
    const text = '请根据《秦朝统一与中央集权制度》这篇已保存笔记，用三句话解释郡县制与分封制的区别；不要创建或修改笔记。';
    assert.equal(companionNamedNoteReadRequest(text, []), true);
    assert.equal(companionNamedNoteReadRequest(text, [{ role: 'system', content: '<prefetched_note>已读取的原文</prefetched_note>', hostObservation: true }]), false);
    assert.equal(companionNamedNoteReadRequest('请用三句话解释郡县制。', []), false);
    assert.equal(companionNamedNoteReadRequest('《秦朝》这个故事挺好，今天不想看笔记。', []), false);
});
test('entry mode is explicit and the unclassified placeholder never invents a tool decision', () => {
    // Default is the native tool loop. An explicit unknown value still falls
    // back to the conservative classified path rather than becoming new work.
    assert.equal(resolveCompanionEntryMode(undefined), 'direct_fast');
    assert.equal(resolveCompanionEntryMode('unknown'), 'classified');
    assert.equal(resolveCompanionEntryMode('hybrid'), 'hybrid');
    assert.equal(resolveCompanionEntryMode('classified'), 'classified');
    assert.equal(resolveCompanionEntryMode('direct_thinking'), 'direct_thinking');
    assert.equal(resolveCompanionEntryMode('direct_fast'), 'direct_fast');
    const a = fresh();
    assert.equal(a.toolUse, 'uncertain');
    assert.deepEqual(a.ambiguities, []);
});
test('direct entry resolves without invoking the classifier and persists voice callback before returning', async () => {
    let written = false;
    const entry = startCompanionEntry({ mode: 'direct_thinking', requestHash: 'a'.repeat(64), cached: null, names: [], relatedGoals: [], pageKind: null, permissionLevel: 'full', deadlineAt: Date.now() + 1000,
        args: { provider: { chatCompletion: () => { throw new Error('classifier must not run'); } }, onTurnInterpretation: async () => { written = true; return 'not_requested'; } } as never,
        recorder: { track: (p: Promise<unknown>) => p } as never });
    assert.ok(entry.cached);
    assert.equal((await entry.promise).voicePreferenceWrite, 'not_requested');
    assert.equal(written, true);
});
test('deepening changes only this turn and recovered deepening stays enabled', async () => {
    const c = createCompanionDirectControls({ mode: 'direct_fast', attention: fresh(), userText: '请严谨推导。' });
    assert.equal(c.disableThinking(), true);
    assert.equal((await c.apply('companion_deepen', {}))?.ok, true);
    assert.equal(c.deepened(), true);
    assert.equal(c.disableThinking(), false);
    const restored = createCompanionDirectControls({ mode: 'direct_fast', attention: fresh(), userText: '同一轮', deepened: c.deepened() });
    assert.equal(restored.disableThinking(), false);
});
test('temporary voice control is applied before speech and leaves the persistent preference unchanged', async () => {
    const attention = fresh();
    let seen: unknown;
    const c = createCompanionDirectControls({ mode: 'direct_thinking', attention, userText: '这句用四川话，语速慢一点。', onInterpretation: a => { seen = a.voiceStyle; return 'not_requested'; } });
    const args = { sourceQuote: '这句用四川话', voiceStyle: agentVoiceStyleDecisionV1Schema.parse({ decision: 'apply', instruction: '请用四川话，语速稍慢。', persistentPreference: { action: 'keep', dialect: null } }) };
    assert.equal(validateCompanionAgentToolArguments('companion_configure_turn', args).success, true);
    assert.equal((await c.apply('companion_configure_turn', args))?.ok, true);
    assert.deepEqual(seen, args.voiceStyle);
    assert.equal(attention.voiceStyle.persistentPreference.action, 'keep');
});
test('durable and one-turn dialect settings remain independent and failed writes have no success claim', async () => {
    const attention = fresh();
    const c = createCompanionDirectControls({ mode: 'direct_fast', attention, userText: '以后默认河南话，这次用四川话。', onInterpretation: () => 'failed' });
    const args = { sourceQuote: '以后默认河南话，这次用四川话', voiceStyle: { decision: 'apply', instruction: '请用四川话。', persistentPreference: { action: 'set', dialect: '河南话' } } };
    assert.equal((await c.apply('companion_configure_turn', args))?.ok, false);
    assert.equal(attention.voicePreferenceWrite, 'failed');
    assert.equal(attention.voiceStyle.instruction, '请用四川话。');
});
test('stale quoted instructions cannot change the voice or forbid a new timed request', async () => {
    const attention = fresh();
    let writes = 0;
    const c = createCompanionDirectControls({ mode: 'direct_fast', attention, userText: '五分钟后提醒我喝水。', onInterpretation: () => { writes++; } });
    assert.equal((await c.apply('companion_configure_turn', { sourceQuote: '不要定时', forbidTimeBasedWakeups: true }))?.ok, false);
    assert.equal(attention.executionConstraints, undefined);
    assert.equal(writes, 0);
});
test('a current event-only request binds the actual execution constraint', async () => {
    const attention = fresh();
    const c = createCompanionDirectControls({ mode: 'direct_fast', attention, userText: '只按事件触发，不要定时。' });
    assert.equal((await c.apply('companion_configure_turn', { sourceQuote: '不要定时', forbidTimeBasedWakeups: true }))?.ok, true);
    assert.equal(attention.executionConstraints?.timeBasedWakeups, 'forbid');
});
test('account voice controls retain existing preference semantics without authorizing note edits', () => {
    const voice = getCompanionAgentTool('companion_configure_turn')!;
    assert.deepEqual(canUseCompanionAgentTool('read_only', voice), { allowed: true, requiresConfirmation: false });
    const edit = getCompanionAgentTool('companion_notes_write')!;
    assert.equal(canUseCompanionAgentTool('read_only', edit, { action: 'edit', operation: 'replace_blocks' }).requiresConfirmation, true);
    assert.equal(canUseCompanionAgentTool('guided', edit, { action: 'edit', operation: 'delete_blocks' }).requiresConfirmation, true);
});
