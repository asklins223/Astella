/** Shared JSON protocol for authenticated companion WebSocket sessions. */
import { z } from "zod";
import {
  companionStreamEventV1Schema,
  createCompanionTurnRequestV1Schema,
  createCompanionTurnResponseV1Schema,
} from "./companion-conversation-contracts.ts";

const uuid = z.string().uuid();

export const companionRealtimeClientMessageV1Schema = z.discriminatedUnion("type", [
  z.object({ version: z.literal(1), type: z.literal("auth"), token: z.string().min(1).max(4096) }).strict(),
  z.object({ version: z.literal(1), type: z.literal("subscribe"), conversationId: uuid, after: z.number().int().nonnegative() }).strict(),
  z.object({
    version: z.literal(1),
    type: z.literal("turn.submit"),
    requestId: uuid,
    conversationId: uuid,
    body: createCompanionTurnRequestV1Schema,
  }).strict(),
  z.object({ version: z.literal(1), type: z.literal("pong") }).strict(),
]);
export type CompanionRealtimeClientMessageV1 = z.infer<typeof companionRealtimeClientMessageV1Schema>;

export const companionRealtimeErrorV1Schema = z.object({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(300),
  recoverable: z.boolean(),
  statusCode: z.number().int().min(400).max(599).optional(),
}).strict();
export type CompanionRealtimeErrorV1 = z.infer<typeof companionRealtimeErrorV1Schema>;

// Two correlated turn.result shapes share the same outer type tag, so this is
// intentionally a regular union instead of a discriminated union.
export const companionRealtimeServerMessageV1Schema = z.union([
  z.object({ version: z.literal(1), type: z.literal("auth.ok") }).strict(),
  z.object({ version: z.literal(1), type: z.literal("subscribed"), conversationId: uuid, cursor: z.number().int().nonnegative() }).strict(),
  z.object({ version: z.literal(1), type: z.literal("event"), event: companionStreamEventV1Schema }).strict(),
  z.object({
    version: z.literal(1),
    type: z.literal("turn.result"),
    requestId: uuid,
    ok: z.literal(true),
    result: createCompanionTurnResponseV1Schema,
  }).strict(),
  z.object({
    version: z.literal(1),
    type: z.literal("turn.result"),
    requestId: uuid,
    ok: z.literal(false),
    error: companionRealtimeErrorV1Schema,
  }).strict(),
  z.object({ version: z.literal(1), type: z.literal("error"), error: companionRealtimeErrorV1Schema, requestId: uuid.optional() }).strict(),
  z.object({ version: z.literal(1), type: z.literal("ping") }).strict(),
]);
export type CompanionRealtimeServerMessageV1 = z.infer<typeof companionRealtimeServerMessageV1Schema>;
