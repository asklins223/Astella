# Host-event and output recovery review — 2026-10-15

> Scope correction, 2026-10-15: the user explicitly restricted this audit to the desktop client and its dependent Agent/backend call chain. Mobile is unreleased and excluded from this goal's acceptance criteria. Audit-added iOS changes were reverted and the dedicated audit simulator was shut down; unrelated mobile work was preserved.

The persistent audit goal remains active. This record follows the no-hard-truncation context review in `agent-context-mature-agents-2026-10-15.md`. It does not certify an issue-free agent.

## Additional primary-source comparison

[OpenClaw heartbeat documentation](https://docs.openclaw.ai/heartbeat) defines a separate host task and tells it not to infer old tasks from earlier chats. Its optional isolated session avoids conversation replay entirely. That isolation would lose the shared conversational background needed here, so it was not copied. [OpenClaw compaction documentation](https://docs.openclaw.ai/concepts/compaction) preserves the durable transcript and tool/result pairing, but also documents sampled summarizer input and bounded recent-history fallbacks. Those omission and trimming paths do not satisfy this user's requirement and were not adopted.

The selected approach remains recoverable semantic projection: preserve originals, retain complete recent exchanges, replace older material only under verified summary coverage, and expose source identities for retrieval. A source hash verifies identity, not summary completeness.

## Startup defect: evidence and repair

The original startup run `9bf6666c-4ed3-410c-be61-3020dd4df13b` answered a failed old mathematics question. A copied QA conversation reproduced that behavior in native Electron: run `486c1cab-c08d-4da8-ae64-c7590821f570`. No new human question had arrived. Screenshot: `ui-host-occasion-failed-resumption.png`.

The first source-policy repair was insufficient. Moving the observation to top-level instructions, a labeled native user event, or a quoted record still inside a native user message did not reliably prevent resumption. Removing old reasoning did not help and was not adopted. Removing a conflicting instruction that identified the last native user message as the current request helped only one of three provider replays. These are disconfirming results, not passed acceptance tests.

The production change gives host events their own task policy, current-source identity, and timeline speaker. Failed reply state is terminal rather than unfinished. In a host-origin run only, trailing terminal user questions are projected as attributed host historical data, preserving their complete text, actual role, sequence, creation time and reply status. Completed exchanges stay native. Real new user turns keep ordinary native history. No assistant answer or human request is fabricated, and no original message is changed or removed.

The handoff now preserves host provenance and assistant phase. The runtime retains host historical records instead of filtering every system message out of replay. The Pi adapter preserves their system identity and position. This keeps task authority separate from historical content rather than relying solely on another prohibition in the prompt.

Three controlled real-provider probes of the production projection avoided answering the old question (`agent-host-production-terminal-probe.json`). The native acceptance run `e5708077-2021-4603-a17f-508f09a6bab0`, in a separate copy of the failed conversation, replied “回来了？歇口气没。” It retained all 19 eligible historical messages, including 24,273 estimated replay tokens and the entire failed question. Omitted count: 0. First persisted visible output: 2,683 ms; final: 2,720 ms. Snapshot, turn and screenshot are `agent-terminal-history-native-snapshot.json`, `agent-terminal-history-native-turn.json`, and `ui-terminal-history-startup.png`. These samples validate this reproduced case, not every possible model response.

A native cancellation/restart test earlier in this round also preserved the cancelled request without executing it again: cancelled run `f74e9608-5b5d-406a-ba17-c267273c027b` had zero deltas and zero late deltas; startup `5f6b4f04-8e85-4efa-b6d8-5721069b9273` greeted. Its 19.7-second first output remains evidence of latency variability.

## Malformed output recovery

Textual tool protocols are quarantined before public delivery. The provider result is consumed in full; quarantined text is neither executed nor treated as a shortened successful answer. Invalid native JSON follows the same correction path. The runtime keeps the already displayed prefix, sends explicit failure feedback, preserves real prior receipts, and continues within the same run. Repeating malformed output without new tool evidence terminates instead of spinning indefinitely. A delivery refusal or cancellation remains a stop boundary and cannot become a format-repair retry.

The streamed and buffered PostgreSQL fault tests cover correction success and repeated failure; public events and stored replies contain no tool syntax, no textual tool invocation executes, and terminal codes distinguish bad arguments from bad reply format. Existing eager dispatch is read-only and its ledger remains authoritative. This round does not establish crash recovery between a failed draft and its correction; that remains part of restart validation.

Governance also now preserves a streaming capability exposed on a provider prototype/getter. Previously object spread could lose that declaration and force the buffered path. A boundary test verifies that governance keeps host origin, request content and message order.

## Pressure projection

The pressure-folding fallback formerly folded covered individual messages even when that split an exchange. It now calls the same whole-exchange projection as initial replay: consecutive user additions and segmented replies remain together, gaps preserve their complete exchange, and the latest answered exchange plus subsequent additions remain intact. Entries without source sequences keep their positions. There is no restored 2,048-token replay cap or character slicing.

## Retrieval and latency limits found in native use

The explicit follow-up `296aa0c7-66ff-46c6-a8d8-60ebf045afe5` entered the separate inbox conversation, not the copied dialogue used by startup. It therefore did not have that dialogue's question in its context. Cross-conversation lookup returned no hit because it searches summaries; the copied dialogue had no summary. The model answered the self-contained mathematics question with a valid counterexample, but added a lookup preface despite a one-sentence request. First output: 17,884 ms; final: 47,012 ms. This is not a successful historical-retrieval test.

The source policy and tool description no longer require a lookup merely because an old conversation is mentioned. They ask for retrieval when needed historical evidence is missing, allow a complete supplied question to be answered directly, and distinguish a search miss from proof that no conversation exists. Two verbose authored tool descriptions were rewritten without cutting any runtime source material; the declaration-description check passes at 3,989 characters. The generic context-change error no longer falsely attributes every invalidation to changed memory.

A repeated native request after that guidance change, `10e7e6ec-9231-4b28-b9c9-5dee6ead656f`, used no tools and produced a direct counterexample. First output: 13,089 ms; final: 14,938 ms. Context differed from the preceding run, so this is not a controlled before/after latency comparison. The question did not explicitly require P(B)>0; the second answer used B=A, with probability zero. Do not reuse it as acceptance evidence for the stronger original boundary case.

## Verification

- Final full worker suite, including later guidance/copy edits: 1,810 passed, 0 failed (`work/host-repair-final-worker-unit.log`, process exit 0). The preceding full run also passed all 1,810 tests.
- PostgreSQL dialogue, initiative and review-fence regressions: 72 passed, 0 failed (`work/terminal-history-postgres.log`). This preceded the final guidance/copy edits, which change no database mechanics.
- Subsequent focused worker guidance/error tests: 121 passed, 0 failed (`work/history-tool-guidance-worker.log`). Shared capability-description checks: 5 passed, 0 failed (`work/history-tool-guidance-shared.log`).
- Final package `npm run typecheck`: shared, API, desktop-client and ai-worker all exited 0 (`work/final-host-repair-package-{0,1,2,3}-typecheck.log`).
- Real Electron/native inputs and screenshots were inspected. Unicode prompts were pasted and verified before submission. QA uses an isolated PostgreSQL database and test accounts; original failed conversations were retained unchanged.

## Required continuation

1. Source-indexed retrieval for unsummarized or uncovered parts of other conversations is implemented and was verified in native Electron. See [desktop history retrieval and quote validation](agent-desktop-history-retrieval-2026-10-15.md) for the failures, repairs and remaining latency limits.
2. Complete pressure-triggered semantic compaction of unsummarized history, including a single oversized exchange. Keep user constraints, corrections, unresolved work and tool/result relationships recoverable. Do not add oldest-message dropping or raw-character cutoffs.
3. Validate real-provider format correction, worker restart during correction, desktop quiet-presence participation, interruption and long-running behavior. Database mocks do not replace these checks. Mobile validation is excluded by the user's latest scope decision.
4. Measure first-output latency across repeated comparable inputs and separate interpretation, provider reasoning, retrieval, delivery and rendering. The native samples above are individual observations.
