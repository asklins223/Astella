import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { notes } from "./note.ts";
import { users, workspaces } from "./identity.ts";
import type { NoteLearningCardQuestionGroundingV1 } from "../contracts/learning/note-learning-card-contracts.ts";

/**
 * Plan 57: one note version owns one card. There is deliberately no link to
 * learning_objectives/learning_cards/review_schedules — this is a clean chain.
 */
export const noteLearningCards = pgTable("note_learning_cards", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  noteVersionId: uuid("note_version_id").notNull(),
  status: text("status").$type<"active" | "stale" | "archived">().notNull().default("active"),
  generatedFromRunId: uuid("generated_from_run_id"),
  /** Plan 57: generated questions discarded after validation (and duplicates); 0 when every question was kept. */
  omittedQuestionCount: integer("omitted_question_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusCheck: check("note_learning_cards_status_check", sql`${t.status} IN ('active','stale','archived')`),
  omittedQuestionCountCheck: check("note_learning_cards_omitted_question_count_check", sql`${t.omittedQuestionCount} >= 0`),
  versionUnique: uniqueIndex("note_learning_cards_version_idx").on(t.workspaceId, t.noteId, t.noteVersionId),
  activeUnique: uniqueIndex("note_learning_cards_active_idx").on(t.workspaceId, t.noteId).where(sql`${t.status} = 'active'`),
  noteOrder: index("note_learning_cards_note_idx").on(t.workspaceId, t.noteId, sql`${t.updatedAt} desc`),
}));

export const noteLearningCardQuestions = pgTable("note_learning_card_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  cardId: uuid("card_id").notNull().references(() => noteLearningCards.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  questionType: text("question_type").$type<
    "single_choice" | "multi_choice" | "true_false" | "fill_blank" |
    "short_answer" | "ordering" | "matching" | "operation"
  >().notNull(),
  stem: text("stem").notNull(),
  options: jsonb("options").$type<string[] | null>(),
  answer: jsonb("answer").$type<unknown>(),
  rubric: jsonb("rubric").$type<unknown>(),
  grounding: jsonb("grounding").$type<NoteLearningCardQuestionGroundingV1>().notNull(),
  operationArtifactId: uuid("operation_artifact_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ordinalCheck: check("note_learning_card_questions_ordinal_check", sql`${t.ordinal} BETWEEN 0 AND 7`),
  stemLength: check("note_learning_card_questions_stem_check", sql`char_length(${t.stem}) BETWEEN 4 AND 2000`),
  groundingShape: check("note_learning_card_questions_grounding_check", sql`jsonb_typeof(${t.grounding}) = 'object'`),
  ordinalUnique: uniqueIndex("note_learning_card_questions_ordinal_idx").on(t.cardId, t.ordinal),
}));

export const noteLearningCardAttempts = pgTable("note_learning_card_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  cardId: uuid("card_id").notNull().references(() => noteLearningCards.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").$type<"in_progress" | "grading" | "completed" | "grading_failed" | "abandoned">().notNull().default("in_progress"),
  score: integer("score"),
  stars: integer("stars"),
  summary: jsonb("summary").$type<unknown>(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => ({
  statusCheck: check("note_learning_card_attempts_status_check", sql`${t.status} IN ('in_progress','grading','completed','grading_failed','abandoned')`),
  scoreCheck: check("note_learning_card_attempts_score_check", sql`${t.score} IS NULL OR ${t.score} BETWEEN 0 AND 100`),
  starsCheck: check("note_learning_card_attempts_stars_check", sql`${t.stars} IS NULL OR ${t.stars} BETWEEN 0 AND 5`),
  cardOrder: index("note_learning_card_attempts_card_idx").on(t.cardId, t.userId, sql`${t.completedAt} desc`),
  scopeOrder: index("note_learning_card_attempts_scope_idx").on(t.workspaceId, t.userId, sql`${t.startedAt} desc`),
}));

export const noteLearningCardAnswers = pgTable("note_learning_card_answers", {
  id: uuid("id").primaryKey().defaultRandom(),
  attemptId: uuid("attempt_id").notNull().references(() => noteLearningCardAttempts.id, { onDelete: "cascade" }),
  questionId: uuid("question_id").notNull().references(() => noteLearningCardQuestions.id, { onDelete: "cascade" }),
  answer: jsonb("answer").$type<unknown>().notNull(),
  score: integer("score"),
  feedback: jsonb("feedback").$type<unknown>(),
  groundingSnapshot: jsonb("grounding_snapshot").$type<NoteLearningCardQuestionGroundingV1>().notNull(),
  usedHint: boolean("used_hint").notNull().default(false),
  gradedAt: timestamp("graded_at", { withTimezone: true }),
}, (t) => ({
  scoreCheck: check("note_learning_card_answers_score_check", sql`${t.score} IS NULL OR ${t.score} BETWEEN 0 AND 100`),
  groundingShape: check("note_learning_card_answers_grounding_check", sql`jsonb_typeof(${t.groundingSnapshot}) = 'object'`),
  questionUnique: uniqueIndex("note_learning_card_answers_question_idx").on(t.attemptId, t.questionId),
}));


/** Plan 57: trusted-template operation questions. The model supplies spec; the host renders/grades. */
export const noteLearningCardOperationArtifacts = pgTable("note_learning_card_operation_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  cardId: uuid("card_id").notNull().references(() => noteLearningCards.id, { onDelete: "cascade" }),
  questionOrdinal: integer("question_ordinal").notNull(),
  template: text("template").$type<"parameter_experiment" | "repair_steps">().notNull(),
  spec: jsonb("spec").$type<unknown>().notNull(),
  html: text("html").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  templateCheck: check("note_learning_card_operation_artifacts_template_check", sql`${t.template} IN ('parameter_experiment','repair_steps')`),
  specShape: check("note_learning_card_operation_artifacts_spec_check", sql`jsonb_typeof(${t.spec}) = 'object'`),
  htmlLength: check("note_learning_card_operation_artifacts_html_check", sql`char_length(${t.html}) >= 1`),
  questionUnique: uniqueIndex("note_learning_card_operation_artifacts_question_idx").on(t.cardId, t.questionOrdinal),
}));
