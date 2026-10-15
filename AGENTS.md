# Project Collaboration Guidelines

Use English for all subsequent project communication and documentation updates unless the user explicitly requests another language.

Understand the experience the user wants to achieve in the current task, and follow the actual call chain through to completion. The user's latest decisions take precedence over older documents and general skills; when conflicts arise, update the relevant guidance and explain the tradeoffs. Existing pages are a starting point for understanding the product and may be restructured.

## Current Documentation Entry Points

Choose the documents relevant to the task; there is no need to load every document.

| Topic | Entry point |
| --- | --- |
| Product, users, permissions, and confirmed capabilities | [PRODUCT.md](PRODUCT.md) |
| Visual direction, layout, and interaction | [DESIGN.md](DESIGN.md) |
| Proactive companion conversation, user-defined participation preferences, sentence segmentation and autonomous follow-up replies, page awareness, and wake-up capabilities | [Plan 56](docs/plans/learning-companion/56-companion-initiative-and-natural-exchange-2026-10-13.md) (All accounts support the following by default: natural sentence segmentation, additional thoughts after a reply, relevant page assistance, startup greetings, breaks during long study sessions, and **the companion spontaneously sharing a thought or asking how things are going when the user has the app in the foreground and their activity settles down**. Tone varies with the basis for participation; greetings and casual conversation use the companionship path, while page assistance and difficult questions use the explanation path. The scheduled batch thought-generation chain has been removed, and there is no separate "Companion Thoughts" page. Personal free-form preferences refine the behavior; they are not a prerequisite for enabling it. See the implementation record for the actual call chain and verification coverage.) |
| Companion access on the go, portable learning, and shared data across apps and mini programs | [Plan 51](docs/plans/learning-companion/51-mobile-companion-full-agent-product-design-2026-10-10.md) (On 2026-10-14, the user decided to replace the React mobile client with two native apps: iOS SwiftUI and Android Kotlin/Compose. Native visuals use system neutral colors and a single system blue. See the update at the beginning of the document for the old project's status.) |
| Mobile conversation redesign, server-side voice, and a shared WebSocket for both native clients | [Plan 55](docs/plans/learning-companion/55-mobile-redesign-and-companion-realtime-2026-10-12.md) (Native clients reuse the companion WebSocket and MiMo whole-utterance ASR. There is no streaming ASR/TTS; desktop continues to use SSE and local ASR.) |
| Project-wide agent, persistent identity, growth feedback loop, and companion experience | [Plan 42](docs/plans/learning-companion/42-unified-agent-and-companion-experience-2026-10-04.md) |
| Companion guidance, first use, getting to know new spaces, and the space arrival experience (implemented after Plan 42) | [Plan 43](docs/plans/learning-companion/43-companion-guidance-and-space-arrival-2026-10-04.md) |
| Note-based learning pages, flows, and states | [Plan 41](docs/plans/learning-companion/41-note-companion-learning-experience-2026-09-28.md) |
| Model calls and background tasks | [Plan 41a](docs/plans/learning-companion/41a-unified-agent-foundation-2026-09-28.md) |
| Companion personality, memory, and diary | [Plan 40](docs/plans/learning-companion/40-companion-long-term-experience-and-diary-prd-2026-09-25.md) |
| Companion runtime, failure communication, and observability | [Plan 40b](docs/plans/learning-companion/40b-companion-runtime-and-observability-2026-09-27.md) |

The current plan index is in `docs/plans/learning-companion/README.md`. Archives are only for tracing earlier decisions; audit reports, `outputs/`, `.workbuddy/memory/`, `.impeccable/`, and `project-archive/` are historical or working materials. Document status labels and old "completed" claims do not prove the current implementation; verify the actual state against the code and real application windows.

## Design and Experience

This project is an Electron desktop study room for individual learners. Warm, tangible paper surfaces alongside a Live2D companion define its identity. Start with what the user is reading, thinking about, or doing, and give that content appropriate space and emphasis.

Thoughtful design decisions are welcome: reorganize layouts, change proportions, and try new object metaphors, accent colors, and interaction patterns. Existing tokens, fonts, and controls provide continuity without requiring every page to use the same structure. There are no universal quotas for the number of proposals, fixed columns, card layers, primary buttons, or animation durations; decide according to the content.

When exploration is needed, use sketches or interactive demos to compare meaningfully different compositions; implement small changes directly when the direction is clear. Explain how the design concept helps the task, and bring inventive ideas into reading, interaction, or state changes instead of merely adding decoration.

Motion conveys spatial relationships and tactile feedback. Actions should take effect promptly, and transitions should follow the latest intent; rapid back-and-forth actions, continuous input, and interruptions should remain coherent. Keyboard interactions can also provide spatial feedback, while focus and functionality must not wait for animations. Judge intensity and rhythm according to the object, distance, context, and the user's motion preferences.

Experience the result in a real application window: check whether the visual emphasis is clear, the content is readable, consecutive interactions feel natural, and the character and paper surfaces each have appropriate space. Screenshots, tests, and source inspection provide distinct evidence and cannot replace hands-on interaction.

## Engineering Structure and Layers

Organize renderer source by feature domain: `notebook / run / settings / library / source / space / companion / review / study`. Keep related components, styles, copy, and state logic close together, moving them to a shared layer when reused across domains; place tests in `__tests__/`.

Page components handle data fetching, derived values, layout, and event wiring. State domains, loading flows, and formatting logic that are difficult to read can be extracted into modules in the same directory. Split code according to dependencies and responsibilities across renderer, main, and preload; line counts and hook counts are clues, not extraction targets.

Styles enter through `apps/desktop-client/src/renderer/src/styles.ts`. Express static layout in CSS; code may supply runtime geometry and animation parameters. When reusing controls, check which styles actually win and how portals render, avoiding style name collisions, ineffective selectors, and multiple owners of the same animation.

When moving code, preserve its actual types, state scope, and call relationships. Pass mutable state through its owning object or accessors; confirm extraction boundaries against the syntax structure. Back up larger batches of changes first and inspect each diff. Update guard scan scopes to follow the files that actually carry the contracts.

The project has not launched yet. Old paths may be removed directly once confirmed to have no runtime callers, build entry points, or valid test dependencies, avoiding unmaintained compatibility layers. The workspace may already contain user changes; preserve everything unrelated to the current task.

## Verification and Delivery

Choose tests, type checks, and application window checks relevant to the change. When a full regression run is needed, record a baseline first and distinguish existing failures from newly introduced ones; take responsibility for problems introduced by the current change and accurately record remaining limitations.

Run type checks with the relevant package's `npm run typecheck`. The desktop root tsconfig contains only references, so running `tsc --noEmit` directly may check nothing; fix syntax errors before assessing type-check results. When changing shared types or cross-package configuration, check shared, api, desktop-client, and ai-worker.

Guards help detect missing styles, interface mismatches, and structural issues. When a guard conflicts with a new user decision, first examine the behavior it protects, then update the tests accordingly; passing guards does not establish good design. For motion changes, check rapid repetition, reverse transitions, Off mode, the system's reduced-motion setting, and focus paths. Window checks should cover real long-form content, zoom, and companion placement.

Explain the result, verification coverage, and anything still unconfirmed in the handoff. Keep implementation records and troubleshooting details close to the relevant task or tests, rather than accumulating them again in this entry document.
