/** Real PostgreSQL regression for paged rebuild, rollback and search projections.
 * SEARCH_REINDEX_TEST_DATABASE_URL must point to a disposable database.
 * This test creates and removes only its own randomly named schema. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@astella/shared/db-schema';
import { testDatabaseUrl } from '@astella/shared/integration-test-db-env';
import type { ApiTransaction } from '../db/client.ts';
import { reindexWorkspaceSearch } from '../modules/search/service.ts';

const connection = testDatabaseUrl('SEARCH_REINDEX_TEST_DATABASE_URL');
const dbName = new URL(connection).pathname.slice(1);
if (!/^astella_(?:it|test|search)[a-zA-Z0-9_]*$/.test(dbName)) throw new Error('Use an astella_it*, astella_test* or astella_search* disposable database');
const client = postgres(connection, { max: 1 });
const schemaName = `search_reindex_${randomUUID().replaceAll('-', '')}`;
const workspace = randomUUID();

test('rebuilds more than 50k entries, filters images, and preserves unrelated projections', async () => {
  try {
    await client.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await client.unsafe(`SET search_path TO "${schemaName}"`);
    await client`CREATE TABLE notes (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, title text NOT NULL, current_version_id uuid, deleted_at timestamptz)`;
    await client`CREATE TABLE note_blocks (version_id uuid NOT NULL, ordinal integer NOT NULL, type text NOT NULL, content text NOT NULL)`;
    await client`CREATE INDEX ON note_blocks(version_id, ordinal)`;
    await client`CREATE TABLE sources (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, title text NOT NULL, origin text, status text NOT NULL, metadata jsonb, type text NOT NULL)`;
    await client`CREATE TABLE source_segments (source_id uuid NOT NULL, ordinal integer NOT NULL, text text NOT NULL)`;
    await client`CREATE INDEX ON source_segments(source_id, ordinal)`;
    await client`CREATE TABLE search_documents (workspace_id uuid NOT NULL, object_type text NOT NULL, object_id uuid NOT NULL, title text, body text, metadata jsonb, indexed_at timestamptz NOT NULL, UNIQUE(workspace_id,object_type,object_id))`;
    await client`INSERT INTO notes (id, workspace_id, title, current_version_id)
      SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(n),12,'0'))::uuid, ${workspace}, 'note-' || n,
        ('00000000-0000-4000-8000-' || lpad(to_hex(n),12,'0'))::uuid
      FROM generate_series(1,50001) AS n`;
    await client`INSERT INTO note_blocks VALUES ('00000000-0000-4000-8000-000000000001',0,'paragraph','first'),
      ('00000000-0000-4000-8000-000000000001',1,'image','private image'),
      ('00000000-0000-4000-8000-000000000001',2,'paragraph','last')`;
    const sourceId = randomUUID();
    const ghostId = randomUUID();
    const otherId = randomUUID();
    await client`INSERT INTO sources VALUES (${sourceId}, ${workspace}, 'source', 'file', 'draft', '{"rawContent":"fallback"}'::jsonb, 'text')`;
    await client`INSERT INTO search_documents VALUES (${workspace}, 'note', ${ghostId}, 'ghost', '', '{}'::jsonb, '2020-01-01'),
      (${workspace}, 'card', ${otherId}, 'keep', '', '{}'::jsonb, '2020-01-01')`;
    const db = drizzle(client, { schema });
    const result = await db.transaction((tx) => reindexWorkspaceSearch(tx as ApiTransaction, workspace));
    assert.deepEqual(result, { deleted: 1, indexed: { note: 50001, source: 1 }, errors: 0, capped: false });
    const [counts] = await client`SELECT count(*) FILTER (WHERE object_type='note')::int AS notes,
      count(*) FILTER (WHERE object_type='card')::int AS cards FROM search_documents WHERE workspace_id=${workspace}`;
    assert.deepEqual({ notes: counts!.notes, cards: counts!.cards }, { notes: 50001, cards: 1 });
    const [note] = await client`SELECT body FROM search_documents WHERE object_type='note' AND object_id='00000000-0000-4000-8000-000000000001'`;
    assert.equal(note!.body, 'first\nlast');
    const [source] = await client`SELECT body FROM search_documents WHERE object_type='source' AND object_id=${sourceId}`;
    assert.equal(source!.body, 'file\nfallback');

    // A writer started before the rebuild must not have its later commit
    // replaced by stale content, regardless of its indexed_at timestamp.
    const other = postgres(connection, { max: 1 });
    let releaseWriter = () => {};
    try {
      await other.unsafe(`SET search_path TO "${schemaName}"`);
      const concurrentWorkspace = randomUUID();
      const concurrentNote = randomUUID();
      const concurrentVersion = randomUUID();
      await client`INSERT INTO notes VALUES (${concurrentNote}, ${concurrentWorkspace}, 'old', ${concurrentVersion}, NULL)`;
      await client`INSERT INTO note_blocks VALUES (${concurrentVersion}, 0, 'paragraph', 'old body')`;
      await client`INSERT INTO search_documents VALUES (${concurrentWorkspace}, 'note', ${concurrentNote}, 'old', 'old body', '{}'::jsonb, '2000-01-01')`;
      let markLocked = () => {};
      const locked = new Promise<void>((resolve) => { markLocked = resolve; });
      const mayCommit = new Promise<void>((resolve) => { releaseWriter = resolve; });
      const writer = other.begin(async (tx) => {
        await tx`UPDATE notes SET title='new' WHERE id=${concurrentNote}`;
        await tx`UPDATE note_blocks SET content='new body' WHERE version_id=${concurrentVersion}`;
        markLocked();
        await mayCommit;
        await tx`UPDATE search_documents SET title='new', body='new body', indexed_at='2000-01-02' WHERE workspace_id=${concurrentWorkspace} AND object_id=${concurrentNote}`;
      });
      await locked;
      const rebuilt = db.transaction((tx) => reindexWorkspaceSearch(tx as ApiTransaction, concurrentWorkspace));
      const blocked = await Promise.race([rebuilt.then(() => false), new Promise<boolean>(resolve => setTimeout(() => resolve(true), 200))]);
      assert.equal(blocked, true, 'rebuild must wait for the in-flight parent update');
      releaseWriter();
      await writer;
      assert.equal((await rebuilt).errors, 0);
      const [latest] = await client`SELECT title, body FROM search_documents WHERE workspace_id=${concurrentWorkspace} AND object_id=${concurrentNote}`;
      assert.deepEqual({ title: latest!.title, body: latest!.body }, { title: 'new', body: 'new body' });
    } finally {
      releaseWriter();
      await other.end({ timeout: 5 });
    }
  } finally {
    await client.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await client.end({ timeout: 5 });
  }
});
