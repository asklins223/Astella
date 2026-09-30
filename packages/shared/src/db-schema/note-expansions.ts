import { sql } from "drizzle-orm";
import { char, check, foreignKey, index, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { noteVersions, notes } from "./note.ts";
import { jobs } from "./job.ts";
import { users, workspaces } from "./identity.ts";
import type { NoteAnnotationAnchorV1 } from "../contracts/note-annotation-contracts.ts";
import type { NoteExpansionDraftV1 } from "../contracts/note-expansion-contracts.ts";

export const noteExpansionTasks = pgTable("note_expansion_tasks", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  noteVersionId: uuid("note_version_id").notNull(),
  requestId: uuid("request_id").notNull(),
  focusAnchor: jsonb("focus_anchor").$type<NoteAnnotationAnchorV1 | null>(),
  sourceMessageId: uuid("source_message_id"),
  conversationId: uuid("conversation_id"),
  drafts: jsonb("drafts").$type<NoteExpansionDraftV1[]>().notNull().default([]),
  confirmedCandidateIds: jsonb("confirmed_candidate_ids").$type<string[] | null>(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  versionBelongsToNote: foreignKey({
    name: "note_expansion_tasks_version_note_fk",
    columns: [t.workspaceId, t.noteId, t.noteVersionId],
    foreignColumns: [noteVersions.workspaceId, noteVersions.noteId, noteVersions.id],
  }).onDelete("cascade"),
  generationJobBelongsToWorkspace: foreignKey({
    name: "note_expansion_tasks_job_workspace_fk",
    columns: [t.id, t.workspaceId],
    foreignColumns: [jobs.id, jobs.workspaceId],
  }).onDelete("restrict"),
  sourcePair: check("note_expansion_tasks_source_pair_check", sql`(${t.sourceMessageId} IS NULL) = (${t.conversationId} IS NULL)`),
  draftsShape: check("note_expansion_tasks_drafts_shape_check", sql`jsonb_typeof(${t.drafts}) = 'array' AND jsonb_array_length(${t.drafts}) <= 4`),
  confirmedIdsShape: check("note_expansion_tasks_confirmed_ids_shape_check", sql`${t.confirmedCandidateIds} IS NULL OR (jsonb_typeof(${t.confirmedCandidateIds}) = 'array' AND jsonb_array_length(${t.confirmedCandidateIds}) BETWEEN 1 AND 4)`),
  idWorkspaceUnique: uniqueIndex("note_expansion_tasks_id_workspace_unique_idx").on(t.id, t.workspaceId),
  requestUnique: uniqueIndex("note_expansion_tasks_request_unique_idx").on(t.workspaceId, t.userId, t.noteId, t.requestId),
  noteVersionOrder: index("note_expansion_tasks_note_version_order_idx").on(t.workspaceId, t.userId, t.noteId, t.noteVersionId, t.createdAt, t.id),
}));

export const noteExpansions = pgTable("note_expansions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sourceNoteId: uuid("source_note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  sourceNoteVersionId: uuid("source_note_version_id").notNull(),
  expandedNoteId: uuid("expanded_note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  expandedNoteVersionId: uuid("expanded_note_version_id").notNull(),
  sourceTaskId: uuid("source_task_id"),
  sourceMessageId: uuid("source_message_id"),
  conversationId: uuid("conversation_id"),
  requestId: uuid("request_id").notNull(),
  requestBodyHash: char("request_body_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sourceNotTarget: check("note_expansions_source_not_target", sql`${t.sourceNoteId} <> ${t.expandedNoteId}`),
  sourceVersionBelongsToNote: foreignKey({
    name: "note_expansions_source_version_fk",
    columns: [t.workspaceId, t.sourceNoteId, t.sourceNoteVersionId],
    foreignColumns: [noteVersions.workspaceId, noteVersions.noteId, noteVersions.id],
  }).onDelete("cascade"),
  expandedVersionBelongsToNote: foreignKey({
    name: "note_expansions_expanded_version_fk",
    columns: [t.workspaceId, t.expandedNoteId, t.expandedNoteVersionId],
    foreignColumns: [noteVersions.workspaceId, noteVersions.noteId, noteVersions.id],
  }).onDelete("cascade"),
  sourceTaskBelongsToWorkspace: foreignKey({
    name: "note_expansions_source_task_workspace_fk",
    columns: [t.sourceTaskId, t.workspaceId],
    foreignColumns: [noteExpansionTasks.id, noteExpansionTasks.workspaceId],
  }).onDelete("restrict"),
  sourcePair: check("note_expansions_source_pair_check", sql`(${t.sourceMessageId} IS NULL) = (${t.conversationId} IS NULL)`),
  sourceOrder: index("note_expansions_source_order_idx").on(t.workspaceId, t.userId, t.sourceNoteId, sql`${t.createdAt} desc`, sql`${t.id} desc`),
  expandedOrder: index("note_expansions_expanded_order_idx").on(t.workspaceId, t.userId, t.expandedNoteId, sql`${t.createdAt} desc`, sql`${t.id} desc`),
  requestUnique: uniqueIndex("note_expansions_request_unique_idx").on(t.workspaceId, t.userId, t.requestId),
}));
