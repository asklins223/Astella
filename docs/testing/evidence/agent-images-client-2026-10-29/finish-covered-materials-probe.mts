import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {AgentRole,getCompanionAgentTool,validateCompanionAgentToolArguments,type AgentTurnRequest} from '../../packages/shared/src/index.ts';
import {platform,observedProvider,safeFailure} from '../../workers/ai-worker/src/live-tests/acceptance-common.ts';
import {companionDirectGuidance} from '../../workers/ai-worker/src/handlers/turn/companion-entry-mode.ts';
import {validateCompanionFinish} from '../../workers/ai-worker/src/handlers/agent/companion-finish.ts';
import {AGENT_GOAL_EVIDENCE_GUIDANCE_V1} from '../../packages/shared/src/contracts/agent/agent-contracts.ts';
const dir=new URL('./',import.meta.url), baseline=JSON.parse(readFileSync(new URL('finish-policy-baseline.json',dir),'utf8'));
const tools=['companion_finish','companion_load_tools','companion_visual'].map(n=>{const {name,description,parameters}=getCompanionAgentTool(n)!;return {name,description,parameters};});
const route=platform('agent_turn'),records:any[]=[];
const picture=(token:string)=>({type:'image_url' as const,image_url:{url:'data:image/png;base64,'+readFileSync(new URL('rendered-fixtures/'+token+'.png',dir)).toString('base64'),detail:'high' as const}});
const cases=[
 {id:'native-followup',provided:true,messages:[{role:'user',content:[{type:'text',text:'请看这两张图。'},picture('ZX7Q6A'),picture('AW29TR')]},{role:'assistant',content:'刚才那份识别可能有误。'},{role:'user',requestBoundary:true,content:'重新读取刚才上传的两张原图，按原顺序抄字符，不要照抄之前的回答。'}]},
 {id:'provided-text',provided:true,messages:[{role:'user',requestBoundary:true,content:'已提供的完整原文：甲有3颗糖，乙有5颗糖。两人合计多少颗？直接根据这段原文回答。'}]},
 {id:'external-note',provided:false,messages:[{role:'user',requestBoundary:true,content:'请读取我的私人笔记《未提供的港口记录》，告诉我正文。这里没有附上正文。'}]},
 {id:'save-text',provided:false,messages:[{role:'user',requestBoundary:true,content:'帮我新建笔记《港口》，把正文逐字保存为：海风吹过码头。'}]},
] as const;
const candidateRepair='你刚才给出了完整草稿，尚未提交交付工具。草稿准确时调用 companion_finish 并省略 text，宿主精确保留，不必重抄。仍提供 outcome 和 requirements。'+AGENT_GOAL_EVIDENCE_GUIDANCE_V1;
const trials=cases.flatMap(c=>['baseline','candidate'].map(arm=>({c,arm})));
function persist(){writeFileSync(new URL('finish-covered-materials-results.json',dir),JSON.stringify({model:route.model,scope:'Real-model protocol experiment only; no database/API tool effects executed. Supplied pixels are real; external calls are proposals, not receipts.',records},null,2)+'\n');}
async function run({c,arm}:typeof trials[number]){
 const wire:any[]=[],p=observedProvider(route,randomUUID(),wire),messages=structuredClone(c.messages) as unknown as AgentTurnRequest['messages'];
 const r:any={id:c.id,arm,steps:[],wire};records.push(r);const start=Date.now();
 const guidance=arm==='baseline'?baseline.guidance:companionDirectGuidance('direct_fast');
 try{
  for(let i=0;i<2;i++){
   const response=await p.executeAgentTurn!({role:AgentRole.COMPANION_AGENT,
    systemPrompt:'本轮使用工作档，最终通过 companion_finish 交付 outcome 与 requirements。'+guidance+'\n宿主确认：消息中图像实际像素已随本次调用提供；可据此回答，未提供的外部资料不能冒充已读。',
    messages,tools:arm==='baseline'?baseline.tools:tools,toolChoice:'auto',reasoningEffort:'high',disableThinking:false,maxTokens:4096,temperature:.4},AbortSignal.timeout(60000));
   const calls=response.toolCalls??[];r.steps.push({names:calls.map(x=>x.name),bodyLength:response.content?.length??0});
   messages.push({role:'assistant',content:response.content??'',toolCalls:calls,...(response.reasoning?{reasoning:response.reasoning}:{})});
   const finish=calls.find(x=>x.name==='companion_finish');
   const external=calls.some(x=>x.name!=='companion_finish');
   if(external){r.proposedExternalCalls=calls.map(x=>({name:x.name,arguments:x.arguments}));r.ok=!c.provided;break;}
   if(finish){
    const parsed=validateCompanionAgentToolArguments(finish.name,finish.arguments);
    const verdict=parsed.success?validateCompanionFinish(parsed.data as never,messages,{requireRequirements:true}):{ok:false,error:parsed.reason};
    r.finish={arguments:Object.fromEntries(Object.entries(finish.arguments).filter(([k])=>k!=='text')),verdict};
    r.ok=c.provided?verdict.ok:!verdict.ok;break;
   }
   messages.push({role:'system',hostObservation:true,content:arm==='baseline'?baseline.repair:candidateRepair});
  }
  r.ok??=false;
 }catch(e){r.error=safeFailure(e);r.ok=false;}
 r.elapsedMs=Date.now()-start;persist();console.log(JSON.stringify({id:r.id,arm,ok:r.ok,steps:r.steps,finish:r.finish,elapsedMs:r.elapsedMs,error:r.error}));
}
for(let i=0;i<trials.length;i+=2){const results=await Promise.allSettled(trials.slice(i,i+2).map(run));for(const x of results)if(x.status==='rejected')throw x.reason;}
persist();process.exit(records.some(r=>r.arm==='candidate'&&!r.ok)?1:0);
