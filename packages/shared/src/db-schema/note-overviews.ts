import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { noteVersions, notes } from "./note.ts";
import { jobs } from "./job.ts";
import { users, workspaces } from "./identity.ts";

export const noteOverviews = pgTable("note_overviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  noteVersionId: uuid("note_version_id").notNull(),
  body: text("body").notNull(),
  overviewPoints: jsonb("overview_points").$type<Array<{ explanation: string; blockOrdinal: number; quote: string }> | null>(),
  sourceReferences: jsonb("source_references").$type<Array<{ blockOrdinal: number; quote: string }>>().notNull().default([]),
  coverage: jsonb("coverage").$type<{ totalBlocks: number; textBlocksRead: number; imageBlocksNotRead: number; pointsDropped?: number } | null>(),
  generationJobId: uuid("generation_job_id"),
  sourceMessageId: uuid("source_message_id"),
  conversationId: uuid("conversation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // 正文只管有没有内容：长度由输出额度与上下文预算管（0412 去掉了 1..20000 那条，
  // 这里此前还留着旧约束名，与库里的 `note_overviews_body_present_check` 对不上）。
  bodyPresent: check("note_overviews_body_present_check", sql`char_length(${t.body}) >= 1`),
  // 条数不设上限（0419）：要点由材料决定，引用由实际核到的原文决定。
  pointsShape: check("note_overviews_overview_points_shape_check", sql`${t.overviewPoints} IS NULL OR (jsonb_typeof(${t.overviewPoints}) = 'array' AND jsonb_array_length(${t.overviewPoints}) >= 1)`),
  referencesShape: check("note_overviews_source_references_shape_check", sql`jsonb_typeof(${t.sourceReferences}) = 'array' AND jsonb_array_length(${t.sourceReferences}) >= 1`),
  versionBelongsToNote: foreignKey({
    name: "note_overviews_version_note_fk",
    columns: [t.workspaceId, t.noteId, t.noteVersionId],
    foreignColumns: [noteVersions.workspaceId, noteVersions.noteId, noteVersions.id],
  }).onDelete("cascade"),
  generationJobBelongsToWorkspace: foreignKey({
    name: "note_overviews_generation_job_workspace_fk",
    columns: [t.generationJobId, t.workspaceId],
    foreignColumns: [jobs.id, jobs.workspaceId],
  }).onDelete("restrict"),
  sourceMessageUnique: uniqueIndex("note_overviews_source_message_unique_idx")
    .on(t.workspaceId, t.userId, t.noteId, t.sourceMessageId),
  generationJobUnique: uniqueIndex("note_overviews_generation_job_unique_idx")
    .on(t.workspaceId, t.generationJobId)
    .where(sql`${t.generationJobId} IS NOT NULL`),
  workspaceIdUnique: uniqueIndex("note_overviews_workspace_id_unique_idx").on(t.workspaceId, t.id),
  createdAtOrder: index("note_overviews_created_at_idx").on(t.workspaceId, t.userId, t.noteId, sql`${t.createdAt} desc`, sql`${t.id} desc`),
}));
