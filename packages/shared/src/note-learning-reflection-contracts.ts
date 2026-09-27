import { z } from "zod";

/** A bookmark references an immutable learning record; only its annotation changes. */
export const reflectionSourceRefV1Schema = z.strictObject({
  kind: z.enum(["teaching", "answer"]),
  id: z.string().uuid(),
});
export const reflectionSourceV1Schema = z.strictObject({
  ref: reflectionSourceRefV1Schema,
  roundId: z.string().uuid(),
  question: z.string().min(1).max(500),
  text: z.string().min(1).max(20_000),
  createdAt: z.string().datetime({ offset: true }),
});
export type ReflectionSourceV1 = z.infer<typeof reflectionSourceV1Schema>;
export const noteReflectionV1Schema = z.strictObject({
  reflectionId: z.string().uuid(),
  noteId: z.string().uuid(),
  source: reflectionSourceV1Schema,
  annotation: z.string().max(4_000),
  revision: z.number().int().min(1),
  createdAt: z.string().datetime({ offset: true }),
});
export type NoteReflectionV1 = z.infer<typeof noteReflectionV1Schema>;
export const noteReflectionPageV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(noteReflectionV1Schema).max(20),
  sources: z.array(reflectionSourceV1Schema).max(50),
  nextCursor: z.string().uuid().nullable(),
});
export type NoteReflectionPageV1 = z.infer<typeof noteReflectionPageV1Schema>;
export const noteReflectionQueryV1Schema = z.strictObject({
  reflectionId: z.string().uuid().optional(),
  roundId: z.string().uuid().optional(),
  before: z.string().uuid().optional(),
});
export const createNoteReflectionV1Schema = z.strictObject({
  source: reflectionSourceRefV1Schema,
  annotation: z.string().trim().max(4_000).default(""),
});
export const updateNoteReflectionV1Schema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  annotation: z.string().trim().max(4_000),
});
export const deleteNoteReflectionV1Schema = z.strictObject({
  expectedRevision: z.number().int().min(1),
});
export const noteReflectionCommandV1Schema = z.discriminatedUnion("kind", [
  createNoteReflectionV1Schema.extend({ kind: z.literal("create") }),
  updateNoteReflectionV1Schema.extend({ kind: z.literal("update"), reflectionId: z.string().uuid() }),
  deleteNoteReflectionV1Schema.extend({ kind: z.literal("remove"), reflectionId: z.string().uuid() }),
]);
export type NoteReflectionCommandV1 = z.infer<typeof noteReflectionCommandV1Schema>;
export const noteReflectionWriteResultV1Schema = z.union([noteReflectionV1Schema, z.strictObject({ removed: z.literal(true) })]);
