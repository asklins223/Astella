# Desktop client

[中文](../zh/desktop-client.md) · English

## What this covers

`apps/desktop-client` is the only user interface in Astella: a single-window Electron 44 study room. The main process owns the window, the custom scheme, the note collaboration channel, artifact storage and the updater; the renderer owns every layout but has **no router** — registered page intents resolved by a store, and the same Live2D companion (伴星, "companion star") sits beside the paper on all of them. This page follows that real call path: where the process boundary falls, how a screen gets chosen, how the companion is driven, how notes are saved, how an installer is produced, and which sentences are easiest to write in a way that contradicts the code. Facts come from `apps/desktop-client/**` sources plus the repository-root [PRODUCT.md](../../../PRODUCT.md) and [DESIGN.md](../../../DESIGN.md); unless stated otherwise, all paths here are relative to `apps/desktop-client/`.

- [Build and three entry points](#build-and-three-entry-points)
- [Window, scheme and preload](#window-scheme-and-preload)
- [Navigation without a router](#navigation-without-a-router)
- [Screen inventory](#screen-inventory)
- [Directory rail, control island and global keys](#directory-rail-control-island-and-global-keys)
- [The companion: in-window Live2D](#the-companion-in-window-live2d)
- [Notes: editing, sync and four bookmarks](#notes-editing-sync-and-four-bookmarks)
- [Settings centre](#settings-centre)
- [Motion and accessibility](#motion-and-accessibility)
- [Packaging and auto-update](#packaging-and-auto-update)
- [Tests and source guards](#tests-and-source-guards)
- [Evidence from a live window](#evidence-from-a-live-window)
- [Traps](#traps)
- [Current state and limits](#current-state-and-limits)

## Build and three entry points

| Item | Value |
| --- | --- |
| Package / version | `astella-desktop-client` / `release/version.json` |
| Runtime | Electron `44.7.0`, electron-vite `^5.0.0`, Vite `^7.3.6` |
| Minimum macOS | macOS 13 Ventura; declared in `electron-builder.yml` |
| UI | React `^19.2.0`, TypeScript `^5.9.3`, Zustand `^5`, GSAP `^3.15` |
| Editor stack | `@milkdown/kit` `^7.22.1` + CodeMirror 6 + `yjs` `^13.6` + `@hocuspocus/provider` `^4.7` |
| Tests | Vitest `^4.1.11` + `jsdom` + Testing Library |
| `npm run dev` | `electron-vite dev --remoteDebuggingPort 9222` |
| `npm run build` | `validate:room-layers` → `electron-vite build` → `validate:room-layers:output` |
| `npm run typecheck` | `tsc --noEmit -p tsconfig.node.json --composite false`, then `-p tsconfig.web.json` |
| `npm run dist` | typecheck → test → build → `electron-builder` |

The development command opens debug port 9222 for [live-window CDP tools](#evidence-from-a-live-window); production installers do not expose it. `build` runs `scripts/validate-room-layers.mjs` twice — once against the layer manifest at `src/renderer/public/assets/learning-room/v1/manifest.json`, once against the output in `out/`; a missing layer stops the build.

The main process has **two entry points** (`electron.vite.config.ts`): `index` and `voice-asr-host`. The on-device speech engine is the emscripten Node build of that engine, its factory calls `require("path")` unconditionally, and the renderer window runs `sandbox: true` where even `require` does not exist — so it has to be forked as a `utilityProcess`, and `fork` takes a file path rather than a function, which is why it needs its own entry. Do not delete the `index` line: providing `input` takes over the default entry. The same block marks `bufferutil` / `utf-8-validate` external and deliberately does not install them, because Vite's dependency pre-bundling emits a **module-top-level** `throw` for unresolvable optional peers; that would kill the whole main process at Electron start-up, before `ws`'s own try/catch ever runs.

The renderer has zero Node access. CRDT documents, image uploads, dynamic artifacts, the clipboard, Markdown export and recognition model bytes all run in the main process through the preload bridge — the boundary every security statement below depends on.

## Window, scheme and preload

| Item | Value | Source |
| --- | --- | --- |
| Window title | 拾星笔记 (display name; package name `Astella`) | `src/main/index.ts` |
| Initial content size | 1440×810 | `src/shared/window-geometry.ts` |
| Minimum size | 1280×720 | same file |
| Background | `#211914` for opaque windows; `#00000000` on Windows, where the window is transparent (otherwise the first frame flashes the desktop, and the opaque colour would seal off the rounded corners) | `src/main/window-chrome.ts` |
| Chrome | macOS `titleBarStyle: hiddenInset`; Windows `frame: false` + `transparent: true` with caption buttons drawn by the renderer; Linux still uses `titleBarOverlay`, recomputed with the theme | `src/main/window-chrome.ts`, `src/renderer/src/components/hud/window-caption.tsx` |
| Window shape | Rounded 14px on the document root while floating; square when maximised or full screen | `src/shared/window-frame.ts`, `src/renderer/src/styles.css` |
| Menu bar | `autoHideMenuBar: true` | `src/main/index.ts` |
| Single instance | `app.requestSingleInstanceLock()` | `src/main/index.ts` |
| Zoom | ⌘ / Ctrl with `+` `-` `=` `0` over a discrete step table | `src/main/window-zoom.ts` |

The comment on top of `window-geometry.ts` is worth reading in full: this file once held a whole aspect-ratio lock (`setAspectRatio` + `maximizable: false` + a 16:9 tolerance assertion). With the lock removed, "no exposed edges, no distorted backplate" is handled by renderer cover placement (`.scene-reference-frame[data-scene-fit="cover"]`, `.room-backplate { object-fit: cover }`), and **only the size floor** is left as something only a native window can guarantee — below it the paper text and the companion's seat collide. Acceptance viewports are 1440×810, the native 1280×720 minimum, and 125% / 150% / 200% zoom.

Content reaches the window only through the custom scheme `astella-app`, with two hosts: `astella-app://bundle` (the app document itself) and `astella-app://artifact/<uuid>` (a full interactive page generated by the AI). The scheme is registered privileged / standard / secure / stream, accepts only `GET` / `HEAD` — anything else gets 405 with `Allow: GET, HEAD` — and reads the `Range` header. Artifacts land at `<userData>/artifacts/<artifactId>.html`, and path safety comes from the shape of `artifactId` (`src/shared/artifact-frame.ts` accepts a uuid only): no `..`, no writable separator, so the resolved path always stays inside `artifacts/`. CSP response headers are split three ways — main document / artifact origin / everything else `rejectAll` — after deleting any header the upstream already set (`src/main/index.ts`); two more gates sit on `onBeforeRequest` (line 390) and `will-navigate` (line 454).

`webPreferences`: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: false`, `devTools: !app.isPackaged`. The preload exposes two frozen bridges, `window.astellaDesktop` and `window.astella`, inside `if (process.isMainFrame)` (`src/preload/index.ts`) — Electron injects preloads into **every** iframe, so artifacts already use iframes, and this guard withholds both IPC bridges from their content. Restricted environments (CI containers, sandboxed agent shells) additionally `appendSwitch('no-sandbox')` (`src/main/index.ts`), otherwise Chromium cannot initialise its own sandbox and every child process dies with "sandbox initialization failed"; a normal local run keeps the sandbox.

## Navigation without a router

Room state is one pure function plus one store. `src/renderer/src/app/room-machine.ts` defines `RoomIntent`, `RoomDestination` / `ViewPresetId` and `resolveRoomIntent(intent) → { destination, viewPreset, surface }`; `room-store.ts` holds surface, theme, motionMode, returnTarget, `invoke(intent)` and an injectable `navigationGuard`. There is no URL, no history, no route table: changing screen means changing the store, `TaskSurface.tsx` picks the component by `surface`, forces a remount with `key={renderedSurface}`, and runs enter/exit as GSAP timelines under a wall-clock deadline — on fast round trips or rapid successive switches a timed-out animation just lands, instead of holding focus on the layer that is leaving (`aria-hidden` plus `inert` while leaving, same file). After the exit, focus returns to the entry point via `data-focus-return`.

"HUD" is not a second window. The whole client is one `BrowserWindow`; the `.hud-surface` and `page-NN` class names are the design substrate aligned with the `.impeccable` mockups, and `components/hud/use-hud-page.ts` publishes the current screen identity as `data-hud-page` on `.desktop-app`. `src/main/__tests__/hud-substrate-guard.test.ts` checks the other direction — that the override layer really contains `.hud-surface .c` selectors (fewer than 20 and the guard fails as vacuous).

Error boundaries are two-tier: `<RenderErrorBoundary label="理解书房" shell>` at `App.tsx` offers a reload if the shell dies, `<RenderErrorBoundary label="这个页面">` at `TaskSurface.tsx` loses only that sheet of paper — the room, the rail and the companion stay.

### One complete call path

Pressing 学这篇笔记 ("learn this note") on screen really walks this route: key or click → `room-store.invoke("open-notebook")` → `resolveRoomIntent` produces `{ destination, viewPreset, surface }` → `TaskSurface` swaps the `key` and remounts `NotebookSurface` → the component calls a typed business method on `window.astella` → a main-process handler issues the request to `apps/api` → the result and its error code travel back on the same path, with the screen updating from the receipt. There is no router on this path, no direct business HTTP in the renderer, and no second window. To add an action, change each layer along it; the mapping table is the "where to change" section of [Architecture](./architecture.md).

![The home room: paper surfaces, directory rail and the always-present companion](../assets/home-room.jpg)

## Screen inventory

| Intent | Screen | Component (relative to `src/renderer/src/`) |
| --- | --- | --- |
| `home` | Home room with 书桌 (desk), 书架 (shelf), 星窗 (star window), 休息角 (rest nook) | `components/home-v2/HomeV2Experience.tsx`, entries in `home-feature-registry.ts` |
| `continue` | 今日学习 (Today's study) — the "next step today" action | `components/surfaces/study/StudySurface.tsx`, `components/surfaces/library/TodayBatchSurface.tsx` |
| `open-resumable` | 未完成的学习 (unfinished study) | `components/surfaces/library/ResumableSurface.tsx` |
| `open-notebook` | A single note, as one booklet | `components/surfaces/notebook/notebook-surface.tsx` |
| `review` | 复习队列 (review queue) | `components/surfaces/review/ReviewSurface.tsx` |
| `search` | 全局搜索 (global search) | `components/surfaces/study/search-surface.tsx` |
| `graph` | 理解星图 (understanding star map): roaming/list modes, star and constellation layers, per-relation confirmation | `components/surfaces/space/graph-surface.tsx`, `space/understanding-universe.tsx` |
| `validate` | 理解练习 → 练习结果 (understanding practice → practice result, pages 16 / 17; inside a run the copy says 这一轮 / 旅程, and the gate is 正式作答) | `components/surfaces/run/validation-surface.tsx`, `learning-run-copy.tsx` |
| `open-card-generation` | Card generation / candidate card review | `components/CardGenerationSurface.tsx`, `components/surfaces/review/candidate-review-desk.tsx` |
| `open-sources` | 来源库 (source library), tabs 全部 / 处理中 / 失败 / 就绪 / 归档 (all / processing / failed / ready / archived; `source/source-index.ts`) | `components/surfaces/source/source-library-surface.tsx` |
| `open-source` | Source detail | `components/surfaces/source/source-detail-surface.tsx` |
| `open-notes` | 笔记库 (note library) | `components/surfaces/notebook/note-library-surface.tsx` |
| `open-objectives` | 学习卡 (study card) library | `components/surfaces/library/WorkspaceLibrarySurface.tsx` (`ObjectiveLibrarySurface`) |
| `open-objective` | Study card detail | same file (`ObjectiveDetailSurface`) |
| `open-companion-center` | 伴星中心 (companion centre): 近况 / 对话 / 日记 / 记忆 / 发现簿 / 动态 / 人格 (news / dialogue / diary / memory / discovery book / activity / persona) | `components/surfaces/companion/companion-center-surface.tsx`, `companion-center-model.ts` |
| `open-settings` | 设置中心 (settings centre) | `components/surfaces/settings/settings-surface.tsx` |

## Directory rail, control island and global keys

`DIRECTORY_ITEMS` at `components/DirectoryRail.tsx` is exactly ten entries under `aria-label="学习空间目录"` (learning space directory): 首页 (home), 来源 (sources), 笔记 (notes), 学习卡 (study cards), 星图 (star map), 今日学习 (today's study), 复习 (review), 查找 (search), 伴星 (companion), 设置 (settings). The collapse button reads 展开目录 / 收起目录 (expand / collapse the directory), and behaviour mode `auto | expanded | collapsed` persists in `astella.directory-rail.mode.v1`. The star map sits with sources / notes / cards because it is the topology view of that same chain; today's study and review are two different screens and the rail is the only way to reach either.

The top-right island (`components/hud/HudRoomControl.tsx`) holds the space pill (`aria-label="学习空间控制"`), 返回学习空间总览 (back to the space overview), day/night flip, 总静音 (master mute), the motion-mode cycle (完整 / 轻量 / 关闭 — full / lite / off — with a status light), 设置 (settings, title carries the version when an update exists), 伴星带路 (companion guidance), an account slot that becomes a face or initials seal when expanded, and the collapse toggle. The bottom-left return bookmark lives in `components/hud/HudPage.tsx`, and its `aria-label` reuses the passed label verbatim: those labels already start with 返回 ("back to"), so prefixing again made screen readers announce "back back to 书房" (note at line 53).

Global keys live in `App.tsx`: `Esc` → home (yielding while the companion HUD is open, so it never steals that close), ⌘ / Ctrl+`Enter` → next step today, ⌘ / Ctrl+`K` → global search, `R` → today's review, `G` → star map. The last four go through `homeV2ShortcutFeature(event)` into a home feature id, then dispatch `astella:home-v2-run-feature` — the shortcuts and the on-screen entries share one path instead of two implementations. `shouldIgnoreGlobalShortcut` suppresses all of them in inputs, during IME composition, with an open dialog, or while onboarding is showing.

## The companion: in-window Live2D

The companion is drawn into a canvas inside the main window — not a transparent always-on-top window, not a second process: `components/companion/WindowLive2D.tsx` mounts the layer and `WindowLive2DDriver.ts` drives it, on top of vendored PIXI / Live2DCubismCore / cubism4 from `src/renderer/public/assets/companion/vendor/` (its README records provenance). This section covers only that in-window layer — how it mounts, loads and degrades; what she is for the person studying (her four surfaces, what she can do, where she still falls short) is in [Companion experience (product design)](./companion-experience.md), and the execution body driving her is in [Unified agent runtime (technical)](./agent-runtime.md).

| Item | Value |
| --- | --- |
| Registered form | `whale` (大肥鱼, "Big Fat Fish") only; `DEFAULT_WINDOW_LIVE2D_MODEL_ID` (`window-live2d-contract.ts`) |
| Model | `assets/companion/live2d-v3/whale/c_0120.model3.json`, 30 `.exp3.json` expressions |
| Motion groups | `Idle` / `Bubble` / `Spray` / `Selfie` / `SelfieQuick` |
| Presentation states | 11, from `characterPresentationStateV1Schema` in `packages/shared`: hidden, idle, invite, listen, think, analyze, speak, navigate, encourage, celebrate, uncertain |
| Semantic moments | 10: `task_started`, `working`, `tool_succeeded`, `tool_failed`, `awaiting_confirmation`, `reply_completed`, `space_arrived`, `reminder`, `celebration`, `run_failed` — each resolves to a motion plus optional overlay / costume (`WHALE_MOMENT_CUE`) |
| Idle shuffle bag | first cue after 4s, then one every 7–15s; expression held 5s, motion 3.5s, overlay 2.6s by default |
| Status | `loading \| ready \| unavailable`; a 15s load timeout marks it `unavailable` (`WindowLive2D.tsx`), and then it takes no space and spam-nothing |
| Lip sync | per-frame TTS amplitude written to `ParamMouthOpenY` (this model has no `ParamA`) |

The moment table only acts out things that **actually happened**: every cue is triggered by an SSE frame or a bubble action, never inserted to add more animation. Glasses are a costume — put on for `working`, taken off for `tool_succeeded` / `reply_completed`, so round spectacles do not hang through the next conversation; sticker props (question mark, departing soul, hearts) are overlays that write only decoration-visibility parameters, so they stack per frame and come off. Hair props would permanently change the look and table props would need a table she does not have, so neither is registered. The companion is present on every page, with seat, framing and proactive-intervention settings grouped in `components/hud/hud-pages.ts`; `HUD_PAGE_DESTINATIONS` in the same file marks the screens she cannot jump to (value `null`: `space`, the four note bookmarks, card detail, generating, candidates and so on), which is exactly the ledger that stops the UI from promising unreachable navigation.

![The short chat beside the companion and its "on hand" status chip](../assets/companion-chat.jpg)

## Notes: editing, sync and four bookmarks

The editor is Milkdown + CodeMirror WYSIWYG (`surfaces/notebook/note-markdown-editor.tsx`); the body has three modes — 阅读 / 编辑 / 源码 (reading / editing / source) — typed as `NoteBodyMode` in `note-document-mode.ts`. One booklet carries four mutually exclusive bookmarks: `leaf` at `notebook-surface.tsx` takes `reading` / `learning` / `history` / `expansion`, and switching bookmarks keeps your place on screen instead of rebuilding the page. The identity published outward is the four entries in `hud/hud-pages.ts`: 这篇笔记 (this note), 笔记编辑 (note editing, subtitled "Markdown WYSIWYG; the versions you can return to are the ones 「保存」(save) left behind"), 学这篇笔记 (learn this note) and 学习记录 (learning record).

The CRDT and the WebSocket live in the main process: `src/main/note-doc-transport.ts` uses `HocuspocusProvider`, one connection per note (in v4 the document name travels in the first protocol message and the server routes per document), with local cache in `note-doc-cache-store.ts`; the renderer reads and writes through the preload bridge. Autosave is debounced and its state settles only on the server receipt. Versions are immutable — `version-history.tsx` restores without destroying history. Annotations anchor to original ranges (`note-annotation-mark.tsx`, `note-annotation-placement.ts`) and the explanation paper sticks beside the exact anchor; 回想 (recall) runs hint / reveal / self-report under `notebook-recall-contract.ts`; 速看 (quick overview) cites the original text and states its real coverage; expansion drafts become new notes and relations only after per-note confirmation. AI-generated full HTML/SVG pages run in an isolated frame (`surfaces/source/artifact-frame-host.tsx` via `astella-app://artifact/<uuid>`) — same machine, same origin family, different capability set. Image upload is in `note-image-uploads.tsx`, Markdown export in the main process (`src/main/note-markdown-export.ts`), and the star map is fed by `understanding.getTopology` plus relation decisions.

### Full-screen and reading continuity

The body supports full-screen reading/editing with the same working draft and editor. Paper fills the application viewport; an upper-right fold opens tools without moving the body, while the companion keeps a temporary lower-right seat. Full-screen is the display mode of this page: 速看 (overview, including its mind map), 回想 (recall), 往外学 (expansion), interactive demos, the learning record and the current round all stay on the same window-filling paper — their tabs no longer drop back to the ordinary book, every view can enter the mode, and exiting leaves you on the sub-page you were on. Full-screen mode survives note navigation/loading; the back arrow follows the current note path and restores mode/position. Leaving notes, switching workspace or explicitly exiting ends the mode.

Esc closes the current overlay, then tools, then full-screen mode before global navigation. Selection, undo and reading position continue across modes, and the temporary seat does not change placement preferences. Entry modules are `notebook-fullscreen-state.ts`, `use-notebook-fullscreen-controls.ts` and `notebook-fullscreen-ribbon.tsx`.

### Annotations, edits and links

Selection actions appear after dragging ends; keyboard expansion follows the final selection. Numbered end markers open individual annotations. Previews anchor to the sentence-end marker, or the first visible fragment if the end is outside the page. Click other body text/blank space to dismiss an open annotation page, or another annotation to switch; dragging is not dismissal.

“让伴星改这段” brings the original passage/location into short chat for the user to supply an instruction and send. Explanation progress and saved annotations remain distinct. Busy ranges are consistently locked in reading, rich text and source views; cancellation/failure unlocks them. See [Companion experience](companion-experience.md) for authoring and real library links. Note links navigate by actual identity and preserve a return path.

Interactive demonstrations run in restricted iframes. Lite retains teaching motion; Off/system reduced motion stop automatic motion but retain manual exploration and explanations. Failed regeneration keeps existing artifacts and source text.

## Settings centre

`SETTINGS_SECTIONS` in `surfaces/settings/settings-book.tsx` is six chapters; the index is keyboard-walkable (arrows / Home / End) and each right-hand sheet keeps its own scroll position:

| Chapter | Contents | Main files |
| --- | --- | --- |
| 账户与空间 (account and space) | nickname, avatar cropping, rename / dissolve / hand over the space | `settings-account-panel.tsx`, `avatar-crop-dialog.tsx`, `settings-workspace-group.tsx` |
| 成员与邀请 (members and invites) | join a room, invite and pending invites | `settings-invite-join-field.tsx` |
| 主题与动效 (theme and motion) | light (随时间 / 日 / 夜 — by time / day / night), motion (full / lite / off, system reduced motion always wins), directory behaviour, bounce-preview paper | `settings-theme-picker.tsx`, `settings-motion-preview.tsx` |
| 伴星设置 (companion settings) | company rules, quiet hours, three assistant permission levels (`read_only` / `guided` / `full`, default guided), account-level web search (off by default), automatic diary, desk model and size, master mute, TTS engine and voice audition, default answer mode, on-device recognition model download | `settings-companion-time.tsx`, `settings-companion-panel.tsx`, `settings-companion-voice.tsx`, `settings-answer-mode-row.tsx`, `settings-voice-model.tsx` |
| AI 数据同意 (AI data consent) | consent switch, data policy, egress log | `settings-data-boundary-group.tsx` |
| 数据与维护 (data and maintenance) | space export, export manifest, capability chips, update panel | `settings-export-group.tsx`, `settings-companion-status.tsx`, `settings-update-panel.tsx` |

All companion reads and writes go through `use-companion-account-settings.ts`, one `patch()` per setting. The permission copy explains the three levels (read-only until you raise it / confirm before every change / navigation and form filling may run automatically but irreversible actions still confirm), and the page says exactly that. That same copy comes from `COMPANION_AGENT_PERMISSION_DETAIL` in `companion-account-presence.ts`: both companion input boxes (the bubble and the conversation journal) carry an inline permission button in their tool row (`companion-agent-permission.tsx`), which takes effect on the spot and broadcasts to the settings page, so the two places can never disagree. Below the index sits a 重新认识书房 ("meet the study room again") button (`onReplayIntro` in `settings-book.tsx`), and each chapter's description and colour tone are defined once inside `SETTINGS_SECTIONS`, with icons from `lucide-react`.

## Motion and accessibility

Transitions use interruptible GSAP timelines that follow the latest intent: the leaving layer takes neither focus nor screen reader, and if a new page arrives early the wall-clock deadline just lands the sequence. `nextMotionMode()` cycles full → lite → off (`room-machine.ts`); when `prefers-reduced-motion` matches, the store's `reducedMotion` overrides it outright and even the settings bounce preview degrades to static. `motionMode === "off"` takes its own branch in `TaskSurface` and lands immediately (same file, line 172), and `lite` is a separate branch too (line 156). Keyboard behaviour follows the same rule: the leaving layer is `inert`, so it drops out of the tab order, while the new page's entry point is pressable before its entrance finishes.

The home background is poster plus parallax layers, not a 3D scene: `data-scene-renderer="poster-live2d"` (`App.tsx`, `components/RoomStage.tsx`), and `scripts/validate-room-layers.mjs` checks layers and posters against `public/assets/learning-room/v1/manifest.json` — source and output each once. There is no free camera and no parallax roaming; liveliness comes entirely from Live2D acting in place plus brief feedback, which is a constraint written into the home contract in [PRODUCT.md](../../../PRODUCT.md).

## Packaging and auto-update

`electron-builder.yml`: `appId: com.asklins.astella`, `productName: Astella` (the Chinese display name 拾星笔记 comes from `CFBundleDisplayName` / `WindowsRegistration`), output `release/`, `asar: true` with maximum compression. `files` explicitly excludes `out/renderer/assets/3d/**` and `out/renderer/models/**` — recognition models are an add-on the user downloads in settings, and one careless copy back into `public/` would add 239MB to the installer for nothing.

| Platform | Target | Notes |
| --- | --- | --- |
| macOS | `dmg` + `zip` | `NSMicrophoneUsageDescription` (without it TCC denies `getUserMedia` outright), `hardenedRuntime: true` |
| Windows | Independent WPF x64 installer | Custom wizard, affirmative notice and noncommercial-license consent, custom location, update and uninstall; current user only |
| Linux | `AppImage` | — |

Windows uses the independent .NET 10 / WPF project in `apps/windows-installer/`; no NSIS shell or installation script is used. `scripts/package-windows.mjs` packages the verified application ZIP and manifest with a self-contained native installer and writes `latest.yml`. The wizard requires affirmative consent before proceeding, supports a custom initial location, and retains local data by default when uninstalling. Updates keep the existing directory and profile, use full-download SHA-512 verification, wait for the old application to exit and roll back failed replacement. See the [installer implementation and verification scope](../../../apps/windows-installer/README.md). Artifact names remain ASCII and versions follow the unified release source.

The update source is GitHub Releases, direct (`publish: provider github, owner asklins223, repo Astella`; implementation `src/main/desktop-update.ts`): the check goes to `api.github.com` and the download to GitHub's CDN, **never through `apps/api`** — so your own API being down does not block updates, and update bandwidth does not land on your own servers. The installer downloads directly first and falls back to an accelerated GH-Proxy URL (`https://v4.gh-proxy.org/`) if GitHub is unreachable — same file, same checksum; the README download table lists both links for manual installs.

> Without an Apple certificate, macOS uses complete ad-hoc signing and a stable designated requirement for cross-version updates; users may still need to allow first launch in Privacy & Security. Configuring Developer ID enables developer signing and notarization.

## Tests and source guards

`vitest.config.ts` sets timeouts/setup; DOM tests declare jsdom per file. Some containment tests read `out/`, so build before testing a clean checkout.

| Guard | Assertion |
| --- | --- |
| `component-size-guard.test.ts` | hard ceiling: file 7000 lines / single function 4500 lines / 70 hooks; above the soft line (2000 / 1200 / 25) an entry in the `SIZE_DEBT` ledger is mandatory, naming the next block to extract, and is deleted once done |
| `desktop-ipc-channel-coverage.test.ts` | the channel set in the contract ⇄ the handler set registered in main must be equal |
| `ipc-channel-single-source-guard.test.ts` | channel names may appear only in the contract file, never copied as strings |
| `hud-substrate-guard.test.ts` | the override layer must contain a real volume of `.hud-surface .c` selectors, with no looser bare selector dissolving the scope |
| `renderer-style-closure` / `-dead` / `-order-guard.test.ts`, `css-var-resolution-guard.test.ts` | styles neither dangle nor go dead, order is predictable, every custom property has a reader |
| `*.page-readable.test.tsx` (per domain under `renderer/src/`) | every screen registers the companion's readable views, so her wording matches what is on screen |
| `graph-surface-shape-guard` / `notebook-round-lost-shape-guard` / `home-feature-wiring-guard` | star map and learning-record shapes; home feature ids and `runFeature` branches present on both sides |
| `*-copy-guard.test.ts` | user-facing copy changes have to be accounted for |
| `docs-vite-vars-have-readers.test.ts` | a build-time variable named in the docs must really be read in `src`; if it is named as nonexistent, that same line must say so |

That last guard protects the sentence this page could most easily get wrong: the only occurrence of `VITE_HOME_SCENE_VARIANT` in the repository is an npm script assigning it in `package.json`, `src` has no read site, and `HomeV2Provider` mounts unconditionally at `App.tsx`. Writing "the home scene is flag-switchable with a V1 fallback" would be false — and worse, it would make "just change the release gate" look like a safe decision.

Renderer tests sit next to their domain in each `__tests__/` folder (`components/surfaces/__tests__/` alone holds around 110 entries, covering `notebook-surface.*` draft recovery, late drafts, typing regressions and version labels, plus a `*.page-readable.test.tsx` for every screen that appears in the rail). Handwritten walkthrough records live beside them — `card-study-desk-qa.md`, `companion-center-experience-qa.md`, `search-experience-qa.md`, `star-map-experience-qa.md`, `today-study-experience-qa.md` — and they describe what someone saw in a window at the time, not an acceptance verdict for today.

## Evidence from a live window

Screenshots, tests and source reading each give one kind of evidence, but only attaching to a running window proves what the client shows right now. `scripts/capture-pages-v3.mjs` reads `ASTELLA_CAPTURE_CDP` (fed by the 9222 port that `npm run dev` opens): only when it is set does the script use `connectOverCDP` and drive **the window the user is looking at**, calling `window.reload()` first so it never captures a stale hot-reload graph, then writing results to `.impeccable/review/desktop-pages-v3/live/`. Without the variable it falls back to launching its own fresh copy — whose profile, workspace and reload state all differ from the window under review, which is exactly the proof value being thrown away. Sibling tools split by purpose: `capture-note-pages.mjs` (note bookmarks), `capture-island.mjs` (control island), `capture-evidence.mjs` with `evidence-manifest.ts` (evidence ledger), `smoke-packaged.mjs` (`package:smoke`, run the installed build), `package-evidence.mjs`, `verify-universe-live.mjs`. A family of `probe-note-round-*.mts` scripts targets specific interaction incidents (conflicts, content moved, two windows, resume, save failure), and `note-collab-two-windows.py` with `note-collab-clobber-check.mts` verify concurrency.

## Traps

- **"未接入" (not wired) on a capability chip does not mean it is absent on screen.** `NATIVE_CAPABILITY_CHANNELS` and `transportNativeCapabilities()` (`src/main/desktop-gateway-transport.ts`) only check whether a channel name exists in `DESKTOP_IPC_CHANNELS`, so anything mapped to `null` — `filePicker`, `notifications`, `live2d` — reports 未接入 ("not wired") even though notifications and the companion visibly work. Change that table if the display is wrong; do not change the copy.
- **Deleted code does not come back.** Home V1 (the nine-tile version), the 魔法目录 page and every Live2D form except `whale` were removed rather than deprecated; grepping for them because an old plan or screenshot mentions them will find nothing, correctly.
- **three.js has exactly one consumer.** `surfaces/review/candidate-card-scene.ts` and `candidate-card-geometry.ts` — card thickness, lighting and flip on the candidate review desk only. The home is not 3D, and neither is the star map (hand-drawn canvas).
- **Line and hook counts are not the extraction rule.** `NotebookSurface` has been past 2000 lines for a while and exists legitimately under a `SIZE_DEBT` entry; split by dependency and responsibility, not by metric.
- **`sandbox` and `--no-sandbox` are environment-dependent.** Without that switch the client cannot start in a restricted container; adding it locally throws away the sandbox. Read the comment at `src/main/index.ts` before deciding.
- **Sub-frames get no bridge.** Artifact iframes receive no preload bridge because of `process.isMainFrame`; before adding any iframe, confirm that guard is still in place.
- **The rail's 学习卡 ("study cards") and the code's objective are one screen.** `DIRECTORY_ITEMS`' `goals` entry points at `open-objectives`, rendered by `ObjectiveLibrarySurface` inside `WorkspaceLibrarySurface`; renaming this screen means touching all three places, otherwise the names fork.

## Current state and limits

Full-screen notes, annotations and companion edits have implementation, tests and selected window evidence. Check notebook `__tests__/` experience records and [note-edit validation](../../testing/companion-note-editing-2026-10-08.md) for scope. New-account tours, microphones and cross-device listening still need separate acceptance.

Context governance has database, real-model comparison and selected window samples; “never verified” is outdated. Review compaction continuity and long-term effects in [plan 44](../../plans/learning-companion/44-unified-context-window-and-compaction-2026-10-05.md). Screenshots and code tests do not replace continuous interaction checks.

## Related pages

- [Product overview](./overview.md)
- [Architecture](./architecture.md)
- [Development environment and daily commands](./development.md)
- [API and data](./api-and-data.md)
- [Models and the worker pipeline](./ai-and-companion.md)
- [Unified agent runtime (technical)](./agent-runtime.md)
- [Companion experience (product design)](./companion-experience.md)
- [Testing and quality](./testing-and-quality.md)
- [Operations](./operations.md)
- [FAQ and troubleshooting](./faq-and-troubleshooting.md)
- Repository root: [README.md](../../../README.md), [PRODUCT.md](../../../PRODUCT.md), [DESIGN.md](../../../DESIGN.md), [AGENTS.md](../../../AGENTS.md)
- Current plan index: [docs/plans/learning-companion/README.md](../../plans/learning-companion/README.md) · [41 note and companion learning experience](../../plans/learning-companion/41-note-companion-learning-experience-2026-09-28.md) · [43 companion guidance and space arrival](../../plans/learning-companion/43-companion-guidance-and-space-arrival-2026-10-04.md) · [44 context governance](../../plans/learning-companion/44-unified-context-window-and-compaction-2026-10-05.md)
