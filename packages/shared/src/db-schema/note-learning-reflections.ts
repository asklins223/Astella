import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const noteLearningReflections = pgTable("note_learning_reflections", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  noteId: uuid("note_id").notNull(),
  roundId: uuid("round_id").notNull(),
  teachingId: uuid("teaching_id"),
  answerArtifactId: uuid("answer_artifact_id"),
  annotation: text("annotation").notNull().default(""),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sourceCheck: check("nlreflection_one_source", sql`(${t.teachingId} IS NOT NULL)::int + (${t.answerArtifactId} IS NOT NULL)::int = 1`),
  teachingUnique: uniqueIndex("nlreflection_teaching_unique").on(t.workspaceId, t.userId, t.teachingId),
  answerUnique: uniqueIndex("nlreflection_answer_unique").on(t.workspaceId, t.userId, t.answerArtifactId),
  noteIndex: index("nlreflection_note_idx").on(t.workspaceId, t.userId, t.noteId, t.createdAt, t.id),
}));
