import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { MindMapContentV1 } from "../contracts/note-mind-map-contracts.ts";
import { noteVersions, notes } from "./note.ts";
import { jobs } from "./job.ts";
import { users, workspaces } from "./identity.ts";

export const noteMindMaps = pgTable("note_mind_maps", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  noteVersionId: uuid("note_version_id").notNull(),
  title: text("title").notNull(), contentHash: text("content_hash").notNull(),
  content: jsonb("content").$type<MindMapContentV1>().notNull(),
  coverage: jsonb("coverage").$type<{totalBlocks:number;textBlockOrdinals:number[];imageBlocksNotRead:number;allTextRead:true}>().notNull(),
  generationJobId: uuid("generation_job_id").notNull(), modelId:text("model_id").notNull(),promptVersion:text("prompt_version").notNull(),
  createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
}, t => ({
  contentShape:check("note_mind_maps_content_check",sql`jsonb_typeof(${t.content}->'nodes')='array' AND jsonb_array_length(${t.content}->'nodes') BETWEEN 2 AND 120`),
  versionBelongsToNote:foreignKey({name:"note_mind_maps_version_note_fk",columns:[t.workspaceId,t.noteId,t.noteVersionId],foreignColumns:[noteVersions.workspaceId,noteVersions.noteId,noteVersions.id]}).onDelete("cascade"),
  jobBelongsToWorkspace:foreignKey({name:"note_mind_maps_job_workspace_fk",columns:[t.generationJobId,t.workspaceId],foreignColumns:[jobs.id,jobs.workspaceId]}).onDelete("restrict"),
  jobUnique:uniqueIndex("note_mind_maps_job_unique_idx").on(t.workspaceId,t.generationJobId),
  createdOrder:index("note_mind_maps_created_idx").on(t.workspaceId,t.userId,t.noteId,sql`${t.createdAt} desc`,sql`${t.id} desc`),
}));

/** Completed model stages survive a worker lease retry; immutable hash identifies the input. */
export const noteMindMapStages = pgTable("note_mind_map_stages", {
  jobId:uuid("job_id").notNull(),workspaceId:uuid("workspace_id").notNull(),userId:uuid("user_id").notNull(),
  stage:text("stage").notNull(),inputHash:text("input_hash").notNull(),output:jsonb("output").$type<MindMapContentV1>().notNull(),
}, t => ({
  identity:uniqueIndex("note_mind_map_stages_key").on(t.jobId,t.stage,t.inputHash),
  jobForeign:foreignKey({columns:[t.jobId,t.workspaceId],foreignColumns:[jobs.id,jobs.workspaceId]}).onDelete("cascade"),
}));
