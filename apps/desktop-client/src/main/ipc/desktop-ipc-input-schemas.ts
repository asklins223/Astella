import { z } from "zod";
import {
  commandIdSchema,
  desktopNoteSaveRequestV1Schema,
  NOTE_DOC_UPDATE_MAX_CHARS,
  requestMetaSchema,
  shellOpenExternalRequestV1Schema,
  subscriptionIdSchema,
  subscriptionTopicM2Schema,
  uuidSchema,
} from "@astella/shared/desktop-ipc-contracts";
import { noteShareScopeValuesV1 } from "@astella/shared/note-share-contracts";
import { NOTE_DOC_PRESENCE_MAX_CHARS } from "../note-doc/note-doc-transport.ts";

const m1InputBase = { meta: requestMetaSchema };

export const shellOpenExternalInputSchema = z.strictObject({
  ...m1InputBase,
  request: shellOpenExternalRequestV1Schema,
});

export const windowThemeInputSchema = z.strictObject({ ...m1InputBase, theme: z.enum(["day", "night"]) });
export const subscribeInputSchema = z.strictObject({ ...m1InputBase, topic: subscriptionTopicM2Schema });
export const unsubscribeInputSchema = z.strictObject({ ...m1InputBase, subscriptionId: subscriptionIdSchema });
export const titlebarThemeOutputSchema = z.strictObject({ applied: z.literal(true) });
export const focusOutputSchema = z.strictObject({ focused: z.literal(true) });
export const subscriptionOutputSchema = z.strictObject({ subscriptionId: subscriptionIdSchema });
export const closedSubscriptionOutputSchema = z.strictObject({ closed: z.literal(true) });

export const noteIdInputSchema = z.strictObject({ ...m1InputBase, noteId: uuidSchema });
export const artifactEnsureInputSchema = z.strictObject({ ...m1InputBase, artifactId: uuidSchema, origin: z.enum(["round", "note_learning", "note_learning_card"]).default("round") });
export const artifactEnsureResultSchema = z.strictObject({
  stored: z.boolean(),
});
export const noteDeepeningInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  limit: z.number().int().min(1).max(500).optional(),
});
export const searchGlobalInputSchema = z.strictObject({ ...m1InputBase, query: z.string().trim().min(1).max(500), type: z.enum(["note", "source"]).optional(), limit: z.number().int().min(1).max(50).optional(), cursor: z.string().min(1).max(512).optional() });
export const noteSaveInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  request: desktopNoteSaveRequestV1Schema,
});
export const noteDocStateInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
});
export const noteDocSyncUpdateInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  update: z.string().min(1).max(NOTE_DOC_UPDATE_MAX_CHARS),
});
export const noteDocSyncTitleInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  title: z.string().min(1).max(200),
  titleSource: z.enum(["manual", "auto"]),
});
export const noteSetShareInputSchema = z.strictObject({
  ...m1InputBase,
  commandId: commandIdSchema,
  noteId: uuidSchema,
  shareScope: z.enum(noteShareScopeValuesV1),
});
export const noteDocPresenceInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  state: z.string().max(NOTE_DOC_PRESENCE_MAX_CHARS),
});
export const noteDocDraftSaveInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
  update: z.string().min(1).max(NOTE_DOC_UPDATE_MAX_CHARS),
});
export const noteDocDraftNoteInputSchema = z.strictObject({
  ...m1InputBase,
  noteId: uuidSchema,
});
