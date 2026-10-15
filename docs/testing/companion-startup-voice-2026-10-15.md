# Companion startup voice repair — 2026-10-15

The 21:47 startup greeting had two persisted `voice.segment.ready` events and
voice was enabled for the account. The desktop audio host nevertheless required
a first pointer/key gesture, except for update notices. A greeting arriving
before that gesture caused `beginCompanionSpeechLine` to choose silent mode for
the entire delivery, with no later replay.

`HomeV2AudioController` now permits foreground, unmuted speech before the first
gesture, including before idle audio preparation. Synthesis prepares the shared
audio graph on demand. Idle preparation and returning from a muted/background
startup reopen the same graph. Preparation starts no source node. Existing
account voice controls, microphone priority and ongoing reply behavior remain
in their owning components.

Verification:

- Five focused desktop test files: 94 tests passed, including real playback
  queue → synthesis transport → decoding → source start, both before and after
  idle preparation. Tests cover mute/background startup, foreground return,
  muting during speech, recording priority, and HUD interactions.
- Desktop `npm run typecheck`: passed.
- Electron production build into an isolated output directory: passed; the
  resulting build was copied to the local desktop `out/` directory without
  deleting resources used by the already-running window.
- An isolated Electron 44 window used the production audio host and speech
  queue, with a bundled local voice sample replacing only the synthesis
  transport. Before and after idle preparation, it reached `finished` with one
  synthesis request, one actual audio source start, and
  `navigator.userActivation.hasBeenActive === false`.

The Electron check verifies local startup audio, not a newly generated model
greeting through the live backend. Temporary renderer fixtures were removed.
The running study window was left open; the copied build applies on restart.
