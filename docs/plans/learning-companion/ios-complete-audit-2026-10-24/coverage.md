# Coverage and verification record — 2026-10-24

## Basis and boundaries

- Repository base: `6882d049`, with substantial pre-existing uncommitted work. The inspected state is the current working tree. This audit writes only its new report directory.
- Application: native iOS SwiftUI/UIKit, local WKWebView reader and operation host, Cubism/Metal companion, local notifications and Live Activity/widget. Android and desktop UI are outside this audit; API/shared/worker code is followed where iOS calls it.
- Runtime: already-installed `com.astella.mobile` Debug app, device `5394F283-BD13-4C34-A541-529FA5980DEF`, “Astella Me QA 2026-10-23”, iOS 27 simulator, inspected in Xcode Device Hub. Bundle/source timestamps were compared, but this is not a newly compiled/reproducible release build.
- Source inventory: 128 first-party runtime files, 37,944 lines: 107 Swift, 6 Objective-C++, 7 headers, 1 C++ header, 4 JavaScript, 2 HTML and 1 CSS. [Manifest and SHA-256 hashes](source-manifest.json) exclude vendored code and generated artwork payloads. Linked API/shared/worker files extend this call-chain scope.
- No production signup, email-code send, login, password reset/change, real content write/delete/restore, role transfer, invitation, upload, or permission grant was submitted. In particular, auth preview isolation is broken (Q01), so those fixtures were observed without submission.
- Existing visual direction was assessed on its intended soft/anime terms. Standard system grouped-card styling was not imposed as a blanket requirement. Current plans did not prevent product/interaction criticism authorized by the user.

## Evidence notation

**S** = source and actual caller/callee/contract inspection; **F** = Debug-fixture visual inspection; **I** = hands-on simulator interaction; **P** = read-only semantic probe or existing automated check. A fixture image demonstrates a rendered state, not production authorization, persistence, network failure or physical gesture correctness. “Pending” means no pass is claimed.

## Page and state matrix

| Page family / surfaces included | Normal and empty | Loading / intermediate / failure | Read-only / role / history | Interaction and remaining limits |
| --- | --- | --- | --- | --- |
| Authentication: password login, registration identity/password/code, forgot/code/new password, email-code login | S/F across all nine route stages | S: validation, busy, cooldown, expired/wrong code, server failure; no real submit | S: consent document access and route-local secret ownership | No real auth request. Compact/large-text instruction loss reviewed in source; no fresh real-device OTP autofill test. A16–A19/A26/A29/Q01. |
| Session recovery, startup artwork, Skip, four-tab shell, dock/orb routing, navigation bridge | S/F/I; startup and dock extra checks | S: restore/loading/error/fallback; F: held startup cover | S: session/account/workspace reset, notification entry | I reproduced hidden accessibility activation under launch cover (G10). Physical swipe interruption, iOS 18 fallback and cold-device frame time pending. |
| Companion landing and speaking bubble | S/F; both landing fixtures | S: delivery/thinking/listening/stopped/model failure; F speaking state | S: full-reply destination and bubble-to-record boundary | I tab/profile/navigation. TTS/ASR timing, real lip sync, long multi-block replies and accessibility focus timeout pending. C24–C26/M01/U06/H02/H04/H05. |
| Conversation records, rich inputs, process, proposals, saved results | S/F; plain/rich/material/result fixtures | S/F: awaiting decision, expired, executing, failed, background, result-reconciliation problems; S initial sync/offline/retry | S/F: historical results/proposals; S user/assistant/run ownership | I reproduced saved-result “full record” returning to mini chat (C14). Existing projection/protocol tests pass; real WS disconnect/replay/failure injection remains unperformed. |
| Full reply/input reader, image gallery/Quick Look, proposal detail, generation list/notice | S; input thumbnails and result cards F; result preview I | S: media/auth failure, per-step detail, loading, receipt/conflict states | S: exact-version/read-only process and input scope | Gallery/Quick Look physical zoom, enormous files, notice restoration after termination pending. Not every nested modal received a fixture screenshot. |
| Composer, + menu, note/file/photo/camera selection, voice recording/transcription/playback | S; composer and selected rewrite F/I | S: preparation/upload/consent/record/ASR/cancel/failure/retry | S: input references and auto page context | No camera/mic permission, recording, real upload or send. S identifies overwrite/disabled Finish/missing recovery; actual permission/eviction/device checks pending. C03–C10/C21/C23/U04/U07/U10–U13/H01/H06. |
| Library, search/paging, continuation, rename/delete/undo | S/F/I: loaded, empty, renamed, deleted | S/F: skeleton, offline error; S search out-of-order/failure, pagination and optimistic receipt | S: owner/member capabilities and version identity | I tab/mini-chat entry. Real import/export/delete not submitted. Search identity/import/status issues N06/N07/N09/N29; export scale H09. |
| Materials/processing status, import/export entry, document extraction | S | S: progress, cancellation, extraction/AI/server errors | S: capability and truthful locality/counts | Source audit; no initiating-file selection/transmission. N06/N07/N29/U04/H09. |
| WK reader: body, title, font settings, paging, internal/external links, images, math, code/tables/lists | S/F/I/P, normal and dark; 15-second recheck resolved early loading frames | S/F skeleton; S network/page/WK/renderer errors and retry | S: immutable version, cached first page, note-owned annotations | I scroll, font-size changes and inert internal-link tap. P canonical grammar/KaTeX divergence. Real authenticated images/large-doc memory/keyboard and VoiceOver operation pending. N01–N04/N08/N14/N18/N30/H07/H10. |
| Reader outline, jump, source location, local work wave, selection/rewrite | S/F: normal/empty/jump/working/rewrite | S: page-load racing and coordinate invalidation | S: range locking and version-aware jump ownership | Extended F verifies outline and jump destination; I reading position on font changes. Pointer long-press attempts did not establish reliable precise selection; physical selection/side-swipe pending. N11/N17/U02/M03/H16. |
| Annotation editor, explanation answer, multiple annotations, delete/edit/locate | S/F: marks and ready explanation; S remaining drawer choices | S: generation, global busy, errors, revision conflicts, delete receipt | S: own annotation permissions, old-version filtering | Source-verified deletion fallback/location/pagination issues. No real annotation mutation; source-to-reader return and accessible selection require later end-to-end checks. N10–N15/G04/G05. |
| Version history and restore | S/F: timeline/selection | S: loading/error/conflict/restore receipt | S: mobile forbidden and owner/member boundary; historical page limit | No real restore. N05/N13/N16 are source/contract/probe findings; fixture restore does not prove production permission. |
| Overview, mind map, expansion, generation progress/authorization | S/F: primer, generated overview/map, selected expansion/saved draft | S/F: generating; S initial empty flash, failed regeneration, consent recovery and selection races | S: source versions, partial confirmation and last good result | Legal deep-tree overlap and fit/pinch mismatch derived from code. Physical pan/pinch/performance pending; no real generation/accept write. N19–N28/N31/H08. |
| Learning card front/setup/generating/practice/question picker/grading/result/history | S/F: front, practice, generating, scored/zero-star results | S: save/submit/grade/retry/close races, scene interruption | S/F: completed result; S all question templates and operation artifact read-only contract | F dark+large practice shows fixed question sizing; S version/count/regeneration/order issues. No real attempt writes or grading. Question scroll and operation device inspection pending. L01–L06/H11. |
| Orbit diary/month calendar/timeline/capture/Hand | S/F: diary/memory/Hand groups; S actual empty filters | S: month/load/refresh/failure/date boundary/active-work states | S: failed/hidden/deleted diary, active/pending/terminal tasks | S/F: calendar/paging/header hierarchy; no real diary write/hide/delete. I related note/result routing; true sparse-neighbour and refresh races source-confirmed. A09–A14/A25/U15/U21. |
| Diary detail, adjacent-day navigation, menus, image lightbox | S/F detail and loading | S: failed day/failed hide-delete/image error/neighbour read failure | S: source references and non-generated-day actions | Physical image zoom needs improvement proposal U16; real actions not submitted. A12–A14. |
| Memory list/groups/filters/detail/correction/history/recycle | S/F: active, candidate, pinned, archived, disputed, superseded, conflict, long, missing, dismissed, goal | S/F: skeleton/error; S refresh/correction/recycle conflict | S/F state distinctions; S actual API pins/dismissal/epistemic state/history | Fixture actions mask several production mismatches. No real adoption/pin/correct/recycle/delete. A04–A09/A11/A15/A16/A28; scale H14. |
| Me/profile/avatar/password | S/F/I normal, dark, long text and supported large text | S: save/prepare/error/logout; I profile open/back | S: account/server boundary and callback lifetime | No credential change. iCloud/large-avatar/latest-selection check H15 and delayed old callbacks H12 remain open. |
| Companion center/name-expression/conventions | S/F: loaded/empty conventions | S/F: loading/error; S dirty navigation/revision conflict/save/reset | S: disabled conventions and settings/personal scope | F normal/dark/large where fixture supports it. No real save/reset. Shared skeleton/font issues G03/G06 and dirty-draft proposal U08. |
| Appearance/startup/motion/reading size/device permissions/AI-data authorization | S/F; I reading-size adjustments | S/F AI settings loading/error/consent-required; S OS permission/status/AI save-failure | S: per-account authorization, local preferences, policy restrictions | No permission grant or real AI-consent mutation. System Reduce Motion not toggled as a full runtime matrix; app reduced-motion fixtures do not prove that separate mode. |
| Cache/about/app-resource updates/public documents/server editor | S/F; service/editor normal fixture | S: cache measurement/removal errors, update checks/activation/network failures | S: docs from authenticated settings and missing public-auth access | No cache clear, update activation or real endpoint change. Unwired assets G09, service lockout A01, responsiveness H13. |
| Workspace create/join/switch/rename/leave/dissolve, invites/receipt/revoke/roster/remove/transfer | S/F: personal, collaborative owner/member, receipt, roster, dissolve confirmation | S: busy/failed/conflict/stale success/draft loss/pagination | S/F personal/member restrictions; S real server co-owner/transfer capabilities | No real workspace or permission mutation. Fixture differences recorded; real reset path is inspected, not inferred from fixture success. A02/A03/A20–A24/A27/G07/G08/U14. |
| Notifications, background execution, Live Activity and widget | S; native protocol tests P | S: limited background task, payload/ownership, completion/end/logout | S: lock-screen content and account/run identity | Not exercised on a physical lock screen, terminated process, or push service. C19/C20/U09 and delivery guarantee decision remain material. |

## Visual capture record

The initial sweep covers **100 distinct Debug route names** with about 2.1 seconds before capture. It includes transition/loading frames and is not a set of settled-state passes. [Initial launch/capture receipts](evidence/initial-sweep.json).

The second matrix contains **127 combinations**: those 100 routes with `--ui-reduce-motion`, 15 routes with dark/large/long-content/reduced flags, and 12 default rechecks. All 127 launch and screenshot commands succeeded. The images were reviewed in the contact sheets below. A successful capture is not equivalent to feature acceptance. `--ui-large-type` is honoured only by the route families listed in `RootView.recordReviewTypeSize`; reader/Orbit/other routes with that argument must not be described as a complete Dynamic Type run.

Seven readers/states were subsequently recaptured after 15 seconds: `read`, `note-working`, `note-annotations-multiple`, `note-explain-ready`, `note-outline`, `note-outline-jump`, `me-bottom`. These clarified several earlier intermediate images. The outline fixture intentionally waits for a visible-section receipt, and the jump fixture waits before jumping. No app-performance duration is inferred from the automation's elapsed time. `me-bottom` rendered the same compact account root rather than demonstrating a distinct long scrolled state.

Additional startup and dock fixtures were inspected. Startup exposed G10 through an actual hidden-control accessibility activation. Dock screenshots establish the outward/return destinations and stable endpoints only; the Debug route deliberately slows its own transition and supplies no production timing/FPS evidence. [Capture arguments and receipts](evidence/capture-matrix.json).

| Set | Contact sheets |
| --- | --- |
| Auth / account / spaces / conversation / library / Orbit / reader / learning, reduced-motion capture | [Part 1](evidence/contact-off-00.jpg) · [Part 2](evidence/contact-off-01.jpg) · [Part 3](evidence/contact-off-02.jpg) · [Part 4](evidence/contact-off-03.jpg) · [Part 5](evidence/contact-off-04.jpg) · [Part 6](evidence/contact-off-05.jpg) · [Part 7](evidence/contact-off-06.jpg) · [Part 8](evidence/contact-off-07.jpg) · [Part 9](evidence/contact-off-08.jpg) · [Part 10](evidence/contact-off-09.jpg) |
| Dark plus supported large-type and long-content flags | [Part 1](evidence/contact-dark-large-00.jpg) · [Part 2](evidence/contact-dark-large-01.jpg) |
| Default checks | [Part 1](evidence/contact-default-00.jpg) · [Part 2](evidence/contact-default-01.jpg) |
| Extended reader/outline/work/explanation rechecks | [Rechecks](evidence/contact-recheck.jpg) |
| Debug dock outward/return states | [Dock](evidence/contact-dock.jpg) |

### Interaction evidence

- **N02**: on a settled reader, scroll to the visible blue internal note link, tap it, observe no navigation or feedback. Source inspection confirms the active WK coordinator/reader does not route note-link activation. The old native block renderer is not the active positive control.
- **C14**: `records-rich` → Library → companion orb → saved-result card → “查看这次完整记录”. The sheet closes to the same mini chat over Library, without selecting/locating full records. [Observed destination](evidence/full-record-returns-to-mini-chat.png).
- **G10**: launch `launch-preview`; while startup artwork covers the app, its accessibility tree also exposes Companion/Records/composer controls. Activate the hidden Records control: its selected state changes with the cover still visible. Activate Skip: Records is now visible. [Cover while hidden action has taken effect](evidence/launch-hidden-record-control-activated.png) · [Destination after Skip](evidence/launch-skipped-to-hidden-records.png). This demonstrates accessibility activation; ordinary touch-through was not separately established.
- Profile entry/back and reader scrolling/font-size adjustments were exercised through the real app controls. Reading continued after size changes; an unconditional position-loss-on-size-change finding was rejected.
- Simulator edge/content drag attempts did not produce a reliable positive control even for a reader with the gesture bridge. They are recorded as inconclusive (H16), not as a reproduced universal swipe-back failure.
- Native CUA did not expose WK text consistently. That alone was not used to claim a general VoiceOver reading failure. N30 is based on the actual disabled native-selection and missing equivalent-action/key-handler implementation.

## Automated checks and semantic probes

| Check actually run | Observed result | Limit |
| --- | --- | --- |
| `node --test apps/mobile-client/scripts/__tests__/annotation-ranges.test.cjs apps/mobile-client/scripts/__tests__/companion-motion.test.cjs apps/mobile-client/scripts/__tests__/note-reader-interaction.test.cjs` | **10 passed** | Existing focused checks; the motion check compiles a temporary C++ probe, not the app. They do not validate every API or accessibility state. |
| `xcrun xctest apps/mobile-client/ios/.build/out/Products/Debug/CompanionProtocolTests.xctest` | **28 passed** | Already-built bundle, not freshly compiled against this audit snapshot. |
| `xcrun xctest apps/mobile-client/ios/.build/out/Products/Debug/CompanionRecordsTests.xctest` | **26 passed** | Already-built bundle; no live backend/network ordering proof. |
| Read-only bundled reader in jsdom with actual KaTeX | Formula `方程 $x^2=1$ 的解。` becomes DOM text `方程 x2=1x^2=1x2=1 的解。`; valid list content becomes a paragraph; highlight/subscript/superscript stay literal | Establishes rendered/canonical projection mismatch (N03/N04), not a production annotation write receipt. |
| Read-only Foundation `ISO8601DateFormatter` probe | `2026-10-23T12:34:56Z` accepted; `2026-10-23T12:34:56.123Z` rejected by default formatter | Supports N16 against the API's fractional timestamps. |
| WCAG relative-luminance calculation for source tokens | Muted text: 3.26:1 on canvas / 3.47:1 on white; white on dark accent: 2.12:1; dark ink on dark accent: 7.77:1 | G02 concerns actual small-text pairs. This is not a full accessibility certification or a claim that disabled text uses the same threshold. |

No fresh app build, package typecheck, broad API regression, new tests, formatter, install or commit was run. This was an audit without source changes; existing focused tests and semantic probes were used for evidence. No test pass overrides a demonstrated caller/callee mismatch.

## Motion review across the stack

| Mechanism | Inspected behaviour | Finding / limit |
| --- | --- | --- |
| Button/toggle/segment/glass tokens and shell | Press scale, lens/selection, focus and tab ownership, reduced-motion branches | No blanket spring-duration defect. G04 targets interaction size; U18 challenges high-frequency whole-content movement. iOS 18 fallback unexercised. |
| Authentication transitions | Step direction/fade, focus and code timer ownership, compact layout | A26 cooldown identity and A29 information loss; real keyboard/autofill interruption pending. |
| Startup WebGL artwork | Readiness/target registration, rendering callbacks, visibility/scene activity, disposal/error/fallback and Skip | G09 active asset root disconnected, U19 readiness coupling, G10 hidden root controls. No GPU/FPS measurement. |
| Skeletons, typing dots and progress scenes | Content shape, retained content, active/reduced gates, cancellation/return | G06 shape mismatch, C22 global loading, A11 refresh replacement, N31 false initial empty. Existing animation loops generally have activity/reduced gates. |
| Companion native model | Event-expression priority/lifetime, motion queue/preload, slots, delta cap and scene foreground ownership | M01 persistent event face; C24–C26 renderer/model recovery; H02/H05 device measurements. No claimed real lip-sync failure. |
| Conversation panels and material transfer | Menu/dock/excerpt/playback transitions, attachment effect origin, interruption ownership | M02 attachment rise under system reduction; G07 timer race; U12 handoff intent; H06 retained drawer ownership. |
| Reader/WK selection and work wave | Native/Web motion preference bridge, current-section reporting, source jump, selection and hydration | N17 latest-jump race; M03 local preference remains inconclusive; N03/N04 coordinate parity; H07/H10 scale/overflow pending. |
| Mind map | Pan/pinch/live/end scale, Fit, tree bounds and node reflow | N19–N22 functional/geometry issues. H08 actual frame-time profiling pending. |
| Learning scenes and completion | Forward/back scene/question transition, answer focus, completion/star/reduced paths, read-only operation renderer | U18 frequency design choice; L01 handoff race; L05/L06 operation replay/appearance. Rapid physical question/keyboard/focus path pending. |
| Orbit calendar/filter/list and image inspection | Group/filter transitions, starfield foreground/reduced gates, detail back/paging, image lightbox | A09–A13 ownership/state issues; U16 image inspection; H14/H16 performance/swipe checks. |

Correct or intentionally retained paths include shared scoped note-document caching; request generation/token checks on most note/account loads; range locking for active note work; idempotent unconfirmed-turn request identity; reusable successful upload receipts; best-score statistics across all completed attempts; zero-star completion lighting; owner-scoped annotation APIs; retained eager history layout for scroll stability; and explicit active/reduced gates in skeleton/Orbit/Live2D/launch loops. They were not turned into speculative defects to increase the count.

## Remaining acceptance boundary

Physical-device touch/gesture reversal, system Reduce Motion on/off, app Off during an active transition, VoiceOver and hardware keyboard through all destinations, iOS 18 fallback, actual camera/microphone prompts, real ASR/TTS/background/lock-screen/termination delivery, large mixed-media performance, network ordering/failure injection, and real read/write permission receipts are **not certified** by this audit. The 17 named verification items collect the concrete risks; the matrix also records routine acceptance still required after approved fixes.

Apple references used to check the platform reasoning: [HIG accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility), [custom fonts](https://developer.apple.com/documentation/swiftui/applying-custom-fonts-to-text), [ScaledMetric](https://developer.apple.com/documentation/SwiftUI/ScaledMetric), and [inactive scene phase](https://developer.apple.com/documentation/SwiftUI/ScenePhase/inactive). These inform readable typography, reachable controls and temporary-alert handling; they do not override the user's visual direction.

## Full second-pass route/variant receipts

The following rows enumerate capture requests, not independent pages or passed interactions. Extended rechecks and hands-on results above take precedence over an early intermediate frame.

| Route | Variants captured | Extended or manual evidence |
| --- | --- | --- |
| `auth-login` | off, default | — |
| `auth-register` | off | — |
| `auth-register-password` | off | — |
| `auth-register-code` | off | — |
| `auth-forgot` | off | — |
| `auth-reset` | off | — |
| `auth-reset-password` | off | — |
| `auth-email-login` | off | — |
| `auth-email-login-code` | off | — |
| `profile` | off, dark-large, default | manual entry/back |
| `companion-center` | off | — |
| `companion-settings` | off | — |
| `companion-settings-loading` | off | — |
| `companion-settings-error` | off | — |
| `reading-settings` | off | — |
| `device-permissions` | off | — |
| `ai-authorization` | off | — |
| `ai-authorization-required` | off | — |
| `ai-authorization-loading` | off | — |
| `ai-authorization-error` | off | — |
| `conventions` | off, dark-large | — |
| `conventions-loading` | off | — |
| `conventions-error` | off | — |
| `conventions-empty` | off | — |
| `server-address` | off | — |
| `settings` | off, dark-large | — |
| `change-password` | off | — |
| `cache-management` | off | — |
| `about` | off | — |
| `workspace-management` | off | — |
| `workspace-management-dissolve` | off | — |
| `invite-management` | off, dark-large | — |
| `invite-management-member` | off | — |
| `invite-management-personal` | off | — |
| `invite-management-members` | off | — |
| `invite-management-receipt` | off | — |
| `conversation` | off | — |
| `conversation-speaking` | off, dark-large | — |
| `records` | off | — |
| `records-plain` | off | — |
| `records-inputs` | off | — |
| `records-rich` | off, dark-large | mini-chat/result navigation reproduction |
| `records-confirmation` | off | — |
| `records-proposal-expired` | off | — |
| `records-proposal-executing` | off | — |
| `records-proposal-failed` | off | — |
| `records-background` | off | — |
| `records-problems` | off | — |
| `library` | off, dark-large | — |
| `library-loading` | off | — |
| `library-empty` | off | — |
| `library-error` | off | — |
| `library-rename` | off | — |
| `library-rename-done` | off | — |
| `library-delete` | off | — |
| `library-deleted` | off | — |
| `read` | off, dark-large, default | 15 s recheck + manual scroll/font/link |
| `read-loading` | off | — |
| `orbit` | off, dark-large, default | — |
| `orbit-memory` | off | — |
| `orbit-tasks` | off | — |
| `orbit-memory-detail` | off | — |
| `orbit-memory-detail-candidate` | off | — |
| `orbit-memory-detail-pinned` | off | — |
| `orbit-memory-detail-archived` | off | — |
| `orbit-memory-detail-disputed` | off | — |
| `orbit-memory-detail-superseded` | off | — |
| `orbit-memory-detail-conflict` | off | — |
| `orbit-memory-detail-long` | off, dark-large | — |
| `orbit-memory-detail-missing` | off | — |
| `orbit-memory-detail-dismissed` | off | — |
| `orbit-memory-detail-loading` | off | — |
| `orbit-memory-detail-error` | off | — |
| `orbit-memory-detail-goal` | off | — |
| `me` | off, dark-large, default | — |
| `me-bottom` | off | 15 s recheck; no distinct bottom state demonstrated |
| `diary` | off | — |
| `diary-loading` | off | — |
| `note-overview-generating` | off | — |
| `note-mind-map-generating` | off | — |
| `note-expansion-generating` | off | — |
| `note-working` | off | 15 s recheck |
| `note-rewrite` | off | — |
| `note-overview` | off | — |
| `note-overview-ready` | off, dark-large, default | — |
| `note-mind-map` | off, dark-large, default | — |
| `note-annotations` | off, default | — |
| `note-annotations-multiple` | off | 15 s recheck |
| `note-explain-ready` | off | 15 s recheck |
| `note-versions` | off, default | — |
| `note-outline` | off | 15 s recheck |
| `note-outline-empty` | off | — |
| `note-outline-jump` | off | 15 s recheck |
| `note-expansion` | off | — |
| `note-expansion-saved` | off | — |
| `note-learning-card` | off, default | — |
| `note-learning-practice` | off, dark-large, default | — |
| `note-learning-generating` | off | — |
| `note-learning-result` | off, dark-large, default | — |
| `note-learning-result-zero` | off | — |
| `launch-preview` | additional default | hidden accessibility activation + Skip |
| `dock-switch` | additional default | five outward/return state captures; Debug timing only |
