# What Astella Is

[中文](../zh/overview.md) · English

What this covers: the problem this repo solves, the capabilities that actually exist today, how it runs, the permission model, and the things it deliberately leaves out. Two audiences — a learner deciding whether to run it, and an engineer deciding whether to build on it. Commands, ports and installation live elsewhere; this page only names them where a decision depends on them. The product is **Astella**; 拾星笔记 is the Chinese display name users see in the window title, Dock and Start menu, while `@astella/…` package scopes and `ASTELLA_*` variables stay as internal identifiers.

- [The problem it solves](#the-problem-it-solves)
- [The main line today](#the-main-line-today)
- [Feature inventory](#feature-inventory)
- [How it runs](#how-it-runs)
- [Workspaces and permissions](#workspaces-and-permissions)
- [What it deliberately is not](#what-it-deliberately-is-not)
- [Current state and boundaries](#current-state-and-boundaries)
- [Reading paths](#reading-paths)

## The problem it solves

The usual failure mode in self-directed study is not "the material got lost". It is "I studied this and cannot tell whether I actually understood it". The more folders fill up, the fewer answers anyone can give: what makes this claim stand, how far the last attempt got, where the next session should start.

This app turns material into understanding that has a source, can be checked, and can be reviewed. Every explanation traces back to a passage in the original. Every attempt leaves a record kept against the note version and the original text. Self-reported confidence, actual answers and system assessment are recorded as different facts and never substitute for one another. When something cannot be checked reliably, the app keeps "practised, not proven" instead of writing it up as mastery.

The other half of the identity is the room itself: warm paper, booklets, sticky notes, stamps, buttons with physical feedback, plus a Live2D companion sitting beside the page. That is not decoration — it decides how pages are composed and how motion responds. See the 方向 (Direction) and Layout sections of [DESIGN.md](../../../DESIGN.md).

## The main line today

The chain that exists now:

**Source → editable note → on demand, inside that same note, "速看 / 回想 / 往外学 / 学习记录" (quick read / recall / learn outward / study record), and on a selected sentence "写批注 / 发给伴星 / 原句解读" (write an annotation / send to the companion / unpack this line) → make cards or add it to long-term review when you want to.**

Three points need stating precisely:

- A source is read-only material. The note starts when you choose "开始写笔记" (Start writing a note); after that the note is the entry point and nothing pulls you back to the source.
- The four bookmarks along the top of a note — 速看 (quick read, "读懂重点"), 回想 (recall, "想起一点"), 往外学 (learn outward, "发现关联") and 学习记录 (study record) — are independent. You can do one and stop. They are not sequenced into a fixed round, and finishing one is not a gate on the next.
- **Learning cards are a separate capability the user opts into. They are not a prerequisite for note-based study.** The older "cards first, fixed study order" framing in the archived plans no longer applies.

Screens say this faster than prose. The home room is a fixed-camera study with four areas (desk, bookshelf, star window, rest corner) carrying real entries:

![The home room: room objects, a due-review slip and the companion](../assets/home-room.jpg)

Entering the product starts on a sign-in paper: the brand, a rainy desk, and one explicit line — the account and password are never read, logged or sent to any model by the companion.

![Sign-in paper: brand, rainy desk and the no-egress note](../assets/login-gate.jpg)

Inside, the source library lays captured material out as paper cards, one per source, with processing state and "how many notes this already produced" on the same surface; Today's study is the pick-up point, where up to three real stops, the items stuck half-way and the day's study records share one paper.

The note page is where study happens. Its bookmarks — 速看·读懂重点 / 回想·想起一点 / 往外学·发现关联 / 学习记录 (overview, recall, going further, records) — hold fixed positions, the body switches between 阅读 / 编辑 / 源码 (read, edit, source), and results land next to the passage you were reading; its composition and call chain are in [Desktop client](./desktop-client.md).

## Feature inventory

| Group | What exists today | Status |
| --- | --- | --- |
| Capture and sources | Ingest and parsing for text, Markdown, code and URL sources; duplicates offer open-existing / re-capture / go back and edit; returning from a note restores the reading position in the source | Working |
| Notes and versions | Milkdown editor (`@milkdown/kit` `^7.22.1`), autosave, immutable version records; Yjs is the single write path for note bodies; the reading view renders formulas with KaTeX and keeps TeX in the source | Working |
| Study and verification | The 理解练习 (understanding practice) and 练习结果 (practice result) screens, pages 16 and 17, behind the unified `LearningRun` entry point — inside a run the copy says 旅程 / 这一轮 (journey / this round); plus the four note bookmarks 速看 / 回想 / 往外学 / 学习记录 | Verification path works; the four note bookmarks have their pages, flows and states in the code, which [PRODUCT.md](../../../PRODUCT.md) still records as in progress and not yet window-accepted |
| Review and records | Spaced review schedule and due queue; study records kept per note version and against the original text, so a new version does not relocate old records | Working |
| Learning cards | Card generation from a note with evidence alignment; V2 adds candidate review and an agent activity stream; regenerate, stop and per-card decisions each have their own contract | Working |
| Search and the understanding star map | Full-text search, source tracing, understanding relationship graph; the star map is one roamable night sky holding real knowledge relations, with keyword search for locating and objective filters that keep related notes and evidence | Working |
| Companion | Live2D character in the window (the only form), voice (server-side TTS plus on-device ASR), the conversation journal, memory, diary | Still being worked on: [PRODUCT.md](../../../PRODUCT.md) lists it as the second differentiator under iteration, marked in testing |
| Workspaces and members | Personal and collaborative workspaces, Owner / Member roles, invite-code signup and joining | Working |
| AI data consent | Account-level AI consent and data-export policy (`PUT /me/ai-consent`, stored in `user_ai_settings`) | Working |

The companion is the one part of this table still moving. Companion Center holds seven content entries (近况, 对话, 日记, 记忆, 发现簿, 动态, 人格 — recent, conversations, diary, memory, discovery book, activity, persona); the conversation tab only displays and searches history, and everyday talking happens through the short chat beside the character and in "our conversation journal" (全部对话 / 伴星念想 / 交给我的事 / 待确认 — all conversations, her thoughts, things handed to her, awaiting confirmation). What she is and how far she can actually go for a learner is on [Companion experience (product design)](./companion-experience.md).

![The short chat beside the companion: a one-line entry and the "on hand" status chip](../assets/companion-chat.jpg)

## How it runs

**Electron desktop only — there is no browser product.** macOS, Windows and Linux. `apps/` contains exactly two applications, `api` and `desktop-client`; the repo has no public-facing web front-end build entry.

The backend is not multi-tenant. The API (Fastify 5 + Drizzle ORM + PostgreSQL 16) and the AI worker (a separate Node.js/TypeScript process) run as a group of local containers: `docker-compose.dev.yml` for development (`make up`, source bind mounts with hot reload), publishing the API to `127.0.0.1:4000` by default. `docker-compose.yml` is the production file, used for image build and scan, and is not wired to any local Makefile target.

The desktop app reaches the local API through `DESKTOP_API_ORIGIN` (default `http://127.0.0.1:4000`). Credentials stay in the main process; the renderer receives a session snapshot and has no way to read or write the token. MinIO, the optional object store, sits behind the `storage` profile, which both `make up` and `make storage` include.

> **Note:** "one person, one local container group" and "a hosted multi-user service" are different operating models. This page describes only the first. Production Compose files, separated database roles and backup scripts exist in the repo; nothing in it commits to running this stack as a hosted service.

## Workspaces and permissions

| Workspace | Role | On workspace data | Private actions |
| --- | --- | --- | --- |
| Personal | Creator, who is the owner | Full read and write | — |
| Collaborative | Owner | Create, read, update, delete | — |
| Collaborative | Member | Read-only | Verification, review and reading understanding state remain available as private user actions |

The Member interface labels its permission boundary explicitly instead of showing controls that cannot work.

AI consent is attached to the **account**, fully separate from workspaces: once signed, every workspace counts as consented; without it, nothing leaves the machine in any workspace. Switching space does not re-ask, and an Owner cannot sign for someone else. Workspaces do not add a second export policy on top.

## What it deliberately is not

| Not built | The standing decision |
| --- | --- |
| Bring-your-own-key, per-user model or provider selection UI | No user-level model choice or BYOK UI exists in the repo. Models and providers come from the worker's platform config; adding this would be a future product decision |
| Free camera, mouse parallax, scene-level 3D | Fixed-camera 2.5D with registered layers; PixiJS only composites the D0–D4 layers |
| A separate transparent always-on-top desktop-pet window | That line of work was retired wholesale and does not exist in code; the main process creates a single `BrowserWindow` |
| Self-service password reset | No email channel and no reset token, so the login page intentionally omits "forgot password". Only the admin-side endpoint that lets an Owner initialise a password for a recovering user exists (`POST /auth/recovered-users/:userId/reset-password`) |
| The orb form and form selection | Removed by the 2026-09-16 decision. When Live2D is unavailable the character is hidden with one dismissible note in place; there is no orb or substitute portrait |
| Sprite-level companion art | Only a shared contract exists — no assets, no renderer. Not claimable as a current capability |

## Current state and boundaries

- **The project is not released.** The version numbers below are records inside the repo, not published artifacts.
- **Unified version.** The server and desktop share `release/version.json` and the `v1.0.0` tag; one push triggers both release chains.
- **Licensing is not yet declared.** There is no `LICENSE` file at the repo root. [PRODUCT.md](../../../PRODUCT.md) states MIT as a brand commitment, but until that file lands, treat the project as undeclared rather than licensed. Third-party components, models and assets are inventoried in [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md), including redistribution limits for the companion character model.
- **CI no longer builds or scans production images** (since 2026-10-06 CI runs the same tests as the local `make verify` baseline). Verifying a production image is a manual local step.
- **Study room artwork is still marked `reviewOnly / IN_REVIEW`** and must not be presented as production assets before licensing and release acceptance are done.
- **Companion guidance (伴星带路) is implemented.** The 伴星带路 button in the room-control island opens a booklet of seven topics that walks the current space using its real content, with skip / pause / replay (`components/hud/HudRoomControl.tsx:365-370`, `components/companion/guidance/guide-definitions.ts`). What has not been verified is two things: the full walk on a brand-new account, and the speech after consent — neither has ever been run in a real window.
- **Context governance (plan 44) is wired in code but its acceptance evidence is still missing**: its §8 has not a single piece of real-model, real-database or real-window evidence, and migrations 0382–0389 have never run against a real database. Plan 42 was accepted for its 2026-10-05 round, but §14.6 records that there is no same-load p95 or long-term trial proof, that unknown stream usage is not counted as zero, and that closing the loop does not establish long-term effect. Acceptance status is settled by the contract table in the [plan index](../../plans/learning-companion/README.md).

## Reading paths

| Who you are / what you need to settle | Page |
| --- | --- |
| Learner: get it running first, then decide | [Development](./development.md); when stuck, [FAQ and troubleshooting](./faq-and-troubleshooting.md) |
| Engineer: overall shape and service split | [Architecture](./architecture.md) |
| How the desktop app is built, motion, room layers | [Desktop client](./desktop-client.md) |
| Wiring endpoints, data model, permission implementation | [API and data](./api-and-data.md) |
| Model calls, the queue and the consent gate | [Models and the worker pipeline](./ai-and-companion.md) |
| How an agent turn is driven and how context is governed | [Unified agent runtime (technical)](./agent-runtime.md) |
| What the companion is and how far she goes for a learner | [Companion experience (product design)](./companion-experience.md) |
| Validating a change, integration tests, guard scripts | [Testing and quality](./testing-and-quality.md) |
| Deployment, backups, secrets, observability | [Operations](./operations.md) |
| The product and design rules themselves | [PRODUCT.md](../../../PRODUCT.md) and [DESIGN.md](../../../DESIGN.md); collaboration conventions in [AGENTS.md](../../../AGENTS.md) |

## Related pages

- [Manual index](../README.md)
- [Architecture](./architecture.md)
- [Development](./development.md)
- [Desktop client](./desktop-client.md)
- [API and data](./api-and-data.md)
- [Models and the worker pipeline](./ai-and-companion.md)
- [Unified agent runtime (technical)](./agent-runtime.md)
- [Companion experience (product design)](./companion-experience.md)
- [Testing and quality](./testing-and-quality.md)
- [Operations](./operations.md)
- [FAQ and troubleshooting](./faq-and-troubleshooting.md)
