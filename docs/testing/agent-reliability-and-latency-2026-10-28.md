# Server agent reliability and latency — 2026-10-28

> 本文是当天较早的审计与规则修补记录。其本地 workload 规则、标题预读、动作措辞闸和消息数量匹配已在后续整改中退出运行主链；当前状态与未通过项见[原生循环实施及验收](./agent-native-loop-implementation-2026-10-28.md)。保留历史结果，不将本页较早的验证当成当前版本证明。

The requested behavior is fast ordinary conversation and careful, complete work when the question or action needs it. This audit found reproducible runtime defects and fixed them. It also found incorrect knowledge answers behind successful run statuses. The runtime fixes are not a certification of factual accuracy.

## Evidence and scope

- Followed the real HTTP submission, queue, worker, native model/tool loop, database receipts, durable message, and event paths. Live tests use an isolated synthetic account in the local Docker database, with real configured providers. They do not use real people's notes or memories. The probe disables its account and removes its session afterward.
- Read local run and error aggregates. Their large synthetic-test population makes them unsuitable for estimating production user satisfaction or the reported “five or six bad answers out of ten.”
- Attempted read-only production SSH access using the known deployment endpoint; authentication failed. Production conversations and production deployment state were not verified. See `outputs/agent-reliability-2026-10-28/production-read-access.log`.
- The checkout advanced from `0877d85b` to `9ac7d098` while this audit was running. That other release commit incorporated the earlier in-progress agent edits along with unrelated release-center changes. Those changes were preserved. This audit did not perform a deployment.
- No new intent-classification network request, universal answer reviewer, task lifetime limit, reduced output ceiling, or silent history truncation was added.

## Implemented changes

| Defect observed | Resulting behavior |
| --- | --- |
| The unclassified entry placeholder always selected thinking and the knowledge checklist, including greetings. | A conservative local workload check recognizes complete greetings, mood statements, and short personal updates. Those openings request `none` and conversational guidance. Unknown, grounded, technical, continuation, and action turns retain reasoning. Tool evidence, corrections, and explicit deepening raise effort on later steps. Tools and permission checks remain available. |
| The Pi adapter ignored explicit per-step reasoning effort; the legacy streaming adapter also lost it. | Shared model-profile resolution maps requested effort to supported levels. Native, buffered, and streaming paths use it, while retaining required protocol compatibility rules. |
| Governance dropped the buffered provider's observation callback. Healthy reasoning/tool progress could look like a stalled request. | Real text, reasoning, and tool-argument output reaches the watchdog through governance. Metadata heartbeats do not extend the wait. First output and idle progress have separate timers. |
| Casual primary calls could wait too long before failover. Applying a short deadline to the reasoning-only alternate then caused a new double timeout. | Casual primary startup defaults to 5 seconds; a recovery provider receives the normal 12-second startup allowance. Both remain configurable, and real progress resets the idle timer. These are attempt timers, not a limit on a working task. |
| Recoveries buffered the entire alternate answer or bounced back onto a broken primary on the next step. | A fitting alternate continues streaming where supported and remains adopted for the turn. Stream and buffered attempts share a bounded recovery sequence. Already delivered text prevents a fresh duplicate generation. |
| Explicit requests for two messages could finish successfully after publishing only one. | A delivery contract counts distinct persisted publications, restores them on resume, requests missing publications, and prevents premature finish and extra bubbles. Transaction replay remains idempotent. |
| A fresh request to read `《可靠性验收》` missed host resolution because it omitted the word “note.” | An imperative title reference can resolve a unique visible stored note. Ambiguous or absent matches are not fabricated. A separate test uses a random secret that exists only in the saved note, preventing history-based answers from passing. |
| Broken tool JSON was silently converted into `{}`. | Malformed or non-object tool arguments fail explicitly before execution and enter the existing repair path. Completed valid eager reads retain their execution semantics. |
| Internal context tokens or partial whitespace could poison delivery and produce a generic failure. | Private-token drafts are quarantined and corrected within the turn; whitespace waits for meaningful content. Terminal empty output still fails. Error attribution distinguishes reply format from transport failure. |
| The action-claim guard interpreted an acknowledgement of the user's progress (“you finally got it done”) as an assistant write. Its correction then caused unsolicited memory writes and a deletion confirmation. It also interpreted replacing an argument in a mathematical proof as an app edit. | Casual acknowledgements and transformations in an explanation are distinguished from application operations. Transformations need an app object, explicit assistance, or an independently identified action request to become edit claims. Genuine assistant completion claims still require receipts. Both retry branches avoid requiring a tool solely because generated wording triggered a claim check; an identified action request can still require execution. |

Main entry points: `companion-turn-workload.ts`, `companion-agent-runtime.ts`, `companion-output-watchdog.ts`, `companion-stream-recovery.ts`, `companion-message-delivery.ts`, `companion-action-claims.ts`, `companion-step-plan.ts`, `lib/providers/pi-agent.ts`, `lib/providers/openai-compatible.ts`, `lib/governance.ts`, and shared `platform-config.ts`.

## Real-provider observations

Raw evidence is retained under `outputs/agent-reliability-2026-10-28/`. Every run has a separate label; earlier failures were not overwritten or relabeled as passes. Structural checks cover execution, publication, receipts, leakage, and requested operations. Keyword matches do not certify an explanation's correctness.

| Batch | Structural result | Interpretation |
| --- | --- | --- |
| `baseline-1793176270207.json` | 12/14 | Both independent-message requests published only one message. Runs could say `succeeded` while violating delivery or factual requirements. |
| `improved-1793177480569.json` | 13/14 | Message delivery worked. The explicit note-title read still lacked a fresh receipt and prompted the title-resolution fix. |
| `final-1793178204521.json` | 21/21 | Includes actual calculation, memory write/read, note create/read, compound two-message delivery, strict proof, and the hidden fresh-note secret. This batch predates the final conversational claim and recovery-deadline fixes. Its filename does not make it final acceptance. |
| `casual-verified-1793179437312.json` | 22/24 | Repeated conversation exposed two unwanted memory-operation turns. The progress-acknowledgement claim guard was the concrete trigger. |
| `casual-final-1793180539756.json` | 21/22 submitted turns; one later submission rejected | No unwanted tools on the submitted chat turns. One turn failed after primary and fallback both inherited 5-second startup deadlines. The next sequence also exposed probe pacing exceeding the real 12-turn/minute API limit. Both led to explicit corrections; the rejected submission is not counted as a model answer. |
| `casual-paced-1793180808068.json` | 24/24 | After the claim-guard and recovery-deadline fixes: no tool calls and no confirmation cards across three repeats of eight ordinary conversation cases in one continuing history. First-visible median 3.32 seconds, nearest-rank P95 7.57 seconds, maximum 11.85 seconds. Provider stalls remain observable. |
| `acceptance-1793181118810.json` | 11/12 | All tested writes, reads, calculations, and independent messages passed. The proof exceeded the probe's 120-second observation limit: its first answer contained “replaced with,” which triggered an unnecessary second model pass. The stored internal correction confirmed the false edit classification. The probe cancelled this synthetic turn; it is retained as a failure. |
| `proof-repaired-1793181635250.json` | 5/5 | After narrowing explanation/edit claims: strict proof, note create/read, chat after the action, and a hidden fresh-note read passed. The proof completed with one model call and no tool calls; manual inspection found the core parity/minimal-denominator argument correct. It still took 106.30 seconds (first visible 72.39 seconds), so knowledge latency remains variable and this is not a speed claim. |

The original five casual samples had a 4.65-second median time to the first durable visible event and a 14.82-second maximum. The first improved five had a 4.43-second median and 4.73-second maximum. These are sequential small samples with different provider load and cache conditions, not a controlled latency benchmark. Later repeated cohorts include provider stalls and must be read separately. First visible text is measured from database events after HTTP submission, not from the provider's first metadata or voice-control token. Client rendering and audible TTS latency were not measured.

## Knowledge quality remains a release concern

Manual review of the successful 21-case HTTP batch found unsupported details and contradictions. Examples include changing the force-system boundary and ending with an unconditional “never cancel,” presenting a possible weather confounder as a demonstrated cause, inventing a control-study result, and adding unjustified cooling-mechanism rankings. A mathematically sound central proof does not make all its appended explanations correct.

Five diagnostic conditions were also tested using the production prompt assembly and native streaming path, without HTTP, queue, or tool execution: configured alternate model, primary without thinking, larger same-provider model, appended scope guidance, and replacement concise scope guidance. There were 27 synthetic diagnostic cases in total. Reference answers were not injected into generation. Returned hidden reasoning was omitted from retained answers; only its hash is kept. These are diagnostic comparisons, not end-to-end acceptance or statistically controlled model rankings.

- The configured alternate and primary without thinking still produced factual or logical errors. Disabling thinking globally was rejected.
- The larger model timed out on one case and still produced unsupported claims in others. It was not promoted.
- Additional and shortened instructions did not reliably fix the errors; both scope candidates timed out on the strict-proof case. They were not added to production.
- None of these experiments justifies a universal reviewer or another model switch. The old reviewer experiment remains retired.

Acceptance therefore needs three separate judgments: delivery and tool correctness, latency under realistic load, and answer quality checked against external references. A successful run status or a green keyword test cannot substitute for the third. `src/live-tests/quality-cases.ts` retains explicit physics and causal-inference criteria and primary references for content review. Factual accuracy remains unconfirmed beyond the manually inspected samples and was demonstrably inadequate in several of them.

## Reproduction

From `workers/ai-worker`, with the local API and worker running:

```sh
REAL_MODEL_BATCH=1 RELIABILITY_LABEL=unique-audit \
  node --import tsx src/live-tests/companion-reliability-probe.ts

REAL_MODEL_BATCH=1 RELIABILITY_LABEL=unique-chat-audit \
  RELIABILITY_CASES=greeting,casual-tired,greeting-english,casual-thanks,after-task-chat,casual-return,casual-success,casual-rest \
  RELIABILITY_REPEATS=3 \
  node --import tsx src/live-tests/companion-reliability-probe.ts
```

The probe uses synthetic full-permission data, records each result incrementally, paces submission outside the latency measurement to respect 12 turns/minute, and never automatically resubmits a failed answer to manufacture a pass. Test-only 120-second observation deadlines cancel that synthetic turn; they do not add a production lifetime cap.

Regression logs include the 1,844-test original worker baseline, deliberately failing provider regressions before fixes, provider and runtime regressions afterward, shared/API/desktop/worker type checks, and structure guards.

The final proof guard refinement also preserves “I helped you replace…” as an application claim when the verb consumed that assistance phrase. A targeted regression caught this during implementation; the preceding candidate suite's one failure is retained, not presented as a pass. A new recovery-timer regression initially depended on event-loop timing and hung under suite concurrency; it now waits for the fallback's explicit start signal before advancing the mock clock. Earlier harness errors and failing candidates remain in their own logs.

Final verification after the assistance-prefix fix and extraction of action-claim recognition into its own module:

| Check | Result | Evidence |
| --- | --- | --- |
| Complete worker unit suite | 1,860/1,860 passed | `worker-delivery-verified.log` |
| Worker type check | Passed | `worker-typecheck-delivery-verified.log` |
| Shared, API, desktop type checks | All passed | `shared-typecheck-final-acceptance.log`, `api-typecheck-final-acceptance.log`, `desktop-typecheck-final-acceptance.log` |
| API file-size and directory structure guards | 8/8 passed | `structure-verified.log` |
| Replay of the actual cancelled proof's 1,599-character public draft through the final claim detector | No false application-action claims | `proof-public-replay-extracted.log` |
| Whitespace/error check | `git diff --check` passed | Working checkout |

The structure guard caught the expanded dialogue-content module crossing 1,500 lines. Its cohesive action-claim recognizer, quotation handling, and future-commitment check were extracted together into `companion-action-claims.ts`; both runtime callers and the tests now import that module directly. The guard allowance was not increased. Live batches precede the final assistance-prefix refinement and this extraction; all worker tests, the worker type check, and the structure guards were rerun afterward. No native-client visual or audio validation was performed.

## Industry references and adoption decisions

- [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents) supports simple composable loops, adding complexity only when measured results justify it. Applied here by retaining one native loop and rejecting an unconditional classifier/reviewer chain.
- [Claude Code's execution loop](https://code.claude.com/docs/en/how-claude-code-works) describes gathering context, acting, and verifying. Applied here through actual read/write/publication receipts and continuation with preserved state.
- [OpenAI: Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) describes native tool-result feedback, streaming, and context management around the model. Applied here by fixing the existing native loop and preserving its history, receipts, and already delivered output during recovery.
- [OpenAI latency optimization](https://developers.openai.com/api/docs/guides/latency-optimization) and [reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning) inform avoiding unnecessary calls and matching effort to the task and supported model capabilities. A brand comparison does not establish an implementation's quality.
- [Grok Bot FAQ](https://docs.x.ai/grok-bot/faq) describes choosing models for the task. This supports measuring task-specific behavior, not assuming one thinking setting fits everything.
- [MiMo Responses documentation](https://mimo.mi.com/docs/en-US/api/chat/responses) states that `none` disables thinking, enabled effort levels have the same behavior, and sampling parameters do not take effect with thinking enabled. Raising `medium` to `high` or reducing temperature alone is therefore not an accuracy fix for this primary model.
- [Meta: How We Built Safety Into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse) describes an execution boundary that the model cannot override, while acknowledging that models make mistakes. The applicable principle here is keeping permissions, execution, and receipts in the host. It does not supply evidence for Muse's private latency router or for copying its model choices.
