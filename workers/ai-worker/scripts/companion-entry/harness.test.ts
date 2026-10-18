import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AIProvider } from '../../src/lib/ai-provider.ts';
import type { ChatOptions } from '@astella/shared';
import { FIXTURES, NOTE_ID } from './fixtures.ts';
import { runTrial } from './harness.ts';
function provider(onStream: (options: ChatOptions, n: number) => {
    content: string;
    toolCalls?: unknown[];
}) {
    const requests: ChatOptions[] = [];
    let classifiers = 0;
    const raw = { id: 'mock', modelId: 'mock', visionModelId: 'mock', promptVersion: 'bench-test', chatCompletionStreamToolCalls: true,
        chatCompletion: async () => { classifiers++; return { content: JSON.stringify({ intent: 'conversation', toolUse: 'none', subjects: [], goalRelation: 'unrelated', candidateOperations: [], ambiguities: [], voiceStyle: { decision: 'none', instruction: null, persistentPreference: { action: 'keep', dialect: null } }, pendingOfferIndexes: [] }) }; },
        chatCompletionStream: async (_messages: unknown, options: ChatOptions, signal: AbortSignal | undefined, onDelta: (text: string) => void) => {
            signal?.throwIfAborted();
            requests.push(options);
            const response = onStream(options, requests.length);
            if (response.content)
                onDelta(response.content);
            return { ...response, toolCalls: response.toolCalls ?? [], finishReason: response.toolCalls?.length ? 'tool_calls' : 'stop', usage: { promptTokens: 10, completionTokens: 10 } };
        },
    } as unknown as AIProvider;
    return { raw, requests, classifiers: () => classifiers };
}
test('classified arm really starts two classifiers and both drafts, then keeps one', async () => {
    const p = provider(() => ({ content: '早上好呀，今天想聊点什么都可以。' }));
    const result = await runTrial(p.raw, FIXTURES.find(f => f.id === 'greeting')!, 'classified');
    assert.equal(result.error, null);
    assert.equal(result.completed, true);
    assert.equal(result.keptDraft, true);
    assert.equal(p.classifiers(), 2);
    assert.equal(p.requests.length, 2);
    assert.equal(result.calls.length, 4);
});
test('single thinking arm makes one request, with native tools and no classifier', async () => {
    const p = provider(() => ({ content: '早上好呀，很高兴又见到你。' }));
    const result = await runTrial(p.raw, FIXTURES[0]!, 'direct_thinking');
    assert.equal(result.checksPassed, true);
    assert.equal(p.classifiers(), 0);
    assert.equal(p.requests.length, 1);
    assert.equal(p.requests[0]!.disableThinking, false);
    assert.equal(p.requests[0]!.toolChoice, 'auto');
});
test('fast arm escalates only after a real model tool call; subsequent request enables thinking', async () => {
    const p = provider((_options, n) => n === 1 ? { content: '', toolCalls: [{ id: 'deepen-1', name: 'companion_deepen', arguments: {} }] } : { content: '只有乙说真话：如果丙为假，乙为真，而甲为假，恰好满足条件。' });
    const result = await runTrial(p.raw, FIXTURES.find(f => f.id === 'liars')!, 'direct_fast');
    assert.equal(result.escalated, true);
    assert.equal(result.checksPassed, true);
    assert.equal(p.classifiers(), 0);
    assert.deepEqual(p.requests.map(r => r.disableThinking), [true, false]);
    assert.equal(p.requests[1]!.tools?.some(t => t.name === 'companion_deepen'), false);
});
test('a final answer without a required fixture read is reported as missing evidence', async () => {
    const p = provider(() => ({ content: '实验组得分72分。' }));
    const result = await runTrial(p.raw, FIXTURES.find(f => f.id === 'note-read')!, 'direct_thinking');
    assert.equal(result.completed, true);
    assert.equal(result.checksPassed, false);
    assert.deepEqual(result.missingTools, ['companion_read_note']);
});
test('tool schema violations do not receive successful read receipts', async () => {
    const p = provider((_options, n) => n === 1 ? { content: '', toolCalls: [{ id: 'read-1', name: 'companion_read_note', arguments: { noteId: 'invented' } }] } : { content: '目前没有读到可验证的笔记内容。' });
    const result = await runTrial(p.raw, FIXTURES.find(f => f.id === 'note-read')!, 'direct_fast');
    assert.equal(result.toolCalls[0]!.valid, false);
    assert.equal(result.toolCalls[0]!.succeeded, false);
    assert.equal(result.checksPassed, false);
});
test('valid reads get fixture facts and the loop continues without application writes', async () => {
    const p = provider((_options, n) => n === 1 ? { content: '', toolCalls: [{ id: 'read-1', name: 'companion_read_note', arguments: { noteId: NOTE_ID } }] } : { content: '实验组复习测验得了72分。' });
    const result = await runTrial(p.raw, FIXTURES.find(f => f.id === 'note-read')!, 'direct_thinking');
    assert.equal(result.toolCalls[0]!.succeeded, true);
    assert.equal(result.checksPassed, true);
    assert.equal(p.requests.length, 2);
});
test('hybrid replies use one generation request and no classifier', async () => {
    const p = provider(() => ({ content: JSON.stringify({ reply: '早上好呀，今天我们就轻松聊聊吧。' }) }));
    const result = await runTrial(p.raw, FIXTURES[0]!, 'hybrid');
    assert.equal(result.hybrid?.decision, 'reply'); assert.equal(result.checksPassed, true);
    assert.equal(p.classifiers(), 0); assert.equal(p.requests.length, 1);
    assert.equal(result.text.includes('"reply"'), false);
});
test('hybrid structured handoff invokes classification only after the first generation', async () => {
    const p = provider((_options, n) => n === 1 ? { content: '{"task":true}' }
      : { content: '早上好呀，今天我们就轻松聊聊吧。' });
    const result = await runTrial(p.raw, FIXTURES[0]!, 'hybrid');
    assert.equal(result.hybrid?.decision, 'task'); assert.equal(p.classifiers(), 2);
    assert.equal(result.calls[0]!.kind, 'generation'); assert.equal(p.requests.length, 2);
});
test('hybrid false conversation decisions remain evidence failures in evaluation', async () => {
    const p = provider(() => ({ content: JSON.stringify({ reply: '实验组得分72分。' }) }));
    const result = await runTrial(p.raw, { ...FIXTURES.find(f => f.id === 'note-read')!, pageKind: undefined }, 'hybrid');
    assert.equal(result.hybrid?.decision, 'reply'); assert.equal(result.checksPassed, false);
    assert.deepEqual(result.missingTools, ['companion_read_note']);
});
