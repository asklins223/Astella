# Project Collaboration Guidelines

## Maintain this file sparingly

Leave `AGENTS.md` alone for routine fixes. Update it only when a durable, repository-wide instruction is necessary for future work or the user explicitly requests an edit. Fold changes into existing guidance where possible. Keep feature decisions in the documents that own them and record task-specific findings with the work.

## Work from the current project

Use English for project communication and documentation unless the user requests another language. Follow the user's latest decisions and trace the actual call chain. Use the code, tests and application to establish current behavior. Preserve unrelated workspace changes.

- [Product and permissions](PRODUCT.md) and [desktop design](DESIGN.md)
- [User and developer guide](docs/guide/README.md), [active plans](docs/plans/learning-companion/README.md) and [Release Center](docs/plans/app-release-center-2026-10-24.md)
- [Native iOS and Android clients](https://github.com/asklins223/astella-mobile)

Keep current guidance, recurring procedures and files required by automated checks in Git. Move superseded documents and one-off evidence with their supporting assets into the Git-ignored `project-archive/` folder. Preserve their original paths within the archive, remove the old paths from Git tracking and update references in current docs.

## Companion turn behavior

Fix companion behavior through the model's role, when tools run and what the turn ledger records. Do not add or extend word lists, regexes or sentence-specific prompt restrictions to catch a bad reply. Keep permission and schema checks at the execution boundary.

An action is complete only after its tool receipt succeeds. `companion_finish` may deliver action results only by citing those receipts. A turn with no tool call is conversation. The host does not scan its wording for implied completion, lookup or promises.

## Engineering and experience

- Group renderer code and tests by feature. Keep state with its owner and split renderer, main and preload code by responsibility. Check build entry points, mocks and source guards when moving files. For shared contract moves, update the barrel, package exports and consumer TypeScript paths together.
- Put static layout in CSS through the renderer's `styles.ts` entry. Give the learner's content room on the paper surface and leave space for the Live2D companion. Keep motion interruptible and apply actions and focus immediately.
- Verify relevant behavior with tests and package-level `npm run typecheck`. Check shared, API, desktop and AI worker when shared contracts or cross-package configuration change. Record a baseline before broad regression runs.
- Verify desktop experience changes in a real Electron window. Include representative content and zoom. For motion, check rapid reversals, keyboard focus, Off mode and system reduced motion. Report what you verified and what remains open.
