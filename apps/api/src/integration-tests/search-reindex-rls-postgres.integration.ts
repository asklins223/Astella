/** Tests search rebuild with the real restricted API role and FORCE RLS. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";

const adminUrl = testDatabaseUrl("SEARCH_REINDEX_ADMIN_DATABASE_URL");
const apiUrl = testDatabaseUrl("DATABASE_URL_API");
const dbName = new URL(adminUrl).pathname.slice(1);
if (!/^astella_(?:it|test|search)[a-zA-Z0-9_]*$/.test(dbName) || new URL(apiUrl).pathname !== new URL(adminUrl).pathname) {
  throw new Error("Use API and admin connections to the same disposable astella_it*, astella_test* or astella_search* database");
}
const admin = postgres(adminUrl, { max: 1 });
const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { createNote } = await import("../modules/note/service.ts");
const { reindexWorkspaceSearch } = await import("../modules/search/service.ts");
const { searchRoutes } = await import("../modules/search/routes.ts");
const { issueSession, revokeSession } = await import("../modules/identity/service.ts");
const { prepareMarkdownImport, importMarkdownNotes } = await import("../modules/import/markdown-import-service.ts");

test("restricted rebuild repairs only its workspace", async () => {
  const actors = [randomUUID(), randomUUID()];
  const spaces = [randomUUID(), randomUUID()];
  let token: string | undefined;
  const app = Fastify();
  try {
    for (let i = 0; i < 2; i++) {
      await admin`INSERT INTO users (id, email, password_hash, role) VALUES (${actors[i]!}, ${`search-rls-${actors[i]}@example.test`}, 'test-hash', 'owner')`;
      await admin`INSERT INTO workspaces (id, name, owner_id) VALUES (${spaces[i]!}, ${`search-rls-${spaces[i]}`}, ${actors[i]!})`;
      await admin`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${spaces[i]!}, ${actors[i]!}, 'owner')`;
      await withWorkspaceTransaction({ workspaceId: spaces[i]!, userId: actors[i]! }, (tx) =>
        createNote(tx, spaces[i]!, actors[i]!, { title: `note-${i}`, blocks: [{ type: "paragraph", content: `body-${i}` }] }));
    }
    await admin`UPDATE search_documents SET title='stale' WHERE workspace_id = ANY(${spaces}) AND object_type='note'`;
    const result = await withWorkspaceTransaction({ workspaceId: spaces[0]!, userId: actors[0]! }, (tx) => reindexWorkspaceSearch(tx, spaces[0]!));
    assert.equal(result.errors, 0);
    assert.equal(result.indexed.note, 1);
    const rows = await admin`SELECT workspace_id, title, body FROM search_documents WHERE workspace_id = ANY(${spaces}) AND object_type='note'`;
    assert.equal(rows.find(row => row.workspace_id === spaces[0])?.title, "note-0");
    assert.equal(rows.find(row => row.workspace_id === spaces[0])?.body, "body-0");
    assert.equal(rows.find(row => row.workspace_id === spaces[1])?.title, "stale");

    // A workspace owner cannot see a different member's private note, even in
    // maintenance diagnostics. Repair continues to use the complete index.
    await admin`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${spaces[0]!}, ${actors[1]!}, 'member')`;
    const secretTitle = `private-${randomUUID()}`;
    // Members are read-only and cannot create notes through the API. Seed a
    // pre-existing private note owned by the member without weakening that
    // permission boundary, then exercise diagnostics with the owner's token.
    const privateNote = await withWorkspaceTransaction({ workspaceId: spaces[0]!, userId: actors[0]! }, (tx) =>
      createNote(tx, spaces[0]!, actors[0]!, { title: secretTitle, blocks: [{ type: "paragraph", content: "private body" }] }));
    assert.ok(privateNote);
    await admin`UPDATE notes SET created_by=${actors[1]!} WHERE id=${privateNote.note.id}`;
    await admin`UPDATE search_documents SET title='outdated-private' WHERE object_id=${privateNote.note.id}`;
    await app.register(sensible);
    await app.register(searchRoutes);
    token = (await issueSession(actors[0]!, spaces[0]!)).token;
    for (const method of ["GET", "POST"] as const) {
      const response: { statusCode: number; body: string } = await app.inject({ method, url: method === "GET" ? "/search/drift" : "/search/auto-fix",
        headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(!response.body.includes(privateNote.note.id), "private ID must not leave the API");
      assert.ok(!response.body.includes(secretTitle), "private title must not leave the API");
      assert.ok(!response.body.includes("outdated-private"), "private indexed title must not leave the API");
    }

    // Import writes its search projection in the same actor-scoped transaction;
    // no post-commit stale copy can overwrite a subsequent edit.
    const scope = { workspaceId: spaces[0]!, userId: actors[0]! };
    const items = await prepareMarkdownImport(scope, [{ title: "imported title", content: "imported body" }]);
    const imported = await withWorkspaceTransaction(scope, (tx) => importMarkdownNotes(tx, scope, { items, importId: null }));
    assert.equal(imported.response.imported, 1);
    const importedId = imported.response.notes[0]!.note.id;
    const [projection] = await admin`SELECT title, body FROM search_documents WHERE workspace_id=${spaces[0]!} AND object_type='note' AND object_id=${importedId}`;
    assert.equal(projection?.title, "imported title");
    assert.equal(projection?.body, "imported body");
  } finally {
    if (token) await revokeSession(token).catch(() => {});
    await app.close();
    await admin`DELETE FROM notes WHERE workspace_id = ANY(${spaces})`;
    await admin`DELETE FROM workspace_members WHERE workspace_id = ANY(${spaces})`;
    await admin`DELETE FROM workspaces WHERE id = ANY(${spaces})`;
    await admin`DELETE FROM users WHERE id = ANY(${actors})`;
    await closeDatabase();
    await admin.end({ timeout: 5 });
  }
});
