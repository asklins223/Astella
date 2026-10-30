# Note collaboration identity and sharing controls — 2026-10-30

The iOS reading screen limits collaboration identity to shared notes in collaborative workspaces. It renders account avatars and compact names rather than an unbounded username. Personal notes omit the entire row. The note tools include a native sharing settings drawer backed by `PATCH /v2/notes/:id/share-scope`. Only the note author can change visibility; editing follows the existing Owner / Member workspace roles.

`editing-state` now returns workspace type, author-specific `canManageSharing`, and the currently published avatar URLs for present users and the last editor. These identities are read in the authenticated workspace transaction. Avatar downloads permit another active member's currently published picture in the same collaborative workspace, with explicit viewer membership, target membership and exact published-path checks. Personal spaces, old avatar paths and departed members remain excluded. Unsharing closes existing collaboration connections for that document; reconnect and HTTP reads recheck visibility.

Validation:

- API `npm run typecheck` passed.
- The mobile note write-scope integration suite passed all 12 tests against the isolated `astella-note-editor-test-20261029` PostgreSQL container. Added checks cover metadata avatars, author-only sharing management, member read-only behavior, sharing and withdrawal, personal-room avatar denial, stale avatar paths, absent viewers and departed targets. Log: `/tmp/astella-note-sharing-postgres.log`.
- Upload security suite passed all 38 tests. Log: `/tmp/astella-note-avatar-unit-tests.log`.
- The iOS protocol/editor suite passed 49 checks, compact Unicode names passed Swift Testing, and the native incremental build passed. UI evidence and remaining device limits are recorded in the mobile repository at `docs/testing/ios-note-interaction-audit-2026-10-30.md`.

Local development API only; no production release, migration, version bump or tag.
