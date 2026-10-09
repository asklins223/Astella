# Astella overview

[中文](../zh/overview.md) · English

Astella is an Electron study room for personal learning. Materials, notes, explanations beside the original text, practice and optional long-term review form its main workflow. A Live2D companion offers dialogue, lookup and execution. This page describes implemented capabilities and boundaries; setup is in [Development](development.md).

## Current learning paths

**Source → note → overview / recall / expansion / records on demand → optional cards and review.**

Sources preserve original material; notes are editable. The four study entries work independently. A selected passage can also be annotated, explained or sent to the companion. Expansion results are drafts that you edit and accept individually.

Dialogue is another starting point: discuss a topic, then explicitly ask for a new note. The companion searches related library content, checks visibility and versions, and adds real links; without a relevant match it creates an independent note. Ordinary questions do not automatically create notes.

Working drafts synchronize automatically; Save creates an immutable version for later reference. Study records retain the version and passage used at the time and are not relocated onto a new version. Recall self-ratings, formal answers and system assessment are separate. Unreliable verification remains “practised, not proven.”

![The home room, review slip and companion](../assets/home-room.jpg)

## Feature inventory

| Area | Current capabilities | Boundary |
| --- | --- | --- |
| Sources | Capture, parse and revisit text, Markdown, code and URLs; PDF and Word (.docx) are parsed into text and images on this machine before capture | Public-network and content limits apply to URL fetches; one source body is capped at 10 MB; scanned pages retain images without OCR; legacy .doc is not parsed; text files decode as UTF-8, falling back to GBK |
| Notes | Read / edit / source, autosave, versions, full-screen mode, formulas, tables, Mermaid and library links | Synchronizing a draft differs from saving a version |
| Study beside the text | Overview, recall, expansion, records, annotations, explanations and interactive demonstrations | Generation starts on demand; expansion drafts require acceptance |
| Companion editing | Cursor insertion, append, selection/block replacement and deletion | Explicit request, permissions and original/version checks; affected paragraphs are locked |
| Notes from dialogue | Save discussions as new notes, link library content and open results | Private by default; successful saving does not establish factual accuracy |
| Cards | Generate and review candidates, accept, practise, review due cards and correct assessments | Candidate generation does not mean activation or mastery |
| Search and star map | Full-text lookup, source tracing, note relations and understanding state | Real data; empty maps require checking content and projection |
| Companion | Chat, tasks, journal, center, voice, diary, memory, discovery, persona and reminders | Long-dialogue naturalness, cross-day behavior and long-term effects remain under validation |
| Web citations | Search public pages on demand; inspect, copy and open numbered sources | Off by default; account opt-in plus AI consent and egress permission |
| Workspaces and data | Personal/collaborative spaces, members, invitations, consent, export and maintenance | Workspace and Agent permissions both constrain writes |

![The companion's short chat and task status](../assets/companion-chat.jpg)

## Runtime modes

The learning UI is an Electron desktop client; there is no browser learning product. Packaging supports macOS, Windows and Linux; automated installer releases currently cover macOS and Windows.

- **Local development:** `docker-compose.dev.yml` runs the API, PostgreSQL, Worker, edge-tts and local MinIO; Electron connects to the loopback API.
- **Remote HTTPS:** packaged clients can connect to a server API. Production adds `docker-compose.deploy.yml`, Nginx HTTPS and remote private S3 objects.
- **Alpha validation:** the production base plus Alpha overlay uses local MinIO, monitoring and backup tools.

The backend supports multiple accounts and workspaces with transaction context and RLS isolation. Single-host deployment does not imply automatic scaling or a complete SaaS operating model. Credentials remain in the desktop main process; the renderer does not call the business API directly.

## Workspaces and permissions

| Role | Workspace content | Private learning actions |
| --- | --- | --- |
| Personal creator / collaborative Owner | Read, write and manage | Available |
| Collaborative Member | Read-only | Answer, review and inspect personal understanding state |

Full Agent permission does not upgrade workspace membership. Read-only mode blocks writes, and some learning tools require confirmation even in full mode. AI consent belongs to the account: Owners cannot sign for others and changing workspace does not re-ask. Web search is a separate account opt-in and does not replace consent.

## Boundaries and evidence

Project-owned source code and documentation use [PolyForm Noncommercial 1.0.0](../../../LICENSE) for its permitted noncommercial purposes (source-available, not OSI open source); SDKs, models and assets follow their separate [third-party notices](../../../THIRD_PARTY_NOTICES.md). [release/version.json](../../../release/version.json) maintains the unified product version; published assets determine download availability.

Implemented entry points and business paths have tests and selected window/real-model evidence. Read acceptance per item: [note editing](../../testing/companion-note-editing-2026-10-08.md), [note creation](../../testing/companion-note-authoring-2026-10-08.md), [plan 44](../../plans/learning-companion/44-unified-context-window-and-compaction-2026-10-05.md) for context governance and database/model comparisons, and [plan 46](../../plans/learning-companion/46-companion-natural-conversation-research-and-design-2026-10-07.md) for dialogue naturalness and waiting stability. These records do not establish acceptance of the entire product or long-term effects.

The product does not offer per-user model/provider settings, a separate transparent always-on-top pet window, free camera/parallax navigation or email password recovery. Failed Live2D loading hides the character with an explanation; text and stored records remain available.

## Further reading

[Guide index](../README.md) · [Desktop client](desktop-client.md) · [Companion experience](companion-experience.md) · [Architecture](architecture.md) · [Development](development.md) · [Server deployment](deployment.md) · [Troubleshooting](faq-and-troubleshooting.md)
