/** Controlled, real-provider comparison. Tool effects are fixture-local only.
 * ENTRY_BENCH_REAL=1 node --import tsx scripts/companion-entry-benchmark.ts
 *   --out /tmp/entry-benchmark.json --repeats 2
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createProvider } from '../src/lib/ai-provider.ts';
import { createGovernedProvider, resolveAIGovernanceContext, resolveProviderForTask } from '../src/lib/governance.ts';
import { FIXTURES, HYBRID_FIXTURES, HYBRID_ROUTE_FIXTURES } from './companion-entry/fixtures.ts';
import { runTrial, type Arm, type TrialResult } from './companion-entry/harness.ts';
function arg(name: string, fallback: string): string { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] ?? fallback; }
const out = arg('--out', '/tmp/companion-entry-benchmark.json');
const repeats = Number(arg('--repeats', '2'));
const timeout = Number(arg('--timeout-ms', '90000'));
const wanted = arg('--fixtures', '').split(',').filter(Boolean);
const arms = arg('--arms', 'classified,direct_fast,direct_thinking').split(',') as Arm[];
const entryOnly = arg('--suite', 'original') === 'routing';
const fixtures = (entryOnly ? HYBRID_ROUTE_FIXTURES : arg('--suite', 'original') === 'hybrid' ? HYBRID_FIXTURES : FIXTURES).filter(f => wanted.length === 0 || wanted.includes(f.id));
if (process.env.ENTRY_BENCH_REAL !== '1')
    throw new Error('Set ENTRY_BENCH_REAL=1 explicitly to run paid real-provider calls.');
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20 || !Number.isFinite(timeout) || timeout < 1000 || timeout > 180_000 || fixtures.length === 0 || arms.length === 0 || (entryOnly && (arms.length !== 1 || arms[0] !== 'hybrid')) || arms.some(a => !['classified', 'direct_fast', 'direct_thinking', 'hybrid'].includes(a)))
    throw new Error('Invalid benchmark arguments.');
const workspaceId = process.env.PROBE_WORKSPACE_ID;
const userId = process.env.PROBE_USER_ID;
if (!workspaceId || !userId)
    throw new Error('Set PROBE_WORKSPACE_ID and PROBE_USER_ID to a consenting development account.');
const gov = await resolveAIGovernanceContext(workspaceId, userId);
if (!gov.consentOk)
    throw new Error('The selected development account has no AI consent.');
const slot = resolveProviderForTask(gov, 'companion_agent');
const tasks = Array.from({ length: repeats }, (_, repeat) => fixtures.flatMap(fixture => arms.map(arm => ({ fixture, arm, repeat })))).flat();
// Deterministic interleaving. Run trials sequentially so only A's intended
// concurrency is present; trials cannot slow another arm's requests.
let seed = 11;
for (let i = tasks.length - 1; i > 0; i--) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [tasks[i], tasks[j]] = [tasks[j]!, tasks[i]!];
}
const results: Array<TrialResult & {
    repeat: number;
}> = [];
const metadata = { version: 3, createdAt: new Date().toISOString(), provider: slot.providerName, model: slot.providerConfig.model, reasoning: slot.providerConfig.modelProfile?.reasoning, seed: 11, repeats, fixtureCount: fixtures.length, suite: arg('--suite', 'original'), entryOnly,
    protocol: { transport: 'production provider, governance, streaming decoder and release gates', baseline: 'real hedged classifier + both real speculative streams; formal rerun when rejected', single: 'same full persona/context and declaration-based tool catalog; native auto tool choice', hybrid: 'one fast JSON reply-or-task generation, streaming reply field with the existing hold policy; task/fallback then invokes hedged classification and the formal task loop without speculation', effects: 'synthetic fixture-local read/write receipts; no application data writes', l1: 'not seeded or used; compares the classifier gate on new synthetic cases', timing: 'firstPublishedMs includes any preamble; answerStartMs is first published content of the final tool-free answer, with short held answers delivered at completion; raw provider TTFT remains in call traces', tokens: 'observed usage is a lower bound when cancelled calls have missing usage', acceptance: 'automated fact/tool checks plus manual semantic review; not production rollout evidence' } };
mkdirSync(dirname(out), { recursive: true });
function quantile(values: number[], p: number): number | null { if (!values.length)
    return null; const sorted = [...values].sort((a, b) => a - b); const position = (sorted.length - 1) * p, low = Math.floor(position), high = Math.ceil(position); return Math.round(sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low)); }
function summary() {
    return arms.map(arm => {
        const rows = results.filter(r => r.arm === arm);
        const finished = rows.filter(r => r.completed);
        const latency = finished.map(r => r.answerStartMs).filter((v): v is number => v !== null);
        return { arm, trials: rows.length, completed: finished.length, completedWithBody: latency.length, automatedPass: rows.filter(r => r.checksPassed).length, answerP50: quantile(latency, .5), answerP95: quantile(latency, .95), modelCalls: rows.reduce((n, r) => n + r.calls.length, 0), escalations: rows.filter(r => r.escalated).length, missingUsageCalls: rows.flatMap(r => r.calls).filter(c => c.promptTokens === null || c.completionTokens === null).length, observedPromptTokens: rows.flatMap(r => r.calls).reduce((n, c) => n + (c.promptTokens ?? 0), 0), observedCompletionTokens: rows.flatMap(r => r.calls).reduce((n, c) => n + (c.completionTokens ?? 0), 0) };
    });
}
const save = () => writeFileSync(out, JSON.stringify({ metadata, summary: summary(), results }, null, 2));
save();
console.log(JSON.stringify({ event: 'start', ...metadata, totalTrials: tasks.length }));
for (const [i, task] of tasks.entries()) {
    const provider = createGovernedProvider(createProvider(slot.providerName, { ...slot.providerConfig, sessionId: `entry-bench-${Date.now()}-${i}` }), gov, workspaceId, { userId, operation: 'companion_entry_benchmark', dataCategories: ['user_answer'] });
    if (!provider.chatCompletionStreamToolCalls)
        throw new Error('Provider must declare native streamed tool calls.');
    const result = await runTrial(provider, task.fixture, task.arm, timeout, entryOnly);
    results.push({ ...result, repeat: task.repeat });
    save();
    console.log(JSON.stringify({ event: 'trial', index: i + 1, total: tasks.length, fixture: result.fixture, category: result.category, arm: result.arm, hybrid: result.hybrid, answerMs: result.answerStartMs === null ? null : Math.round(result.answerStartMs), publishedMs: result.firstPublishedMs === null ? null : Math.round(result.firstPublishedMs), elapsedMs: Math.round(result.elapsedMs), calls: result.calls.length, kept: result.keptDraft, escalated: result.escalated, completed: result.completed, checksPassed: result.checksPassed, missingTools: result.missingTools, error: result.error }));
}
console.log(JSON.stringify({ event: 'complete', summary: summary(), out }));
// Governance owns lazy database pools; the explicit benchmark process ends here.
process.exit(results.every(r => r.completed && (!entryOnly || r.checksPassed)) ? 0 : 1);
