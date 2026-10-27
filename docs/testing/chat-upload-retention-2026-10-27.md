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

Backups still read the bytes of newly retained objects once; moving the job to nighttime does not remove that traffic. Reducing the backup set, immutable-object receipts and local client cache reuse reduce repeated transfers. Provider billing: [Rainyun ROS](https://www.rainyun.com/docs/products/ros/buy/billing) charges downloads; uploads do not consume transfer quota. The existing upload-completion integrity check also reads staged bytes and is separate from the backup.

## Verification

- Real disposable PostgreSQL verified 30-day defaults, historical note retention, source-original promotion, actor RLS, atomic deletion claims, racing promotion rejection and crash retry.
- A complete fresh committed migration set and two subsequent `roles.sql` reconciliation runs passed. Maintenance functions remain callable by API, without exposing trigger-only promotion functions.
- Real disposable MinIO integration passed retained-file mirroring, cloud outage, local writes, cloud recovery and deletion. Queue unit checks cover Beijing window boundaries, daytime recovery/deletion, persistent receipts and one-time policy upgrades.
- Resolved Compose checks confirm one local store in development/Alpha and the production-only backup window. No existing development container or user content was used as a destructive test fixture.
- API unit suite: 2,008 passed, one existing skip. Focused grant/script checks: 238 passed. API typecheck passed. Final release/production readback is recorded after CI deployment.
