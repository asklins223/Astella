import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { pngWithText } from '../../workers/ai-worker/src/live-tests/companion-image-fixture.ts';

assert.equal(process.env.REAL_PRODUCTION_AGENT_ACCEPTANCE, '1');
const workspaceId=randomUUID(), userId=randomUUID(), token=randomBytes(32).toString('hex');
const tokenHash=createHash('sha256').update(token).digest('hex');
const suffix=workspaceId.slice(0,8), title='Agent线上验收-'+suffix;
const secret='海风'+randomBytes(4).toString('hex');
const records:any[]=[], active:any[]=[];
const label=process.env.ONLINE_ACCEPTANCE_LABEL??'production-acceptance';assert.match(label,/^[a-z0-9-]+$/u);
const output=new URL('./'+label+'.json',import.meta.url);
const q=(v:string)=>"'"+v.replaceAll("'","''")+"'";
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function sql(statement:string):Promise<any[]> {
 return new Promise((resolve,reject)=>{
  const command='docker exec -i astella-postgres-1 sh -c '+"'"+'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'+"'";
  const child=spawn('ssh',['-S','/tmp/astella-agent-1029/control','-o','BatchMode=yes','-p','11587','root@103.106.191.159',command]);
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  child.on('error',reject);child.on('close',code=>{
   if(code!==0)return reject(Error('Scoped SQL failed: '+stderr.slice(0,1200)));
   try{resolve(stdout.trim()?stdout.trim().split('\n').map(line=>JSON.parse(line)):[]);}catch(e){reject(e);}
  });
  child.stdin.end('BEGIN; SET LOCAL app.workspace_id='+q(workspaceId)+'; SET LOCAL app.user_id='+q(userId)+';\n'+statement+'\nCOMMIT;\n');
 });
}
async function api(endpoint:string,body?:unknown){
 const response=await fetch('http://127.0.0.1:4129'+endpoint,{method:body===undefined?'GET':'POST',
  signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':randomUUID()},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal(response.ok,true,'HTTP '+response.status+' '+endpoint);return await response.json() as any;
}
const persist=()=>writeFileSync(output,JSON.stringify({version:1,environment:'production',workspaceId,userId,
 sourceHash:'da8a24b31518d6bee52b01adafa82877ed95a1d8ae8d9919dc551b5ca599ca25',records,
 note:'Synthetic account only. Public replies and real receipts. Structural pass is not an overall semantic success rate. firstVisibleMs measures server acceptance to first durable visible event.'},null,2));
const tokens=['DB9D76','B80D2F','ZX7Q6A','AW29TR','K73Y8P','HV4X6N','MP7J3C','FR62ZA','XY9K5V','JN3T8E','UW74RC','AK2M6Y'];
let conversationId='',images:any[]=[],lastStart=0, fatal=false;
const cases:any[]=[
 {id:'literal-create',prompt:'新建笔记，标题《'+title+'》。正文必须逐字为下面三个独立段落，直接保存，不要创作、扩写或补充任何正文：\n\n早晨看海\n\n午后写信\n\n夜里关灯',tools:['notes.write.create'],document:['早晨看海','午后写信','夜里关灯']},
 {id:'literal-edit',prompt:'把《'+title+'》第二段逐字替换为“午后去码头”；第一段和第三段不得增删或改动。',document:['早晨看海','午后去码头','夜里关灯']},
 {id:'greeting',prompt:'在吗？',noWrites:true},
 {id:'quiet-chat',prompt:'今天有点累，只想靠这里待会儿，不用问我问题，也别安排学习。',noWrites:true},
 {id:'calculate',prompt:'用计算工具核对347乘以29是多少。',tools:['observe.calculate'],includes:/10[，, ]?063/u},
 {id:'note-create',prompt:'新建一篇笔记，标题《'+title+'》，按三个独立段落写：早晨看海、午后写信、夜里关灯。',tools:['notes.write.create'],document:['早晨看海','午后写信','夜里关灯']},
 {id:'note-read',prompt:'请读取《'+title+'》，告诉我里面是哪三段。',tools:['notes.read.read'],includes:/早晨看海/u},
 {id:'note-edit',prompt:'把《'+title+'》的第二段改成“午后去码头”，其余两段保留原样。',document:['早晨看海','午后去码头','夜里关灯']},
 {id:'hidden-note',prompt:'读取《线上独立资料-'+suffix+'》，告诉我资料里的暗号。',includes:new RegExp(secret,'u'),tools:['notes.read.read']},
 {id:'offer-first',prompt:'我早餐只喝燕麦奶。先不要保存；你先问我是否要记住这一点。',noWrites:true},
 {id:'accept-followup',prompt:'可以，把刚才说的这个偏好记住吧。',memory:true},
 {id:'split',prompt:'分两条独立消息发给我：先说早上好，再问我今天准备先做什么。',messages:2,tools:['say.publish']},
 {id:'quote-no-action',prompt:'朋友今天说“干脆都删掉重来”，我只是跟你吐槽，不是让你做操作。',noWrites:true},
 {id:'bayes',prompt:'一种病患病率2%，试剂敏感度80%，未患病者误报率10%。随机一人阳性，他患病概率多少？请把假阳性计入并推导。',quality:'核对患病阳性0.016，未病阳性0.098，后验8/57约14.04%。'},
 {id:'after-work-chat',prompt:'哈哈，谢谢你，晚安。',noWrites:true},
 {id:'image',prompt:'按图片顺序逐张抄出每张图的字符，共12张。请核对全部图片，不能遗漏或把顺序换掉。',image:true,pixelTokens:tokens},
 {id:'image-followup',prompt:'再看看刚才上传的12张原图，按原顺序重新读取，不要照抄上一个答案。',pixelTokens:tokens},
 {id:'image-followup-second',prompt:'只参考刚才上传的原图，再核对一下这12项；看不清就直说，请按原顺序逐张列出结果。',pixelTokens:tokens},
 {id:'cancel',prompt:'请详细推导一维波动方程并解释各种边界条件，过程写完整。',cancel:true},
];
try{
 await sql(`INSERT INTO users(id,email,password_hash,role) VALUES(${q(userId)},${q('agent-online-'+userId+'@test.invalid')},'synthetic-no-login','owner');
 INSERT INTO workspaces(id,name,owner_id,workspace_type) VALUES(${q(workspaceId)},${q('Agent线上独立验收 '+suffix)},${q(userId)},'personal');
 INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${q(workspaceId)},${q(userId)},'owner');
 UPDATE users SET personal_workspace_id=${q(workspaceId)} WHERE id=${q(userId)};
 INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy) VALUES(${q(userId)},'ai-consent-v1',now(),'${JSON.stringify({sendToExternal:true,sendImageContent:true,piiDetection:false,auditLogging:true})}'::jsonb);
 INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${q(userId)},0,true);
 UPDATE user_companion_account_state SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"full"'::jsonb) WHERE user_id=${q(userId)};
 INSERT INTO sessions(token,user_id,workspace_id,client_kind,expires_at) VALUES(${q(tokenHash)},${q(userId)},${q(workspaceId)},'desktop',now()+interval '30 minutes');`);
 conversationId=(await api('/companion/inbox/ensure',{})).id;
 await api('/notes',{title:'线上独立资料-'+suffix,blocks:[{type:'paragraph',content:'资料暗号：'+secret+'。'}]});
 for(const pixelToken of tokens){
 const bytes=readFileSync(new URL('rendered-fixtures/'+pixelToken+'.png',import.meta.url));
 const form=new FormData();form.append('file',new Blob([bytes],{type:'image/png'}),'fixture.png');
 const uploaded=await fetch('http://127.0.0.1:4129/uploads/companion-images',{method:'POST',headers:{Authorization:'Bearer '+token},body:form,signal:AbortSignal.timeout(20000)});
 assert.equal(uploaded.ok,true,'image upload '+uploaded.status);const asset:any=await uploaded.json();
 images.push({type:'image',assetId:asset.assetId,url:asset.url,label:'测试图片'});assert.ok(asset.assetId);
 }
 const selected=process.env.ONLINE_ACCEPTANCE_CASES?.split(',')??cases.filter(c=>!c.id.startsWith('literal-')).map(c=>c.id);
 assert.ok(selected.every(id=>cases.some(c=>c.id===id)));
 for(const c of cases.filter(c=>selected.includes(c.id))){
  await delay(Math.max(0,lastStart+5100-Date.now()));const start=Date.now();lastStart=start;
  const accepted=await api('/companion/conversations/'+conversationId+'/turns',{version:1,clientMessageId:randomUUID(),inputKind:'text',sourceSurface:'pet',blocks:[{type:'text',text:c.prompt},...(c.image?images:[])]});
  active.push(accepted);
  if(c.cancel){await delay(400);await api('/companion/runs/'+accepted.runId+'/cancel',{version:1,generation:accepted.generation,reason:'user'});}
  let run:any;
  for(;;){
   [run]=await sql(`SELECT json_build_object('status',status,'errorCode',error_code,'route',route,'stepCount',step_count,'modelCallCount',model_call_count) FROM companion_turn_runs WHERE id=${q(accepted.runId)} AND user_id=${q(userId)};`);
   if(['succeeded','failed','cancelled','waiting_for_confirmation'].includes(run?.status)||Date.now()-start>180000)break;
   await delay(1000);
  }
  const [evidence]=await sql(`SELECT json_build_object(
   'firstVisibleMs',(SELECT round(extract(epoch FROM min(e.created_at)-r.created_at)*1000) FROM companion_stream_events e WHERE e.run_id=r.id AND e.type IN ('assistant.delta','assistant.utterance')),
   'calls',(SELECT coalesce(json_agg(json_build_object('name',name,'status',status,'riskClass',risk_class) ORDER BY created_at),'[]'::json) FROM companion_agent_tool_calls WHERE run_id=r.id),
   'messages',(SELECT coalesce(json_agg(blocks ORDER BY seq),'[]'::json) FROM companion_messages WHERE run_id=r.id AND role='assistant'),
   'providerCalls',(SELECT coalesce(json_agg(json_build_object('provider',provider,'operation',operation,'durationMs',duration_ms,'promptTokens',prompt_tokens,'completionTokens',completion_tokens,'status',status) ORDER BY created_at),'[]'::json) FROM ai_audit_log WHERE job_id=r.job_id)
   ) FROM companion_turn_runs r WHERE id=${q(accepted.runId)} AND user_id=${q(userId)};`);
  const texts=evidence.messages.map((b:any[])=>b.filter(x=>x.type==='text').map(x=>x.text??'').join(''));
  const text=texts.join('\n\n'),calls=evidence.calls;
  const checks:any=c.cancel?{cancelled:run.status==='cancelled',noWrites:!calls.some((x:any)=>x.status==='succeeded'&&x.riskClass!=='read')}:
   {succeeded:run.status==='succeeded',nonempty:!!text.trim(),noInternalLeak:!/<current_turn|<memory_data>|companion_[a-z_]{4,}/u.test(text)};
  if(c.tools)checks.tools=c.tools.every((name:string)=>calls.some((x:any)=>x.name===name&&x.status==='succeeded'));
  if(c.messages)checks.messageCount=texts.length===c.messages;
  if(c.includes)checks.content=c.includes.test(text);
  if(c.pixelTokens){const positions=c.pixelTokens.map((t:string)=>text.indexOf(t));checks.actualPixels=positions.every((p:number)=>p>=0);checks.noRepeatedImageAnswer=c.pixelTokens.every((t:string)=>text.split(t).length===2);checks.imageOrder=positions.every((p:number,i:number)=>i===0||p>positions[i-1]);}
  if(c.noWrites)checks.noWrites=!calls.some((x:any)=>x.status==='succeeded'&&x.riskClass!=='read');
  let observedDocument,observedMemory;
  if(c.document){
   const [n]=await sql(`SELECT json_build_object('id',id) FROM notes WHERE workspace_id=${q(workspaceId)} AND title=${q(title)} AND deleted_at IS NULL;`);
   if(n){const d=await api('/v2/notes/'+n.id);observedDocument=d.currentVersion.blocks.map((x:any)=>x.content??'');}
   checks.exactDocument=JSON.stringify(observedDocument)===JSON.stringify(c.document);
  }
  if(c.id==='offer-first'||c.memory){
   observedMemory=await sql(`SELECT json_build_object('content',m.content,'appliesWhen',m.applies_when,'sourceBlocks',c.blocks) FROM assistant_memory_items m LEFT JOIN companion_messages c ON c.id::text=m.source_event_id WHERE m.user_id=${q(userId)} AND m.deleted_at IS NULL AND m.content LIKE '%燕麦奶%';`);
   if(c.memory)checks.originalFactSource=observedMemory.some((m:any)=>m.content.includes('早餐')&&JSON.stringify(m.sourceBlocks).includes('我早餐只喝燕麦奶'));
   else checks.noPrematureMemory=observedMemory.length===0;
  }
  const record={id:c.id,prompt:c.prompt,runId:accepted.runId,run,checks,ok:Object.values(checks).every(Boolean),elapsedMs:Date.now()-start,...evidence,texts,...(observedDocument?{observedDocument}:{}),...(observedMemory?{observedMemory}:{}),...(c.quality?{manualRubric:c.quality,semanticReview:'pending'}:{})};
  records.push(record);persist();console.log(JSON.stringify({id:c.id,ok:record.ok,checks,firstVisibleMs:record.firstVisibleMs,elapsedMs:record.elapsedMs,status:run.status}));
  if(!['succeeded','failed','cancelled'].includes(run?.status))await api('/companion/runs/'+accepted.runId+'/cancel',{version:1,generation:accepted.generation,reason:'user'});
 }
}catch(e){fatal=true;records.push({fatal:e instanceof Error?e.message:String(e)});console.error(e);}
finally{
 for(const r of active)await api('/companion/runs/'+r.runId+'/cancel',{version:1,generation:r.generation,reason:'user'}).catch(()=>{});
 await sql(`UPDATE user_companion_account_state SET global_enabled=false,epoch=epoch+1 WHERE user_id=${q(userId)}; DELETE FROM sessions WHERE user_id=${q(userId)};`).catch(e=>{fatal=true;records.push({cleanupError:String(e)});});
 persist();console.log(JSON.stringify({passed:records.filter(r=>r.ok).length,total:records.length,userId,workspaceId}));
 if(fatal||records.some(r=>r.ok===false))process.exitCode=1;
}
