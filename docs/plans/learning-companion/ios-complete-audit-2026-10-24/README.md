# Complete native iOS audit — 2026-10-24

**Approved implementation and simulator regression completed on 2026-10-24.** The audit below records the original baseline. All 105 findings and 21 proposals have an implementation record; 17 hardware/fault/performance checks retain explicit limits. See [implementation.md](implementation.md) and the [fresh integrated verification](../../../testing/ios-complete-audit-implementation-2026-10-24.md). Existing working-tree changes are preserved.

The audit covers the current native iOS implementation from authentication and startup through Conversation, Library, reading and note tools, learning cards, Orbit, diary, memory, account and workspace management. It follows the actual API, worker and shared-contract paths used by those screens, including the Web reader, operation artifacts, Cubism, notifications and Live Activity. Product and UI plans were context, not restrictions on the audit.

| Review set | Count | Read here |
| --- | ---: | --- |
| Implementation findings | **105**: 12 P1, 86 P2, 7 P3 | [Full findings and proposed corrections](findings.md) |
| Product and UI proposals | **21** | [Decisions for review](proposals-and-verification.md#product-and-ui-decisions) |
| Unconfirmed device/ordering/performance risks | **17** | [Remaining verification](proposals-and-verification.md#checks-that-must-not-be-presented-as-proven-failures) |
| Coverage, evidence and verification limits | — | [Page/state/motion coverage](coverage.md) |

The 105 findings have source/call-chain evidence. Some also have simulator interaction or semantic-probe evidence; the evidence type is stated per item. This is **not** a claim that 105 production incidents were reproduced or that every physical-device state passed.

## Highest-impact findings

| ID | What can go wrong |
| --- | --- |
| G01 | Conversation cache is not scoped to account/server/workspace and can show another account's messages on a failed inbox load. |
| A01 | Saving an unreachable service address logs out the user, with no service editor on login/recovery to repair it. |
| N01 | Authenticated uploaded images have no valid loading/authentication path inside the local-file Web reader. |
| N02 | In-note links do not navigate correctly; the internal link was inert in the running app. |
| N03 | Formula DOM text differs from the server's canonical anchor text, breaking selection/highlight coordinates. |
| N05 | Version Restore is offered but the server rejects mobile sessions; the confirmation also describes different version semantics. |
| N07 | Library import errors/preparation can occur with no initiating-page feedback or recovery. |
| N19 | Valid depth-3 mind-map nodes can occupy exactly the same position and hide one another. |
| N30 | Replacement passage selection has no equivalent keyboard/assistive action; focusable annotation marks lack keyboard activation. |
| L01 | Editing during submission can leave answers unsaveable after grading begins and block ordinary exit. |
| L02 | Questions/stars belonging to an older note version can be labelled with the current version. |
| Q01 | Auth Debug previews bypass the review-mode network guard and can send real auth/email requests. No such request was submitted. |

G10 was additionally reproduced during startup inspection: an obscured Records control remained accessible/activatable beneath the launch cover, and its navigation took effect before Skip.

## Motion assessment

The soft, rounded, anime character direction can remain. A spring's `response` is not treated as elapsed duration, and no arbitrary duration quota was applied. No frame-rate conclusion is drawn from still images.

Confirmed motion defects are transient Live2D expressions that never expire (M01) and attachment-panel displacement under system Reduce Motion (M02). Copy-feedback ownership is also interruptible incorrectly (G07). Question/filter motion frequency is a design decision (U18), while gesture scale handoff is a proven coordinate mismatch awaiting physical feel-check (N21). Outline app-Off behaviour remains a check (M03).

Useful motion opportunities are real recording-level/time feedback (U11), a coherent attachment handoff if it improves understanding (U12), and local loading/refresh transitions that retain usable content (G06/N26/A11). Additional decorative loops are not proposed as a universal fix.

## Confirmation and subsequent work

The user confirmed the entire collection and authorized implementation with parallel subagents on 2026-10-24. Entries keep their original IDs. The implementation record distinguishes completed code, verified behaviour and checks that still require physical hardware or deployment configuration.

Implementation followed the dependency order: account/scope and audit isolation → reader/permission contracts and learning integrity → asynchronous ownership and recovery → shared accessibility/loading → local product/layout/motion refinements. The 17 risks remain distinguishable from confirmed source defects; implemented hardening and simulator evidence do not replace their remaining physical or controlled-runtime checks.

## Evidence snapshot

128 first-party Swift/native/Web runtime files are inventoried with hashes in [source-manifest.json](source-manifest.json), plus the linked API/shared/worker call-chain files. The running app was an already-installed QA Debug app on an iOS 27 simulator; no fresh compilation was performed.

100 page/state Debug routes received an initial sweep. A second 127-case matrix was visually reviewed in contact sheets, with seven delayed reader/state rechecks and additional startup/dock interaction checks. Some early frames were intermediate; they are not presented as settled-state passes. Existing checks reported 10 JavaScript/native-motion tests and 54 tests in prebuilt native bundles passing. [Coverage](coverage.md) records the limitations and the exact commands.

Machine-readable entries: [register.json](register.json). The source snapshot and reports describe the working tree at audit time, not a clean release revision.
