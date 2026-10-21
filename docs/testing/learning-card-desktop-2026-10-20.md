# Desktop learning-card implementation — 2026-10-20

> **Follow-up, 2026-10-21:** The [Plans 57/58 audit](plan-57-58-audit-2026-10-21.md) adds real model generation/grading, all-question-type fixtures, summary-only recovery, version selection, exact-source return and zoom-layout fixes. It removes legacy contracts/readers and records remaining acceptance limits. The verification boundaries below describe the original revision.

## Scope and decisions

The user approved direct project implementation and requested newly drawn backgrounds. This supersedes the earlier demo-only approval gate and the inline presentation in Plan 57. The implementation keeps a note-owned, versioned card; it does not recreate a global card library or a review queue.

The desktop card entry now navigates to an independent `note-card` room destination with its own `LearningCardSurface`, room background and paper. The normal directory and page-title plaque remain, the return-to-note action sits inside the paper at its upper left, and the existing companion sits at bottom right. It does not mount `NotebookDesk`, its reading/overview/recall tabs, or its source-bag toolbar. The card front shows actual question counts and types, completed practice count, recent attempts, best score and best stars. A missing card offers working 4/6/8-question settings and a generation state driven by the existing job status. No invented generation percentage, difficulty control or focus option is shown.

Answering is a separate full-window state with one question, a persistent jump sheet, previous/next controls, explicit skips and saved drafts. References, correctness, scoring feedback and companion conversation are withheld during answering. Leaving saves the unfinished attempt without grading. Submission explicitly confirms remaining unfinished questions as skips; every question stays in the equal-weight denominator.

Completion opens a finite reward with a score medal, laurel, sequential earned stars, paper bursts and the registered Live2D celebration motion and expression. The companion settles after the reward; controls remain available throughout. The report contains correct/partial/wrong/skipped filters, submitted answers, grading points, frozen note passages, labeled extension sources and the actual attempt summary. The full summary has a dedicated reading layout.

## Production call chain

- The notebook entry calls `openNoteLearningCard`, which navigates through `resolveRoomIntent("open-note-card")` to `TaskSurface` → `LearningCardSurface`. It preserves the note identity, mode, workspace scope and parent return target. The notebook unmounts; returning remounts the same note and restores its stored reading position. The old embedded panel wrapper is deleted.
- The independent surface reads the selected note through the actual note bridge, then mounts the card controller. Only practice/grading/celebration/report scenes portal beside the companion inside the access gate's room stacking context. The underlying main content becomes inert/hidden while a separate scene is open. Only answering/grading additionally hide and inert the room controls, portaled directory and notifications. Celebration/report retain the live directory, upper-right room-control island, page-title plaque and internal return action; their content reserves space for that chrome and follows its collapsed/expanded left gutter. The companion is hidden during practice/grading and uses its normal component during celebration/report. No second Live2D instance is rendered.
- `use-learning-card.ts` uses the actual `window.astella.noteLearningCard` bridge. It restores in-progress answers from attempt history, serializes debounced saves, retains failed drafts, flushes before exit/submission, and polls generation/grading without overlapping requests.
- The selected question count travels through shared IPC, main-process validation, the note gateway, the API job payload and worker generation. Worker validation requires the requested count.
- Attempt history now includes answer receipts and frozen grounding. Reference answers, rubrics, scores and feedback remain hidden until the attempt is completed. Completion locks the attempt, requires all answer receipts and avoids duplicate grading jobs.
- Explicit skips carry `{ skipped: true, draft? }`. The renderer preserves the draft when skipping and allows the learner to adopt it again. Shared and worker grading assign skips zero without semantic grading. A boolean `false` remains a valid judgment answer.
- Best score/stars and completed practice count are aggregated across all completed attempts for the version, independently of the recent-history limit. A zero-star completed attempt still lights the card.
- Matching questions retain the generated right-side labels and the grader accepts the renderer's `pairs` envelope.
- Operation questions use the existing isolated artifact host with a `note_learning_card` origin and the note-card artifact endpoint. The trusted template restores bounded controls/steps from the actual parent; it never accepts a client-reported score. Frame recreation restores the latest saved draft.
- Practice and grading temporarily use the existing companion focus gate and stop ongoing speech. The prior participation preference is restored afterward.

Implementation lives under `apps/desktop-client/src/renderer/src/components/surfaces/notebook/learning/card/`. The old inline card controls and their obsolete CSS were removed. Unrelated workspace changes were preserved.

## Original artwork

Three new 1672 × 941 PNG backgrounds were generated with the built-in `image_gen` tool and copied into `apps/desktop-client/src/renderer/public/assets/learning-card/`:

| Asset | Use |
| --- | --- |
| `sunroom-v1.png` | Card front and practice records |
| `atelier-v1.png` | Generation settings and waiting |
| `focus-room-v1.png` | Answering, grading, reward and report |

The palette follows the notebook's cream paper, mint binding, green ink/actions, honey wood and peach secondary controls. The application uses these new assets rather than the earlier demo backgrounds. Exact final prompts and file mapping are retained in [generation-prompts.json](../../apps/desktop-client/src/renderer/public/assets/learning-card/generation-prompts.json); see the [asset usage record](../../apps/desktop-client/src/renderer/public/assets/learning-card/README.md).

## Automated verification

All four relevant packages passed `npm run typecheck` both before implementation and after the cross-package changes: `packages/shared`, `apps/api`, `apps/desktop-client` and `workers/ai-worker`. The desktop check uses both its node and web tsconfigs.

The initial cross-package implementation passed 81 focused tests (before the layout correction below):

| Package | Result | Coverage |
| --- | --- | --- |
| Desktop | 47 tests / 7 files | Complete renderer flow, draft resume/save failure, skip recovery, generation count, retry polling, version changes, result formatting, finite reward/companion lifecycle, motion Off, artifact host trust/restore, main artifact IPC/store and component-size guard |
| API | 9 tests | Actual service decisions with transaction fixtures, answer visibility, idempotent completion, explicit receipt completeness, all-history best score/count, source and directory guards |
| Shared | 25 tests | Card contracts, generation payloads, quality, grading/skip semantics, matching envelopes, trusted operation templates and bounded restore |

Reproduction commands, run from the named package:

```sh
# apps/desktop-client
npx vitest run src/renderer/src/components/surfaces/notebook/learning/card/__tests__ src/renderer/src/components/surfaces/__tests__/artifact-frame-host.test.tsx src/main/__tests__/desktop-ipc-artifact.test.ts src/main/__tests__/artifact-store.test.ts src/main/__tests__/component-size-guard.test.ts
npm run typecheck
npm run build

# apps/api
node --import tsx --test src/modules/note-learning-cards/__tests__/attempt-flow.test.ts src/__tests__/note-learning-card-source-guard.test.ts src/__tests__/directory-fanout-ratchet.test.ts

# packages/shared
node --import tsx --test src/__tests__/note-learning-card-contracts.test.ts src/__tests__/note-learning-card-grading.test.ts src/__tests__/note-learning-card-operation.test.ts src/__tests__/note-learning-card-quality.test.ts src/__tests__/job-payload-contracts.test.ts
```

The desktop production build passes, including main, preload, renderer and room-layer validation. This is focused verification; a full repository regression and a live PostgreSQL/worker grading run were not performed for this visual change.

## Independent-page correction and final verification

The user's latest correction rejects embedding the card in the notebook. This revision adds a real room destination and component, removes the embedded panel and notebook-only CSS overrides, and keeps card ownership/versioning unchanged. The card page uses a sunroom background; generation uses the atelier. Practice, grading, reward and report use the clear study-room illustration with no blur or translucent fog layer.

Practice now uses one continuous board, including the question, jump sheet and navigation footer; the title and save/exit actions are compact. The report is one continuous paper with attached score statistics, filters, answer rows and summary. Reward stars start unlit and light at 650 ms plus 280 ms per earned star; replay cancels and restarts the finite effect. Off and system reduced motion immediately show the final stars. The shared companion presentation store drives the existing character's celebration cue/expression/hearts. Keeping the immersive layer in the access gate's stacking context fixes a real-window issue where the report covered the companion despite its local z-index. Portaled directory and notification UI are hidden/inert during practice/grading. The user then clarified that celebration/report need normal chrome; those scenes now retain the directory and upper-right room-control island, and the paper moves below the page header with a left navigation gutter. A regression test checks that those controls remain available through report ↔ celebration transitions. The floating return-to-note pill is removed on this destination; front/setup/loading states place their return inside the paper, while report and reward use an internal return-to-card action. The physical card’s decorative top stripe is removed. A shared left-gutter variable follows the normal directory state at desktop and compact breakpoints. Portaled report/reward papers register as the current directory-motion content, so the existing interruptible FLIP moves the visible paper rather than the hidden underlying page.

Attempt history sorts by completion time, so an older resumed attempt completed later is actually the most recent. The worker's deterministic summary wording now counts all questions rather than calling a skipped-subjective attempt entirely objective.

Final desktop verification: `npm run typecheck`, **106 tests across 15 files**, and `npm run build` pass. The focused tests cover the independent destination and return target, stale workspace callbacks, the actual note/card/generation bridge from the new surface, the existing answering/save/skip flow, focus-scene portal isolation/restoration and live result/celebration chrome (including the real gate wrapper and portaled rail), history ordering, staggered stars, replay disposal, Off/reduced motion, HUD policy, scene-camera registry, navigation/transition behavior, directory collapse/expand and visible portal-paper selection, and the component-size guard. The worker type check also passes. Existing bundler warnings about externalized Node modules, dynamic imports and chunk sizes remain; the build and room-layer validation finish successfully.

```sh
# apps/desktop-client
npm run typecheck
npx vitest run src/renderer/src/components/surfaces/notebook/learning/card/__tests__ src/renderer/src/components/hud/__tests__/hud-pages.test.ts src/renderer/src/components/hud/__tests__/hud-page-destinations.test.ts src/renderer/src/app/__tests__/room-machine.test.ts src/renderer/src/app/__tests__/room-store.test.ts src/renderer/src/scene/__tests__/scene-camera.test.ts src/renderer/src/components/__tests__/task-surface-transition-deadline.test.tsx src/renderer/src/components/__tests__/directory-rail.test.tsx src/renderer/src/components/__tests__/directory-rail-spring.test.ts src/renderer/src/components/surfaces/notebook/__tests__/notebook-fullscreen.test.tsx src/main/__tests__/component-size-guard.test.ts
npm run build
```

## Native window checks and evidence limits

The actual project client is running with the actual main/preload/gateway and signed-in account. The earlier unsupported-contract response recorded during the initial implementation no longer blocks note/card access. Current screenshots and interaction checks use real account notes, cards and stored attempts, rather than the earlier isolated fixture. No credential or contract gate was changed for this correction.

Native checks covered opening the note's independent card page; absence of notebook tabs/tools; the normal directory, upper-right room-control island and right companion on the card and completed-work pages; resuming an existing practice; direct question jumps and rapid keyboard reversal; the separate answer board without references; real completed-attempt reports; correct/partial/wrong/skipped counts; filtering, answer/reference expansion and the stored summary; celebration replay and the normal companion's registered celebration; two standard zoom-in steps and reset; card/report/reward leftward movement on directory collapse, restoration on expansion and consecutive direction reversals. Reward/report controls stay available while motion runs. Generation settings/waiting and save/skip failure paths also have focused automated coverage. This revision did not submit an extra attempt or generate a new card solely to obtain screenshots.

The test client remains open for review. It uses a temporary, separately identified clone of the installed official Electron runtime so native automation can distinguish it from another application that shares Electron's original bundle identifier. It runs the actual project and normal profile, not an alternate renderer entry. No release/deployment is included. Full repository regression, animation frame-rate profiling, a newly generated operation-question run and a forced live subjective-model grading run were not performed in this layout revision.

| Current evidence | View |
| --- | --- |
| [01-standalone-card.png](assets/learning-card-2026-10-20-layout/01-standalone-card.png) | Independent page, physical card, history, normal directory and companion |
| [03-celebration.png](assets/learning-card-2026-10-20-layout/03-celebration.png) | Settled reward, earned stars, collapsed directory gutter, room island and normal bottom-right companion |
| [04-report.png](assets/learning-card-2026-10-20-layout/04-report.png) | Continuous report with answer comparison and original passage |
| [05-summary.png](assets/learning-card-2026-10-20-layout/05-summary.png) | Stored attempt summary on the report paper |
| [06-card-collapsed.png](assets/learning-card-2026-10-20-layout/06-card-collapsed.png) | Card paper shifted left after collapsing the directory |
| [07-report-collapsed.png](assets/learning-card-2026-10-20-layout/07-report-collapsed.png) | Report paper shifted left after consecutive collapse/expand actions |

Earlier screenshots under `assets/learning-card-2026-10-20/` describe the superseded design and isolated initial verification. They are historical evidence, not the current page specification. Screenshots do not establish animation frame rate or live model execution.
