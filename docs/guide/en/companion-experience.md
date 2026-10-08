# Companion experience

[中文](../zh/companion-experience.md) · English

The companion is the shared Agent's dialogue and execution entry for learners. She stays beside the page, reads the current context and performs explicitly requested work within permissions. Domain services continue to own results and persistence. See [Agent runtime](agent-runtime.md) for implementation.

## Dialogue and records

| Entry | Purpose |
| --- | --- |
| Short chat | Ask questions, quote current material, inspect replies and action confirmations; start voice dialogue |
| Task bubble | Track ongoing work and results, revise requirements, pause, resume, stop or retain a cooperation method |
| Conversation journal | All dialogue, companion thoughts, delegated work and pending decisions; inspect process, sources and results, with no new input field |
| Companion Center | Overview, conversation history search, diary, memory, discovery, activity and persona; its conversation tab does not send turns or decide live proposals |
| Guided tour | Topic book on the control island, with skip, pause and replay; marked examples do not create actual learning records |

Chat, journal and center history share real sessions and source records. Acceptance, saved results and a successful final reply are distinct states. If the reply fails after saving, the saved result should keep its own opening entry.

## Capabilities

Tools are projected from `packages/shared/src/agent-capability-catalog.ts`. Availability also depends on account settings, workspace permissions, AI consent, vision/search switches and service configuration.

| Task | Behavior and result |
| --- | --- |
| Understand the current page | Read pages, notes, sources and history; paginate long text and expose coverage |
| Find and open content | Search notes, open notes/cards and focus the star map; navigation supports registered destinations |
| Study and ongoing work | Start/resume learning, request hints, switch practice, postpone reviews; generate overviews, demonstrations, expansion drafts or card candidates |
| Create notes | Explicitly save a discussion as a new editable note with verified library links |
| Edit the current note | Insert at the cursor, append, replace/delete selections or blocks |
| Read public sources | Opt into web search; read explicitly supplied public HTTPS documents with provenance and coverage |
| Calculate and illustrate | Check bounded expressions, read images and provide diagrams or interactive artifacts |
| Cooperate over time | Reminders, memory, persona changes, diaries, bookmarks and evidence-backed methods |

Users review and accept card candidates and expansion drafts. Ordinary questions do not automatically start ongoing goals, create notes or modify the body.

## Ask her to write or edit a note

After discussing a topic, explicitly ask to turn it into a note. The result is saved in the current workspace, private by default, and remains editable. Links require actual library search and body reads, followed by visibility/version checks during saving. No relevant match produces an independent note.

For body edits, place the editor cursor or select text and choose “让伴星改这段,” then describe the change. The selection action quotes text and location without sending it. Before submission the draft synchronizes; execution checks the original and version and refuses stale overwrites. Other paragraphs remain editable while affected paragraphs show progress and block input/formatting. Completion, failure or cancellation unlocks them. Motion Off and system reduced motion retain a static status.

Explanation and editing are different actions. An explanation may become an annotation; a knowledge question does not change the body. A save receipt proves persistence, not independent factual verification. Evidence and limits are in [note creation](../../testing/companion-note-authoring-2026-10-08.md) and [note editing](../../testing/companion-note-editing-2026-10-08.md).

## Web search and citations

Enable web search in companion settings; it is off by default and follows the account. The server reuses its BigModel credential, with no client key field. AI consent and egress policy still apply.

Numbered markers point to actual sources. Click to inspect title, URL and date, copy a link or open the system browser; the source list folds away. Source metadata and citation markers are excluded from spoken text. Chat and history retain the same source identities.

On exhausted quota the turn can continue with an indication that online verification failed. The current Worker cools down that credential for 30 minutes without changing the user's switch. Missing citations do not establish that search succeeded. Search calls per turn are bounded, and webpage content is data, never additional authorization. See [search validation](../../testing/agent-web-search-2026-10-08.md).

## Permissions, presence and quiet

Agent permission has read-only, guided and full tiers. Guided permits reversible low-impact actions and requests confirmation for others. Full reduces confirmation, but six learning tools executed through proposals still require a decision. Read-only blocks writes; full does not override a Member's read-only workspace role.

Seat, framing and interaction are registered in `components/hud/hud-pages.ts`. Full-screen notes give her a temporary lower-right seat without rewriting placement preferences. Formal answering suppresses proactive hints and speech.

Master mute, focus/hide and quiet hours have separate responsibilities. Requested reminders and awaited completion notifications do not enter routine proactive-message frequency limits. Real task, reminder and arrival events drive moment animations. Failed Live2D loading hides the character with a dismissible explanation.

## Voice

Output uses Qwen or Edge-TTS. Qwen synthesis/network failure can fall back to Edge; governance denial does not. The reply model marks contextual tone, laughter or sighs, supported Qwen models use those tags, and display/history stay clean. Persona's voice-expression switch disables the tags. Expressions follow the playing segment, while mouth motion follows decoded audio amplitude.

Input uses local SenseVoice. Users download/remove the model in Settings; it is excluded from installers. Audio reaches a utility process through local IPC and does not go to cloud ASR. Voice dialogue segments at pauses, displays captions in order and sends the completed turn directly; continue speaking to correct it. Interruption can stop reply playback.

Idle recognition releases memory and may reload after a long pause. Real microphones, interruption thresholds, listening quality and device differences need separate validation; engine/synthesis tests do not accept the complete speaking experience. The backend retains `POST /voice/transcribe`, but the desktop does not call it.

## Identity, memory and diary

Persona, name, speech style and account settings follow the account. Concrete material, conversations, diaries, experiences and goals stay in their workspace. Shared cooperation preferences must not carry workspace-specific facts; ambiguous scope stays local.

Memory requires the user's words as evidence, admission checks and confidence. Volatile facts and rejected sources cannot simply be reused. Resident/active/archived tiers have budgets; tidying suggestions do not imply automatic moves. The UI supports confirmation, pinning, archival, restore, ignore, removal and a recovery area; the map displays confirmed server-filtered relations. Consolidation and source-grounded semantic admission still have open work: a quotation alone does not establish that it supports the memory.

Diaries accumulate material only while enabled and are generated by local day. Hiding keeps text; deletion removes derived content. “Discuss this entry” brings its date/version into the input without sending. Diaries and her judgments are subjective work, not user facts or evidence of mastery.

## Cooperation methods and limits

Methods record applicability, steps, exceptions, reasons, versions and sources. Users adopt, disable, revise and restore them and give feedback after real use. Growth should mean smoother continuity and less repeated explanation, not points, streaks or relationship levels.

`companion_read_history` can retrieve originals. Compaction folds only complete messages covered by a valid summary and records coverage. Summaries can omit meaning, and later calls may not recover everything needed, so compaction cannot promise memory without loss. Plan 44 has database, real-model comparison and selected window evidence; remaining limits are in [plan 44](../../plans/learning-companion/44-unified-context-window-and-compaction-2026-10-05.md). Naturalness and waiting stability are tracked in [plan 46](../../plans/learning-companion/46-companion-natural-conversation-research-and-design-2026-10-07.md).

Cross-day memory, long-term method effectiveness, new-account tours, microphones and packaged updates require their respective acceptance records. Personal model settings and a separate pet window are outside the current product. See [Testing and quality](testing-and-quality.md) and the [plan index](../../plans/learning-companion/README.md).
