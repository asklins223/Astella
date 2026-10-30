import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { notes } from "@astella/shared/db-schema/note";
import { users } from "@astella/shared/db-schema/identity";
import { companionTurnRuns } from "@astella/shared/db-schema/companion-conversations";
import { withWorkspaceTransaction, scopeOfSession } from "../../db/client.ts";
import { requireOwner, isWorkspaceOwner } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import { uuidParamSchema } from "../../lib/pagination.ts";
import { visibleNotesCondition } from "./visibility.ts";
import { noteCollaboration, documentNameForNote, notePresenceSnapshot } from "./collaboration.ts";
import { projectFragmentBlocks } from "./doc-fragment.ts";
import { activeRewriteLocks, acquireRewriteLock, bindRewriteLock, releaseRewriteLock, lockProjection, pruneCompletedRewriteLocks, persistRewriteLocks } from "./edit-locks.ts";

export async function noteEditingRoutes(app: FastifyInstance) {
  const visible = (session: Parameters<typeof scopeOfSession>[0], id: string) => withWorkspaceTransaction(scopeOfSession(session), tx => tx.query.notes.findFirst({
    where: and(eq(notes.id, id), eq(notes.workspaceId, session.workspaceId), isNull(notes.deletedAt), visibleNotesCondition(session.userId)),
  }));
  app.get<{ Params: { id: string } }>("/v2/notes/:id/editing-state", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format" });
    const note = await visible(req.session, params.data.id);
    if (!note) return reply.code(404).send({ error: "not_found" });
    await pruneCompletedRewriteLocks(req.session.workspaceId, note.id, req.session.userId);
    const viewers = notePresenceSnapshot(req.session.workspaceId).find(item => item.noteId === note.id)?.viewers ?? [];
    const personIds = [...new Set([...viewers.map(person => person.userId), ...(note.lastEditedBy ? [note.lastEditedBy] : [])])];
    const people = personIds.length ? await withWorkspaceTransaction(scopeOfSession(req.session), tx => tx.query.users.findMany({
      where: inArray(users.id, personIds), columns: { id: true, displayName: true, email: true, avatarUrl: true },
    })) : [];
    const byId = new Map(people.map(person => [person.id, person]));
    const editor = note.lastEditedBy ? byId.get(note.lastEditedBy) : null;
    reply.header("Cache-Control", "private, no-store");
    return { canEdit: isWorkspaceOwner(req.session), shareScope: note.shareScope,
      workspaceType: req.session.workspaceType,
      canManageSharing: note.createdBy === req.session.userId && req.session.workspaceType === "collaborative",
      lastEditor: editor ? { userId: editor.id, displayName: editor.displayName?.trim() || editor.email.split("@")[0], avatarUrl: editor.avatarUrl, editedAt: note.lastEditedAt?.toISOString() } : null,
      viewers: viewers.map(person => ({ ...person, avatarUrl: byId.get(person.userId)?.avatarUrl ?? null })),
      locks: activeRewriteLocks(note.id).map(lock => lockProjection(lock)),
    };
  });
  app.post<{ Params: { id: string } }>("/v2/notes/:id/edit-locks", { preHandler: [requireOwner] }, async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format" });
    const body = parseBody(app, z.object({ id: z.string().uuid(), startBlock: z.number().int().min(0), endBlock: z.number().int().min(0), expectedBlocks: z.array(z.string()).min(1) }), req.body);
    const note = await visible(req.session, params.data.id);
    if (!note?.currentVersionId) return reply.code(404).send({ error: "not_found" });
    await pruneCompletedRewriteLocks(req.session.workspaceId, note.id, req.session.userId);
    const connection = await noteCollaboration.openDirectConnection(documentNameForNote(note.id), { ...scopeOfSession(req.session), noteId: note.id, versionId: note.currentVersionId, readOnly: false });
    try {
      let result: unknown;
      await connection.transact(doc => {
        const current = projectFragmentBlocks(doc).slice(body.startBlock, body.endBlock + 1).map(block => block.content);
        if (JSON.stringify(current) !== JSON.stringify(body.expectedBlocks)) throw Object.assign(new Error("这段正文刚刚更新，请重新选择后改写。"), { statusCode: 409 });
        result = lockProjection(acquireRewriteLock({ ...scopeOfSession(req.session), noteId: note.id, id: body.id, startBlock: body.startBlock, endBlock: body.endBlock }, doc), doc);
      });
      try { await persistRewriteLocks(req.session.workspaceId, note.id, req.session.userId); }
      catch (error) { releaseRewriteLock(note.id, body.id, req.session.userId); throw error; }
      return result;
    } finally { await connection.disconnect(); }
  });
  app.patch<{ Params: { id: string; lockId: string } }>("/v2/notes/:id/edit-locks/:lockId", { preHandler: [requireOwner] }, async (req, reply) => {
    if (!z.object({ id: z.string().uuid(), lockId: z.string().uuid() }).safeParse(req.params).success) return reply.code(400).send({ error: "invalid_id_format" });
    if (!await visible(req.session, req.params.id)) return reply.code(404).send({ error: "not_found" });
    await pruneCompletedRewriteLocks(req.session.workspaceId, req.params.id, req.session.userId);
    const body = parseBody(app, z.object({ runId: z.string().uuid() }), req.body);
    const run = await withWorkspaceTransaction(scopeOfSession(req.session), tx => tx.query.companionTurnRuns.findFirst({ where: and(eq(companionTurnRuns.id, body.runId), eq(companionTurnRuns.userId, req.session.userId)) }));
    if (!run || !bindRewriteLock(req.params.id, req.params.lockId, req.session.userId, run.id)) return reply.code(404).send({ error: "not_found" });
    await persistRewriteLocks(req.session.workspaceId, req.params.id, req.session.userId);
    return { bound: true };
  });
  app.delete<{ Params: { id: string; lockId: string } }>("/v2/notes/:id/edit-locks/:lockId", { preHandler: [requireOwner] }, async (req, reply) => {
    if (!z.object({ id: z.string().uuid(), lockId: z.string().uuid() }).safeParse(req.params).success) return reply.code(400).send({ error: "invalid_id_format" });
    if (!await visible(req.session, req.params.id)) return reply.code(404).send({ error: "not_found" });
    await pruneCompletedRewriteLocks(req.session.workspaceId, req.params.id, req.session.userId);
    releaseRewriteLock(req.params.id, req.params.lockId, req.session.userId);
    await persistRewriteLocks(req.session.workspaceId, req.params.id, req.session.userId);
    return reply.code(204).send();
  });
}
