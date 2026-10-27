# Chat attachment retention and nightly persistent backups

Accepted policy on 2026-10-27: chat image/document originals expire 30 days after upload. Chat text remains. Only note media, saved source files, imported note images and avatars have regular server-local backups. Local development and Alpha continue to use one local MinIO.

## Lifecycle

`chat_upload_objects` records upload time and expiry. Both direct transfers and local multipart uploads register chat originals before persisting bytes. Existing image timestamps are backfilled during migration; old file timestamps come from paged S3 metadata inventory without downloading file bodies. Cleanup metadata survives account/workspace deletion.

A note-block reference or an authorized source file reference promotes the object in the same database transaction as the reference. Historical note versions are included in the migration. Promotion permanently removes the object from chat expiry and creates a durable backup notification. Converting document text into a note retains that note text; an original binary is retained only when the saved record actually references it.

Expiry is checked before download authorization and before 304 responses. An expired original returns HTTP 410 with `attachment_expired`. Already cached private client bytes do not require a cloud read; the client must not evict unrelated images/files when one original expires.

A small API maintenance tick claims at most 10 expired objects every five minutes, deletes both storage copies and then confirms the purge. Claimed deletion blocks a racing note promotion; unfinished claims retry after ten minutes. Message rows are untouched. A replica-queue tombstone fences any in-flight recovery copy against resurrecting deleted bytes.

## Replication

Production Compose persists `STORAGE_BACKUP_START_HOUR_UTC8=2` and `STORAGE_BACKUP_END_HOUR_UTC8=6`. Cloud-to-local incremental backup runs only in that Beijing-time window at the existing 256 KiB/s, one object per five seconds. The host/container timezone does not affect scheduling. Jobs left at 06:00 wait for the next window; an already running transfer may finish.

Chat originals do not enter normal cloud-to-local replication. Old completed receipts are rechecked once under policy version 2; a redundant chat replica is removed only after the cloud original is confirmed. Local-only outage uploads are copied back to cloud before their transient local copy is removed. Recovery copies and deletions may run during the day.

Backups still read the bytes of newly retained objects once; moving the job to nighttime does not remove that traffic. Reducing the backup set, immutable-object receipts and local client cache reuse reduce repeated transfers. Provider billing: [Rainyun ROS](https://www.rainyun.com/docs/products/ros/buy/billing) charges downloads; uploads do not consume transfer quota. Server 2.0.6 asks the object store to verify the full SHA-256 on PUT and inspects only the needed image/PDF/DOCX header (PNG 24 bytes, PDF 5 bytes; JPEG at most 256 KiB). Text needing complete UTF-8 validation, source/import payloads, old transfers without a provider checksum, and unusually large JPEG headers retain the full-read fallback.

## Verification

- Real disposable PostgreSQL verified 30-day defaults, historical note retention, source-original promotion, actor RLS, atomic deletion claims, racing promotion rejection and crash retry.
- A complete fresh committed migration set and two subsequent `roles.sql` reconciliation runs passed. Maintenance functions remain callable by API, without exposing trigger-only promotion functions.
- Real disposable MinIO integration passed retained-file mirroring, cloud outage, local writes, cloud recovery and deletion. Queue unit checks cover Beijing window boundaries, daytime recovery/deletion, persistent receipts and one-time policy upgrades.
- Resolved Compose checks confirm one local store in development/Alpha and the production-only backup window. No existing development container or user content was used as a destructive test fixture.
- API unit suite: 2,008 passed, one existing skip. Focused grant/script checks: 238 passed. API typecheck passed. Final release/production readback is recorded after CI deployment.

## Production and upload verification

Server `s-v2.0.5` passed [CI and deployment](https://github.com/asklins223/Astella/actions/runs/40507579171); the public version endpoint returned 2.0.5 and readiness was healthy. Two synthetic chat originals verified a 30-day expiry, normal reading before expiry, expired reading, and absence from the backup queue and standby bucket. The temporary objects and ledger entries were removed.

The configured Rainyun primary rejected both a missing signed checksum and a mismatched checksum, accepted the correct checksum, returned it on HEAD, and honored byte ranges. The standby MinIO also returned the matching checksum. A real Fastify/Postgres/MinIO integration with a TLS test proxy verified a large image and PDF used a 24-byte PNG header and 5-byte PDF header and no full staging GET, rejected a tampered signed upload, preserved SHA-256 and full length, accepted a legacy transfer without a checksum, and returned the exact original bytes on download. The isolated test containers were removed. API suite: 2,010 passed, one existing skip.
