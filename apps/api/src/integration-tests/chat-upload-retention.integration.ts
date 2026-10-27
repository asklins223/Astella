/** Real Postgres migration/RLS checks, in a disposable container without published ports. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const enabled = process.env.ASTELLA_RUN_CHAT_RETENTION_TEST === "1";
const room = '10000000-0000-0000-0000-000000000001', user = '20000000-0000-0000-0000-000000000001';
const asset = '30000000-0000-0000-0000-000000000001';
test('chat expiry, historical note promotion, cleanup claims, RLS and restart recovery', { skip: !enabled, timeout: 90000 }, async () => {
 const name = `astella-chat-retention-qa-${process.pid}`;
 const docker = (args: string[], input?: string) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
 const query = (input: string) => docker(['exec','-i',name,'psql','-h','127.0.0.1','-U','postgres','-v','ON_ERROR_STOP=1','-At'], input).trim();
 const actor = (input: string) => query(`BEGIN; SET LOCAL ROLE astella_api; SELECT set_config('app.workspace_id','${room}',true); SELECT set_config('app.user_id','${user}',true); ${input}; COMMIT;`);
 try {
  docker(['run','-d','--rm','--name',name,'--memory','256m','--cpus','0.5','-e','POSTGRES_PASSWORD=disposable-retention-qa','pgvector/pgvector:pg16']);
  for (let attempt=0;;attempt++) {
   try { query('SELECT 1'); break; } catch (error) { if (attempt===50) throw error; await new Promise(r=>setTimeout(r,200)); }
  }
  query(`CREATE ROLE astella_migrator BYPASSRLS; CREATE ROLE astella_api NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE,CREATE ON SCHEMA public TO astella_migrator; GRANT USAGE ON SCHEMA public TO astella_api;
    CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE workspaces(id uuid PRIMARY KEY);
    CREATE TABLE note_image_assets(id uuid PRIMARY KEY,workspace_id uuid,created_by uuid,object_key text,created_at timestamptz DEFAULT now());
    CREATE TABLE note_blocks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid,image_asset_id uuid,type text,content text);
    CREATE TABLE sources(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid,metadata jsonb);
    GRANT ALL ON ALL TABLES IN SCHEMA public TO astella_migrator; GRANT SELECT,INSERT ON note_blocks,sources TO astella_api;
    INSERT INTO users VALUES('${user}'); INSERT INTO workspaces VALUES('${room}');
    INSERT INTO note_image_assets VALUES('${asset}','${room}','${user}','${room}/companion/retained.png',now()-interval '60 days');
    INSERT INTO note_image_assets VALUES('30000000-0000-0000-0000-000000000002','${room}','${user}','${room}/companion/old.png',now()-interval '31 days');
    INSERT INTO note_image_assets VALUES('30000000-0000-0000-0000-000000000003','${room}','${user}','${room}/notes/note/durable.png',now()-interval '60 days');
    INSERT INTO note_blocks(workspace_id,image_asset_id,type,content) VALUES('${room}','${asset}','image','![kept](/api/uploads/${room}/companion/retained.png)');`);
  const migration = readFileSync(new URL('../db/migrations/0461_chat_upload_retention.sql',import.meta.url),'utf8');
  query('SET ROLE astella_migrator;\n'+migration);
  assert.equal(query('SET ROLE astella_api; SELECT count(*) FROM chat_upload_objects'), 'SET\n0', 'no actor context reveals no rows');
  assert.equal(query(`SELECT count(*) FROM chat_upload_objects`),'2','note images are outside the expiring ledger');
  assert.equal(query(`SELECT retained_at IS NOT NULL FROM chat_upload_objects WHERE object_key='${room}/companion/retained.png'`),'t','old note versions already retain images');
  assert.match(actor(`SELECT count(*) FROM chat_upload_objects`), /\n2\nCOMMIT$/);
  assert.equal(query(`SET ROLE astella_api; SELECT astella_chat_upload_retained('${room}/companion/retained.png')`),'SET\nt');
  const file=`${room}/companion-files/${user}/original.pdf`;
  actor(`INSERT INTO chat_upload_objects(object_key,workspace_id,user_id) VALUES('${file}','${room}','${user}')`);
  assert.equal(query(`SELECT abs(extract(epoch FROM expires_at-created_at)-30*86400)<1 FROM chat_upload_objects WHERE object_key='${file}'`),'t');
  actor(`INSERT INTO sources(workspace_id,metadata) VALUES('${room}',jsonb_build_object('storageObjectKey','${file}'))`);
  assert.equal(query(`SELECT retained_at IS NOT NULL FROM chat_upload_objects WHERE object_key='${file}'`),'t','saved files become durable');
  const old=`${room}/companion/old.png`;
  assert.equal(query('SET ROLE astella_api; SELECT * FROM astella_claim_expired_chat_uploads(10)'),`SET\n${old}`);
  assert.equal(query('SET ROLE astella_api; SELECT count(*) FROM astella_claim_expired_chat_uploads(10)'),'SET\n0','another consumer cannot claim an in-flight deletion');
  assert.throws(()=>actor(`INSERT INTO note_blocks(workspace_id,image_asset_id,type,content) VALUES('${room}','30000000-0000-0000-0000-000000000002','image','expired')`),/expired/,'a claimed deletion fences a racing promotion');
  query(`UPDATE chat_upload_objects SET purge_started_at=now()-interval '11 minutes' WHERE object_key='${old}'`);
  assert.equal(query('SET ROLE astella_api; SELECT * FROM astella_claim_expired_chat_uploads(10)'),`SET\n${old}`,'crashed cleanup can retry');
  query(`SET ROLE astella_api; SELECT astella_finish_chat_upload_purge('${old}')`);
  assert.equal(query(`SELECT purged_at IS NOT NULL FROM chat_upload_objects WHERE object_key='${old}'`),'t');
  const pending=query('SET ROLE astella_api; SELECT count(*) FROM astella_pending_chat_upload_promotions(50)');
  assert.equal(pending,'SET\n2');
  query(`SET ROLE astella_api; SELECT astella_ack_chat_upload_promotion('${file}')`);
  assert.equal(query('SET ROLE astella_api; SELECT count(*) FROM astella_pending_chat_upload_promotions(50)'),'SET\n1');
  assert.throws(()=>query(`SET ROLE astella_api; SELECT astella_retain_chat_upload('${old}')`),/permission denied/,'promotion is only available through the note/source triggers');
 } finally { try { docker(['rm','-f',name]); } catch {} }
});
