# Approved iOS audit implementation — 2026-10-24

Status: approved source implementation and integrated simulator regression complete. All 105 findings and 21 proposals have an implementation record; the 17 named risk checks retain their explicit hardware, fault-injection or profiling limits. The user approved the entire set and explicitly requested parallel agents. The original audit remains the historical baseline.

## Execution ownership

| Owner | Scope | Record |
| --- | --- | --- |
| Root | Shared design/accessibility/loading, cache/session/sync boundaries, startup/shell, project integration and final build/window verification | This file |
| Notes agent | Library/reader/annotations/version/overview/map/expansion/learning and actual contracts | notes-implementation.md |
| Companion agent | Conversation/voice/media/records/model/notifications/drafts and actual contracts | companion-implementation.md |
| Account/Orbit agent | Auth/account/space/diary/memory and actual contracts | account-implementation.md |

Existing modified and untracked work was snapshotted before implementation: `/tmp/astella-ios-implementation-2026-10-24/baseline` (151 source files, pre-existing tracked diff and status). No reset, clean or source replacement from HEAD was performed.

## Baseline verification

`npm run typecheck` passed in shared, api, desktop-client and ai-worker at baseline and again after integration. The audit's prebuilt tests are historical; the results below come from fresh source compilation and the newly installed app.

## Shared implementation

- G01/C01/C02: versioned account/server/workspace envelope, full Codable rich messages and scoped asynchronous disk I/O. A failed refresh never overwrites retained history with an empty array; successful receipts and subsequent message changes schedule bounded cache writes.
- C17/C18: establish the run replay snapshot before reading messages, and refuse to start replay with a fabricated zero cursor after snapshot failure. Conversation initial-load/refresh/reconnect state is independent of note work (C22).
- G02/G03: stronger semantic secondary/error/success contrast, reusable Dynamic Type modifier for custom proportions and accessible-size segment reflow; every Debug route can use the large-type argument.
- G03: the Debug large-type argument also updates the temporary window's content-size trait, so presented learning/overview hosts receive the same category as the root. Learning options expose selection semantics. Model failure details remain independently accessible beside the character.
- G06: actual form, card, map and operation-shaped skeleton variants. Shared headings and controls reflow, with content-based detail header height (U17).
- G10/Q01: launch root hit testing and accessibility are blocked while covered; all auth previews enable the same API isolation as other fixtures.
- G09: launch resolves the same activated resource root as reader; manifest capability availability is explicit, origin/path/hash checks protect activation, cached fallback is origin-bound, expensive completeness work runs away from UI. Current backend's missing manifest capability is reported as unavailable rather than advertised as working.
- A01/A03 integration: logged-in recovery can mount the service editor; pending account routes survive shell reconstruction and are consumed once.
- U19/U20: authenticated shell readiness is independent of secondary note/history requests; notification permission is moved out of automatic account arrival into the contextual companion path.
- H13: filesystem measurement/removal no longer synchronously walks/deletes on the UI actor; actual large-cache latency remains a device verification item.

Other shared findings are implemented across the domain records: G04 touch targets, G05 accessible control names, G07 copy-feedback ownership, G08 selected-workspace semantics and U02 precise range selection. The [machine-readable register](register.json) maps each individual ID to its responsible record.

## Integrated acceptance

- Final incremental simulator build passed in **4.58 seconds**; the resulting app installed in **1.02 seconds** and launched in **0.61 seconds**. Earlier integration failures and their corrections are recorded in the runtime record. No clean or archive was used.
- Final Swift package run: **88 passed** — 41 record/cache, 30 protocol/integrity/notice, 5 geometry and 12 independently owned Journey checks. The Journey checks establish compatibility with the concurrent feature; that feature is not attributed to this audit.
- All four package typechecks passed. Native motion/reader/annotation/source-registration checks passed **11/11**; canonical reader checks **26/26**; operation checks **6/6**. Isolated API/Postgres suites passed **8** note-permission, **10** run/cursor/history and **31** account/Orbit checks.
- The installed app received **127** page/state/appearance captures and **49** delayed rechecks, plus hands-on checks of startup isolation, internal note navigation, complete-record navigation, drawer reversal, answer retention at ordinary/large type, model recovery details and auth fixture isolation. Early frames remain identified as intermediate evidence. Capture success is not equated with successful backend operation or physical-device acceptance.
- Every issue/proposal has an implementation mapping, and every risk retains a verification mapping. The original finding text and source snapshot remain intact.

The [runtime record](../../../testing/ios-complete-audit-implementation-2026-10-24.md) and its [evidence index](../../../testing/assets/ios-complete-audit-implementation-2026-10-24/README.md) carry the commands, capture receipts and practical limits. No physical iPhone is connected; the 17 original checks are not marked universally passed.

## Integration corrections

All 105 source findings and 21 approved proposals now have source implementations or the explicitly approved honest-capability alternative. The three domain records provide individual IDs and exact call-chain changes: [notes](notes-implementation.md), [companion](companion-implementation.md), [account/Orbit](account-implementation.md). The 17 original checks retain their device, fault-injection or profiling limits. [The runtime record](../../../testing/ios-complete-audit-implementation-2026-10-24.md) owns integrated app acceptance.

Peer review found and corrected additional interleavings in the integrated batch:

- Old-space drafts are snapshotted before the token boundary and then removed from live state before restoring the next scope.
- Conversation resync stops the previous socket and establishes its replay floor only after the owned message snapshot succeeds. Ordinary record/mini-chat refreshes coalesce while resync is in flight; Hand refreshes actionable tool state after resync completes. A cancelled/old socket cannot consume a buffered frame after its receive await.
- Cache writes and Clear share one storage actor and epoch. Late encoded conversation/note writes from the old epoch are rejected, and writes pause while clearing. A fresh Swift test covers the actual disk interleaving.
- Versioned note recommendations open the recommended saved content, carrying title/run identity; opening the current note is explicit. Artifact destinations keep their complete note/version/task/artifact identity.
- Auth preview isolation now also blocks absolute image transport, and auth failure copy identifies the local preview rather than suggesting a network repair.
- Small accent text uses light cobalt `#285FE8`: contrast is 5.395:1 on white, 5.077:1 on canvas and 4.856:1 on sky. Dark filled controls use `accentLabel` (8.193:1 on dark accent). Primary pressed feedback preserves label/fill contrast; scale remains the tactile cue.

Additional window corrections keep short companion bubbles at their measured intrinsic height, place model failure details in an independent accessible action, and preserve large-type option selection when advancing and returning. The pressed primary action retains its semantic contrast, while scale supplies tactile feedback. The operation Web runtime and its native host use the same stronger accent.

The concurrent user-owned chat **“设计 iOS 联想词与新手指引”** implements Plan 59. Its Journey, private address, dialect and four-surface suggestion feature work is preserved and is not attributed to this audit. Integration registered new sources and adapted shared voice/context boundaries. The user explicitly authorized coordination messages to avoid simultaneous Device Hub input; the window has been released to that chat. Build logs can be separated through `ASTELLA_IOS_LOG_DIR` without discarding incremental caches.
