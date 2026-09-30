import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { noteVersions, notes } from "./note.ts";
import { jobs } from "./job.ts";
import { users, workspaces } from "./identity.ts";

export const noteAnnotations = pgTable("note_annotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  noteVersionId: uuid("note_version_id").notNull(),
  startBlockOrdinal: integer("start_block_ordinal").notNull(),
  startOffset: integer("start_offset").notNull(),
  endBlockOrdinal: integer("end_block_ordinal").notNull(),
  endOffset: integer("end_offset").notNull(),
  excerpt: text("excerpt").notNull(),
  prefix: text("prefix").notNull().default(""),
  suffix: text("suffix").notNull().default(""),
  explanation: text("explanation").notNull(),
  sourceMessageId: text("source_message_id"),
  generationJobId: uuid("generation_job_id"),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  versionBelongsToNote: foreignKey({
    name: "note_annotations_version_note_fk",
    columns: [t.workspaceId, t.noteId, t.noteVersionId],
    foreignColumns: [noteVersions.workspaceId, noteVersions.noteId, noteVersions.id],
  }).onDelete("cascade"),
  sourceRange: check("note_annotations_source_range_check", sql`${t.startBlockOrdinal} >= 0 AND ${t.endBlockOrdinal} >= ${t.startBlockOrdinal} AND ${t.startOffset} >= 0 AND ${t.endOffset} >= 0 AND (${t.endBlockOrdinal} > ${t.startBlockOrdinal} OR ${t.endOffset} > ${t.startOffset})`),
  excerptLength: check("note_annotations_excerpt_length_check", sql`char_length(${t.excerpt}) BETWEEN 1 AND 2000`),
  explanationLength: check("note_annotations_explanation_length_check", sql`char_length(${t.explanation}) <= 8000`),
  revisionPositive: check("note_annotations_revision_check", sql`${t.revision} >= 1`),
  noteVersionIndex: index("note_annotations_note_version_idx").on(t.workspaceId, t.userId, t.noteId, t.noteVersionId, t.createdAt, t.id),
  workspaceIdUnique: uniqueIndex("note_annotations_workspace_id_unique_idx").on(t.workspaceId, t.id),
  generationJobBelongsToWorkspace: foreignKey({
    name: "note_annotations_generation_job_workspace_fk",
    columns: [t.generationJobId, t.workspaceId],
    foreignColumns: [jobs.id, jobs.workspaceId],
  }).onDelete("restrict"),
  generationJobUnique: uniqueIndex("note_annotations_generation_job_unique_idx")
    .on(t.workspaceId, t.generationJobId)
    .where(sql`${t.generationJobId} IS NOT NULL`),
  sourceMessageUnique: uniqueIndex("note_annotations_source_message_unique_idx")
    .on(t.workspaceId, t.userId, t.noteId, t.sourceMessageId)
    .where(sql`${t.sourceMessageId} IS NOT NULL`),
}));
