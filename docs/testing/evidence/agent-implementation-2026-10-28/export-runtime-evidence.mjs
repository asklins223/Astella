import {createRequire} from 'node:module';import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
const postgres=createRequire(new URL('../../workers/ai-worker/package.json',import.meta.url))('postgres');
const {env}=JSON.parse(readFileSync(new URL('./services.private.json',import.meta.url)));const db=postgres(env.DATABASE_URL,{max:2});
const dir=new URL('./',import.meta.url);const files=readdirSync(dir).filter(f=>/^http-[a-z0-9-]+-\d+\.json$/.test(f));const results=[];
for(const f of files){const batch=JSON.parse(readFileSync(new URL(f,dir)));for(const r of batch.records??[]){if(!r.runId)continue;
 const events=await db`SELECT type,payload,created_at FROM companion_stream_events WHERE run_id=${r.runId} AND type IN ('assistant.delta','assistant.utterance','agent.tool') ORDER BY seq`;
 const calls=await db`SELECT name,status,tool_call_id FROM companion_agent_tool_calls WHERE run_id=${r.runId} ORDER BY created_at`;
 results.push({batch:f,id:r.id,repeat:r.repeat,runId:r.runId,events,calls});}}
writeFileSync(new URL('http-events.json',dir),JSON.stringify(results,null,2));
console.log(JSON.stringify({batches:files.length,runs:results.length}));await db.end();
