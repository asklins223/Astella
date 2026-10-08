# Models and the worker pipeline

[中文](../zh/ai-and-companion.md) · English

## What this covers

This page explains how the model side actually runs: a Node worker consuming a Postgres queue, one server-side model-configuration file, an account-level consent and egress governance layer, and where the worker-side card-generation, voice and companion jobs land in files and tables. Every judgement here comes from `workers/ai-worker/src/**`, `packages/*/src/**`, `config/ai-platforms.json`, `apps/api/src/modules/**` and the migration files, not from what a plan document claims. How an agent turn is driven — the turn kernel, the capability and tool surface, context governance and the state vocabulary — now has its own page in [Unified agent runtime (technical)](./agent-runtime.md), and what the companion is for the person using it is in [Companion experience (product design)](./companion-experience.md); this page no longer expands either. Plan 44 records database, real-model and selected-window evidence; remaining limitations must be checked against those records.

- [Worker runtime](#worker-runtime)
- [Job type inventory](#job-type-inventory)
- [The second queue: card-generation outbox](#the-second-queue-card-generation-outbox)
- [Model configuration: one file](#model-configuration-one-file)
- [Provider protocol registry](#provider-protocol-registry)
- [Thinking and reasoning levels](#thinking-and-reasoning-levels)
- [Vision routing](#vision-routing)
- [Token measurement and context governance](#token-measurement-and-context-governance)
- [Web search and sources](#web-search-and-sources)
- [Governance and consent](#governance-and-consent)
- [Card generation: domain package and worker chain](#card-generation-domain-package-and-worker-chain)
- [ai-quality: the offline quality layer](#ai-quality-the-offline-quality-layer)
- [Voice](#voice-synthesis-in-the-api-segmentation-in-the-worker-recognition-on-the-desktop)
- [Companion: persona, memory, diary](#where-the-companion-lands-in-this-pipeline)
- [Probe and evaluation scripts](#probe-and-evaluation-scripts)
- [Timeout ladder](#timeout-ladder)

## Worker runtime

Entrypoint: `workers/ai-worker/src/index.ts`. `main()` starts on module load. The only exception is when `NODE_ENV=test` **and** `WORKER_DISABLE_AUTOSTART=1` are both set — a stray production environment variable alone will not silently disable the worker.

### Claim, lease and retry

`claimJobs()` calls the fixed `SECURITY DEFINER` function `public.astella_claim_jobs(p_limit, p_background_limit, p_max_attempts)` (established in migration 0022, reworked in 0228 to rate-limit by resource class and return `resource_class`). Locking and the lease token live in that SQL; the application layer no longer issues its own `FOR UPDATE`.

- Lease `LEASE_TIMEOUT_MS = 120_000`. Orphan reaping runs through `public.astella_reap_stale_jobs(...)`, throttled to once every 30 seconds (`REAP_THROTTLE_MS`) rather than a full scan of `jobs` on every tick.
- `MAX_ATTEMPTS = 3`. Retry parameters are **not computed in TS**: `astella_fail_job(id, workspace_id, lease_token, last_error, max_attempts)` returns `status / attempts / backoff_ms / is_dead / scheduled_at` directly, with backoff `2000 * 2^(attempts-1)` milliseconds. TS keeps only `MAX_ATTEMPTS`, for dead-letter forcing and for the claim/reap arguments; `retry-strategy-contract.test.ts` asserts the two sides agree.
- Every terminal transition is a lease-token CAS: `astella_finish_job` / `astella_fail_job` are both fenced by `(id, workspace_id, status='running', lease_token)`. Zero rows affected means the job was reaped or re-claimed, so this attempt's result is **not committed** and only `jobLeaseLostTotal` is incremented.
- Terminal transitions also have a wall-clock bound: `resolveWorkerStatementTimeoutMs() + 5_000` (60 s + 5 s by default). A timeout means the outcome is unknown, so it is handed to the reaper to settle by lease — never mislabelled as a failure.

Main-queue jobs renew every 30 seconds while running (`index.ts` + `lib/lease-heartbeat.ts`). Migration 0394 adds `lease_renewed_at`; reaping uses the latest heartbeat. Failed renewal aborts execution, and an obsolete lease cannot commit.

### Concurrency and the interactive lane

`QUEUE_CONCURRENCY` defaults to 4 and caps at 16; illegal values (NaN, fractions, non-positive) fall back to the default. `INTERACTIVE_RESERVE_SLOTS = 1`: background jobs (`maintenance` / `card_foreground`) may occupy at most `concurrency - 1` slots, and the last free slot is only open to `interactive_ai`. `computeClaimLimits()` is the pure function behind that allocation. Deployments with `concurrency <= 1` drop the reserve, otherwise background work would stall permanently. The connection pool derives from the same number as `clamp(concurrency × 4, 15, 64)`.

### Polling, wake-up and memory backpressure

When the queue is idle the poll interval backs off exponentially from `POLL_MS = 500` to `POLL_MAX_MS = 5_000`, and returns to the fast tier as soon as a claim succeeds or a NOTIFY arrives. LISTEN/NOTIFY uses channel `astella_job_events` (the sender is the `AFTER INSERT` trigger in migration 0115; the worker only consumes), with a 3-second connection timeout and a fall back to pure polling on failure; `WORKER_DISABLE_NOTIFY=1` turns it off explicitly. Claiming new jobs pauses while heap usage exceeds `WORKER_MEMORY_LIMIT_MB` (default 1536; invalid values fall back with a warning).

### Graceful shutdown and observability

On SIGTERM/SIGINT the worker stops claiming, first returns any in-flight V2 outbox leases (without that, a force-kill leaves the run's lease held for the full 30 minutes while the note stays locked and the money already spent), then waits for the drain. `WORKER_DRAIN_TIMEOUT_MS` defaults to 45_000; after that the process exits and orphaned running jobs are reaped by the next worker. `WORKER_STATEMENT_TIMEOUT_MS` (60 s), `WORKER_LOCK_TIMEOUT_MS` (5 s), `WORKER_IDLE_IN_TRANSACTION_TIMEOUT_MS` (15 s) and `WORKER_POOL_IDLE_TIMEOUT_SECONDS` (30 s) are all set at connection time.

The metrics server listens on `WORKER_METRICS_PORT`, default 9100, and exposes `/metrics` and `/ready`. `/ready` is a real dependency probe (`SELECT 1`); when no probe is wired it fails closed with 503. Queue depth and oldest-pending age refresh every 5 seconds from `astella_queue_job_depth()` / `astella_queue_oldest_pending_age()`. The DSN comes from `DATABASE_URL_WORKER`, which is required — and throws when missing — under `NODE_ENV=production`.

The image `workers/ai-worker/Dockerfile` builds on `node:22.11.0-alpine3.20`; the prod stage bundles to `dist/index.cjs` with esbuild, runs as `USER node`, and `EXPOSE 9100`.

## Job type inventory

`HANDLERS` is the only type-to-implementation map. Anything else goes through `markUnknownJobFailed()` (`max_attempts=1`) and lands straight in `dead`.

| type | handler | dead finalizer | notes |
| --- | --- | --- | --- |
| `parse_source` | `runParseSource` | `markSourceParseFailed` | URL fetch plus text segmentation, no model call |
| `companion_agent` | `runCompanionDialogue` | — | the companion's single dialogue entry; payload carries only an opaque runId |
| `agent_run_advance` | `runAgentAdvance` | `markAgentAdvanceFailed` | an advance step for a continuing goal |
| `companion_memory_extract` | `runCompanionMemoryExtract` | — | per-turn memory extraction |
| `companion_summarizer` | `runCompanionSummarizer` | — | conversation summaries |
| `companion_memory_embedding_rebuild` | `runCompanionMemoryEmbeddingRebuild` | — | the heaviest one: 200 rows per batch |
| `companion_daily_summary` | `runCompanionDailySummary` | — | daily digest plus the first-person diary written in her persona |
| `companion_memory_organize` | `runCompanionMemoryOrganizeJob` | — | background semantic organization |
| `companion_thought` | `runCompanionThought` | — | candidate thought generation, phrasing and delivery |
| `note_overview_generate` | `runNoteOverviewGenerate` | — | note quick-look |
| `note_annotation_explain` | `runNoteAnnotationExplain` | — | annotation explanation |
| `note_dynamic_artifact_generate` | `runNoteDynamicArtifactGenerate` | — | dynamic teaching artifact |
| `note_expansion_generate` | `runNoteExpansionGenerate` | — | note expansion |

`DEAD_FINALIZERS` currently covers only `parse_source` and `agent_run_advance`. The generic job loop only knows the `jobs` table; what a failure means for the user is known only by the type itself. A collection failure has to move `sources.status` to `failed`, otherwise the list keeps saying "parsing" forever. Finalizer failures are logged only — the job is already terminal.

## The second queue: card-generation outbox

Alongside the main queue there is `card_generation_run_outbox_v2`, polled at the end of the same tick by `pollV2Outbox(1, V2_POLL_TICK_BUDGET_MS)` (`workers/ai-worker/src/card-generation-v2/outbox-queue.ts`). It is not part of the main queue, but it shares the scheduling loop.

| parameter | value |
| --- | --- |
| per-tick poll budget | `V2_POLL_TICK_BUDGET_MS = 5_000`; the poll returns past it while running jobs continue in the background |
| lease | `V2_OUTBOX_LEASE_TIMEOUT_MS = 30 * 60_000` (30 minutes) |
| renewal / loss detection | `V2_LEASE_RENEWAL_INTERVAL_MS`, default 120_000, must be smaller than the lease window |
| job wall-clock budget | `V2_PIPELINE_BUDGET_MS`, default 60 minutes; expiry aborts and terminates the job without retry |
| concurrency | `V2_OUTBOX_MAX_CONCURRENCY`, default 4 (independent of main-queue concurrency) |
| orphan reap | `V2_REAP_THROTTLE_MS = 30_000` |

Claiming uses `FOR UPDATE SKIP LOCKED` and writes `lease_token = gen_random_uuid()` inline; renewal and completion are both `WHERE ... lease_token = $token` CAS statements, and zero rows means another worker took the lease, so this attempt must stop committing results. The V2 poll runs **after** the main queue's claim and dispatch (round-5 audit W#5), but the early return taken when the main queue has no free slot still performs this poll.

## Model configuration: one file

The user-facing surface is a single file, `config/ai-platforms.json` (relocatable with `AI_PLATFORMS_CONFIG`). `packages/shared/src/platform-config.ts` describes the contract; `platform-config-node.ts` loads it.

- `platforms.<id>`: a name the user chose, plus the protocol `type`, `apiKey`, `baseUrl`, the `models` profiles, and `options` that now holds gateway quirks only.
- `capabilities.<cap>`: maps a capability to a `platform + model`. The capability enum in code is `text_generation`, `vision`, `agent_turn`, `companion_fallback`, `embedding`, `rerank`, `speech_recognition`, `image_generation`. The current file maps five of them: `agent_turn`, `text_generation`, `companion_fallback`, `vision`, `embedding`. An unmapped capability is unavailable and warns once per process.
- `tts`: an optional node, inside the contract (see [Voice](#voice-synthesis-in-the-api-segmentation-in-the-worker-recognition-on-the-desktop)).

`${ENV_VAR}` interpolation applies recursively to **every string** in the file. When a variable is unset the literal `${VAR}` text is kept and one warning is emitted at load. `resolveSystemPlatform()` returns `null` for a non-mock platform whose `apiKey` is empty or still contains `${` — the caller then decides between the mock fallback and failing closed, rather than sending a bogus key out and taking a 401. Precedence is config file > environment variable > built-in default (that is exactly the relationship between `tts.qwen.*` and `DASHSCOPE_TTS_WORKSPACE_ID`; for provider selection itself the config file is the only source, personal BYOK having been removed in v0.6).

**Declaration is the truth.** Context window, output ceiling, whether the model can read images, and reasoning levels are attributes of the **model**, written under `platforms.<id>.models.<model>`: `contextWindowTokens`, `maxOutputTokens`, `vision`, `reasoning.levels` / `reasoning.default`. The admin panel runs `validateConfig()` (`apps/api/src/modules/admin/config-service.ts`) before writing back, and a `capabilities` reference to an undeclared model is a **blocking** issue — guessing the window or output ceiling shows up as a mis-computed budget or an upstream 400, so it is better caught while editing. A `reasoning.default` outside that model's `levels` blocks too. When a hand-written file bypasses validation, undeclared models take provider defaults and warn once per (platform, model). The old platform-level `options.contextWindowTokens` / `enableThinking` / `reasoningEffort` keys have no readers left and are blocking.

```json
{
  "platforms": {
    "opencode-go": {
      "type": "opencode_go",
      "apiKey": "${OPENCODE_GO_API_KEY}",
      "baseUrl": "https://opencode.ai/zen/go/v1",
      "models": {
        "deepseek-v4.1-flash": {
          "contextWindowTokens": 1000000,
          "maxOutputTokens": 384000,
          "vision": true,
          "reasoning": {
            "levels": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
            "default": "high"
          }
        }
      }
    }
  },
  "capabilities": {
    "agent_turn": { "platform": "opencode-go", "model": "deepseek-v4.1-flash" }
  }
}
```

## Provider protocol registry

`type` decides the transport. Adding a platform instance means editing the config only; adding a protocol means implementing a provider class, registering it in `PROVIDER_METADATA` in `packages/shared/src/provider-registry.ts`, and calling `registerFactory()` from the worker's `providers/*.ts`.

| type | protocol shape | registered capabilities | notes |
| --- | --- | --- | --- |
| `mock` | fixed in-process fake text | text_generation, vision, agent_turn, embedding, rerank | exempt from the consent check; refused as a fallback in production when configured-provider mode is on |
| `openai_compatible` | `/chat/completions` | text_generation, vision, agent_turn, embedding | `options.disableMaxTokens` stops sending `max_tokens` |
| `dashscope` | compatible-mode preset | text_generation, vision, agent_turn, embedding | **a preset over `OpenAICompatibleProvider`**, not a separate implementation |
| `siliconflow` | `/v1` | embedding, rerank | embedding and rerank only; chat has to go through an `openai_compatible` platform on the same baseUrl |
| `opencode_go` | `/responses` (OpenAI Responses API) | agent_turn | see the traps below |

Three traps that keep biting:

1. **DashScope is a preset, not a protocol branch.** `providers/dashscope.ts` still constructs an `OpenAICompatibleProvider`, only adding `resolveEndpoint`, `maxTokensStrategy: "always"`, the `X-DashScope-WorkSpace` header and the `enable_thinking` preset; the baseUrl must end with `/compatible-mode/v1`.
2. **`opencode_go` speaks the Responses API.** The current DeepSeek dialogue slot also uses `/responses`. Models only available through chat/completions need a separate `openai_compatible` platform; do not infer protocol from model names. Every request also has to carry a stable `x-opencode-session`, and the client must self-identify with a user agent that is not a generic SDK name.
3. **The aliyuncs host guard.** `dashscope`'s `validateBaseUrl` accepts only `^dashscope(-[a-z0-9]+)?\.aliyuncs\.com$`; pointing the baseUrl somewhere else is a configuration error, not an allowed choice.

`createCapabilityProvider()` additionally checks the returned shape at the factory exit: declaring `vision` without implementing `analyzeImage()` becomes an explicit configuration error instead of a `TypeError` at call time.

## Thinking and reasoning levels

Hybrid thinking models on chat/completions only have on/off, while the Responses API has levels, so there are two distinct emission paths:

- `OpenAICompatibleProvider#thinkingField()`: profile `reasoning.default === "none"` or an explicit per-call `disableThinking` → `enable_thinking: false`; a declared `reasoning` → `enable_thinking: true`; nothing declared → the field is omitted and the gateway default applies.
- `OpenCodeGoProvider#reasoningField()`: when declared, sends `reasoning.effort = default`; when thinking is explicitly turned off it picks the level closest to "off" among that model's declared `levels`; nothing declared → the field is omitted.

There is no universal "lowest level". Measured: `muse-spark-*` rejects `none`, `gpt-5.6-luna` rejects `minimal`, deepseek accepts all levels — so levels must be declared per model or the upstream replies 400.

Two things on the long path:

- **Reasoning-handle replay order.** deepseek models in thinking mode require the previous turn's reasoning to be passed back verbatim, or the second step of the tool loop returns 400. The Responses provider re-inserts handles as input items in the order `reasoning → message → function_call`; putting the message first is rejected. The plaintext reasoning content is stripped on the provider side and only the opaque handle is kept. The cold-start path for "continue after the user confirms" persists handles in `companion_agent_tool_calls.reasoning_handles` (migration 0218); proposals awaiting confirmation created before 0218 have no handle and take a non-retryable 400 when resumed.
- **Empty-content retry.** With thinking on, some providers intermittently return an empty `content` (everything landed in `reasoning_content`). `openai-compatible.ts` re-sends the same request up to 3 times (`MAX_EMPTY_OUTPUT_ATTEMPTS`); the outer AbortSignal is unchanged, so timeout semantics do not move.

Long reasoning and multistage generation can exceed older short deadlines. Provider calls now default to 15 minutes and ordinary handlers to 30 minutes, with leases renewed during execution. Model profiles supply output limits and task contracts constrain content. A lease controls crash recovery, not total runtime.

> **Note for future changes**: the project has decided to keep thinking enabled across the whole companion chain, favouring quality. The levels, replay and retry machinery above exist so that running with thinking on works — not as a case for switching it off to gain speed.

## Vision routing

`resolveVisionReader()` (`workers/ai-worker/src/lib/governance.ts`) decides whose eyes this recognition uses, purely from declarations, with no runtime capability probe:

1. the current dialogue model's profile declares `vision: true` → the main model looks at it itself;
2. otherwise `capabilities.vision` is mapped and its profile is not explicitly `vision: false` → use the dedicated vision model;
3. neither → `null`. Then the `companion_read_image` tool is **neither offered nor executed** (`visionEnabled = policy.sendImageContent === true && resolveVisionReader(govCtx) !== null`), and an image is never handed to a model that cannot see.

`visionReaderAvailableFromConfig()` keeps the here-and-now wording about "this note has N images" on the same source as the tool surface, so the companion cannot be told she can't see while the read-image tool is still handed to her.

## Token measurement and context governance

> How the turn runtime spends this budget, compaction cooldown and receipts are in [Agent runtime](./agent-runtime.md); this section covers only the model-side measurement rules.

Measurement entry point: `packages/agent-core/src/context/measure-request.ts`. It measures **everything actually serialized and sent**: system, history, current input, tool schemas, tool call arguments and results, multimodal payloads. Measuring only the system prompt leads to the false conclusion "the system prompt is short, so we are fine".

Conservative ratios and floors: CJK counts 1 token per character, non-CJK 1 token per 3 characters; each image has floor `IMAGE_TOKEN_FLOOR = 1_500`; each opaque reasoning handle has floor `REASONING_HANDLE_TOKEN_FLOOR = 64`; per-message envelope 4 (`ITEM_ENVELOPE_TOKENS`), per-tool-schema envelope 8 (`TOOL_SCHEMA_ENVELOPE_TOKENS`). The estimation path carries an error margin of `max(256, 12% of the estimated volume)` (`heuristicTotal`), exact paths (provider count / tokenizer) carry none (`EXACT_ERROR_MARGIN = 0`). Counting capability falls back in the order `finish()` runs it at runtime: `providerCount → tokenizer → usage_anchor → heuristic`; payloads that cannot be measured go into `unmeasured` and unknown cost is never recorded as zero. The measurement vocabulary is versioned as `CONTEXT_MEASUREMENT_VERSION = "v1"`, so a change in how a provider serialises a request invalidates older usage anchors.

The budget line itself (`B_hard = max(0, min(C − O, I) − M)`, trigger 0.80 / target 0.60, `M = 2_048`, fallback window 128 000 and output reservation 16 384), its fixed decision order, the compaction cooldown and the companion's coverage-based folding are written out in full in the context-governance section of [Unified agent runtime (technical)](./agent-runtime.md). What belongs here is where the layer is attached: `createGovernedProvider` — the single boundary for every outbound model call — so it covers the first step, every tool turn, material refetch, background continuation, retries and fallback model switches, and it measures the full outgoing request **before** it is sent. Its job is only to decide and record honestly; it does not delete content.

> **Evidence scope:** plan 44 records database migrations, compaction commits and permission fences, real-model comparisons and selected windows. Review semantic continuity, concurrent recovery and long-term effects against [plan 44](../../plans/learning-companion/44-unified-context-window-and-compaction-2026-10-05.md) §8/§11; old “never run” claims are no longer a current-state summary.

## Web search and sources

`agent_web_search` serves both conversation and ongoing goals. `agent/web-search.ts` reuses the `bigmodel` credential for BigModel Web Search. Account `webSearchEnabled` defaults to false, and exposure/execution check opt-in, service availability and AI governance.

Each turn has at most 3 searches, returning bounded excerpts and HTTPS sources. URLs determine stable source identities and citation markers. Durable receipts restore sources on replay without searching again. Chat, journal and history share citation blocks; titles, URLs and dates stay in source lists/popovers and outside spoken text.

Exhausted quota starts a 30-minute credential cooldown in the current Worker. The turn can continue but cannot claim online verification. Cooldown is process-local, so restarts and other replicas do not share it; it is not global quota enforcement. See [search validation](../../testing/agent-web-search-2026-10-08.md).

## Governance and consent

Consent is **account-level**: migration 0237 removed `ai_consent_version` / `ai_data_policy` from `workspaces` and created `user_ai_settings` (`user_id` primary key, `consent_version`, `consent_at`, `data_policy jsonb`). The reasoning is in the migration comment — consent is about whether *my* content may leave, and hanging it on a workspace means someone else's consent decides where my data goes.

`readUserAiSettings()` **must** run inside `withWorkerWorkspaceTransaction`: the table has RLS enforced by `app.user_id`, and a bare query **silently returns 0 rows**, which reads as "this person never consented" instead of raising an error. With no signing row, `consentOk = false` and `getAccountAIPolicy()` falls back to the deny-by-default policy.

| field | default | source |
| --- | --- | --- |
| `sendToExternal` | `false` | `DEFAULT_AI_DATA_POLICY` in `packages/agent-host/src/ai-governance-policy.ts` |
| `sendImageContent` | `true` (a 2026-10-06 user decision) | same file; consent is still the first gate, this only decides whether the image path is also allowed once consent is signed |
| `piiDetection` | `true` | same file |
| `auditLogging` | `true` | same file |

The `mock` provider is exempt from the consent check (a development stand-in sends nothing out). With `AI_REQUIRE_CONFIGURED_PROVIDER=true`, an `agent_turn` platform that fails to resolve is no longer a degradable state but a configuration error: `AIProviderNotConfiguredError` is thrown (`code = ai_provider_not_configured`), which `isNonRetryableError()` recognises as its own class, and the job goes straight to `dead`. Retrying will not make a missing key appear, and mock would have stored fixed fake text as a reply or a memory.

On the worker side `ai_audit_log` has exactly one writer, `logAICall()`, called asynchronously by the governance wrapper after every real outbound call. **Metadata only**: provider, model, operation, `data_categories`, token counts, duration, status and a sanitised error message — never content. `data_categories` is declared by the call site, because only the initiator knows whether what left was the user's answer, note body or a quote. Writing that row also needs workspace and actor context, otherwise the two RESTRICTIVE tenant guards reject it.

## Card generation: domain package and worker chain

`packages/card-generation` owns **card generation itself**: the creation transaction (`createGenerationRunInTransaction`), source sealing (`sealEvidenceSnapshotsV2`), run events and error classes. It does not know Fastify, React or providers, does not read env, and does not open its own transaction — it receives the transaction executor from the caller. Review, activation, reminders and the execution of the simplified chain stayed where they were: not moved, not duplicated. The pure rules (filtering, hashing, the seal plan) exist once, in `packages/shared/src/card-generation-v2-pipeline/`. The worker's V3 simplified chain is the executing side.

Evidence sealing hard constraints (`evidence-seal-core.ts`): `evidenceSnapshotHash` comes from `computeEvidenceSnapshotHashV2` (domain `evidence-snapshot-v2`); the body text is wrapped in the immutable `protectedQuoteRef = evidence://snapshot/<snapshotId>` and does not embed a semantic support report that does not exist yet, avoiding a hash cycle; every table is workspace-scoped; **sealing completes before Author**, guaranteeing the source-only one-way closure.

The deterministic gates (`deterministic-gates.ts`) carry the non-negotiable half: every answer/rubric unit needs at least one legal Evidence Snapshot; the offsets and hashes an answer references must match the frozen source and `evidenceRefIds` may not leave the sealed manifest; a candidate with no evidence reference anywhere across objective and rubric raises `no_evidence_reference` at severity `hard` — no grounding means no `review_ready`. Semantic judgement belongs to the Critic, not to a regex.

On the review desk, data loading and actions live in `apps/desktop-client/src/renderer/src/components/surfaces/review/use-card-generation-data.ts` and `use-card-generation-session.ts`; writes remain authoritative and animation only decides what looks smooth. The chain counts its own model calls and writes them into the completion event `card_generation.simplified_completed` as `modelCalls`, so "the ordinary short-text success path is exactly 2" is readable from the database rather than asserted in a process. When stages 4/5 fail and the job is re-invested, the generation call does not happen again (re-investment is not re-payment). The switch is `CARD_GENERATION_V3_PROVIDER`: unset means the deterministic stand-in, `llm` means a real model billed per call; production refuses the deterministic stand-in behind a guard, and offline reproduction needs `V3_ALLOW_DETERMINISTIC_PROVIDERS=1`.

## ai-quality: the offline quality layer

`packages/ai-quality` holds versioned evaluation inputs, and each of the four parts has its own version — content may only change by bumping one: `DATASET_VERSION` and `LABEL_VERSION` are both `2026-07-19-v1`, `SCORER_VERSION = 1.1.0`, `PROMPT_VERSION = "generate-card.v3"`. The labelled card-generation V2 corpus is under `src/card-generation-v2/corpus/`, batched by micro / medium-long / multimodal / zero-card adversarial.

The PR tier runs only schema / parser / alignment / scorer plus fixed mocks, and **does not touch the paid network** (ADR-0005 item 2). To run it:

```bash
cd packages/ai-quality && npm run pr-gate    # JSON output, exit 0 on pass, 1 on fail
make verify                                  # already includes typecheck + test + pr-gate
```

`realAlignEvidence()` performs real-evidence alignment with trigram Jaccard similarity over a sliding window, and its comment states it is isomorphic to the worker's quote-alignment criteria — isomorphic so that the offline reading and the online one judge the same thing. The RC tier is threshold gates (`HARD_GATES_V2` and `CONTENT_QUALITY_GATES_V2` in `rc-gate.ts`, which must be bucketed by micro/long/zero/safety/modality/language so an overall average cannot hide micro-note regression); the semantic judge (`semantic-judge.ts`) emits frozen verdicts through a strict schema. The judge **cannot replace the grounding hard gate**: it is a level-2 pedagogical call, and whether the evidence genuinely exists is still said by the deterministic gates and the seal.

## Voice: synthesis in the API, segmentation in the worker, recognition on the desktop

**TTS is not in the worker.** Engine selection lives in `apps/api/src/modules/learning-sessions/voice-providers/tts-engine.ts`: `tts.engine === "qwen"` with a configured workspaceId → the DashScope WebSocket native protocol, strictly serialised per queue key `workspaceId:userId` (the order of a user's segments cannot shuffle), different users in parallel but bounded overall by `QWEN_TTS_MAX_CONCURRENCY` (default 4), with connection reuse for 60 idle seconds. A failed qwen task (`QwenTtsError` / network error) → logged, then automatically degraded to edge-tts.

Degradation has one exception: **a governance denial does not degrade.** `isGovernanceDenial()` singles out `AIConsentRequiredError` / `AIDataPolicyDeniedError` — an unsigned consent means this call should not happen, not that an upstream is down, and retrying will not make it should.

The budget arithmetic is 30 + 30 + 8: qwen's default `DEFAULT_TIMEOUT_MS = 30_000`, edge's default also 30_000, plus 8 seconds of orchestration slack, giving `TTS_TASK_DEADLINE_MS = 68_000`. Expression tags (the 23 control tags such as `[excited]`) are a qwen-audio exclusive: qwen passes them through, and the edge branch must run `stripVoiceExpressionTags` before synthesis or the tags get read aloud as words. The `emotion` field (driving the Live2D expression) is engine-independent and the worker always parses and emits it.

**The worker is the sole owner of sentence segmentation** (`workers/ai-worker/src/lib/tts-segments.ts`): it splits primarily on `。！？；\n .!?;`, caps a segment at `TTS_MAX_SEGMENT_CHARS = 160`, targets 48 characters for display segments (past that, with a comma-level pause inside the sentence, it cuts there), lets the first segment start once it holds 14 characters so audio keeps up with text, and allows at most 200 segments and 20 000 speakable characters per run. `segmentId = sha256(runId:ordinal:text)`, with `textSha256` stored alongside. The server also warms synthesis before pushing a segment event to the client (`companion-tts-warm.ts`: 120-second TTL, at most 64 entries, 3 in-flight per user).

**On the desktop it is local recognition, not cloud transcription.** The SenseVoice int8 model (`model.int8.onnx`, 239 MB, plus `tokens.txt`; both files' byte counts and sha256 are in the contract) is downloaded by the user from Settings and removable at any time. Recognition runs in an Electron `utilityProcess` (a Node child process) because the bundled sherpa-onnx is emscripten's Node build and needs `require`, while the window is `sandbox: true` with no `nodeIntegration`. Recording is still captured in the renderer, and the audio reaches the child process over a local IPC — it never leaves the machine. The engine starts lazily, returns its memory after 90 idle seconds, and caps a single decode at 120 seconds (the first one includes engine and model load).

## Where the companion lands in this pipeline

> Her product role, the four surfaces, the capability list and the growth loop live in [Companion experience](./companion-experience.md), the execution body in [Agent runtime](./agent-runtime.md); this section records only which handlers and tables back those behaviours.

| capability | worker side | data tables |
| --- | --- | --- |
| dialogue and tool loop | `companion-dialogue.ts`, `companion-agent-runtime.ts`, `companion-tool-execution.ts` | `companion_conversations` / `companion_messages` / `companion_turn_runs` / `companion_agent_steps` / `companion_agent_tool_calls` / `companion_stream_events` |
| memory extraction and maintenance | `companion-memory-extractor.ts`, `companion-memory-maintenance.ts`, `companion-memory-organize.ts` | `assistant_memory_items` plus `assistant_memory_item_revisions`, `assistant_memory_source_suppressions`, `assistant_memory_budget_events` |
| vectors and links | `companion-memory-vector.ts`, `companion-memory-embedding.ts`, `companion-memory-tools.ts` | `assistant_memory_embeddings`, `memory_links`, `memory_usage_log` |
| summaries and handoff | `companion-summarizer.ts`, `companion-context-handoff.ts`, `companion-summary-retrieval.ts` | `conversation_summaries`, `companion_context_handoff_snapshots` |
| daily digest and diary | `companion-daily-summary.ts`, `companion-diary-content.ts`, `companion-diary-candidates.ts`, `companion-diary-checkpoints.ts` | `companion_daily_summaries`, `companion_diary_generation_checkpoints` |
| persona | `companion-persona-self-edit.ts`, plus the dialogue side reading current and pending revisions | `companion_persona_profiles`, `companion_persona_profile_versions`, `pet_profiles` |
| thoughts and proactive delivery | `companion-thought.ts`, `companion-delivery-write.ts`, `companion-proposal-copy.ts` | `assistant_deliveries` (the only delivery channel), `companion_action_proposals`; `companion_proactive_deliveries` has a table definition and test references only, with no production writer |
| discovery book and long-term experience | the book is read and written on the API side, not in the worker; method experience is owned by `packages/agent-host/src/methods.ts` | `companion_discovery_entries`, `companion_procedural_playbooks`, `companion_method_revisions` / `companion_method_uses` |

The four self-edit tools (tone, personality tags, expression weight, boundaries) share `applyAssistantPersonaEdits()`: each change is booked through `fieldOrigin` as `assistant`, so switching persona later can tell which fields she wrote and must not be wiped by the preset; when the account never picked a persona the system default persona becomes the base for a new profile instead of answering "cannot change"; an unchanged value earns neither an "edited" receipt nor a version number; and `name` is not editable by her at the type level.

Proactive delivery goes through the inbox: `inboxSequence` on `assistant_deliveries` is max+1 inside the same per-user advisory lock, and the row and its `pg_notify` commit together. The client connects to `GET /companion/deliveries/inbox/stream` (`event=assistant.delivery`, `id=inboxSequence`) and resumes by `Last-Event-ID` after a drop — durable inbox semantics. When the worker writes a `system_event` display row it takes the same lock and the same notification rather than starting a second scheme.

Journeys and the discovery book are read and written on the API side: `apps/api/src/modules/companion-journey/routes.ts` and `apps/api/src/modules/companion-conversation/discovery/discovery-service.ts`, gated by `COMPANION_JOURNEY_V2` (`.env.example` defaults it to `true`, as it does `COMPANION_BRIDGE_V2`). A book entry freezes the source text as it read at collection time; later edits to the original do not touch it, and the user's own note is stored in a separate column.

## Probe and evaluation scripts

Every real-model probe needs an explicit switch, and CI never satisfies it, so nobody spends money by accident:

| script | switch | purpose |
| --- | --- | --- |
| `workers/ai-worker/scripts/companion-s1-behavior-probe.ts` / `-required-probe.ts` / `-fact-span-probe.ts` / `companion-persona-ab-eval.ts` / `experience-comparison-runner.ts` / `agent-42-real-path-probe.ts` | `REAL_MODEL_BATCH=1` | real-model behaviour, required probes, fact spans, persona A/B, experience comparison |
| `workers/ai-worker/scripts/card-generation-v3-live.ts` | `V3_LIVE=1` | one real-model run of the simplified chain |
| `scripts/companion-provider-health.mjs` | must run inside the worker container | one fixed prompt per model slot, to see whether it returns half a sentence today; reuses production's `looksTruncatedReply` |
| `scripts/companion-turn-e2e-verify.py` | `--rounds` | end to end: streaming batch counts and span, failure rate and cause, the shape of the stored body |
| `scripts/companion-quality-report.py` | `--compare <baseline.json>` | read-only corpus report plus before/after delta |
| `scripts/companion-gate-counterfactual.py` | read-only | counterfactual replay of the 11 output gates over the last 30 days of real traffic; the first piece of evidence for removing a gate |

`companion-provider-health.mjs` has to run inside the worker container: on the host `AI_PLATFORMS_CONFIG` points at a path the container cannot see, so resolution yields `provider=mock` plus "platform not configured", which measures nothing real. It prints no keys and no credentialed URLs — only provider name, model, latency and conclusion.

## Timeout ladder

Execution deadlines and crash recovery are separate. Defaults come from `packages/shared/src/ai-execution-budgets.ts`, `lib/handler-timeout-config.ts` and the card outbox; deployed overrides can differ.

| Layer | Default and constraint |
| --- | --- |
| Main queue lease | 120 seconds, renewed every 30 seconds while running; reaping uses the latest `lease_renewed_at` |
| Handler | Ordinary AI jobs 30 minutes, `parse_source` 60 seconds; resolved values cap at 24 hours |
| Provider call | Default 15 minutes, bounded by remaining handler time minus persistence margin |
| Companion/artifact loop | Derived from the handler, reserving 15 seconds for persistence |
| Multistage cards | `V2_PIPELINE_BUDGET_MS` defaults to 60 minutes; separate 30-minute outbox lease and renewal |

Handler priority: `WORKER_TIMEOUT_<TYPE>_MS` → `WORKER_MODEL_TIMEOUT_MS` → per-type default → global default. Provider priority: `WORKER_PROVIDER_TIMEOUT_<TYPE>_MS` → `WORKER_PROVIDER_TIMEOUT_MS` → 15-minute default, then constrained by available handler time. New overrides must be forwarded in Compose; a value in `.env` alone may not reach the process.

`lib/providers/model-output-budget.ts` resolves output limits. Normal generation uses the model profile's declared ceiling; a small visible-text allowance is not a reasoning-plus-output total. Context budgeting still reserves output capacity and task contracts limit structure/content. Cancellation, lease loss, bounded call counts and retries remain enforced. See [budget validation](../../testing/ai-execution-budgets-2026-10-08.md).

## Related volumes

- [Overview](overview.md)
- [Architecture](architecture.md)
- [Development](development.md)
- [Desktop client](desktop-client.md)
- [API and data](api-and-data.md)
- [Unified agent runtime (technical)](agent-runtime.md)
- [Companion experience (product design)](companion-experience.md)
- [Testing and quality](testing-and-quality.md)
- [Operations](operations.md)
- [FAQ and troubleshooting](faq-and-troubleshooting.md)
- [Plan index](../../plans/learning-companion/README.md) · [41a unified agent foundation](../../plans/learning-companion/41a-unified-agent-foundation-2026-09-28.md) · [42 unified agent system and companion growth](../../plans/learning-companion/42-unified-agent-and-companion-experience-2026-10-04.md) · [40 long-term companionship and diary](../../plans/learning-companion/40-companion-long-term-experience-and-diary-prd-2026-09-25.md) · [40b runtime and observability](../../plans/learning-companion/40b-companion-runtime-and-observability-2026-09-27.md) · [44 context governance and compaction](../../plans/learning-companion/44-unified-context-window-and-compaction-2026-10-05.md)
