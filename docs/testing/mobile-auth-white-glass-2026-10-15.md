# Mobile authentication: white background and ordinary glass

Date: 2026-10-15.

## Final user decision

Implement the authentication screens directly. Use a white background and ordinary neutral glass for inputs and submit/back controls. Remove companion portraits and illustrations from every authentication route; keep the official app icon. The earlier illustrated, iridescent raster concepts are historical references.

## Implementation

- iOS: `Auth/AuthScreen.swift` and `Auth/AuthComponents.swift`.
- Android: authentication extracted from `LibraryScreens.kt` into `ui/screens/AuthScreen.kt`; the remaining library screen content was compared with the pre-change snapshot and is unchanged.
- Both clients share the same titles, copy, fields, step counts, spacing, rounded geometry, verification cells and ordinary glass treatment.
- All nine existing routes remain: password login; registration profile, password and verification; email login and verification; password recovery email, verification and new password.
- Authentication uses light appearance independently of the device appearance. The signed-in dark theme remains available.
- Shared backgrounds lose ambient color gradients; shared glass loses directional sheen in favor of a uniform neutral edge and small contact shadow.
- A compact, scrolling layout preserves alternate login and registration navigation while editing. Android hardware Back follows the auth flow. Returning from new-password entry to verification preserves the code, matching iOS.
- Existing session handlers and API endpoints remain in use: `/auth/login`, `/auth/login-with-code`, `/auth/email-code`, `/auth/register-v2` and `/auth/reset-password`.

## Verification performed

- iOS: full simulator Debug build passed with Xcode 27. The final build was installed on the iPhone 18 Pro / iOS 27 simulator.
- Device Hub window checks covered password login, registration profile, expanded invitation input, registration password, recovery email and email-code login. Checked disabled submission for missing required values, retained email on navigation, back links and absence of companion artwork.
- Actual software keyboard was opened on email-code login: the compact layout kept the email field, submit button and password-login switch above the keyboard. Screenshots were captured from the simulator.
- Android: `:app:compileDebugKotlin` passed, followed by a successful offline `:app:assembleDebug` using JDK 17. The APK was copied into the task deliverables.
- Source review confirmed authentication only references the official icon asset, and no longer calls iOS `glassEffect` / `glassProminent` or draws gradient borders.

## Limits

Android runtime visuals have not been rechecked in this round because its emulator/runtime image is not installed on this host. The four downstream verification/new-password routes compile but were not traversed through email delivery in this visual review. No email delivery, account creation or credential update was performed. Physical devices, maximum accessibility font sizes, reduced transparency and sustained animation performance remain unverified.

The iOS build retains existing Cubism linker warnings about a simulator library built for iOS 26.2 while the app deployment target is iOS 18. These are pre-existing and unrelated to the authentication styling.

## Deliverables

The task workspace contains `outputs/white-glass-implementation/`: the Android Debug APK and actual iOS simulator captures. Build logs and the focused diff against the pre-change snapshot are retained under `work/`. No new design images were generated during implementation.


## Shared-element continuity correction — 2026-10-15

The user reported that the fixed brand and whole-page push/pop lost the prior continuity. Both native authentication clients now keep one live composition. The official icon remains visible and moves 56 pt/dp with its wordmark (94% scale on child steps); common email/password controls have stable identities, and the submit control remains mounted while the form reflows. New/removed fields and title changes receive short direction-aware transitions; returns reverse the brand movement. Reduced motion skips position/scale interpolation and uses opacity changes.

The current iOS simulator Debug build and Android offline `:app:assembleDebug` both passed after this correction. In the iPhone 18 Pro window, navigation was exercised from login to registration, registration profile to password, and back through both steps. The illustrative email `motion@example.test` remained intact; the accessibility identity of the live email field stayed unchanged between login and registration, and the submit control kept its identity across the steps. The active button was visibly soft blue, with no arrow or companion illustration. No registration or email request was submitted. A simulator video was captured for motion review. Android runtime animation, physical-device frame timing, interactive edge-swipe reversal and the system reduced-motion setting were not checked in this round.

Recorded intermediate-frame review confirmed the icon moves through intermediate x positions rather than teleporting: approximately 141 → 187 → 257 → 284 → 297 → 302 → 305 px in the sampled native capture. A short extracted clip is available as `auth-transition-preview.mp4` beside the full review recording. This is evidence of position continuity, not a physical-device frame-rate measurement. The final iOS build also includes the reduced-motion geometry gate and resets password reveal when changing password content types; it compiled and was reinstalled after the normal-motion window checks.
