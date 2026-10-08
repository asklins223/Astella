# The unified Agent runtime (technical)

[中文](../zh/agent-runtime.md) · English

What this page covers: the **one Agent execution mechanism** this project has — how a turn is driven, where capabilities and tools come from, how context is measured and compacted, how work commits and recovers across processes, which state words are legal, and which parts actually run today versus which are still backend only. The companion's user-facing side (the four places she appears, the growth loop, what memory and the diary mean as product) lives in [The companion experience (product design)](./companion-experience.md); this page describes only her execution body. Providers and the job queue themselves are in [AI and the companion](./ai-and-companion.md).

Unless noted otherwise, paths are relative to the repository root.

- [The model in one line](#the-model-in-one-line)
- [One turn, end to end](#one-turn-end-to-end)
- [The turn kernel](#the-turn-kernel)
- [Capability catalog and tool surfaces](#capability-catalog-and-tool-surfaces)
- [Permission tiers and the proposal round trip](#permission-tiers-and-the-proposal-round-trip)
- [Context governance](#context-governance)
- [Persistence and host ports](#persistence-and-host-ports)
- [State vocabulary](#state-vocabulary)
- [Governance gates](#governance-gates)
- [Numbers worth remembering](#numbers-worth-remembering)
- [Wired up today vs backend only](#wired-up-today-vs-backend-only)
- [Where to start debugging](#where-to-start-debugging)

## The model in one line

**One kernel, two entry points, one governance layer.**

- The kernel is `packages/agent-core`: turn boundaries, step driving, context assembly and budget criteria, nothing else. It imports no provider, no database, no UI.
- Two entry points: **declarative requests** (a page button has already picked the capability, so no planning model is needed) and **goal advancement** (the companion or a long goal composes capabilities step by step). Both land in the same `agent_runs` table and the same receipt machinery.
- Governance is `packages/agent-host`: consent, egress scope, PII, audit, leases and idempotency are all settled before a request actually leaves. A failed gate is a non-retryable error — no downgrade, no silence.

```mermaid
flowchart LR
  UI["Page button / companion bubble"] -->|"astella.v1.* IPC"| MAIN["Client main process"]
  MAIN -->|HTTP| API["apps/api"]
  API -->|"agent_runs + jobs"| DB[("PostgreSQL")]
  API -.->|"accepts directRequest inline"| API
  DB -->|claim| WORKER["workers/ai-worker"]
  WORKER --> CORE["agent-core turn kernel"]
  CORE --> HOST["agent-host governance and ports"]
  HOST --> PROVIDER["Model provider"]
  CORE -->|"events + receipts"| DB
  DB -.->|"pg_notify"| API
  API -->|"SSE"| MAIN
```

## One turn, end to end

One turn of the companion talking, from keypress to ink on paper, walks this chain:

```mermaid
sequenceDiagram
  participant R as Renderer
  participant M as Main process
  participant A as apps/api
  participant D as PostgreSQL
  participant W as ai-worker
  participant P as Provider
  R->>M: window.astella.companion.chat.sendTurn
  M->>A: POST /companion/conversations/:id/turns
  A->>D: write companion_turn_runs + jobs(type=companion_agent)
  A-->>M: 202 accepted (runId)
  W->>D: claim (120s lease, interactive slot)
  W->>W: runCompanionAgentLoop → executeTurn
  W->>P: measure the whole request → governance gates → send
  P-->>W: text deltas / tool calls
  W->>D: appendAgentEvent (next_event_seq +1)
  W->>D: pg_notify('astella_companion_events_v1')
  D-->>A: LISTEN wakes up
  A-->>M: GET /companion/conversations/:id/events (SSE)
  M-->>R: assistant.delta / agent.tool / action.proposed / voice.segment.ready
```

The parts that matter:

- **Acceptance and execution are separate.** The API only creates the run, queues it and returns a `runId`; a model call never happens on the request thread (`workers/ai-worker/src/handlers/companion-agent-runtime.ts:186`).
- **One owner of the event sequence number.** `appendAgentEvent` (`workers/ai-worker/src/handlers/companion-agent-events.ts:211-255`) bumps `companion_conversations.next_event_seq` first and only then inserts into `companion_stream_events`, so the client can fill gaps by sequence number and duplicate events are idempotent by construction.
- **Polling backs up push.** After an SSE disconnect, `run-nodes` is polled with 2500ms→30000ms backoff (`apps/api/src/modules/companion-conversation/routes.ts:435`).
- **Write-back is lease-fenced.** Every step commits inside `ports.transaction` with a `SELECT … FOR UPDATE` on the run row, checked against the `astella_agent_run_authorized` fence; an expired fence raises `advance_obsolete` (409), so an old worker can never overwrite a new one (`packages/agent-host/src/advance-store.ts:27-39`).

## The turn kernel

`packages/agent-core/src/runtime/`:

| Function | Where | What it owns | What it stays out of |
| --- | --- | --- | --- |
| `executeTurn` | `execute-turn.ts:4-18` | The bounded loop: `step 1..maxSteps`, `signal.throwIfAborted()`, `now() >= deadlineAt → budgetError()`, until `advance()` returns `{kind:"settled"}` | Never touches the model, never touches the database |
| `executeAgentStep` | `execute-step.ts:16-29` | One checkpointable step: `context.prepare()` → `state.prepare()` → `model.execute` → **`state.saveResponse` before any capability runs** → `capabilities.invoke` one at a time → `state.apply` | Does not decide when the turn ends |
| `runAgentModelStep` | `model-step.ts:19-47` | A single model boundary on the `runAiTask` kernel, budget `{maxModelCalls:1, maxAutoRetries:0}`, completion criterion `structured_parsed`; maps `lease_lost` or `cancelled` to inactive, `timeout` or `budget_exhausted` to timeout | No retrying — retries belong to the outer job |
| `resolveAgentTurnInterpretation` | `attention.ts:6-37` | Binds the utterance to host objects; records one ambiguity each for an unknown sequence number, an unresolvable referent and an unavailable capability (capped at 6); pure small talk is forced to `toolUse:"none"` | Does not guess — if it cannot resolve, it marks `uncertain` |
| `validateAgentGoalDelivery` | `goal-delivery.ts:36` | Decides `completed`: every operation `succeeded` with a result, every requirement satisfied, and any non-text requirement must cite a `callId` that really succeeded | Does not accept "the model says it is done" |
| `classifyAgentRunFailure` | `failure-learning.ts:71` | Classifies failure as `transient_provider / outcome_unknown / cancelled / incomplete / not_applicable / unclassified` and says whether that failure **may** count as experiential evidence (`contributesRule`) | Cancellation never counts as experience |

`state.prepare()` reuses persisted responses, so replay of a saved checkpoint can skip the model call. A crash between the provider response and persistence can still result in another call; this is not an unconditional exactly-once billing guarantee. Tool execution has separate idempotency and lease fencing.

Termination comes from the host: `workers/ai-worker/src/agent/advance.ts:60-112` uses `maxSteps:3` and `maxCalls:4` per step; `packages/agent-host/src/advance-store.ts:105-114` writes `completed|paused|failed` from the delivery outcome, stays `waiting` while receipts are still outstanding, and judges `failed` when two assistant turns in a row call no tool at all.

## Capability catalog and tool surfaces

`packages/shared/src/agent-capability-catalog.ts` is the index. Domain manifests declare arguments, risks and executors, then project onto conversation and goal surfaces. JSON Schema and runtime validation share Zod definitions; contract tests are still needed for serialization and adapters.

| Executor domain | Main capabilities |
| --- | --- |
| Companion | Read context/history/material, search notes, navigate, learning actions, memory, persona, reminders, diary and diagrams; `companion_create_note` and `companion_edit_note` persist new notes or edit the current body |
| Goal control | Start, list, revise, pause/resume/cancel work and read long-term goals |
| Notes and cards | Read frozen versions, generate overview/demonstration/expansion, read saved drafts and generate card candidates |
| Methods | Read applicable, current cooperation methods |
| Basic and external | `agent_calculate`, `agent_read_public_document`, `agent_web_search`; search is on conversation and goal surfaces |
| Delivery | `agent_deliver_goal` checks each requirement against successful receipts |

Use the exported catalog rather than a separately maintained total. Exposure also filters read-only permissions, vision policy, web-search opt-in and service availability. Main executors live in `workers/ai-worker/src/handlers/companion-tool-execution.ts` and `workers/ai-worker/src/agent/external-capabilities.ts`.

New notes use `packages/agent-host/src/note-creation.ts`. Current-note edits are claimed by API `modules/note/companion-edit-dispatch.ts` and saved through the existing collaborative document. Both verify workspace, user and version; saved receipts and the final chat reply are recorded separately.

## Permission tiers and the proposal round trip

One place decides, ever: `canUseCompanionAgentTool` (`packages/shared/src/contracts/companion-agent-contracts.ts:236-264`).

| Tier (visible in Settings) | Reads | Reversible low-impact writes | Other writes | The 6 tools that must propose |
| --- | --- | --- | --- | --- |
| Read-only `read_only` | Allowed | Blocked | Blocked | Blocked |
| Guided `guided` (default) | allowed | done directly | confirmed first | proposal, waits for confirmation |
| Full `full` | allowed | done directly | done directly | **still** proposes, waits for confirmation |

- The `irreversible` risk class always confirms — except that no manifest declares it today, so the enum exists ahead of any use (`companion-agent-contracts.ts:57-62`).
- The forced-proposal list is `COMPANION_PROPOSAL_EXECUTED_TOOLS` (`:227`, six names). The code comment states outright that the full tier's server-side auto-confirmation **is still owed**.
- Surface filtering lives in `packages/shared/src/companion-agent-registry.ts:15-21`: `read_only` strips every non-read tool, and vision-related tools are stripped while image reading is off.

The proposal round trip:

```mermaid
sequenceDiagram
  participant W as ai-worker
  participant D as PostgreSQL
  participant A as apps/api
  participant U as User
  W->>D: createAgentProposal → companion_action_proposals
  W->>D: tool row waiting_confirmation / run waiting_for_confirmation
  W-->>A: SSE action.proposed
  A-->>U: bubble or 手记 (journal) shows target, impact and a confirm button
  U->>A: POST /companion/proposals/:id/decision
  A->>W: decideCompanionProposal (learning-action-bridge.ts:852)
  W->>D: execute + receipt
  W-->>A: SSE action.decision, run continues
```

Routes are in `apps/api/src/modules/companion-conversation/routes.ts`: `/companion/menu-proposals` (`:89`), `/companion/tool-proposals` (`:124`), `GET /companion/proposals/:id` (`:158`), `POST /companion/proposals/:id/decision` (`:181`).

## Context governance

**Assembly** (`packages/agent-core/src/context/assemble-context.ts`): sources resolve in plan order → `composeAgentContext` (`:58`) first checks scope and authority (throws outright when they do not hold, `:68-72`), then decides **admission** by `required → priority → index` (`:77-79`), while the **display** order still follows the plan (`:101`). The decisive trade-off: **body text is never cut** — an optional source over budget is marked `budget_omitted`, a required source over budget throws `required_context_overflow` (`:86,92`). The assembly result becomes a receipt (`summarizeContextAssemblyReceipt`, `:202`).

Plan order for goal advancement (`workers/ai-worker/src/agent/goal-context.ts:67-76`): `identity`(required) → `persona` → `preferences` → `execution`(required) → `long_goal`(required, 12000) → `methods` → `materials`(required) → `receipts`(required, 27000) → `evidence`(required), with a 64000-character overall cap.

**Measurement** (`context/measure-request.ts:25-31`): what is measured is the **whole outgoing request**, not message bodies — tool definitions, system sections, images and reasoning handles all count. `CONTEXT_MEASUREMENT_VERSION:"v1"`, image floor `IMAGE_TOKEN_FLOOR:1500`, reasoning-handle floor `REASONING_HANDLE_TOKEN_FLOOR:64`; real usage returned by the provider is preferred as the anchor (`:68-90`), and kinds that cannot be measured go into `unmeasured` instead of pretending to be 0.

**Budget authority** (`context/context-budget.ts:24-46,161-173`):

```
B_hard = max(0, min(C − O, I) − M)      C=window O=output reserve I=input cap M=2048 overhead
T(trigger) = floor(B_hard × 0.80)
G(target)  = floor(B_hard × 0.60)
With no profile, C falls back to 128000 and O is taken conservatively as 16384
```

The decision order inside `evaluateContextPressure` (`:198-251`) **is** the policy: required content overflows → fits the budget so send → over the hard ceiling so refuse → compaction unavailable so send with a reason (`compaction_budget_spent` / `over_trigger_line`) → compact. The verdict is persisted into `companion_turn_runs.context_pressure` and `context_assembly_receipt`.

**Compaction**: cooldown `MAX_COMPACTION_ATTEMPTS 3` / `COMPACTION_COOLDOWN_MS 60000` / `MAX_NO_PROGRESS_ATTEMPTS 2` (`context/compaction-cooldown.ts:27-33`), with state persisted per `(conversation, sourceHash, provider, model)` in `agent_context_compaction_state` and `attempts` incremented by SQL (`packages/agent-host/src/compaction-state.ts:105`).

Companion compaction and generic compaction are **not the same thing**:

- Generic: `withBoundedContextCompaction` (`workers/ai-worker/src/handlers/companion-compaction.ts:223`) plus `boundedStepSender` (`:279`), at most one compaction per request.
- Companion: **coverage-based folding** `foldReplayUnderSummaryCoverage` (`:95-155`) — it folds only whole messages fully covered by a summary (`seq ≤ coverage.throughSeq`, and the summary must carry `sourceSha256`); the current request is always kept, and the receipt records `remainingFromSeq` / `uncoveredBeforeSeq`. The model can still pull the folded original back with `companion_read_history{fromSeq}`, so compaction costs no memory.
- The handoff snapshot is its own chain: `companion_context_handoff_snapshots` (`packages/shared/src/db-schema/companion-conversations.ts:206`), produced by `handlers/companion-context-handoff.ts:157`, with replay window `REPLAY_WINDOW_MESSAGES 20`.

## Persistence and host ports

| Port | File | Tables |
| --- | --- | --- |
| Run create/update/delete, idempotency, quota | `packages/agent-host/src/store.ts:156-321` | `agent_runs`, `agent_operations`, `jobs` |
| Advance lease and step replay | `advance-store.ts:22-140` | `agent_run_steps`, `agent_run_events` |
| Receipt reduction | `packages/agent-core/src/runtime/run-state.ts:65` | `agent_operations` |
| History and revisions | `history.ts`, `store.ts:94-126` | `agent_run_revisions` |
| Long-term goals | `long-goals.ts:15-65` | `assistant_memory_items` (`kind='goal' AND user_confirmed`) |
| Methods and playbooks | `methods.ts:107-459` | `companion_procedural_playbooks`, `companion_method_revisions`, `companion_method_uses` |
| Operation and artifact receipts | `operation-receipt.ts:166`, `artifact-receipt.ts:60` | `note_overviews`, `note_learning_artifacts`, `note_expansions`, `card_generation_runs_v2` |
| Whether a context source went stale | `context-sources.ts:7-24` (`FOR SHARE`, revision compared) | `assistant_memory_items` |
| Compaction cooldown | `compaction-state.ts:50-133` | `agent_context_compaction_state` |

Idempotency keys are a hard convention: job side `agent-start:` / `agent-revise:` / `agent-resume:` / `agent-handoff:` (`store.ts:127-131`), step side `agent-step:{runId}:{revision}:{stepId}` (`workers/ai-worker/src/agent/advance.ts:88`), and the `applied` flag guarantees `applyStep` takes effect exactly once (`advance-store.ts:86-88`).

## State vocabulary

Docs and UI may only use these words; do not invent new ones:

- **run**: `queued → running → waiting | paused → completed | failed | cancelled` (`packages/shared/src/contracts/agent-contracts.ts:3`). `waiting` = a receipt is still outstanding, or a declarative request accepted it; `paused` = a delivery asked for more input, a pause control, or a long-goal change (`advance.ts:115-118`).
- **operation**: `accepted → running → succeeded | failed | cancelled | outcome_unknown` (`agent-contracts.ts:6`). A terminal state cannot be overwritten; **`outcome_unknown` may only be rewritten by an `authoritative` event** (`run-state.ts:98-108`). Rejection reasons: `scope_mismatch / identity_mismatch / revision_mismatch / stale_event / terminal / unverified`.
- **companion turn run**: `accepted / running / waiting_for_confirmation / succeeded / cancel_requested / cancelled / failed / superseded`, phases `accepted / thinking / streaming / acting / awaiting_confirmation` (`companion-conversation-contracts.ts:247,268`).
- **step**: kind `model / tool / confirmation / final / error`, status `running / succeeded / waiting / failed / cancelled`.
- **tool**: `requested / executing / waiting_confirmation / succeeded / outcome_unknown / failed / blocked / expired / not_executed / unavailable`.
- **methods and experience**: state `candidate / active / disabled / disputed`, epistemic state `tentative / supported / disputed`, availability `available / pending / disabled / source_changed / capability_changed / previous_version`, use stage `offered / read / adopted`, feedback `helpful / unhelpful`, actions `confirm / disable / restore`.
- **control**: `cancel / pause / resume`.

## Governance gates

Everything is decided once, before a request goes out, at `prepareGovernedAIPayload` (`packages/agent-host/src/ai-governance-policy.ts:254-265`):

1. Consent: `!consentOk && provider !== "mock"` → `AIConsentRequiredError` (403, `AI_CONSENT_REQUIRED_CODE`). Consent that cannot be read is treated as unsigned — it must be read inside the workspace transaction, or RLS silently returns 0 rows.
2. Egress scope: refused when `sendToExternal=false`; refused for images when `sendImageContent=false` (defaults `sendToExternal:false`, `sendImageContent:true`, `:21-30`).
3. Rule-based PII scrubbing (`:127`, patterns at `:103-115`).
4. Data categories are **declared by the call site**: goal advancement passes `["note_content","user_answer"]` (`advance.ts:56`), and image parts add `image_content` automatically; this vocabulary is exactly `ai_audit_log.data_categories`.
5. Audit is written only by `logAICall` (`workers/ai-worker/src/lib/governance.ts:530,831`), recording provider/model/operation/tokens/duration/status/userId/jobId and **never the body text**.

Non-retryability is decided at two layers: the task kernel retries only `transport / timeout / output_shape` (`packages/shared/src/ai-task-kernel.ts:68`); at the job layer `isNonRetryableError` (`workers/ai-worker/src/lib/non-retryable-errors.ts:194`, pattern table `:29-68`) kills billing exhaustion, `invalid api key`, `access denied`, `not configured`, `consent not signed` and context-dependent 401/403 outright. Read-only permission is enforced before queuing: `requireAgentAuthority` (`store.ts:140-146`).

## Numbers worth remembering

These are mechanism defaults. Deployment overrides and remaining task time can reduce them.

| Mechanism | Default and source |
| --- | --- |
| Companion loop | At most 8 steps, 4 tools per step, 12 tools and 12 model calls per turn; contract deadline 30 minutes and ordinary tool timeout 10 seconds. See `companion-agent-contracts.ts`; long note generation has a dedicated budget |
| Goal advancement | Up to 3 steps per execution and 4 calls per step; model calls respect remaining task time and provider budget. See `agent/advance.ts` |
| Main queue | 120-second lease, renewed every 30 seconds while running; reaping uses the latest heartbeat, with at most 3 attempts. See `queue.ts`, `index.ts`, migration 0394 |
| Execution time | Provider default 15 minutes, handler default 30 minutes; loop retains 15 seconds for persistence. The lease does not cap total runtime. See `lib/handler-timeout-config.ts` |
| Multistage cards | Default total budget 60 minutes with separate outbox leases and renewal. See `card-generation-v2/outbox-queue.ts` |
| Quotas | At most 5 active Agent runs and 50 pending jobs per workspace |
| Context | Trigger 0.80 and target 0.60 of the hard budget; cooldown and compaction attempts are separately bounded |
| SSE | 3 streams per conversation, 10 per user; sequence cursors support recovery |

Model profiles supply output limits; task contracts constrain content length. A small visible-text allowance is not treated as the total reasoning-plus-output budget. See [Model pipeline](ai-and-companion.md#timeout-ladder) for overrides.

## Wired up today vs backend only

Connected entries include direct note/card requests, short chat and goal advancement, goal/method pages, new-note creation, current-body edits, web sources and run diagnostics. Check this turn's exposure instead of treating the static catalog as available tools.

`not_executed` and `unavailable` are persisted tool states in contracts and database constraints, representing no execution and current unavailability respectively. Full-mode automatic confirmation is still absent for six proposal-backed tools. `irreversible` exists as a risk enum but is not used by current manifests. `agent_deliver_goal` is specific to goal runs.

Context governance has real-database, model-comparison and selected window evidence. Check compaction continuity, concurrency recovery, method adoption and long-term effects against individual evidence in [plan 44](../../plans/learning-companion/44-unified-context-window-and-compaction-2026-10-05.md); neither “never verified” nor “complete” describes the whole system.

## Where to start debugging

| Symptom | Look here first |
| --- | --- |
| The bubble spins and no text appears | Find the run via `GET /companion/runs` → `/companion/runs/:id/doctor` → `/turn` to see which phase is stuck |
| A tool was called but produced no result | Is the `agent_operations` row `outcome_unknown`? Recovery relies on `astella_enqueue_agent_recovery()` (30s throttle, `advance.ts:127-131`) |
| Context keeps getting compacted | `attempts` and cooldown in `agent_context_compaction_state`; the persisted verdict in `context_pressure` |
| 403 consent | Whether `user_ai_settings` is signed, and whether a real provider was called while consent was off |
| Events do not push | The LISTEN connection on `pg_notify` channel `astella_companion_events_v1`, and whether SSE slots are blocked by the 10-per-user limit |
| One-shot evidence capture | `GET /companion/runs/:id/issue-bundle` (`run-diagnostics-routes.ts:145`); the read-only health script `scripts/companion-provider-health.mjs` (must run inside the worker container) |

Related pages: [The companion experience (product design)](./companion-experience.md) · [AI and the companion](./ai-and-companion.md) · [Astella system architecture](./architecture.md) · [API and data](./api-and-data.md) · [Desktop client](./desktop-client.md) · [FAQ and troubleshooting](./faq-and-troubleshooting.md)
