import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companionConversations, companionMessages } from "./companion-conversations.ts";
import { noteVersions, notes } from "./note.ts";
import { users, workspaces } from "./identity.ts";

export const noteRecallRecords = pgTable("note_recall_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  noteVersionId: uuid("note_version_id").notNull(),
  sourceMessageId: uuid("source_message_id").references(() => companionMessages.id, { onDelete: "set null" }),
  conversationId: uuid("conversation_id").references(() => companionConversations.id, { onDelete: "set null" }),
  requestId: uuid("request_id").notNull(),
  sectionOrdinal: integer("section_ordinal"),
  sectionTitle: text("section_title"),
  question: text("question").notNull(),
  hintSnapshot: text("hint_snapshot"),
  hintSourceMessageId: uuid("hint_source_message_id").references(() => companionMessages.id, { onDelete: "set null" }),
  hintConversationId: uuid("hint_conversation_id").references(() => companionConversations.id, { onDelete: "set null" }),
  answerSnapshot: text("answer_snapshot").notNull(),
  answerTruncated: boolean("answer_truncated").notNull().default(false),
  selfReport: text("self_report").$type<"remembered" | "partly" | "not_yet">(),
  reflection: text("reflection"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  hintViewedAt: timestamp("hint_viewed_at", { withTimezone: true }),
  revealedAt: timestamp("revealed_at", { withTimezone: true }),
  reportedAt: timestamp("reported_at", { withTimezone: true }),
}, (t) => ({
  versionBelongsToNote: foreignKey({
    name: "note_recall_records_version_note_fk",
    columns: [t.workspaceId, t.noteId, t.noteVersionId],
    foreignColumns: [noteVersions.workspaceId, noteVersions.noteId, noteVersions.id],
  }).onDelete("cascade"),
  noteHistory: index("note_recall_records_history_idx").on(t.workspaceId, t.userId, t.noteId, sql`${t.createdAt} desc`, sql`${t.id} desc`),
  requestUnique: uniqueIndex("note_recall_records_request_unique_idx").on(t.workspaceId, t.userId, t.requestId),
}));
