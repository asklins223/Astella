import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {platform,observedProvider} from '../../workers/ai-worker/src/live-tests/acceptance-common.ts';
import {decideCompanionEntry} from '../../workers/ai-worker/src/handlers/turn/companion-entry-decision.ts';
const dir=new URL('./',import.meta.url),prior=JSON.parse(readFileSync(new URL('../agent-capability-decision-2026-10-28/routing-holdout-manifest.json',dir)));
const native=JSON.parse(readFileSync(new URL('./native-input.json',dir)));
const cases=[...prior.cases.map(c=>({...c,messages:c.history.map(([role,content])=>({role,content})).concat([{role:'user',content:c.text}])})),...native.cases.filter(c=>['moving-frame','proof-odd','causal','ambiguous'].includes(c.id)).map(c=>({...c,expected:'work',messages:(c.history??[]).map(([role,content])=>({role,content})).concat([{role:'user',content:c.text}])}))];
const route=platform('companion_fallback');const records=[];
writeFileSync(new URL('./router-model-manifest.json',dir),JSON.stringify({cases,model:route.model,scope:'Same frozen few-shot policy and resource-only contract, alternate configured provider. Prior diagnostic cases + four new failures; not independent acceptance. Parent deadline 5sec; no retries or edits to examples.'},null,2));
async function run(c){const r={id:c.id,expected:c.expected,wire:[]},start=performance.now();records.push(r);const provider=observedProvider(route,randomUUID(),r.wire,undefined,undefined,undefined,b=>{r.requestHash=createHash('sha256').update(JSON.stringify(b)).digest('hex');});try{r.decision=await decideCompanionEntry({provider,signal:AbortSignal.timeout(10000),userText:c.text,messages:c.messages});r.pass=r.decision.path===c.expected;}catch(e){r.error=e.name;r.pass=false;}r.elapsedMs=Math.round(performance.now()-start);writeFileSync(new URL('./router-model-results.json',dir),JSON.stringify({records},null,2));console.log(JSON.stringify({id:r.id,pass:r.pass,path:r.decision?.path,error:r.error,ms:r.elapsedMs}));}
for(let i=0;i<cases.length;i+=2)await Promise.all(cases.slice(i,i+2).map(run));
