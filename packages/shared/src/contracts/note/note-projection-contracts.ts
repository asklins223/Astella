/**
 * Golden Slice Note detail read projection.
 *
 * This is deliberately smaller than the persistence model.  A Note detail
 * consumer receives the current version and renderable blocks, but never raw
 * database rows, image object identities, or source binding internals.
 */

import { z } from "zod";

const uuidSchema = z.string().uuid();
const nonNegativeIntSchema = z.number().int().min(0);
const positiveIntSchema = z.number().int().min(1);
const isoTimestampSchema = z.string().datetime({ offset: true });
const contentHashSchema = z.string().regex(/^[a-f0-9]{32}$/, "invalid note content hash");

export const noteBlockTypeV1Schema = z.enum([
  "paragraph",
  "heading",
  "code",
  "list",
  "quote",
  "image",
]);

export const noteBlockProjectionV1Schema = z.strictObject({
  ordinal: nonNegativeIntSchema,
  type: noteBlockTypeV1Schema,
  content: z.string().max(50_000),
});
export type NoteBlockProjectionV1 = z.infer<typeof noteBlockProjectionV1Schema>;

export const noteVersionProjectionV1Schema = z.strictObject({
  versionId: uuidSchema,
  noteId: uuidSchema,
  versionNo: positiveIntSchema,
  contentHash: contentHashSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  // 块数**不设上限**（2026-10-14 修）：此前这里是 `.max(10_000)`，而写侧
  // （`POST /notes` 的 noteCreateSchema、`/import/markdown`）两边都不设块数上限——
  // 于是系统自己导进来的 12,000 块笔记，`GET /v2/notes/:id` 读回时被**自己的响应合同**
  // 判红，抛 ZodError → 500（dev 库实测：api 日志 `unhandled error`，`path:
  // ["currentVersion","blocks"]`，`Array must contain at most 10000 element(s)`）。
  // 读形合同的任务是核结构（字段齐不齐、类型对不对），不是替写侧发明第二个上限；
  // 正文规模的唯一闸门是传输层的 `MAX_SOURCE_TEXT_BYTES`（守卫见
  // apps/api/src/__tests__/whole-note-body-transport-guard.test.ts）。
  // 同一件事只能有一份数字：这里再写一个 10_000，就是「两头各说一套」。
  blocks: z.array(noteBlockProjectionV1Schema),
});
export type NoteVersionProjectionV1 = z.infer<typeof noteVersionProjectionV1Schema>;

export const notePermissionProjectionV1Schema = z.strictObject({
  canRead: z.literal(true),
  canEdit: z.boolean(),
  canSave: z.boolean(),
  /**
   * 能不能改这篇的归属（「共享给空间」/「取消共享」）。判据是**作者**，不是空间角色，
   * 所以它和 canEdit 可以取不同的值；服务端 `setNoteShareScope` 用的是同一个判据。
   */
  canShare: z.boolean(),
});
export type NotePermissionProjectionV1 = z.infer<typeof notePermissionProjectionV1Schema>;

export const noteDetailV1Schema = z
  .strictObject({
    version: z.literal(1),
    noteId: uuidSchema,
    workspaceId: uuidSchema,
    title: z.string().max(200),
    titleSource: z.enum(["manual", "auto"]),
    sourceId: uuidSchema.nullable(),
    currentVersionId: uuidSchema,
    /** `private` = 界面上的「仅自己可见」，`shared` = 「已共享给空间」。 */
    shareScope: z.enum(["private", "shared"]),
    currentVersion: noteVersionProjectionV1Schema,
    permissions: notePermissionProjectionV1Schema,
    // The current version ID is the OCC/read revision for the frozen Note
    // surface.  It is opaque to the renderer and must be echoed as
    // baseVersionId by a future save adapter.
    revision: uuidSchema,
    snapshotAt: isoTimestampSchema,
  })
  .superRefine((value, context) => {
    if (value.currentVersionId !== value.currentVersion.versionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentVersionId"],
        message: "currentVersionId must match currentVersion.versionId",
      });
    }
    if (value.noteId !== value.currentVersion.noteId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentVersion", "noteId"],
        message: "currentVersion.noteId must match noteId",
      });
    }
    if (value.revision !== value.currentVersionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revision"],
        message: "revision must match currentVersionId",
      });
    }
  });
export type NoteDetailV1 = z.infer<typeof noteDetailV1Schema>;

