## iOS note subpages design pass — 2026-10-21

User decision this round: the note module's subpages still looked bad, and only iOS should be reworked for now.

- **One page language.** 速览、脑图、版本记录、批注抽屉与拓展笔记 now share an eyebrow (10.5 pt, 2.2 tracking), a Songti title (20–23 pt) and hairline separators instead of a stack of unrelated glass cards. Reader quotations and numerals use the serif face.
- **速览.** Opens at `.fraction(0.95)`. The header carries 「速览 · 第 N 版」 and the real note title; 核心脉络 is one paper sheet with an inset accent rule, and 要点与原文 is one sheet whose rows are separated by hairlines, each with a serif number and the original sentence in a low-contrast inset. The duplicate source card was removed.
- **脑图.** Rewritten canvas: three columns (中心 → 分支 → 要点), dark ink seal for the root, accent rule on branches, dot + one-line explanation on leaves, dotted paper grid, curved links. The layout now distributes leaf rows over the available height; default zoom fits the width and the dock holds zoom out / 适应 / zoom in / 重新生成. The old 12 pt text cards and the duplicate top 「适应」 pill are gone.
- **版本记录.** Timeline with a per-row rail that starts and ends on real dots, so it no longer floats above/below the list. Current version shows the writing pill 「正在读」 and a 3-line excerpt; older rows offer 「恢复这一版」. Date copy is `M 月 d 日 · HH:mm`; empty state explains how future saves append.
- **批注.** Serif header and excerpt, companion explanations on a sky sheet with a round glyph, user notes on paper, compact capsule actions (修改 / 请伴星讲解 / 撤下). A new annotation opens the drawer at `.fraction(0.95)` so the excerpt, editor and save button are all visible together; the excerpt is capped at six lines with 「回到原文」 still available. Sheet errors still surface below the actions.
- **阅读页 / 书房.** The version entry is now a 34 pt capsule (「第 N 版 · 最近更新」) instead of a 68 pt glass card; shelf rows use a Songti title and a `今天 / 昨天 / M 月 d 日` date (date-only strings no longer fall back to 刚刚, which also fixes the previous 「刚刚」 for `yyyy-MM-dd`).
- **Fixtures (DEBUG only).** `note-versions` now returns two deterministic versions so the timeline can be inspected without a backend; existing note review modes are unchanged.
- **Verification.** `xcodebuild -project apps/mobile-client/ios/Astella.xcodeproj -scheme Astella -sdk iphonesimulator -configuration Debug build CODE_SIGNING_ALLOWED=NO` exits 0 with no NotesScreen warnings. Simulator captures on iPhone 18 Pro Max / iOS 27 (installed Debug build, `--ui-review=` modes): library, read, note-overview-ready, note-mind-map, note-annotations, note-explain, note-explain-ready, note-versions, note-expansion, note-learning-card. Files: `apps/mobile-client/outputs/notes-subpages-2026-10-21/`. A dark-appearance smoke check (`study.appearance.mode=dark`) covered the mind map and 速览; the mind-map root switched to a fixed deep-navy seal and leaf highlights no longer hard-code white. The simulator preference was restored to light afterwards.
- **Limits.** Backend generation, restore and annotation writes were not exercised (the API is unauthenticated in this environment, 403); only the review fixtures and reader UI were rendered. Android notes were left untouched. The annotation screenshots still show a fixture-only 「批注信息不完整」 error because the fixture anchor does not match the review block. Overflow at the largest accessibility text sizes and physical-device feel were not measured.

## iOS companion home: transient speech and a bigger stage — 2026-10-21

User decisions this round (iOS only): remove the 「回想练习」「今日手边」 shortcuts and the 「继续一起读」 card from the companion home; make the companion larger and adjust her placement; the reply bubble must not be permanent — it appears while she is speaking and leaves by itself when she finishes; drop the 「阿星轻轻说」 label from the bubble.

- **Speech bubble is now a transient utterance.** `CompanionScene` keeps a small speech lifecycle instead of rendering the last assistant message forever. The bubble opens when a turn starts (`isSending` or an active run), follows `streamingText` while the answer is written, stays while the saved answer is read aloud (the playback object now exposes `spokenText`), and closes after a short reading beat once the turn and audio are done. The idle home has no bubble at all; the historical greeting no longer reappears on launch or after returning from 记录.
- **Lifecycle edge cases.** The first page of loaded history is admitted without speaking; a newly persisted reply replaces the streamed snapshot before the linger is measured; a reply that arrives without a watched turn (proactive message) is shown once and then leaves; a new turn clears the previous lingering sentence to three dots until its first words arrive; a failed turn grants the same short grace instead of cutting the bubble instantly. Reduce Motion keeps the opacity fade but removes the scale/offset and the dot loop.
- **Composition.** `CompanionScene` no longer has the quick-action row, the reading row, or their helpers. A `CompanionStageLayout` fits the 440×534 artwork to the page, centers its *visible* pixels, and reserves a bubble band above the headdress (the PNG has ~23% transparent headroom), so the bubble floats above her head without covering it. On iPhone 18 Pro Max the visible artwork grows to ≈415×388 pt (previously ≈305×285); short pages shrink the artwork so a three-line bubble still clears her head. The live 「正在发生」 progress card stays as a bottom overlay while a run is active.
- **Entry points preserved.** 记录 is still the top-bar segment (回想记录), 手边 still lives in 星轨, and continuing a note still happens in 书房, so the removed home shortcuts do not remove capabilities. `DESIGN_SPEC.md` records the new home rule.
- **Review fixture.** Added `ASTELLA_UI_REVIEW=conversation-speaking` (DEBUG only): an active run plus streaming text so the transient bubble and progress card can be inspected without a live backend.
- **Verification.** Final `xcodebuild -project ios/Astella.xcodeproj -scheme Astella -destination 'id=D7787BF2…' CODE_SIGNING_ALLOWED=NO build` exits 0. Real-window screenshots on iPhone 18 Pro Max / iOS 27 and iPhone 18 Pro / iOS 27: idle home (bubble absent), speaking home (bubble without label, enlarged artwork, progress card), compact-height layout, and a dark-appearance smoke check. Auto-dismiss was checked with a temporary fixture that completed the turn after 20 s: the bubble was still present while the run was active, and gone (~3 s after completion) in the next capture; that temporary code was removed before the final build. `git diff --check -- apps/mobile-client` clean.
- **Limits.** The review fixture forces the known static-artwork fallback, so the Live2D slot, real streamed deltas and server TTS ending were not exercised in this pass (the playback end path is code-verified). No VoiceOver announcement is posted for the transient bubble; the full conversation remains readable in 记录. Timing was checked from screenshots, not video, so rapid re-send/interrupt frames and physical-device refresh were not measured. Screenshots: `apps/mobile-client/outputs/companion-home-transient-2026-10-21/`.

## Mobile note-card flow and design-quality pass, both platforms — 2026-10-21

User decisions this round: connect 拓展笔记 and the new client 学习卡 (including answering) on both native clients; then, after reviewing the Android result page, the user required 学习卡 to be its own dedicated page and rejected the design as 「全部东西挤在一起，没层级，没动效，没布局，没设计。贼难看」. Scope confirmed with the user: all 学习卡 pages, the 拓展笔记 drawer, 手记阅读页/书库, and 星轨/伴星/我的 surfaces, on **both** iOS and Android, staying within the existing mobile visual language.

- **Systemic AI-consent contract fix (both clients).** `GET /me/ai-settings` returns `requiresConsent = systemUsesExternalAI()` — a deployment capability flag that stays true for every account — while the account's signature lives in `consentVersion`/`consentAt`. Both apps treated `requiresConsent` as "still unsigned", so a correctly signed account saw 「需要授权」 and every generate path was disabled locally (`ai_consent_required`), including 学习卡/拓展笔记/速览/脑图. iOS now derives `isSigned`/`needsSigning`/`canUseExternalAI` on `AISettings`; Android derives `signed`/`needsSigning`. Gates are `!needsSigning && sendToExternal`, notices use `needsSigning`, and accepting consent records the signature instead of faking the capability flag. Verified on `owner@astella.local` (real card generation, real expansion generation, honest failure states).
- **iOS — 学习卡 (kept its dedicated `.fullScreenCover` page).** Front rebuilt around a hero (version pill, Songti title, 0–5 star row, 54/82pt score numeral with 最佳得分, hairline stat cells, one primary CTA, one 最近一次 row, quiet regenerate link) with explicit empty/generating states. Practice: type chip + 第 x/N + real progress bar, large stem, ≥56pt option rows, all eight editors restyled, material bottom action bar, reduce-motion-gated slide+fade between questions. Result: score count-up + animated star fill, 全部/错题/跳过 filters, collapsible review cards whose expanded state uses muted labels on separate lines (你的作答 / 参考答案 / 评分要点 / 伴星点评 / 原文依据 + AI/web extension), a 本次点评 section, and 再练一次 / 回到学习卡. No answer or grounding is exposed before submit.
- **iOS — 拓展笔记 drawer and note surfaces.** Editorial two-line header, source-note card, existing links shown first (direction pill), 全选/取消全选 with count, draft cards (title, relationship, quoted 原文依据 with accent rule, 正文预览), sticky action dock; 书库 gained a section header/count and larger cover rows with two-line snippets; the reader got tighter title tracking and more body rhythm.
- **iOS — shell surfaces.** 相伴/记录 rebuilt around one focal speech card + stage, record mode with day rules and readable bubbles, collapsed one-line process row expanding into a timeline, content-layer failure notice; 星轨 gained a compact constellation hero, full-width lens, per-section headers/actions, date-rail diary cards and grouped memory cards; 我的/设置 normalized to a 56pt paper row system with 26pt section rhythm; local `shellEntrance` stagger (45ms) plus matched-geometry lenses, all gated by reduce motion. `Design/*` untouched.
- **Android — 学习卡 is now a dedicated full-screen destination** rendered as an animated page push instead of a 96% `ModalBottomSheet` (no grabber/sheet), with the same information hierarchy as iOS: hero stars/score/stat cells + one CTA, airy practice with progress/stem/≥52dp options and independent bottom action surface, result with hero score, filters, collapsible labeled review cards, 本次点评, pinned 回到学习卡/再练一次. `NoteExpansion.kt` drawer re-spaced with draft hierarchy and 全选/取消全选; 书库/阅读页 hierarchy aligned.
- **Android — shell surfaces.** Shared shell kit (`ShellSectionHeader`, `Hairline`, `QuietTextAction`, `ShellNotice`, `StaggerReveal`) keeps Me/Settings rows consistent while conversation, 星轨 (hero/lens/section headers/grouped rows), diary and memory details were restyled; motion uses `MotionTokens` springs with `LocalReduceMotion` gating.
- **Other real defects fixed in this pass.** iOS composer regression from the interrupted dock refactor (the shell-level bottom inset does not reach `NavigationStack` content; the reserve moved into `root(_:)`, so the composer floats above the persistent dock again). iOS expansion confirm returned 500 because generation-only draft fields were sent to the strict review schema — the payload is now projected to `{candidateId,title,blocks,selected}` and real confirms create notes. iOS answer autosave cancellation no longer raises a failure banner. Android attempts never loaded because `cardId` was captured in the initial composition; autosave is debounced and grading polling extended.
- **Verification.** iOS: final `xcodebuild` on the real tree exits 0; 30+ real-window screenshots (`/tmp/ios-design-shots/`, `/tmp/ios-shell-shots/after-*.png`, `/tmp/final-ios-*`), including reduce-motion and dark smoke captures. Android: final `./gradlew assembleDebug` exits 0 on the combined tree; APK installed on the AstellaQA AVD and checked in-window (`/tmp/final-and-*.png`, `/tmp/and_5*.png`), dark and reduce-motion states included. `git diff --check -- apps/mobile-client` clean; the temporary XCUITest harness was removed (no pbxproj/scheme residue).
- **Limits.** `matching`/`operation` card editors have no real card data on the dev account and no fixture on either platform — code/compile-verified only. iOS card empty/generating states are code-verified (the fixtures always render a card). Android Me/Settings detail pages were restyled but not all re-captured after the final build. Motion was inspected through code, screenshots and reduce-motion captures rather than video; rapid-interrupt/reversal checks remain open. Card-front stat cells repeat information that also appears in the header and the 最近一次 row — a follow-up hierarchy/duplication polish item, not a defect.

## Android → iOS parity pass, account and companion surfaces — 2026-10-21

Follow-up to the reader/feature pass below, using the current iOS `HandAndAccountScreens.swift` and `SettingsDetailScreens.swift` as the reference.

- **Companion center.** Replaced the portrait/status list with the iOS composition: a 160dp gradient hero (stage art, live status line, workspace), a recent-exchange card (4-line markdown, `继续对话` / `完整记录` capsules), `相伴 · 留下的记录` shortcuts to memory and diary, and the `伴星配置` row. The status line now follows iOS (`正在回应` / `语音交流已连接` / `随时可以继续交流`) instead of showing the raw socket state. Shortcuts call the existing `openOrbitSection("memory")` / `("diary")` path.
- **Companion settings.** Split the old hub/config page into two routes. The config page now has only the iOS groups `表达设定 / 相处方式 / 声音与语音` with the same rows and copy; profile and conventions push on top of it.
- **Permissions, AI authorization, profile, conventions.** Rebuilt each against the current iOS source: the 34dp circular companion bubble and paper bubble; real runtime permission states with `已允许 / 未请求 / 已拒绝 / 系统按次授权 / 未使用` and denied-path guidance; the AI consent card with signed version and export; the profile avatar picker, inline name+save, email row and account rows; conventions list/add/remove with revision-conflict retention and a paper secondary button.
- **Account navigation.** Replaced the fixed parent-table back rules with a route stack. System back and header back now return to the page actually opened from (`我的 → 个人约定 → 我的`, `伴星中心 → 伴星配置 → 个人约定 → 伴星配置`, and so on).
- **Reader + library.** Quote blocks now render with the accent rule, italic serif text and muted color; `[label](astella-note:…)` links are clickable and open the referenced note; code blocks use the compact rounded paper treatment. The library download action now really exports `GET /export/workspace` and opens the system share sheet; the library header and note rows follow the iOS hierarchy.
- **Export API fix.** The Android export exposed a real 500: the size guard counted card questions/answers with a predicate on the parent table without putting that table in FROM (`missing FROM-clause entry for table "note_learning_cards"`). Both counts now `innerJoin` their parent tables. Added `apps/api/src/__tests__/export-service-size-guard.test.ts`, which fails if any count query references a table that is neither its FROM nor a JOIN.
- **Verification.** Android Debug APK built with `JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew :app:assembleDebug` and installed on the Pixel 8 / API 36 AVD. Real-window checks: library redesign, reader quote/list/code/link, export share sheet after the API fix, permissions, AI authorization, profile (including long-email ellipsis), conventions empty state plus add → save → remove against the real API, companion hub, companion settings, and the back-stack paths listed above. `apps/api` `npm run typecheck` passed, the new guard test passed, and `git diff --check -- apps/mobile-client apps/api/src/modules/export apps/api/src/__tests__/export-service-size-guard.test.ts` passed. Screenshots: `/tmp/and-profile-final2.png`, `/tmp/and-conventions4.png`, `/tmp/and-permissions-final.png`, `/tmp/and-hub-redesign2.png`, `/tmp/and-companion-settings-final3.png`.
- **Limits.** The headless AVD became unstable after repeated cold boots, so the hub's memory/diary shortcut taps and a light-theme hub capture were not completed; that wiring is type-checked but not touch-verified. Recent hub/settings screenshots are dark-theme only. The export share sheet was verified before the final navigation/hub build, against the same API fix. No physical Android device, IME rapid open/close, large-font, or sustained-frame-rate checks were done in this follow-up. iOS was not modified.

## Android → iOS parity pass — 2026-10-21

User decision this round: Android's UI and overall completion lag behind iOS, and Android should follow the current iOS implementation rather than keep its older 2026-10-19 pages ("所有都要"). iOS source is the reference; Android keeps Compose-native controls and Material 3 semantic colors.

- **Reader.** Rebuilt the top matter to the iOS structure: `手记 · 第 N 版 · 个人书房` eyebrow, real note snippet as subtitle, glass version row with `最近更新 · M 月 d 日`, and a smaller serif body (16 sp; headings 21 sp). Annotations now follow their paragraph: one annotation shows `我的批注` / `伴星讲解`, several show `N 条批注` with an expandable list. Tapping opens an annotation drawer that creates, shows, edits (PATCH with `expectedRevision`), re-asks the companion, locates the block, and removes with confirmation. Text selection gained a `留批注` action. The tools sheet is now `速览 / 脑图 / 版本` plus `在对话里继续提问`, matching iOS; the standalone 讲解 page was removed because iOS now explains through annotations.
- **Feature pages.** 速览, 脑图 and 版本 follow the iOS layout: detail header, glass source-note line, primer card (numbered rows + real excerpt), overview summary card and numbered point cards with quoted passages, a pannable/pinch-zoomable mind-map canvas with curved connectors, and the version sheet list with current badge and restore dialog.
- **Orbit.** The header now uses the iOS `聊聊今天` pill (opens the conversation with a reviewable prompt and focuses the composer) instead of refresh. 伴星记忆 gained the three groups (关于你的 / 她的记事 / 目标与方法), the five filters, the iOS card hierarchy, and tappable cards. Added memory detail (revise with revision check, pin/unpin, archive/restore, dispute, delete-to-recycle, revision history) and the memory recycle sheet (restore / erase), both against the existing `/companion/memory` routes.
- **Conversation.** Added the right-side quick buttons (回想练习 / 今日手边) and a Markdown-lite renderer for assistant text and streaming, covering bold, italic, inline code, headings and list bullets so raw markers no longer surface in bubbles.
- **Verification.** `JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew --offline assembleDebug --console=plain` succeeded; the APK installed on the Pixel 8 / API 36 emulator. Window checks: reader with real note, 速览 primer, 脑图 primer, 版本 list, annotation create → view → edit state → remove against the real API, Orbit memory groups, memory detail, and the empty recycle sheet. Screenshots: `/tmp/and-reader2.png`, `/tmp/and-overview.png`, `/tmp/and-mindmap.png`, `/tmp/and-versions.png`, `/tmp/and-drawer.png`, `/tmp/and-after-save.png`, `/tmp/and-memory2.png`, `/tmp/and-memorydetail2.png`, `/tmp/and-recycle.png`. `git diff --check -- apps/mobile-client/android` passed.
- **Limits.** The QA account has not signed AI consent, so generated 速览/脑图 results and companion explanations were not exercised. Memory mutations (pin/archive/dispute/revise), recycle restore/erase (recycle was empty), iOS window comparison, dark theme and physical-device feel remain unverified. iOS was not modified in this pass.

## iOS design-reference pass — 2026-10-19

Same reference project and the same rendered route captures (`/tmp/ref-shots`). iOS keeps SwiftUI-native glass materials, `NavigationStack`, matched geometry and springs, while layout, hierarchy, copy and geometry follow the mockup.

- Reader rebuilt around the mockup: floating 44pt back glass circle, centered "第 N 版 · 一起读", floating T/tools glass pill, book-glyph metadata eyebrow, 39pt Songti title with 3pt tracking, glass version row, Songti body at the chosen point size with two-character first-line indent, wider paragraph gaps, and no full-width bottom CTA (the shell companion orb remains). Selection offsets are unchanged; the T and grid actions preserve 阅读与显示 / 速览 / 脑图 / 讲解 / 版本 routes.
- Library: faint 资料与处理状态 footer with a truthful local status sheet; covers resized to 35×49. Home: header segment narrowed to the mockup proportion with the chevron hugging the workspace label; stage-card label/reply typography enlarged.
- Me/Settings stack: shared 44pt back-circle + 32pt title header, 17/11 typographic rows, 36pt icon tiles, 68pt divider inset, unclipped companion-card art, 修改密码 row and a real `POST /auth/change-password` screen, settings wordmark. 设备权限, AI 使用授权与数据, 服务地址, 个人约定, 阅读与显示 and 伴星配置 rebuilt to the mockup's page model while keeping real permission, consent, participation, export and attendance endpoints.
- Orbit memory now has the mockup's sub-segments (关于你的/她的记事/目标与方法) and filter chips; auth gained the login channel label and the subpage brand row/step caption; the companion-center blank gap was removed.
- `xcodebuild` Debug build for iPhone 18 Pro Max / iOS 27 succeeded (`CODE_SIGNING_ALLOWED=NO`, exit 0; remaining warnings are the existing Cubism SDK/linker-version warnings). `git diff --check -- apps/mobile-client/ios` passed. Fresh route captures: `/tmp/ios-final-*` and contact sheets `/tmp/ios-final-home-library-contact.png`, `/tmp/ios-final-orbit-me-contact.png`, `/tmp/ios-final-settings-contact.png`, `/tmp/ios-final-auth-contact.png`.
- Limits: no Simulator.app on this host, so no touch/keyboard/VoiceOver session; signed-in captures used DEBUG-only review fixtures (`ASTELLA_UI_REVIEW`, no effect on Release) rather than a logged-in API session. Real Dynamic Type extremes, Reduce Motion/Transparency rendering, the export share sheet, password change submission, TTS and physical-device feel were not exercised. Data-dependent copy (workspace name, note metadata, reader subtitle) still differs from the mockup because the product API does not carry author/category/version in list rows.

## Android design-reference pass — 2026-10-19

This pass follows the same OpenDesign mockup (`/Users/asklins/Library/Application Support/Open Design/namespaces/release-stable/data/projects/astella-3df6/index.html`); rendered reference screens for every route were captured at `/tmp/ref-shots/*.png` at 390×844@2x. User decision for this round: iOS may keep native system glass and animations, while Android must follow the mockup's own glass/segmented/cover language rather than Material defaults.

- **Glass foundation.** Rewrote the shared glass material as background blur + a 142° white-to-pale-blue sheen + a white-to-grey-blue hairline edge + a soft neutral shadow (with a solid fallback below API 31). Added the mockup's segmented control with a sliding near-white lens, glass dock and lens, glass circular buttons, section labels/page eyebrows at 11/600/1.6 tracking, the 37–39px page title scale, vertical serif book covers in five stable paper colours, and a custom A—A reading-size slider without M3 tick marks or bar thumbs.
- **Pages brought to reference structure.** Companion and record home (stage reply card radius 24/7, 继续一起读 reading object with rotated cover and 上次停下的那一页, record-mode 阿星 header, composer + dock in one glass plate with divider); 书房 (page heading, circular export/import actions, space bar with 切换, continuous note rows with hairline dividers and 资料与处理状态); 阅读 (floating back circle, centred version label, floating T/grid pill, metadata eyebrow, 39pt serif title, light-blue version plate, Songti-equivalent body with 2-em first-line indent and 25pt paragraph gaps, companion orb instead of the old full-width CTA); 星轨 (real 14-day star hero, glass segment with lens + refresh action, diary cards with day/month tiles and real daily summaries, memory filter chips and evidence badges, 手边 run and proposal cards); 我的 (glass avatar header with settings grid + 编辑 pill, light-blue companion card, 和伴星相处/阅读/隐私与高级 groups with 36dp icon tiles, T tile for reading size).
- **New settings stack in the mockup's page model.** 设置 (appearance segment 银白/深空/随日夜, 阅读设置, 轻柔动效, 伴星与隐私, 资料与连接, 关于), 阅读与显示, 设备权限 (real runtime microphone state; photo/file picker and unused camera/notification rows stated honestly), AI 使用授权与数据 (real consent/policy endpoints), 服务地址, 个人约定 (real `/me/companion/participation` with revision conflict handling), 个人资料, 修改密码 and 伴星配置. Inline account expansions were replaced by these routes.
- **Navigation corrections.** Every tab/subpage action now clears sibling subroutes (feature → account, note → account, account → tab); system back returns 阅读与显示/设备权限/AI 授权/服务地址 to 设置 and 个人约定/个人资料 to 伴星配置 instead of jumping straight to 我的; the reader's companion orb continues with the current note version. The 设置 subpage header back controls carry accessibility labels.
- **Verification.** `JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew --offline assembleDebug --console=plain` succeeded; the APK was installed on the Pixel 8 / API 36 emulator. Captured and inspected home (companion), record, 书房, 阅读, reader action sheet, 速览, 星轨 日记/伴星记忆/手边, 我的, 设置, 阅读与显示, 设备权限, AI 使用授权与数据, 服务地址, 个人资料, 个人约定, 伴星配置 and 登录; also logged out and re-logged in with the isolated QA account to confirm the auth path and session restore. `git diff --check -- apps/mobile-client/android` passed.
- **Limits.** Emulator only, no physical Android device; no automated tests added or run. The QA account still has not signed the AI agreement, so generated overview/mindmap/explanation results and TTS were not exercised. The Live2D manifest still returns 502, so the companion remains the static fallback. Dark theme, narrow width, large font, IME rapid open/close and real scrolling performance were not re-verified this round; the iOS part of the same reference pass is recorded separately.

## Android bookshelf and reader pass — 2026-10-19

This pass follows the local OpenDesign project at `/Users/asklins/Library/Application Support/Open Design/namespaces/release-stable/data/projects/astella-3df6/index.html` and the prior implementation review in the “Implement the mobile app design” conversation. The useful practice carried forward was to compare the reference and the live native app at the same viewport, retain real application state and routes, and use a prototype only to understand hierarchy and visual intent.

- Reworked the Android bookshelf into a continuous list and order it by the actual last-opened note when available. The companion shortcut uses the same recent note, with an honest recently-updated fallback when there is no reading history.
- The reader now uses a compact floating toolbar, a lighter current-version row, and serif title/body typography while retaining native text selection, real note blocks, and the existing question and feature routes. Reader-size choices persist locally. The app also saves a visible block ordinal scoped to the signed-in user and workspace, then restores that anchor when reopening a note.
- Built with `JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew --offline assembleDebug --console=plain` from `apps/mobile-client/android`; build succeeded. `git diff --check -- apps/mobile-client/android` passed. Installed and inspected the build in the Pixel 8 / API 36 Android Preview window: companion home, bookshelf ordering, note reader, reader-size sheet and size change, Orbit's real empty state, and the profile page. No automated tests were run.
- The available QA note fit within the viewport, so the saved reading-anchor restoration after a real scroll and reopen remains unverified. Other Android routes still need their own design-reference pass. The build reports an existing unnecessary safe-call warning in `LibraryScreens.kt` and Gradle deprecation warnings.

# 原生手机页面多轮审查记录

## iOS full-page visual pass — 2026-10-19

The current reference is the local OpenDesign project at `/Users/asklins/Library/Application Support/Open Design/namespaces/release-stable/data/projects/astella-3df6/index.html`, including its `v3.js` and `v3.css`. This pass captured and inspected 33 iOS routes: nine authentication states and 24 signed-in page states. All signed-in routes were captured on iPhone 18 Pro Max / iOS 27; the four root tabs plus login and registration verification were also checked at the smaller iPhone 17e size.

- Fixed a narrow-width overflow in the conversation header. Long workspace names now truncate within the available width, and the mode switch, appearance control, and model fallback card stay within the screen bounds.
- Matched the reference's 128-point scroll clearance at the bottom of the Library, Orbit, and Account root pages so long lists can scroll clear of the floating dock.
- Applied both the app-level and system “Reduce Motion” settings to shared button press feedback, authentication primary-button feedback, custom toggles, and the appearance selector's moving selection lens.
- Verified the root navigation has four items (`相伴 / 书房 / 星轨 / 我的`), with `手边` inside Orbit; detail pages use their own header and companion shortcut.
- Captured route contact sheets at `/private/tmp/study-ios-audit-auth-contact.png`, `/private/tmp/study-ios-audit-reading-contact.png`, `/private/tmp/study-ios-audit-orbit-account-contact.png`, and `/private/tmp/study-ios-audit-settings-contact.png`. The narrow-width conversation fix is `/private/tmp/study-ios-audit-small-conversation-fixed.png`.
- Removed the temporary Debug route and token-injection code after capture. The standard iOS Simulator Debug build succeeded; the rebuilt app installed and launched on iPhone 18 Pro Max / iOS 27, with a clean login screenshot at `/private/tmp/study-ios-audit-final-clean-login-after-build.png`. `git diff --check -- apps/mobile-client/ios/Astella apps/mobile-client/MOBILE_AUDIT.md` passed. No automated tests were added or run. The existing Cubism archive emits a warning that its simulator objects were built for iOS 26.2 while the app links for iOS 18.0.

**Remaining evidence limits:** this Xcode installation has no `Simulator.app`, so screenshots came from `simctl`; there was no manual touch, keyboard, VoiceOver, or accessibility-tree walkthrough, and no physical iPhone test. Screenshots used an isolated `.test` QA account. The companion model manifest returned 502, so the UI correctly shows its static fallback/error card; the QA account has no generated diary, so diary detail remains a real empty state. AI consent is unsigned, so successful AI-generation screens were not exercised. These states are not counted as successful service or interaction tests.

## 2026-10-19 iOS reading continuity repair

The “last page” claim on the companion screen was not backed by reader state: opening it always showed the start of the note, and the library's featured-note view existed but was not connected. iOS now stores the last opened note and the visible paragraph ordinal in local preferences scoped to the signed-in user and workspace. Opening a note restores its last visible paragraph, including when returning from the selection sheet. The library now presents the last opened note when available and labels the first-use fallback as the most recently updated note; the companion shortcut follows the same recent-note choice.

- The reading anchor is a note block ordinal rather than a pixel offset, so changing text size returns to the same paragraph. The position remains local to this device, consistent with Plan 51's first-release boundary; shared cross-device reading handoff remains future work.
- iOS Simulator Debug build succeeded and the clean app launched on iPhone 18 Pro Max / iOS 27. The captured current-window screenshot is `/tmp/study-ios-reading-resume-final-stable.png`; it shows the unauthenticated login screen. The host's Xcode installation has no `Simulator.app`, so `simctl` can install, launch, and capture the app, but this change has not yet received logged-in scrolling/reopen touch verification.
- No automated tests were run. The latest build still emits the existing Cubism archive warning that its simulator objects were built for iOS 26.2 while the app deployment target is iOS 18.0.

## 2026-10-18 iOS 优先收口 — Android 暂停

用户已把当前阶段切换为先完成 iOS，Android 暂停。本节仅记录本轮 iOS 变更，不代表所有 iOS 页面已完成窗口验收。

- 主 Shell 在四个根页面共用品牌／工作区页眉。非相伴根页面底部为「相伴／书房／星轨／我的」四栏，右侧单独显示伴星头像；从阅读或设置子页仅保留伴星入口，不重复显示根导航。头像入口返回相伴场景。
- 我的账户入口使用真实昵称或邮箱首字母。设置、伴星中心和从 AI 错误提示进入账户的导航都改为路径式路由，使 Shell 能正确识别根页面与子页面，避免子页重复页眉或 Dock。
- 页面窗口复核发现共享页眉曾与书房／星轨／我的页面内容重叠；已把页眉放入 Shell 的纵向布局，单独占据高度。
- iOS 手记页按手机验收图重新整理为「留住你的思路／手记／篇数／搜索／继续阅读／其他手记」层级；移除封面缩略图与重复的空间卡片。工作区继续由共享页眉切换，导入与刷新保留在手记操作菜单中。
- 登录页保留单一的邮箱验证码与注册入口；之前发现的重复验证码入口已移除。
- 四个根页面截图已由 iPhone 18 Pro Max / iOS 27 模拟器渲染：`/tmp/study-ios-conversation-fixed.png`、`/tmp/study-ios-library-fixed.png`、`/tmp/study-ios-orbit-fixed.png`、`/tmp/study-ios-me-fixed.png`。为绕过尚无登录会话的限制，截图时临时使用 Debug 本地样例资料；样例启动代码已在截图后移除，因此这些截图确认页面布局，不代表真实账户数据、服务端状态或登录后触控流程。
- 清理截图夹具后的 iOS Simulator Debug `xcodebuild` 通过；`git diff --check -- apps/mobile-client/ios/Astella` 与本记录的格式检查通过。没有运行自动化测试。
- 该 Xcode 安装没有 Simulator 桌面应用；`simctl` 可安装、启动和截图但无法手动点按。清理夹具后的当前登录页截图为 `/tmp/study-ios-login-final-clean.png`。Cubism 静态库仍报告按 Simulator 26.2 构建、当前链接目标为 iOS 18.0 的版本警告。

## 2026-10-18 按最新 OpenDesign 手机稿纠正导航与页面 — 当前基线

本节以 `/Users/asklins/Library/Application Support/Open Design/namespaces/release-stable/data/projects/astella-3df6/index.html`、其同目录说明文件和用户最新明确指正为准。此前把「手边」当作主导航，是错误理解；稿件对应的底部四栏为「相伴／书房／星轨／我的」，「手边」只作为星轨内的次级内容。登录页与所有内页也必须按各自设计内容逐页实现，不能只换图标或沿用旧布局。

- 双端主 Shell 已调整为四栏，移除「手边」根 Tab；书房、星轨和我的分别承接手记列表、日记／伴星记忆／手边，以及账户设置等真实产品能力。星轨首页以真实日记数据计算相伴天数和点亮星数，不把原型样例文字当成用户数据。
- 相伴页按稿件重排为工作区／伴星与记录切换／主题入口、对话气泡、角色舞台、可续读手记和底部输入器；已移除稿件里不存在的建议动作卡和独立发送键。保留真实发送、录音、手记续读等产品行为。
- 书房和星轨使用稿件的栏目层级、标题、说明和页面职责；我的页显示真实相伴天数及今日记录数量，并保留通往真实设置、伴星中心的入口。登录页按稿件的品牌标题、副标题、字段标签、找回密码、登录／注册与法律说明逐项对照；最终 iOS 窗口复核还发现并移除了重复出现的验证码登录入口。
- 通用系统图标已在相关自定义页面替换为 Astella glyph。iOS 以 SwiftUI 系统材质与原生弹簧完成触感；Android 以 Compose／Material 3 和单一系统蓝表达相同层级。原生键盘、文档选择器和文本选择菜单继续使用平台控件。
- 星轨所需的首条已生成日记日期由 `GET /companion/daily/month` 提供；我的页统计调用日记月汇总和今日列表接口。服务端若无日记或接口失败，页面给出空态／不可用状态，不虚构数字。
- 本节覆盖的源码已通过 Android `assembleDebug`、iOS Simulator Debug `xcodebuild` 与 API `npm run typecheck`；没有运行测试套件。模拟器检查以本节补记的最终构建截图为准。Android SDK 与 AVD 在 `/Volumes/asklins/Android`。

### 最终构建窗口复核 — 2026-10-18

- Android 最终 Debug APK 通过 `JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew --offline assembleDebug --console=plain`，已安装到外置盘 Pixel 8 / API 36 AVD。模拟器安装期间曾遇到系统启动未完成与 Package Manager 服务不可用；保留 AVD 数据重启后服务恢复，最终安装和启动成功。未清除用户数据。
- Android 窗口截图：`/tmp/study-android-final-home-now.png`（相伴）、`/tmp/study-android-final-library.png`（书房）、`/tmp/study-android-final-orbit.png`（星轨，内部分段可见「日记／伴星记忆／手边」）、`/tmp/study-android-final-account.png`（我的）、`/tmp/study-android-final-settings.png`（阅读与个人约定设置）、`/tmp/study-android-final-companion-center.png`（伴星中心）和 `/tmp/study-android-final-note-detail.png`（手记详情）。实际画面确认底部四栏与「手边」只在星轨内。我的页、设置和伴星中心显示 `10.0.2.2:4000` 连接错误／重连态，日记统计接口不可用，因此只确认这些降级画面，没有确认真实统计和服务端内容成功态。手记详情显示的是已缓存的本机 TXT 导入手记。
- iOS 最新 SwiftUI 构建通过 `xcodebuild -quiet -project apps/mobile-client/ios/Astella.xcodeproj -scheme Astella -configuration Debug -sdk iphonesimulator -destination 'id=D7787BF2-9BDA-4135-A3DF-74678E45ACD4' -derivedDataPath /tmp/study-ios-design-derived CODE_SIGNING_ALLOWED=NO build`，安装并启动于 iPhone 18 Pro Max / iOS 27。窗口截图 `/tmp/study-ios-final-login.png` 确认品牌、邮箱／密码字段、找回密码、登录按钮和验证码／注册链接；删掉了原先重复展示的验证码登录按钮。iOS 当前能截图但没有图形触控会话，本轮没有把登录后页面记作交互验收通过。
- API `npm run typecheck`（`apps/api`）通过。`git diff --check -- apps/mobile-client apps/api/src/modules/companion-conversation/daily-summary-routes.ts` 通过；没有运行自动化测试。

**验收边界：** 本轮实际检查了 Android 四个主页面及设置、伴星中心、手记详情和 iOS 登录页，不等于整套双端逐页验收；Android 服务端在线时的真实统计态、iOS 登录后内页与触控、两端其余流程、真机权限／音频／持续帧率仍待后续检查。模拟器结果不外推为实体机表现。

## 历史记录（旧导航决策；已由上面的四栏设计基线替代）

## 原生导航第二轮与真实登录态复核 — 2026-10-18

本轮接着上一节完成 Android 登录态核验，并重建／安装了当前双端 Debug 包。Android SDK 与 Pixel 8 AVD 均从 `/Volumes/asklins/Android` 运行；`emulator-5554` 为 Pixel 8 / API 36，系统动画比例和字体比例在结束时均恢复为 `1.0`。JDK 17 位于 `/opt/homebrew/opt/openjdk@17`，当前 shell 需显式设置 `JAVA_HOME` 才能启动 Gradle。

- **测试身份与数据：** 使用一次性本地开发验证码记录，通过正式 `/auth/register-v2` 流程建立隔离的 `.test` 账号，并通过真实 `/notes` API 创建一篇包含标题、正文、引用、列表与代码的手记。没有发送邮件、签署 AI 协议或请求模型生成；密码仅保存在权限为 0600 的 `/tmp/study-mobile-qa-credentials.json`，不进仓库。
- **Android 主流程：** 使用已安装原生 App 的真实登录态读取会话；查看对话、手边、手记列表、手记详情、速览和账户／使用设置。Accessibility 树与截图确认列表标题、手记正文、引用、列表、代码块及版本信息来自本地服务端；详情页收起主 Dock，返回后 Dock 恢复。手记操作菜单能打开速览、脑图、讲解与版本记录；脑图与讲解显示引用当前手记的真实正文片段和未生成预览，生成按钮都因未同意 AI 而禁用；版本记录显示真实第 1 版且标记为当前。没有发起生成。
- **续读与轻入口：** 在手边的手记卡片打开会话，确认输入区带有当前手记标题；手记详情的“在对话里继续提问”使用同一条真实路径。手边／手记页右侧伴星入口可回到对话。Android 主 Dock 连续切换“伴星／手边／手记”后停在正确页面；系统动画比例临时设为 `0` 时页面仍可切换，随后恢复 `1.0`。设置里的本机减弱动效开关也切换过后恢复关闭。
- **原生选区：** 在手记正文长按，出现 Android 文本选区和系统操作浮层，并显示“伴星解释／伴星改写”。本轮只确认选区和按钮，未点击会请求 AI 的动作，也没有保存批注。
- **本机 TXT 导入：** 在 Android 系统文档选择器从 `Download` 选取测试文件；文件名与正文在客户端显示，随后用“存为手记”调用真实 `/import/markdown`，在手记列表读回 `study-mobile-import` 与对应正文。正文没有上传对话附件，没有发送消息或调用模型；列表截图为 `/tmp/study-android-import-note.png`。
- **减弱动效边界修正：** 代码复核发现静态伴星降级动画有几处绕过 iOS「减少动态效果」，Android 附件吸收与伴星脉冲在动效中途切换偏好时也不会立刻停下，输入器「＋」在 Reduce Motion 下仍旋转。现已把系统／本机偏好贯穿到 iOS 降级角色脉冲、歪头、呼吸与透明度动画；偏好开启会取消延迟回调并立即回到静止状态，呼吸幅度接入实际视图。Android 对应动画在偏好开启时立即 snap 回静止值、不会关闭后重放；输入器图标直接切换。最新双端构建通过。Android 最新包在系统动画时长缩放为 `0` 时打开输入器菜单，三个动作仍可用，截图为 `/tmp/study-android-plus-menu-reduced-final.png`；结束后系统动画及字体比例都恢复为 `1.0`。iOS 该路径尚未能在窗口里手动点按。
- **窗口证据：** 当前安装包的代表截图为 `/tmp/study-android-current.png`、`/tmp/study-android-hand2.png`、`/tmp/study-android-notes2.png`、`/tmp/study-android-detail2.png`、`/tmp/study-android-overview2.png`、`/tmp/study-android-mindmap-final.png`、`/tmp/study-android-explain-final.png`、`/tmp/study-android-versions-final.png`、`/tmp/study-android-selection-detail-final.png` 和 `/tmp/study-android-import-note.png`。Reduce Motion 系统比例 `0` 下的最新输入菜单截图为 `/tmp/study-android-plus-menu-reduced-final.png`；主 Dock 动画取样见 `/tmp/study-android-motioncheck.png`；连续导航后的手记列表状态稳定。模拟器日志未发现 Astella FATAL 崩溃；过程中一次额外系统返回退出到桌面，重新打开后登录态与数据正常恢复。
- **当前模型服务状态：** 用隔离账号调用只读 `GET /companion/model/manifest` 返回 `502 model_manifest_missing`；对话显示静态伴星图是当前服务配置的降级结果，不代表 Live2D 已在运行时渲染。仓库说明现有模型资源不具备发行／商业分发许可，因此不把它重新上传到模型桶。已验证静态降级可用；动态模型需有获批模型资产并发布清单后才能验收。
- **双端构建与安装：** iOS `xcodebuild -project apps/mobile-client/ios/Astella.xcodeproj -scheme Astella -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/astella-ios-derived CODE_SIGNING_ALLOWED=NO build` 成功，并安装／启动于 iPhone 18 Pro Max / iOS 27；Android `JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew --offline assembleDebug` 成功，APK 已重新安装并启动在 Pixel 8 AVD。`git diff --check -- apps/mobile-client` 通过。Android Gradle 仍报告 Gradle 10 弃用警告。
- **iOS 交互范围：** 当前 Xcode 安装没有 `Simulator.app` 图形应用。最新 iOS App 已重新安装并启动，冷启动截图 `/tmp/study-ios-motion-fix-final.png` 显示白色登录表单；`simctl` 能截图和查看进程日志，但不提供点按／输入操作，所以本轮没有把 iOS 登录后页面记为已触控验收。之前“无登录会话、需用户输入”的状态只适用于上一节，当前 Android 已有本地隔离测试登录态。
- **仍需完成：** iOS 逐页交互与导航、iOS 文件选择及本机抽取、Android 选区工具条／批注／版本记录／脑图和讲解空态的窗口逐项复核、授权后的录音与 TTS 正向播放、设备权限与实体机运动表现仍未在本轮完成。模型动态渲染受合规模型资产缺失阻塞；邮箱有效验证码仍因 `.test` 无收件箱不能走通。未运行自动化测试，也不将模拟器结果外推成实体机帧率。

## 原生导航与 Android 模拟器首轮验收 — 2026-10-18

依据 OpenDesign Cloud 手机稿核对原生入口时，按实际产品能力保留“相伴、手边、手记”三标签和页头账户入口。主 Dock 增加移动选中面；非相伴一级页提供轻量伴星快捷入口。iOS 在当前手记可见时沿用现有继续阅读流程并传递不可变版本；Android 保留手记详情原有的上下文入口，避免重复控件。原型中的四标签、演示日记和模拟分享／语音动作没有接入产品导航。

iOS 使用 SwiftUI 匹配几何、原生弹簧、按钮按压样式与选择触感反馈，保留 `NavigationStack`、系统返回手势和手记进入时的原生缩放。页头与唯一 Dock 固定在 Shell 的 safe-area inset 中；共享几何命名空间保持稳定，跨标签切换时只替换内容栈。Android 使用独立调校的 Compose 弹簧，并把系统动画时长缩放与本机减弱动效偏好合并为动效门控。

- **构建：** iOS `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` 成功；Android 使用拓展盘 SDK 执行 `./gradlew --offline assembleDebug` 成功；`git diff --check -- apps/mobile-client` 通过。未新增或运行自动化测试。
- **Android 模拟器：** Android Emulator 37.2.12、Android 16 / API 36 ARM64 系统镜像、Pixel 8 配置的 AVD 数据均位于 `/Volumes/asklins/Android`。SDK 根目录为 `/Volumes/asklins/Android/sdk`；复用的内部 platform-tools／build-tools／platforms／CMake／NDK 包通过符号链接接入，避免重复占用空间。`/Volumes/asklins/Android/launch-astella-pixel-8.command` 可启动设备。Pixel 8 模拟器已完成启动，Debug APK 已安装并实际打开。
- **Android 触控：** 手动走过注册第一步、邮箱输入、无效邮箱提示、输入法弹出与页面避让、继续到密码步骤、系统返回注册与登录页，以及验证码登录入口。150% 字号下，登录和注册的主要操作仍可达；注册键盘遮挡提交按钮时，表单可滚动把提交和“返回登录”露出。系统动画时长缩放设为 0 后，认证路由和系统返回立即切换。没有触发验证码发送；未见 FATAL 崩溃。验收后恢复字体和动画比例至 1.0，清除本轮模拟器输入，保留干净登录页。
- **iOS 模拟器：** 最新 Debug 包安装并启动于 iPhone 18 Pro Max / iOS 27，截图为 `/tmp/astella-ios-20261018.png`。冷启动最初截图尚未完成首帧；等待后登录页正常显示。当前 Xcode 安装未包含 Simulator 桌面应用，`simctl` 截图可用但无法在该宿主窗口中手动触控。模拟器没有已登录会话，因此本轮尚未看到真实三标签 Dock。
- **设计核对边界：** OpenDesign Cloud 的设计源文件已读取。其本地预览文件被浏览器安全策略拒绝打开，因此本轮是源文件级核对，没有声称与原型截图完成视觉并排比较。
- **待完成：** 需要已登录会话才能逐页检查会话、手边、手记、阅读详情、账户与伴星入口，并实际反复切换标签、验证减少动态效果及手记版本续读。TTS 正向播放、Live2D 真实资源渲染和授权账号的服务端流程也尚未在模拟器完成运行验收。不得把构建或未登录的首屏当作这些能力的视觉验收。

## Latest authentication update — 2026-10-15

The current implementation uses white backgrounds, ordinary glass controls and the official icon only, with no companion artwork on authentication pages. iOS simulator build and Android Debug APK build passed. The actual window checks and unverified downstream email flows are recorded in [the authentication review](../../docs/testing/mobile-auth-white-glass-2026-10-15.md). Earlier visual descriptions and verification claims below belong to earlier builds.

审查日期：2026-10-15。iOS 是界面、颜色和动效的标尺；Android 保持同样的信息层级、留白、纸面质感和单一系统蓝，再用 Compose 与 Android 控件表达。审查依据是模拟器中的实际窗口和服务端响应，不把源码或构建成功单独当作运行验收。

## 测试账号与数据

- 专用开发账号：`codex-mobile-qa-20261014@example.test`。账号用一次性、本地开发专用的邮箱校验旁路建立，旁路进程随后已关闭；之后的密码登录、会话恢复和页面 API 均连接正常本地服务。密码与会话令牌没有写进仓库，临时密码文件已在验收后删除。
- 测试手记：`手机端实机验证 · 阅读与交互`，包含标题、段落、引用、列表、代码和版本记录。用来检查真实列表、正文、批注和版本接口。
- 账号的 AI 使用协议仍未签署，`sendToExternal` 为关闭状态。没有替用户签署协议，也没有触发外部模型生成。

## 页面与真实调用链

| 页面 / 流程 | 原生实现 | 本轮实际核验 |
| --- | --- | --- |
| 密码登录、邮箱验证码登录、注册、找回与重置密码 | iOS `Screens/RootView.swift`；Android `ui/screens/LibraryScreens.kt` | Android 输入真实测试账号登录成功；错误密码收到服务端失败并显示行内说明。注册与找回真实请求到达验证码步骤；错误验证码返回服务端错误并显示状态卡片。 |
| 会话恢复 | iOS `Screens/RootView.swift`；Android `ui/screens/NoteFeatures.kt` 与 `AstellaRoot.kt` | 两端均使用本地凭据恢复同一测试账号；iOS `/auth/me` 返回 200。Android 登录后显示真实书房与“已连接”。 |
| 对话、伴星与记录 | iOS `Screens/RootView.swift`、`App/AppStore.swift`；Android `ConversationScreen.kt`、`AppViewModel.kt` | iOS inbox、消息与 run-nodes 请求返回 200；Android WebSocket 显示已连接。验证了伴星中心“翻开完整记录”回到同一对话，不误进手记讲解页。没有发送 AI 消息。 |
| 手边 | iOS `HandAndAccountScreens.swift`；Android `LibraryScreens.kt` | 两端查看当前真实工作与连接空态；页面提供返回伴星的入口，没有伪造任务历史。 |
| 手记列表、正文、批注与版本 | iOS `NotesScreen.swift`、`AppStore.swift`；Android `LibraryScreens.kt`、`AppViewModel.kt` | 两端展示真实测试手记。iOS `/notes`、`/v2/notes/:id`、`/annotations` 与版本请求均返回 200；Android 点开正文、查看版本，并从手记点击“在对话里继续提问”，确认上下文入口回到对话且携带手记标题。 |
| 速览、脑图、讲解 | iOS `NotesScreen.swift`；Android `NoteFeatures.kt` | 实际打开页面并核对当前无生成内容时的说明和操作入口。因未签署 AI 协议，未触发生成任务。iOS 对应查询返回 200。 |
| 账户与使用设置 | iOS `HandAndAccountScreens.swift`；Android `LibraryScreens.kt`、`SettingsAndCompanionScreens.kt` | 检查账号资料、权限说明、AI 协议与数据开关、服务地址、字号、记录视图、减少动效和个人约定。Android 三个偏好开关均实际切换后恢复原值；AI 同意和个人约定没有写入。 |

## 多轮审查与修正

1. 对照入口、导航和共享 API 合同，逐项列出认证、三项主导航、手记派生页、账户、设置和伴星中心。
2. 在 Android API 37 模拟器用触屏输入、打开软键盘、按钮点按、滚动和返回；在 iPhone 18 Pro Max / iOS 27 模拟器用原生构建逐页截取。认证、主要空态、长手记、账户和设置均复核过。
3. 修复走查发现的问题：认证错误改成带标题和可执行说明的状态面板；安卓登录错误文案去掉标题与正文重复；手记、对话错误使用页面化说明和重试；伴星中心与手记“继续提问”清除旧的手记子路由；AI 许可空字段不再显示字面量 `null`；iOS 验证码步骤避免重复邮箱与多余句点。
4. 修正后重新构建并回到模拟器复核。Android 登录错误、验证码错误、验证码步骤、手记续问路由、账户授权状态和设置恢复值已重查；iOS 认证与登录后页面在最新原生构建上重截。
5. 清理了只为走查加入的 iOS 路由跳转、令牌注入和 HTTP 记录钩子；标准构建完成后又检查源码中不再残留这些 QA 入口。

## 构建、运行证据与边界

- Android：JDK 17 与 Android SDK 37，`./gradlew --offline assembleDebug` 成功；Pixel 10 Pro 配置的 API 37 模拟器 `emulator-5554` 完成真实 UI 登录和页面操作。认证登录、注册步骤、找回步骤、记录键盘状态、手记与账户页均有屏幕截图。登录、注册、找回和邮箱登录输入时，Accessibility 树未发现可滚动节点；键盘出现后当前字段和主要操作仍在屏内。
- iOS：Xcode Debug 构建成功；iPhone 18 Pro Max / iOS 27 模拟器实际启动原生 App，逐页截取 9 个认证路由及 11 个登录后页面。请求记录确认 `/auth/me`、伴星 inbox、消息、run-nodes、手记、批注、版本、速览和脑图读取均为 200。截图目录是 `/tmp/astella-mobile-ios-round3/`，总览图为 `/tmp/astella-mobile-ios-round3-contact.jpg`。
- Android 逐屏截图散存在 `/tmp/astella-android-*.png`；本轮覆盖认证、错误态、键盘、手记、版本、派生页、账户、设置和伴星中心。总览图为 `/tmp/astella-mobile-android-round3-contact.jpg`。模拟器可执行 ADB 触屏操作，但它仍不是实体手机。
- iOS 所在主机没有可操作的 Simulator 图形界面，本轮用 `simctl` 启动、读取真实 API 并截图，没有手动点按 iOS 屏幕，也没有实体 iPhone。iOS 键盘连续操作、系统边缘返回等只做了源码和静态窗口核对。
- 服务端公开能力位显示邮箱通道已配置。测试注册与找回请求均走到了验证码输入步骤；`.test` 测试邮箱没有可访问的收件箱，所以无法核对真实邮件收取、输入有效验证码完成注册或完成密码重置。邮箱验证码登录的无效验证码路径已实际核验。
- AI 生成页已核对空态与入口；因为账号明确未同意外部 AI，未发起速览、脑图或讲解生成。这是账号权限边界，不记作生成调用通过。
- 实体设备上的相机／麦克风授权、录音质量、TTS、不同机型触感、刷新率与持续帧率仍未实测；不据模拟器构建承诺稳定 60/120 fps。

## 当前能力限制 — 2026-10-18

移动端语音识别仍为 MiMo 整段 ASR；没有流式识别或流式播放。手记正文不提供本地编辑器，只有伴星提出改写、用户查看前后对照并确认写回；锚点冲突时保留原文并显示服务端状态。TTS 客户端链路已接通，但生产可用性受 AI 同意与服务端开关约束。PDF 扫描件、加密或损坏文档、复杂 DOCX 版式不承诺完整抽取。Live2D 可用性取决于部署的模型 manifest 与分发授权，失败时回退静态图。实体设备录音、系统音频中断、后台长期运行和硬件刷新率仍需真机验收。其余产品边界见 [README](README.md#当前限制)。

## 2026-10-15 视觉重构后的复核

本轮按已确认的登录页标准重新梳理已登录页面：iOS 用系统语义色、iOS 26 原生 Liquid Glass 输入与短操作面、轻纸面阅读层；Android 用 Material 3 的中性色、同一系统蓝、Compose 原生状态与触控。两端共享信息重心和用户任务，不复制同一组卡片骨架。

- 对话重组为书房状态、伴星主体、当下提示和输入；提示短语点按后只填入输入框，没有自动发送。手边把真实空态和书房连接分开表达。书架与阅读页改成搜索列表、连续正文和较少的操作控件；段落批注／讲解改由长按打开。
- 速览、脑图、讲解各自使用不同的空态结构，按当前手记解释真实输出会怎样保留主线、层级、讲述和原文依据；没有填入虚构生成结果。主要生成操作固定在底部安全区。手记长按菜单改为白色 Material 3 表面和轻阴影，去掉了系统默认的紫调。
- iOS：最新源码 Debug 构建成功，iPhone 18 Pro Max / iOS 27 启动成功，并重新截图检查登录页（`/tmp/astella-redesign-ios-final-login-latest.png`）。本机没有可操作的 Simulator 图形界面，Xcode 项目也没有 UI 测试目标，因此本轮没有手动点按登录后的 iOS 页面。先前 API 路由核验仍覆盖其真实调用链，但不能作为这次视觉修改的 iOS 屏幕验收。
- Android：最终 APK 构建成功并安装到 API 37 模拟器。触屏逐页查看了对话与提示词预填、手边、书架、手记正文、版本、速览、脑图、讲解、账户、使用设置和伴星中心；真实长按段落确认菜单出现。代表性截图在 `/tmp/astella-redesign-android-final-current2.png`、`/tmp/astella-redesign-android-chip.png`、`/tmp/astella-redesign-android-final-hand.png`、`/tmp/astella-redesign-android-final-notes.png`、`/tmp/astella-redesign-android-final-detail.png`、`/tmp/astella-redesign-android-final-versions.png`、`/tmp/astella-redesign-android-overview-final2.png`、`/tmp/astella-redesign-android-mindmap-final.png`、`/tmp/astella-redesign-android-final-explain.png`、`/tmp/astella-redesign-android-final-account.png`、`/tmp/astella-redesign-android-final-settings.png`、`/tmp/astella-redesign-android-final-companion.png` 与 `/tmp/astella-redesign-android-context-final.png`。
- 最终构建：`xcodebuild ... build CODE_SIGNING_ALLOWED=NO` 成功；Android `./gradlew --offline assembleDebug` 成功。没有触发 AI 生成；测试账号尚未签署 AI 协议，页面真实生成结果因此未验收。登录、注册与找回的验证码输入交互使用此前认证流程的真实请求核验；`.test` 邮箱没有可收件箱，不能验证有效邮件验证码。
- 以上是模拟器核验，不是实体 iPhone 或实体 Android 设备测试。当前版本还未核验 iOS 认证后所有页面的逐页视觉结果、实体设备权限／键盘／手势和硬件帧率；不能据模拟器构建推断 60/120fps。

## 2026-10-15 授权状态与外观切换复核

- 深色外观触发 Android Activity 重建时，生成页先前只保存在页面局部的授权错误会消失，导致按钮重新可点。现已改为进入速览、脑图或讲解页时读取账号级 AI 设置；授权状态未知或要求同意时禁用主操作。服务端明确返回未授权后，同步锁定 ViewModel 状态。iOS 也按账号设置禁用按钮，并在每个生成方法里再次校验。
- 用测试账号重新登录 Android API 37 模拟器，打开真实手记的脑图页；未同意时看到授权说明和“查看 AI 使用设置”，主按钮为禁用样式。Accessibility 树里按钮父节点在浅色和深色外观下均为 `clickable=true, enabled=false`。打开账户入口后核对账号及 AI 数据说明，再返回脑图。切换深色并恢复浅色，授权说明和禁用按钮均保持；没有签署协议，也没有触发模型生成。
- iOS 用最新 Debug 包在 iPhone 18 Pro Max / iOS 27 模拟器重新启动，分别截取浅色和深色登录页，检查系统颜色和输入面材质。双端最新源码再次构建成功：Android `assembleDebug`、iOS `xcodebuild ... build CODE_SIGNING_ALLOWED=NO`。
- 本机图形会话处于锁定状态，CUA 确认无法访问 Simulator 窗口。因此 iOS 本轮仅验证构建、启动及浅／深色首屏截图，没有手动点按登录后的页面；上一轮 iOS 认证后截图不能替代本轮页面操作复核。测试设备仍为模拟器，不是实体手机。

## 2026-10-15 第二次返工复核（最新构建）

这次复核从用户已认可的认证页规范重新开始：语义中性色、单一系统蓝、玻璃只放在可交互面、正文保持稳定表面；每个页面依内容和任务排版，不复制同一套卡片骨架。对话欢迎态、手记书架、手边空态、版本和生成前说明作了针对性调整；设置和个人页减少重复卡片，并让保存按钮反映实际未保存状态。认证屏保持固定视口；Android 在系统字体放大时也切换紧凑排布。没有新增模拟生成内容，也没有改变现有 API 契约。

- **iOS 构建与窗口：** 最新 SwiftUI Debug 构建成功，并安装到 iPhone 18 Pro Max / iOS 27 模拟器。通过 Device Hub 实际打开登录页和注册第 1、2 步，确认邮箱、称呼、密码、返回、步骤进度和禁用的主操作可见。未输入密码、发送验证码或登录。没有手动检查软键盘、放大字号、验证码错误、其余认证步骤及登录后页面。
- **Android 构建与窗口：** 使用 JDK 17、Android SDK 37 执行 `./gradlew --offline assembleDebug` 成功，APK 已安装到 API 37 `AstellaQA` 模拟器。为了让模拟器窗口可由桌面工具识别，曾正常重启该开发 AVD；重启后主机锁定，CUA 返回无法访问窗口。因此，本次 Android 源码修改尚无新窗口截图或触屏复核。此前 `/tmp/astella-redesign-android-*.png` 是旧构建证据，不能用来证明本次布局。
- **本轮修正：** 构建发现的 Swift 字体 API 用法、Compose 布局参数和图标导入错误均已修复；Android 字体缩放较大时会提前切换认证紧凑版式。验证码下方的重复标签改成“没有收到邮件？”，邮箱、登录密码和新密码字段补上 Compose `ContentType` 自动填充语义。最新双端标准构建均成功，最新 APK 与 iOS App 已安装到各自模拟器。Android Gradle 仍报告既有 Gradle 10 弃用警告，不影响当前构建。Android 官方的 Compose 自动填充指南已补入[设计心得](DESIGN_NOTES.md)。
- **账号边界：** iOS 注册表单中只填入了 `codex-mobile-qa-ios-20261015@example.test` 用于检查表单状态；未发送验证码。现有开发测试账号的密码不在仓库或可用凭据中，因而没有自动输入或尝试密码登录。`.test` 邮箱没有可访问的收件箱，不能据此完成有效邮箱验证。
- **其余真实链路：** 本轮没有改动 API 或模型权限链；之前记录的接口状态和页面调用仍是之前构建的证据。AI 使用协议仍未签署，因此没有触发外部 AI 生成，也没有把生成空态误记成结果验收。
- **下一步尚需窗口复核：** 主机解锁后，在新 APK 上实际逐屏检查 Android 对话、手边、手记、版本、速览、脑图、讲解、账户、设置和伴星中心；在 iOS 上继续查看所有认证路由和登录后页面。两台模拟器完成后还需要用户在自己的测试账号登录字段中输入凭据，才能验证认证后的 iOS 真实页面。模拟器之外的实体设备、麦克风／相机授权和持续帧率仍未验证。

## 2026-10-15 按已认可规范重新返工

本轮把页面审查退回到用户认可的 Apple 风格基准，检查了整个原生 UI 的共享组件与页面入口。代码里曾把不透明内容面命名为 `GlassSurface`：iOS 显示系统纸面，Android 显示普通白色 Surface。现已改称 `NoticeSurface`，不再把内容卡片误当作 Liquid Glass。iOS 背景改用系统动态背景色；主操作采用系统 `glassProminent`，认证输入、手记搜索、对话输入和发送控件采用 SwiftUI 原生 Glass API；内容正文、错误说明、权限和状态仍使用稳定表面。iOS 18 通过系统材质回退。Android 采用 Material 3 中性色角色、系统蓝、白色主表面和圆角 filled action，不模拟苹果模糊材质。

这轮也对注册、邮箱确认、找回密码与验证码登录调整了步骤标题和指引文案；Android 登录页改为和 iOS 一样的顶部层级，认证错误出现时进入紧凑排布。对话发送按钮改为 iOS 系统玻璃控制，内容页的主要 CTA 使用同一套原生主操作，既有的各页面独立布局、真实 API 和路由保持连接。

- iOS 最新标准 Debug 构建成功：`xcodebuild -quiet ... -derivedDataPath /tmp/astella-ios-redesign-derived CODE_SIGNING_ALLOWED=NO build`；已安装到 iPhone 18 Pro Max / iOS 27 模拟器。
- Android 最新 Debug 构建成功：`./gradlew --offline assembleDebug`；已安装到 API 37 `emulator-5554`。Gradle 输出既有 Gradle 10 弃用提示。
- 本轮重新调用 CUA 检查时，macOS 仍处于锁定状态。没有对最新两端构建进行新的屏幕截图或触控走查；旧截图不作本轮证据。当前可以确认的是源码、构建和安装，不能确认最新窗口的实际材质、键盘压缩和每页视觉重心。
- 页面结构覆盖面与上一节一致；需主机解锁后逐页再审 Android 登录后各页、iOS 所有认证路由及登录后各页，并让用户本人在模拟器输入测试凭据。验证码收件箱、AI 授权和实体设备仍有前述边界。

## 2026-10-15 本轮返工续记：账号、真实数据与窗口边界

上一节记录的是当时的安装状态和窗口限制。本次继续清理认证流程，并重新核对材质规则：iOS 26 使用系统 Liquid Glass 输入／操作样式，正文与说明保持清晰的系统表面；Android 使用 Material 3 中性色和同一系统蓝。双端最新标准构建成功并重新安装。此后 CUA 再次查询系统窗口，仍返回“Mac is locked”，因此这里不把旧截图或上一构建的触屏记录算作最新包验收。

静态压力检查还发现连续代码字符串没有局部溢出处理。现已在 iOS 和 Android 把代码块改为自身横向滚动区域，并保留正文的纵向阅读；两端最新构建均重新通过并安装。此修正尚未在窗口里验证滚动手势、长按批注是否冲突或圆角裁切效果。

- 为登录后的真实页面准备了新的隔离开发账号 `codex-mobile-redo-qa-20261015@example.test`。仅在本机 API 容器中短暂启用已有开发邮箱验证旁路来注册，随后恢复原配置；当前旁路未启用。真实 `/auth/login`、`/auth/me`、`/auth/workspaces`、`/companion/inbox/ensure`、会话消息与 run-nodes、`/me/ai-settings`、`/me/companion` 与 `/me/companion/participation` 均返回 2xx。没有真实邮箱收件箱，因此这不等于有效邮箱验证码、注册邮件或密码重置链路已验收。密码不写入仓库。
- 通过同一真实 API 创建了复核手记“移动端复核 · 学习科学”，包括标题、段落、引用、列表和代码。`/notes`、`/v2/notes/:id`、`/notes/:id/versions`、`/v2/notes/:id/annotations` 均返回 200。当前服务端内容可用于登录后逐页复核，不触发 AI 生成。
- 另建了压力手记“移动端边界复核：中英文混排、超长标题、长段落、窄屏换行与段落操作测试记录”：标题 36 字符、长段落 1,152 字符，含 442 字代码块连续字符串，用于小屏与代码溢出复核。该数据只写入隔离 QA 账号，尚未在窗口中查看。
- 压力手记的鉴权列表、搜索、正文、版本、批注、速览、脑图及讲解任务读取路由均返回 200；这些都是读取请求，没有创建派生任务或调用外部模型。
- 随后把包含代码块局部横向查看修正的最新 iOS App 与 Android APK 安装到已启动的 iPhone 18 Pro Max / iOS 27 和 `emulator-5554` 模拟器。安装命令成功；安装后 CUA 仍报告 Mac 锁屏，所以当前构建的页面截图、触控与无障碍检查仍未完成。
- 上述 API 响应只证明鉴权及数据端点可用。最新 iOS／Android 窗口中的登录、键盘、认证错误、导航、手记正文、批注、账户设置及其余页面仍待模拟器实际操作；没有新截图、触屏或无障碍树证据。需要先解锁 Mac，再由用户在模拟器登录表单输入这组临时测试凭据；不要把密码发回聊天。
- AI 使用协议仍未签署，不会触发外部模型。模拟器检查也不能替代实体设备对系统权限、硬件帧率和音频表现的验收。

## 2026-10-15 继续返工：状态一致性与数据权限

本轮继续按登录页与 `DESIGN_SPEC.md` 核验真实交互链，修复了三类可复现于状态逻辑中的问题：

- **个人约定冲突：** 两端遇到服务端 revision 冲突时，原提示声称重读仍保留草稿，但实际加载会覆盖输入。现在会保留本机草稿、读取并展示另一设备的版本，让用户在输入框里合并，或明确选择用云端版本替换后再保存。
- **书架请求乱序：** iOS 搜索结果及分页没有校验请求是否仍对应当前查询；Android 重复同一查询刷新时也可能让旧响应覆盖新状态。双端现按请求代次和游标校验，只允许当前查询更新列表与错误状态。
- **外部 AI 与图片输入：** 速览、脑图、讲解现在同时检查 AI 使用授权和账号的 `sendToExternal` 数据策略；关闭时禁用生成并提供账户设置入口，服务端拒绝后刷新策略。Android 认证中的密码、确认密码、邀请码和一次性验证码不再进入可恢复的 saved-instance-state。
- **图片上传资源边界：** Android 头像与伴星图片现在流式读取并在超过 10 MB 时立即停止；iOS 头像在解码前检查文件大小，并先生成最长边 1024 px 的缩略图再压缩。
- **最新验证：** `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` 和 `./gradlew --offline assembleDebug` 均成功，最新 App/APK 已重新安装到 iPhone 18 Pro Max / iOS 27 与 Android API 37 模拟器；`git diff --check` 通过。Gradle 仍提示项目已有 Gradle 10 弃用项。
- **窗口边界：** 最新 CUA 查询仍返回“Mac is locked”。所以本节只记录源码、构建和安装；没有新截图、触控操作、无障碍树或最新包页面验证。上文较早版本的模拟器截图不作为最新构建的证据。解锁后仍需逐页核对双端，包括外部 AI 关闭时生成按钮状态、个人约定冲突保稿、快速搜索与长代码块横向查看。
- **真实数据边界：** QA 账号的 `.test` 邮箱没有收件箱，仍不能完成有效验证码、注册邮件及密码重置；AI 使用协议未签署，不会生成真实 AI 输出。当前也没有实体设备的麦克风／相机、系统手势、热态、持续帧率验收。

## 2026-10-15 再次续审：跨手记请求与认证提交

- 手记正文与批注存在全局可观察状态。旧的正文、批注读取或保存任务若在快速切换手记后返回，可能覆盖当前详情页的批注或状态。iOS 与 Android 现为正文读取、批注读取和批注写入／讲解任务增加请求代次及当前手记校验；切换手记会使旧结果失效。
- 发送邮箱验证码时，表单原先仍能修改邮箱或切换路由，晚到的成功响应可能进入新邮箱的验证码步骤。iOS 在认证请求期间禁用认证表单；Android 在请求期间禁用认证输入、验证码编辑、重发与导航操作。
- 上述改动后的 iOS `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` 与 Android `./gradlew --offline assembleDebug` 均成功；最新包已重新安装。`git diff --check` 通过。
- 本轮开始与安装后检查的 CUA 仍报告 macOS 锁定，故此处没有声称页面在窗口内通过。需要解锁后在当前安装包上实际复查认证请求状态、快速切换两篇手记及批注列表；其余页面的逐屏视觉与触控复核也仍未完成。

## 2026-10-15 继续全页返工：记录空态

在逐屏静态复核时补出“交流记录为空”的布局遗漏：此前提示留在列表顶部，底部输入框与提示之间形成无意义空带。现在 iOS 与 Android 都把空态放到记录区中部，用一条标题和一条说明告诉用户可以从底部输入开始；记录出现后空态立即消失，输入框、草稿及真实消息列表逻辑保持原样。

- iOS `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` 成功，最新 App 已安装并由 `simctl` 启动于 iPhone 18 Pro Max / iOS 27 模拟器。
- Android `./gradlew --offline assembleDebug` 成功，最新 APK 已重新安装，`MainActivity` 启动命令成功。
- 本机 CUA 仍报告 macOS 锁屏；这次新增空态以及此前全页布局改动尚未在当前模拟器窗口通过截图和触控验证。旧版截图不作为当前构建证据。

## 2026-10-15 用户拒绝当前视觉质量：重新梳理页面构图

用户指出，最近构建出来的界面与认可的登录页标准不符，并要求整套手机页面重做。之前的截图属于更早的构建；它们只能用于理解当时的问题，不能证明本次代码在当前模拟器窗口中的呈现效果。检查这些旧图能看到几个具体问题：欢迎页人物、文案和输入区相隔过远；手边空态重复使用角色图与大白卡；书架首条手记、阅读正文和设置被卡片边框分割；速览、脑图和讲解在首屏留白过多，内容层级不清。

这次重新以已认可的登录页为视觉基准；认证版式方向保留，其余页面按各自任务重构，不复制登录卡片结构：

- 对话欢迎态缩小伴星形象，让问候、解释与快捷问题组合成一个连续场景；回复态改用左对齐阅读排版。手边空态去掉重复伴星插画，压缩为待办状态、下一步和连接信息。
- 书架的最新手记改为无卡片的内容预览，其他条目按标题、真实摘要、更新时间和细分隔线排列。正文页继续使用连续阅读纸面，版本页保留时间线语义。
- 速览／脑图／讲解的未生成预览不再嵌套白卡，改为不同的结构预览；实际引用仍来自当前手记，标签明确说明这不是模型生成结果。三页的内容区域改为围绕主体组织，不再只把一段说明贴在顶部。
- 账户中的开发服务地址收进可展开的进阶入口，账户默认视图优先展示身份、书房、伴星权限与 AI 数据选项；伴星中心缩小重复的角色图，集中呈现名称、连接状态、最近回应与返回交流入口。
- 清理非交互状态块中的半透明材质；Liquid Glass 仅留在 iOS 可操作的输入、导航和短操作面。Android 继续使用 Material 3 实色表面与系统蓝，不仿制苹果玻璃。

**本次证据：** iOS SwiftUI 标准 Debug 构建成功，并重新安装、启动于 iPhone 18 Pro Max / iOS 27 模拟器；Android Compose `assembleDebug` 成功，APK 已重新安装到 API 37 模拟器。`git diff --check -- apps/mobile-client` 通过。没有运行 UI 测试。

**尚未验收：** 本轮 CUA 发现 macOS 仍处于锁定状态，无法看到最新模拟器窗口或进行触控。因此上面列出的改动目前是源码与构建事实，不代表新版本已经视觉通过；更早截图不作为本轮验收。解锁后仍要在最新包逐页查看双端的对话、手边、书架、阅读、批注、版本、速览、脑图、讲解、账户、设置、伴星中心以及所有认证步骤，并按实际窗口继续修正。有效邮件验证码、AI 生成和实体设备行为仍受上文所述账号与设备边界限制。

## 2026-10-15 全量重构裁决

用户复核前述各轮返工后作出裁决，后续工作不再沿旧轮局部修补推进，而是双端全量重构。裁决要点：

- **动效：** 达到 Telegram 级——物理 spring、共享元素转场、可中断可反转手势；默认弹性而非例外，iOS 参数为 Android 标尺，双端参数以新增的 `DESIGN_TOKENS.md` 双端参数表为准；动效偏好统一为“跟随系统减少动态 + 本机手动覆盖”，不跨设备同步。
- **伴星形态：** 接入 Live2D 模型，Cubism SDK 双端原生；模型资产不进 App 包，走对象存储 + 服务端临时签名下载链接在运行时下载、客户端缓存，静态 PNG 保留为降级；动作映射 idle 呼吸／视线跟随／吸收／说话口型／思考／失败。在场矩阵：对话页完整在场，手边／手记／派生页轻量形态可召唤，非对话空态不重复大幅角色图，生成／吸收事件用全屏浮层。仓库记录该模型 `redistributionAllowed:false`、`commercialReleaseAllowed:false`，运行时下载不改变发布前需再确认分发合规的要求。
- **对话输入：** 「+」二级菜单（加图片／加文件／引用手记），Telegram 式弹簧散开、stagger 24ms，语音保留独立按住说话键；对话可发文件并在手机本机解析（iOS PDFKit、Android pdfbox，docx 为 zip/XML 抽正文）导入手记，原件不出本机，回合上送抽取正文、原件资产留档。
- **语音与粒子：** 录音由麦克风振幅驱动伴星身周粒子；回复朗读接服务端 TTS（`POST /voice/tts`）与口型，reduceMotion 降级静态波形条；完整语音体验需部署侧开启 `COMPANION_VOICE_DIALOGUE_V1_ENABLED` / `COMPANION_STREAMING_VOICE_V1_ENABLED`（生产默认关）。
- **选段→伴星：** 选区工具条（复制／批注／伴星解释／伴星改写）→ 底部纸面 sheet 流式呈现（改写给前后对照 diff）→ 确认后经伴星写入通道落库；服务端“手机上人不改正文，伴星改”闸门不动，复用已有 selection／pageContext／`companion_edit_note` 地基。
- **认证与授权：** 认证页改为优先紧凑排布、放不下时表单区内滚动且绝不裁切字段／错误／主操作（验收＝150% 字号 + 最小屏可完成登录）；AI 外发同意改为进入门槛，新用户注册后强制签署方可进入、老用户未签先补签。
- 同轮完成 16 条方案审阅修订，依据优先于旧文档。

后续双端重构以本轮裁决、`DESIGN_SPEC.md` 2026-10-15 修订段与 `DESIGN_TOKENS.md` 双端参数表为准；本文件此前各轮返工与修正记录仅作问题追溯，不再作为新重构的验收基线。裁决落地情况按重构进度在后续章节续记。

## 2026-10-19 iOS annotated issue pass and route sweep

Reviewed the supplied screenshots as reports of UI defects and the supplied Open Design prototype as the visual reference. I read its `index.html`, README, and companion styling sources. The browser tool rejected the local `file://` URL, so a rendered side-by-side comparison of the prototype was not available; the simulator checks below are direct captures of the native app.

### Fixes in this pass

- Removed the duplicate “用注册邮箱登录” action from the password form; the existing email-code login entry remains available.
- Expanded the launch composition and its web view across the full screen bounds to remove the left edge strip.
- Replaced the Live2D loader's raw English texture error with Chinese recovery guidance, and made the text-only action readable in both appearance modes.
- Aligned the note-derived preview pages to the top, simplified the single-version history state, and removed the reader's zoom navigation transition that produced a narrow dark loading strip.
- Rendered internal note citations as tappable links and routed them to the referenced note.
- Connected the orbit pencil to a user-editable conversation draft and input focus; it does not fabricate a diary record.
- Reworked the companion center summary and kept account/settings row separators inside their owning groups.
- Fixed dark-mode selected-state and action-label contrast across the shared palette, navigation dock, conversation mode selector, memory filters, appearance selectors, and accent buttons.

### Coverage and evidence

- Captured all 27 DEBUG review routes on iPhone 18 Pro Max / iOS 27: nine authentication routes; conversation, records, library, reader, orbit, memory and hand; account, profile, settings, companion settings, reading settings, device permissions, AI authorization, server address, conventions, companion center, and password change.
- After the final palette and text-mode button changes, captured and reviewed login, conversation, orbit memory, settings, and reading-settings screens in both light and dark appearance. The final dark conversation capture used a launch-time appearance override; the simulator's stored appearance was restored to dark.
- Latest iOS simulator Debug build succeeded with `CODE_SIGNING_ALLOWED=NO`. The linker still warns that the prebuilt Live2D core objects target simulator 26.2 while this project links against iOS 18.0; these are existing SDK warnings.
- `git diff --check -- apps/mobile-client/ios/Astella` passed. No tests were added or run.

### Remaining verification limits

- This review used DEBUG route fixtures and simulator screenshots. It did not exercise taps, keyboard behavior, VoiceOver, Reduce Motion transitions, or a physical device.
- The companion model still cannot load in the current environment: the model manifest request returned HTTP 502 (`model_manifest_missing`). This pass improves the failure state but does not repair the model service or establish asset redistribution rights.
- The local Open Design prototype could not be rendered in the browser due to the local-file URL policy; prototype review was limited to its source and the screenshots supplied by the user.

## 2026-10-22 iOS shell motion, native behaviour and icon pass

A full sweep of the signed-in iOS surface (shell, conversation, library, orbit, account and every settings detail) while checking motion, icons and page chrome. Only iOS was touched; Android remains as-is.

### What was wrong

- The shell swapped tabs with a `switch`, destroying and rebuilding each root on every tap. Scroll position reset, page `.task` fetches re-ran, and the three-step entrance stagger (opacity + 10 pt, 45 ms apart) replayed. A system tab bar never does this.
- Every page hides the navigation bar for its own header, which also turns off UIKit's interactive pop gesture. Back was tap-only even though the specification asks for the native swipe.
- Streaming replies re-started a 0.32 s spring scroll on every token, so the transcript stuttered while text arrived.
- The shared press style dimmed whole cards to 0.76 opacity and scaled them to 0.97, flashing and shrinking list rows like a web button; circular 38–60 pt controls then got the same treatment.
- Icons: `.settings` drew a 2×2 grid (read as an app launcher), `.orbit` was a second four-point star next to 相伴's star, `.person` was a solid blob, the companion center used SF Symbol labels, appearance names disagreed between screens (深空/深夜, 随日夜/随系统), and the result-return control was a system-blue bordered button.
- The profile page always showed a disabled blue 保存 button, so the primary action read as broken until the name differed.

### Fixes in this pass

- Tabs are a real `TabView` with the system bar hidden; each stack, scroll offset and loaded data now survives switching. All shell entrance staggers and the tab-swap animation were removed, so a tab change is instant like the system bar.
- Added `InteractivePopGestureEnabler` (a small `UIViewControllerRepresentable` bridge per stack root) so the native interactive pop gesture works under the hidden bar, with its own cancellation and rubber-banding.
- Streaming text scrolls without animation; message insertion keeps its spring. Appearance switching is no longer wrapped in an animation.
- Split press feedback: `AstellaPressStyle` now dims rows/cards slightly (0.86, scale 0.99); `AstellaRoundPressStyle` keeps the deeper 0.93 press for circular icon controls (back, appearance, companion shortcut, settings). The auth primary button follows the same softer values.
- Icon redraws: `.settings` is now three sliders, `.orbit` a tilted ring with a satellite, `.person` a line-art head and shoulders. Companion-center action labels use the app glyphs instead of SF Symbols; reading-settings scene icons use the companion mark and a chat bubble. Appearance labels are consistently 银白／深夜／随系统.
- Profile only reveals 保存 when the trimmed nickname actually changes; the hint copy is shorter. The result-return control is a glass capsule with the app back glyph.
- The note reader keeps the native push. The iOS 18 zoom transition was tried again and removed again: the narrow dark loading strip documented on 2026-10-19 could not be reproduced or ruled out without gesture automation, so it was not re-landed.

### Coverage and evidence

- iOS simulator Debug build succeeded (`CODE_SIGNING_ALLOWED=NO`); the only warnings are the existing Live2D core objects built for simulator 26.2 while the project links iOS 18.0. No Swift warnings in the touched files.
- Captured conversation (light and dark), records, library, orbit, me, settings, profile, reading settings, companion center, device permissions, AI authorization, conventions, server address, change password, register, forgot password, the reader and the mind map. The `dock-switch` fixture switched to 书房 and back under a slow animation and rendered correctly with the custom dock after each change.
- Full-screen captures are in `/tmp/audit-after` for this session; they are not committed. The dock's bottom margin, safe-area reserve and page padding were checked again after moving to `TabView`.

### Remaining verification limits

- `simctl` cannot inject taps or gestures. Swipe-back, the zoom decision, keyboard focus and VoiceOver still need a person or UI-test automation on a device; the pop bridge uses the standard `UINavigationController` delegate approach.
- The backend remains unauthenticated for these runs (403), so screenshots use DEBUG fixtures. The Live2D manifest still returns 502 and the PNG fallback is what is visible.
- Dark appearance keeps the light companion artwork because no night variant exists; the lit desk illustration is still bright at night. This pass did not recolour the character art.
- Android was not modified.
