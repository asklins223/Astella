/** Companion-owned interpretations and working documents, scoped to their space.
 * Immutable versions and wake consumption are managed by migration 0405. */
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users, workspaces } from "./identity.ts";

export const companionSelfNotes = pgTable("companion_self_notes", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  entryKey: text("entry_key").notNull(), revision: integer("revision").notNull().default(1),
  userDisabled: boolean("user_disabled").notNull().default(false),
  title: text("title").notNull(), body: text("body").notNull(),
  tier: text("tier").$type<"resident" | "active" | "archived">().notNull(),
  nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }), reason: text("reason").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  pk: primaryKey({ columns: [table.workspaceId, table.userId, table.entryKey] }),
  wakes: index("companion_self_notes_wakes").on(table.nextReviewAt)
    .where(sql`${table.nextReviewAt} IS NOT NULL AND ${table.tier} <> 'archived'`),
}));
export const companionSelfNoteVersions = pgTable("companion_self_note_versions", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  entryKey: text("entry_key").notNull(), revision: integer("revision").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ pk: primaryKey({ columns: [table.workspaceId, table.userId, table.entryKey, table.revision] }) }));
