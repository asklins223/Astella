# Integrated iOS audit implementation evidence — 2026-10-24

This evidence belongs to the [fresh implementation verification](../../ios-complete-audit-implementation-2026-10-24.md), not the original audit's installed-app snapshot. It uses the iOS 27 iPhone 17 simulator **Astella Me QA 2026-10-23**. No physical-phone, microphone, APNs or frame-rate result is inferred from a screenshot.

## Page/state captures

[Initial matrix](capture-matrix.json): 127 launches/captures, with 12 cells per contact sheet, ordered left to right then top to bottom. Each label retains the original matrix index, route and appearance/motion variant. The first pass waited approximately 2.5 seconds after launch, so some cells are deliberately recorded as early/intermediate evidence.

[00](contact-00.jpg) · [01](contact-01.jpg) · [02](contact-02.jpg) · [03](contact-03.jpg) · [04](contact-04.jpg) · [05](contact-05.jpg) · [06](contact-06.jpg) · [07](contact-07.jpg) · [08](contact-08.jpg) · [09](contact-09.jpg) · [10](contact-10.jpg)

[Delayed rechecks](delayed-rechecks.json): 49 launches/captures, waiting at least five seconds and retrying low-ink candidates. The matrix retains the observed wait, original index and contact-sheet cell. All launch/capture exit codes were zero. The two remaining heuristic candidates, 57 `read-loading` and 77 `diary-loading`, show valid skeletons. Annotation index 86 is still an intermediate frame; later same-family index 122 contains settled content. These frames were inspected, not silently counted as settled passes.

[00](recheck-00.jpg) · [01](recheck-01.jpg) · [02](recheck-02.jpg) · [03](recheck-03.jpg) · [04](recheck-04.jpg)

The original full-resolution sweep PNGs remain in `/tmp/astella-ios-audit-implementation/captures/`; this folder retains compact contact sheets and the individual images below. Receipts include original basenames and hashes without promising that temporary full-resolution files are permanent repository artifacts.

## Hands-on interaction images

| Evidence | What was observed |
| --- | --- |
| [Launch cover](launch-boundary.png) | Cover rendered; separately observed accessibility tree exposed only cover controls, and Skip restored the unchanged tab. The still alone cannot prove hit-testing isolation. |
| [Internal note link](internal-note-link.png) | Reader link opened the correct target “无标题笔记”, version 1. |
| [Complete record destination](full-record-destination.png) | Saved result from Library mini chat opened the correct original conversation record and dismissed floating layers. |
| [Answer return](learning-answer-return.png) | Q1 → Q2 → Q1 retained B and returned the stem to the top. |
| [Answer return, large type](learning-large-return.png) | Same sequence after real Debug window trait scaling; selection was also exposed in accessibility. |
| [Model status, large type](model-status-large.png) | Independent details action exposed the full failure reason and Reload without making the character action inaccessible. |
| [Auth preview isolation](auth-preview-isolation.png) | Synthetic email Send code was blocked locally with explicit no-network copy. |
| [Service editor before login](service-before-login.png) | Login could open service connection editing without authentication. |

## Machine-readable receipts

- [Verification summary](verification-summary.json): final source/build/test totals and remaining scope.
- [Build timings](build-timings.json): actual incremental build/install/launch operations, including failed development attempts.
- [Semantic contrast](semantic-contrast.json): 52 nominal opaque pairs in both themes; minimum 4.7769:1. This does not measure every composited state.

The source register retains all 143 original IDs: 105 findings, 21 proposals and 17 explicitly limited checks. The separately owned Plan 59 Journey/suggestion feature is preserved in the installed app and is not attributed to this audit.
