# Desktop startup latency and complete speech — 2026-10-19

## Confirmed causes

The installed v1.8.25 app connects to the production API. Read-only production
diagnostics show a first user turn after startup taking 8.206 seconds from run
creation to its first `assistant.delta`; worker queue wait was under a second.
Its visible request was a short name. The model step began about six seconds
after run creation. These timestamps locate the delay before display; they do
not independently prove which internal routing branch ran.

The hybrid entry had a reproducible routing defect: any short statement after
an assistant question was treated as accepting a pending offer. A new greeting
or name therefore incurred a separate classifier before answer generation.
The corrected guard requires an acknowledgement, refusal, choice or reference;
other new messages go through the existing hybrid reply/task decision. Existing
acceptances and voice-setting requests retain their task path. This is a
routing optimization, not a change to available tools or execution permission.

Speech had a separate, explicit 200-character prefix budget. The production
recipe recommendation issued 11 short speech segments ending at character 203,
although its persisted answer continued. The worker silently omitted the rest.
The budget module, environment override and filtering are removed. Every
speakable segment is issued, including the final sentence. Existing segment
size and synthesis sanitization still bound each request.

## Verification

- The new greeting/name regression failed against the original routing guard
  and passes after the fix; acceptances, refusals and references still hand off.
- Worker hybrid entry, entry mode, dialogue, streaming, envelope and segmentation:
  **188 tests passed**. Worker `npm run typecheck` passed.
- An isolated disposable PostgreSQL database ran the actual handler with
  restricted API/worker roles. Both buffered and incremental long replies issued
  all display-aligned speech segments through their final sentence. The existing
  private-thinking separation case also passed: **3 integration tests passed**.
- Real configured MiMo requests for synthetic name/greeting inputs after a
  question delivered their first visible body at **2.635 s / 3.961 s**, with one
  model call and no reasoning tokens. These are small synthetic samples, not a
  production latency distribution or a guarantee.
- An isolated real Electron window, using the current build and local API/worker,
  submitted its first user message after startup through the normal composer.
  Run `2d7d782c-2c04-4456-988c-0eef29b21c7f` delivered its first server delta in
  **4.194 s**, used one hybrid call and no classifier. The reply appeared in the
  window. This is server event timing, not a frame-level UI measurement.
- In that window, a complete **344-character** story issued **14 segments**
  through character 344. Run `a21b508a-f2b3-48fa-b743-a4b870c125ae` returned
  `playback=ok / played` for all 14 segments, including the final “晚安。”
  The reply then retired normally. Playback receipts establish completion,
  not human listening quality.
- Desktop playback/queue regression: **43 tests passed**. Together with the
  worker and database cases, **234 tests passed**. `git diff --check` passed.

Diagnostics and test logs are in the ignored local directory
`outputs/startup-latency-2026-10-19/`. Production conversation bodies and
credentials are not added to Git.

## Delivery boundary

The repaired worker source is active in the local development service.
The production server and installed app have not been replaced by this task.
Both behavior changes live in the worker and require deploying it; no desktop
binary change is needed. Upstream model latency and genuinely ambiguous or
actionable requests can still take longer.
