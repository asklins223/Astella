import {parseEnv} from 'node:util';
import {readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=fileURLToPath(new URL('./',import.meta.url));
const action=process.argv[2],name='astella-agent-impl-test-db';
const privatePath=out+'services.private.json';
const rootEnv=parseEnv(readFileSync(root+'.env','utf8'));
function run(cmd,args,opts={}){const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',...opts});if(r.status!==0)throw Error(cmd+' failed: '+String(r.stderr??'').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[database URL]').slice(-800));return r.stdout;}
if(action==='database'){
 const image=run('docker',['inspect','astella-dev-postgres-1','--format','{{.Config.Image}}']).trim();
 const passwords={owner:randomBytes(20).toString('hex'),migrator:randomBytes(20).toString('hex'),api:randomBytes(20).toString('hex'),worker:randomBytes(20).toString('hex')};
 const url=(user,pw)=>`postgres://${user}:${pw}@127.0.0.1:55438/astella_acceptance`;
 const env={...rootEnv,DATABASE_URL:url('astella',passwords.owner),DATABASE_URL_MIGRATOR:url('astella_migrator',passwords.migrator),DATABASE_URL_API:url('astella_api',passwords.api),DATABASE_URL_WORKER:url('astella_worker',passwords.worker)};
 writeFileSync(privatePath,JSON.stringify({env,name}),{mode:0o600});
 run('docker',['run','-d','--rm','--name',name,'-p','127.0.0.1:55438:5432','-e','POSTGRES_USER=astella','-e','POSTGRES_DB=astella_acceptance','-e','POSTGRES_PASSWORD='+passwords.owner,image]);
 let ready=false;for(let i=0;i<60;i++){if(spawnSync('docker',['exec',name,'pg_isready','-U','astella'],{stdio:'ignore'}).status===0){ready=true;break;}await new Promise(r=>setTimeout(r,500));}if(!ready)throw Error('test postgres not ready');
 const roles=readFileSync(root+'infra/postgres/roles.sql');
 const apply=requireRls=>run('docker',['exec','-i',name,'psql','-q','-v','ON_ERROR_STOP=1','-U','astella','-d','astella_acceptance','-v','migrator_password='+passwords.migrator,'-v','api_password='+passwords.api,'-v','worker_password='+passwords.worker,'-v','require_rls_disabled='+requireRls,'-f','-'],{input:roles});
 apply('false');
 const fd=openSync(out+'test-db-migrations.log','w');const m=spawnSync('npm',['run','--silent','db:migrate'],{cwd:root+'apps/api',env:{...process.env,...env},stdio:['ignore',fd,fd]});closeSync(fd);if(m.status!==0)throw Error('test DB migration failed; see log');
 apply('true');console.log('Isolated PostgreSQL ready; migrations and restricted runtime roles applied.');
}else{
 const {env}=JSON.parse(readFileSync(privatePath));
 const runtime={...process.env,...env,NODE_ENV:'development',AI_PLATFORMS_CONFIG:process.env.AGENT_TEST_PLATFORM_CONFIG??root+'config/ai-platforms.json',AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS:'true',COMPANION_AGENT_RESOURCE_ROUTING:process.env.AGENT_TEST_RESOURCE_ROUTING??'enabled',PORT:'4108',HOST:'127.0.0.1',API_BIND_ADDRESS:'127.0.0.1',WORKER_METRICS_PORT:'9118',LOG_LEVEL:'warn'};
 if(action==='api'||action==='worker'){
  const dir=action==='api'?'apps/api':'workers/ai-worker';
  if(action==='worker'){const files=['workers/ai-worker/src/handlers/agent/companion-agent-runtime.ts','workers/ai-worker/src/handlers/agent/companion-finish.ts','workers/ai-worker/src/handlers/turn/companion-step-plan.ts','workers/ai-worker/src/handlers/turn/companion-entry-mode.ts','workers/ai-worker/src/handlers/turn/companion-entry-decision.ts','workers/ai-worker/src/handlers/tools/companion-tool-receipts.ts','workers/ai-worker/src/handlers/note/companion-note-authoring.ts','workers/ai-worker/src/lib/providers/pi-agent.ts','packages/shared/src/agent/companion-capability-manifest.ts'];writeFileSync(out+'worker-source-'+Date.now()+'.json',JSON.stringify(Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(root+f)).digest('hex')])),null,2));}
  const fd=openSync(out+action+'-isolated.log','w');
  const child=spawn('node',['--import','tsx',action==='api'?'src/server.ts':'src/index.ts'],{cwd:root+dir,env:runtime,stdio:['ignore',fd,fd]});
  console.log(action+' isolated process '+child.pid);process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));child.on('exit',code=>{closeSync(fd);process.exitCode=code??0;});
 }else if(action==='integration'){
  const fd=openSync(out+'postgres-integration.log','w');
  const child=spawn('node',['--import','tsx','--test','--test-concurrency=1','src/integration-tests/companion-note-authoring-postgres.integration.ts','src/integration-tests/companion-runtime-recovery-postgres.integration.ts'],{cwd:root+'workers/ai-worker',env:{...runtime,COMPANION_AGENT_RESOURCE_ROUTING:'disabled'},stdio:['ignore',fd,fd]});
  child.on('exit',code=>{closeSync(fd);process.exitCode=code??0;});
 }else throw Error('unknown service action');
}
