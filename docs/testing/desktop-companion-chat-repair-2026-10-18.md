# Desktop companion chat repair — 2026-10-18

Local Electron development client, API and worker; Asia/Shanghai. The existing mobile changes were outside this repair.

## Observations and fixes

The real conversation contained a story request answered only with an introduction at 22:44, followed by a 22:45 answer ending at “晚上躺在床上发誓：”. Both abbreviated messages were already persisted as successful fast-path replies. Their original provider output was not captured, so the specific cause of those two generations cannot be established retrospectively.

The audit reproduced and repaired four deterministic faults:

1. **Completion followed by a failed history read discarded the reply.** `claimCompanionReply` treated a missing read result as an intentional silent completion and cleared the draft. It now retains the draft and waits on fallback polling. Only an explicit silent completion can settle immediately without a message.
2. **A late history snapshot erased a newer answer.** Concurrent history refreshes updated the same message list in response-arrival order. Successful reads now carry an ordering token, preventing an older request from overwriting a newer committed snapshot.
3. **Stop could leave a send promise pending during fallback recovery.** After the initial stream race had settled, the recovery branch awaited only the poll promise; cancelling that poll did not resolve the send. Both recovery branches now keep racing against the explicit stop signal.
4. **A malformed reply envelope could become a successful shortened answer.** The incremental decoder stopped at an unescaped quotation mark and returned its prefix without validating the complete provider result. Completion now requires valid JSON whose selected body exactly matches the decoded text. Invalid or unfinished envelopes cannot be committed as successful prefixes. Already delivered text follows the existing interrupted-output path; this does not reconstruct malformed missing text.

The fast-entry instruction also explicitly requires completing requested stories and explanations in the current answer. It disallows substituting an introduction for the requested content or leaving the unfinished answer for proactive follow-up. This improves generation guidance; it is not a deterministic guarantee of model completeness.

Relevant code:

- `apps/desktop-client/src/renderer/src/app/companion-session/companion-chat-session.tsx`
- `workers/ai-worker/src/handlers/agent/companion-agent-streaming-step.ts`
- `workers/ai-worker/src/handlers/turn/companion-dialogue-envelope.ts`
- `workers/ai-worker/src/handlers/turn/companion-hybrid-entry.ts`

## Verification

- Initial worker baseline: 34 tests passed.
- Added regression fixtures reproduced the lost completion, stale history overwrite, malformed quotation and unfinished-envelope failures before their fixes.
- Final desktop chat, polling, voice playback and component guard run: **138 tests passed** across 12 files.
- Worker dialogue, runtime, hybrid entry, envelope, output repair and streaming handoff regression: **235 tests passed**.
- Actual package `npm run typecheck`: desktop-client and ai-worker passed. Shared contracts and API source were unchanged.
- `git diff --check` passed for the repair files.

Diagnostic logs are in the ignored local working directory `outputs/chat-repair-2026-10-18/`; the regression cases themselves are tracked alongside the existing tests.

## Native application checks

The running development process had exited during initial inspection and left a blank Electron window. Restarting the development client restored the window. This was an environment recovery, not a confirmed application crash fix.

Using the real app controls and configured MiMo provider:

| Check | Evidence |
| --- | --- |
| Complete story with quoted dialogue | A fox-and-turtle story reached its ending in both the app history and persisted message. |
| Repeat the original multi-story request | Three complete stories appeared in the history. |
| Two new stories after the worker changes | Run `2ece8153-8ae8-41ee-b8c3-2f54e3d0504c` succeeded, with both story endings and quoted dialogue visible; 364 characters persisted. |
| Stop a longer streaming story | Run `47a55b34-5ece-491a-b46c-756e57222438` remained cancelled. The app retained the partial story and marked the stopping point. |
| Send immediately after stopping | Run `89177935-e2fa-435d-83cc-3ff382d155d2` succeeded with “晚安，好梦。” The cancelled story did not replace it. |
| Cached story audio | The real history control entered playing state, then returned to stopped when pressed again. This verifies control behavior, not human listening quality. |

Test prompts were submitted in the existing local conversation. Original user messages and earlier incomplete answers were preserved. The repaired source is active in the local development client; no packaged release was produced.

Long-running conversation reliability, comprehensive model answer quality, microphone input and human audio listening remain outside this verification. The existing background V2 outbox warnings refer to a missing legacy table and were not changed by this chat repair.
