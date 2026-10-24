# Complete iOS audit implementation verification — 2026-10-24

Status: approved source implementation and integrated simulator regression complete. All 105 findings and 21 product/UI proposals have implementation records. The 17 original hardware/fault/performance checks remain explicitly limited rather than universally passed. The user approved the whole set and requested parallel agents. The [original audit](../plans/learning-companion/ios-complete-audit-2026-10-24/README.md) remains the historical baseline; [per-ID implementation records](../plans/learning-companion/ios-complete-audit-2026-10-24/implementation.md) and `register.json` describe the resulting source.

## Environment and ownership

Repository base: `6882d049`, with substantial existing modified/untracked work. Before implementation, 151 relevant source files and the pre-existing status/diff were copied to `/tmp/astella-ios-implementation-2026-10-24/baseline`. Unrelated changes were preserved; no reset, clean, archive or IPA export was used.

The integrated app uses Xcode 27 and the iOS 27 iPhone 17 simulator **Astella Me QA 2026-10-23**, UDID `5394F283-BD13-4C34-A541-529FA5980DEF`. There is no connected physical iPhone. Another user-owned chat, **“设计 iOS 联想词与新手指引”**, owns Plan 59 feature work and uses its separate Journey QA simulator. Its code is retained; it is not counted as an audit implementation deliverable. Device Hub input is coordinated because both simulators share native window/menu control.

## Fresh automated verification

| Check | Observed result |
| --- | --- |
| `npm run typecheck` in shared, API, desktop-client and ai-worker | All four passed at baseline, the integrated checkpoint and final regression. Desktop uses the actual node/web project commands. |
| `swift test --scratch-path .build/audit-implementation` in `apps/mobile-client/ios` | 88 passed: 41 record/cache, 30 protocol/integrity/notice, 5 graph geometry and 12 independently owned Journey checks. Swift Testing counts are used, rather than the empty XCTest compatibility summaries. |
| Native motion, reader interaction, annotation ranges and actual Xcode source registration | 11/11 passed using `node --test`. |
| Canonical reader/projection/page tests | 26/26 passed, including bundled KaTeX/canonical selection parity, readonly rejection, metadata preserving DOM/scroll, and serializer safety. |
| Shared operation template tests | 6/6 passed, including chosen repair sequence, undo/reset, exact readonly replay and reenabling. |
| Isolated note permission integration | 8/8 passed: real mobile owner/member credentials, owner saved-version restore, forbidden freeform body writes, conflict and unchanged version count. |
| Isolated conversation/process integration | 4 run-window plus 6 cursor/history checks passed. Older user-only/recoverable runs and resolved tool status are covered. |
| Isolated account/Orbit HTTP/Postgres | 31/31 passed, covering actual memory state/filter/pagination, sparse diary neighbours, member/invite pagination and co-owner transfer. |
| API directory fanout and component-size guards | 4/4 passed; new files remain in the structural scan. |
| `python3 scripts/sync-reader-runtime.py --check` | Bundled point-wave runtime current. |
| `git diff --check` | Passed after removing new whitespace errors. |

The isolated DB is `astella_ios_audit_notes_20261024`, fully migrated with restricted API/worker roles and separate fixture admin. Unique fixtures were cleaned by each suite. Connection secrets are not included in this record.

## Build and integration evidence

`ASTELLA_IOS_LOG_DIR=/tmp/astella-ios-audit-implementation python3 scripts/ios-dev.py build` uses the existing incremental DerivedData and passed. The routing integration build completed in 26.44 seconds; later targeted window corrections also passed. The final build completed in **4.58 seconds**, followed by install in **1.02 seconds** and `open me` in **0.61 seconds** on the audit simulator. `open` installs only when the built product changes. [Operation timings](assets/ios-complete-audit-implementation-2026-10-24/build-timings.json) retain successful and failed attempts, while the full temporary logs stay under that log directory.

Failed development attempts were repaired before acceptance: new Journey files needed actual target registration; a Journey helper referenced the old voice location; one heterogeneous ternary needed explicit branches; the new account draft helper needed main-actor isolation. A concurrent feature's opaque SwiftUI body changed during compilation and initially failed linking; the subsequent incremental rebuild passed. No source replacement or clean was used to hide those failures.

The bundled Cubism Core simulator library retains a deployment-version warning (built for iOS simulator 26.2, application deployment target 18). This host verifies iOS 27 only. App Store signing, minimum-version hardware and native GPU fault recovery are not certified by a simulator link.

## Window and interaction evidence

The first fresh installed Library window rendered the normal shelf, resume card, search, content cards and native dock coherently. The installed audit build then received **127 page/state/appearance captures**, followed by **49 delayed rechecks** of early frames, reader surfaces and large-type hosts. All launch and screenshot commands returned zero, and all 16 contact sheets were visually inspected. Two delayed captures still matched the low-ink blank heuristic: `read-loading` and `diary-loading`; inspection confirmed that both show their intended skeletons. The first annotation capture was still intermediate, while the later same-family capture settled to normal content. Intermediate frames are retained as such and are not claimed as settled-state passes.

The [evidence index](assets/ios-complete-audit-implementation-2026-10-24/README.md) links contact sheets, normalized capture receipts, standalone interaction images and nominal palette calculations. Debug fixtures establish layout, local state and navigation evidence; real service permissions/queries are established separately by the isolated HTTP/Postgres checks above. This matrix does not prove every possible combination of network, device, content and lifecycle state.

After the final small operation-color correction, its six focused checks were rerun and the app was rebuilt/reinstalled successfully. The final install uses the same source fixes observed in the interaction checks.

## Explicit capability and hardware boundaries

- Resource updates: the current API has no manifest endpoint. About reports that capability honestly and uses bundled/verified fallback. Reader and launch consumers share the activated root; origin/path/hash activation is guarded. A deployed remote-update service is not claimed.
- Notifications: the contextual offer/settings explain the local-process delivery limit. Guaranteed APNs delivery after suspension/termination is not implemented or advertised.
- Historical diary references: the stored revision is checked; an overwritten revision is unavailable rather than replaced by current content. No nonexistent historical archive is claimed.
- H01–H16 and M03 retain their exact per-ID scope. Real microphone permission/capture/ASR races, VoiceOver focus/rotor, physical gestures, ActivityKit, native render fault injection, large-cache/export/photo waits and Instruments memory/frame-time evidence need the corresponding hardware or controlled runtime. Host graph/DOM timing and simulator screenshots do not establish device FPS.

### Hands-on checks observed

- **G10:** Under the launch cover, Device Hub accessibility exposed only Skip and the loading status from the app. No Records or underlying navigation control was present. Activating Skip revealed the unchanged Companion selection.
- **N02:** Tapping the formerly inert blue internal link opened “无标题笔记”, version 1, with the fixture’s explicit target content. The native Back action returned through the reader chain. Evidence: `internal-note-link.png`.
- **C14:** Conversation rich fixture → Library → floating mini chat → saved version → Full record selected Conversation/Records, displayed the correct original user turn/result, and dismissed the floating layers. Evidence: `full-record-destination.png`.
- **M02/H06:** With app motion disabled, opened and reversed the attachment drawer three times. Its actions remained available, the drawer closed coherently and the native dock returned. No frame-rate claim is inferred.
- **H11/L01:** Selected B in question 1, advanced to question 2 and returned. Question 1’s stem was at the top and B remained selected with 1/6 answered. Repeated at actual accessibility large type, including scrolling, and confirmed B's selected accessibility trait. This short fixture does not certify deep long-question or keyboard/focus performance. Evidence: `learning-answer-return.png` and `learning-large-return.png`.
- **H04/G03/C24:** The large-type stage exposed an over-expanded short bubble and an oversized model status over the character. The bubble now measures intrinsic content before applying its height cap; large model status is a separate details action. Recovery is independent of the character tap, and the accessibility tree now contains both buttons. Activating Details exposes the full reason and Reload at large type. Evidence: `model-status-large.png`.
- **G03 preview validity:** Presented learning/overview hosts were retaining the system type size while the root preview was enlarged. The explicit Debug argument now also sets the temporary window’s content-size trait, so root and modal QA use the same category. This does not change the user’s system setting.
- **Q01:** Entered synthetic `audit@example.invalid` in the auth email preview and activated Send code. The app explicitly reported that no code was sent and local-preview network operations were disabled; source transport isolation was also inspected. No real email request was submitted. Evidence: `auth-preview-isolation.png`.
- **A01:** Returned to login and opened the service connection editor before authentication. The real editor was reachable; no server-address mutation was needed for this navigation check. Evidence: `service-before-login.png`.

Nominal opaque semantic text/fill pairs were recalculated in both appearances: **52 pairs**, minimum **4.7769:1**. The operation Web accent now matches the native `#285FE8`. This calculation does not certify every translucent, disabled or composited pixel state; actual content was also inspected in the appearance/large-type matrix.
