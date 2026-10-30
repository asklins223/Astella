# iOS voice replay, dialects and cache identity — 2026-10-28

Implemented and verified against the local development API and real TTS. No production release tag or deployment was created. The companion mobile implementation and its native/UI evidence live in the sibling `astella-mobile` repository, in `docs/testing/ios-reading-voice-cache-interactions-2026-10-28.md`.

## Behavior

Ordinary `/voice/tts` and `/voice/tts/stream` reading no longer clear the saved dialect. Notification and guidance purposes retain their intentional profiles.

The V2 segment-reference contract accepts optional `replay: true`. Replay resolves the original server-side synthesis text, expression tags and scene instruction, then uses the current saved dialect rather than a dialect embedded in an old turn instruction. Live segments retain their original turn semantics. Very old histories without retained references may be read as plain text; the user explicitly accepted that fallback. Missing archives are distinct from transient or authorization failures.

Both GET and PATCH `/voice/preference` include a stable `cacheKey` derived from effective voice settings and audio-affecting synthesis configuration. Successful stream responses identify those bytes with `X-Astella-Tts-Cache-Key`. `X-Astella-Tts-Replay-Compatible: 1` means a live segment's synthesis profile also matches replay under the current preference, allowing the client to reuse those bytes for history. A fallback engine does not advertise the requested engine's cache identity.

Warm entries carry the configuration identity used to synthesize them. Both stream and whole-response routes verify segment ownership before serving warm bytes and require the identity to match the current selection. Explicit historical replay bypasses live warm bytes. Serving a warm hit does not add another provider invocation or governance audit.

iOS caches complete MP3 segments under account/workspace/origin and voice configuration. Switching a voice changes the active variant and backfills previously cached coverage; old variants remain available when switching back. The new fields are optional for existing clients. New iOS only sends the replay extension after the preference response advertises the new identity capability.

## Verification

- 49 targeted API tests passed across `voice-ai-governance`, `voice-routes`, `companion-tts-warm`, `tts-engine` and `tts-synthesis-profile`. The governance warm-hit guard now checks the ownership and configuration boundaries in the whole-response route as well.
- 18 related shared voice-contract/catalog/preference tests passed.
- `npm run typecheck` passed in shared, api, desktop-client and ai-worker; api was repeated after the final route adjustment.
- Real historical standard-Mandarin and Henan-dialect synthesis returned 31,437 and 23,496 bytes. Plain text under the same Henan preference returned 45,648 bytes. Each response's identity matched the selected configuration; the original preference was restored.
- Native UI cache replay produced zero additional synthesis requests. After populating both voice variants, three further switches kept all 16 original MP3 hashes unchanged and made zero synthesis requests.

Local detailed logs are `/tmp/astella-ios-voice-api-tests-20261028.log`, `/tmp/astella-ios-voice-shared-tests-20261028.log` and `/tmp/astella-ios-voice-*-typecheck-20261028.log`. Credentials are excluded. These tests do not substitute for human dialect listening or complete iPhone network/performance acceptance. The working tree also contains unrelated agent changes, which were preserved and not deployed.
