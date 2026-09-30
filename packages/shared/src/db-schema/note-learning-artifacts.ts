import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { jobs } from "./job.ts";
import { noteVersions, notes } from "./note.ts";
import { users, workspaces } from "./identity.ts";
import type { NoteAnnotationAnchorV1 } from "../contracts/note-annotation-contracts.ts";

export const noteLearningArtifacts = pgTable("note_learning_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  noteVersionId: uuid("note_version_id").notNull(),
  /** Optional conversational provenance; the note workflow can create artifacts without chat. */
  sourceMessageId: uuid("source_message_id"),
  conversationId: uuid("conversation_id"),
  requestId: uuid("request_id"),
  generationJobId: uuid("generation_job_id"),
  sourceKind: text("source_kind").$type<"overview" | "annotation">().notNull(),
  selectionText: text("selection_text"),
  selectionAnchor: jsonb("selection_anchor").$type<NoteAnnotationAnchorV1 | null>().default(null),
  sourceContentHash: text("source_content_hash").notNull(),
  generatorRef: text("generator_ref").notNull(),
  title: text("title").notNull(),
  subject: text("subject").notNull(),
  caution: text("caution").notNull(),
  outline: jsonb("outline_json").$type<unknown>().notNull(),
  html: text("html").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sourceKindCheck: check("note_learning_artifacts_source_kind_check", sql`${t.sourceKind} IN ('overview', 'annotation')`),
  sourceSelectionLength: check("note_learning_artifacts_selection_length_check", sql`${t.selectionText} IS NULL OR char_length(${t.selectionText}) BETWEEN 1 AND 2000`),
  selectionAnchorShape: check("note_learning_artifacts_selection_anchor_shape_check", sql`${t.selectionAnchor} IS NULL OR jsonb_typeof(${t.selectionAnchor}) = 'object'`),
  overviewHasNoSelection: check("note_learning_artifacts_overview_selection_check", sql`${t.sourceKind} <> 'overview' OR ${t.selectionAnchor} IS NULL`),
  hashLength: check("note_learning_artifacts_hash_length_check", sql`char_length(${t.sourceContentHash}) BETWEEN 8 AND 128`),
  htmlLength: check("note_learning_artifacts_html_length_check", sql`char_length(${t.html}) BETWEEN 1 AND 220000`),
  versionBelongsToNote: foreignKey({
    name: "note_learning_artifacts_version_note_fk",
    columns: [t.workspaceId, t.noteId, t.noteVersionId],
    foreignColumns: [noteVersions.workspaceId, noteVersions.noteId, noteVersions.id],
  }).onDelete("cascade"),
  generationJobBelongsToWorkspace: foreignKey({
    name: "note_learning_artifacts_generation_job_workspace_fk",
    columns: [t.generationJobId, t.workspaceId],
    foreignColumns: [jobs.id, jobs.workspaceId],
  }).onDelete("restrict"),
  sourceUnique: uniqueIndex("note_learning_artifacts_source_unique_idx")
    .on(t.workspaceId, t.userId, t.noteId, t.sourceMessageId)
    .where(sql`${t.sourceMessageId} IS NOT NULL`),
  generationJobUnique: uniqueIndex("note_learning_artifacts_generation_job_unique_idx")
    .on(t.workspaceId, t.generationJobId)
    .where(sql`${t.generationJobId} IS NOT NULL`),
  requestUnique: uniqueIndex("note_learning_artifacts_request_unique_idx")
    .on(t.workspaceId, t.userId, t.noteId, t.requestId)
    .where(sql`${t.requestId} IS NOT NULL`),
  workspaceIdUnique: uniqueIndex("note_learning_artifacts_workspace_id_unique_idx").on(t.workspaceId, t.id),
  historyOrder: index("note_learning_artifacts_history_idx").on(t.workspaceId, t.userId, t.noteId, sql`${t.createdAt} desc`, sql`${t.id} desc`),
}));
