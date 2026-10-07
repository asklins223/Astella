import { readFileSync } from "node:fs";
import { observedProvider, outputDir, platform, save, safeFailure, type WireReceipt } from "./acceptance-common.ts";
import { buildCompanionPersonaMessages } from "../handlers/companion-dialogue-content.ts";
import { resolveCompanionPersonaContext } from "../handlers/companion-identity-context.ts";

const wire:WireReceipt[]=[],results:Array<Record<string,unknown>>=[];
async function run(name:string,fn:()=>Promise<Record<string,unknown>>) {
  console.log(JSON.stringify({starting:name}));const started=Date.now();
  const row:Record<string,unknown>={name};results.push(row);
  try{Object.assign(row,await fn());}catch(error){row.ok=false;row.error=safeFailure(error);}
  row.elapsedMs=Date.now()-started;save("quality-repeat",{results,wire});console.log(JSON.stringify(row));
}
for(let repeat=0;repeat<2;repeat++)await run(`dedicated-crop-repeat:${repeat}`,async()=>{
  const provider=observedProvider(platform("vision"),"vision-repeat",wire);
  const image=readFileSync(`${outputDir}/vision-crop.png`).toString("base64");
  const reply=await provider.chatCompletion([{role:"system",content:"只读取图片中确实可见的内容，看不到的字段填null，不猜。只输出JSON。"},
    {role:"user",content:[{type:"text",text:'输出JSON：{"blueCode":蓝色矩形的编号,"greenCode":绿色圆圈的编号,"rice":RICE的VALUE,"soup":SOUP的VALUE}。看不到的填null。'},
      {type:"image_url",image_url:{url:`data:image/png;base64,${image}`,detail:"high"}}]}],
    {maxTokens:1500,temperature:0.2,responseFormat:"text"},AbortSignal.timeout(90000));
  const matched=reply.content.match(/\{[\s\S]*\}/);let v:Record<string,unknown>={};try{v=JSON.parse(matched?.[0]??reply.content);}catch{}
  return {ok:v.blueCode==="A7"&&v.greenCode===null&&v.rice===null&&v.soup===null,answer:reply.content};
});

const history=(JSON.parse(readFileSync(`${outputDir}/runtime.json`,"utf8")) as {
  results:Array<{text:string;answer:string}>}).results.slice(0,4).flatMap(r=>[
    {role:"user" as const,text:r.text},{role:"assistant" as const,text:r.answer}]);
for(const temperature of [0.9,0.2])await run(`convection-recheck:${temperature}`,async()=>{
  const provider=observedProvider(platform("agent_turn"),"science-quality",wire);
  const messages=buildCompanionPersonaMessages({userText:'咖啡冷却时，杯内较热和较冷的液体通常分别向哪个方向运动？只输出JSON：{"warmDirection":"up或down","coolDirection":"up或down","reason":"原因"}。',
    recentMessages:history,pageContext:null,petProfile:resolveCompanionPersonaContext(null)});
  const reply=await provider.chatCompletion(messages,{temperature,maxTokens:4096,responseFormat:"text",disableThinking:false},AbortSignal.timeout(90000));
  const matched=reply.content.match(/\{[\s\S]*\}/);let v:Record<string,unknown>={};try{v=JSON.parse(matched?.[0]??reply.content);}catch{}
  return {ok:v.warmDirection==="up"&&v.coolDirection==="down",answer:reply.content,
    note:"聚焦方向的复核样本；不能据此证明长解释已修复，也不能把差异归因于采样温度。"};
});

await run("embedding:shape-and-retrieval",async()=>{
  const provider=observedProvider(platform("embedding"),"embedding-test",wire);
  const texts=["热咖啡向凉空气散热","咖啡把热量传给周围环境","查询公交线路和到站时间"];
  const vectors:number[][]=[];
  for(const text of texts){const v=await provider.embed!(text,AbortSignal.timeout(60000));if(!v)return {ok:false,reason:"empty_vector"};vectors.push(v);}
  const cosine=(a:number[],b:number[])=>a.reduce((sum,v,i)=>sum+v*b[i]!,0)/Math.sqrt(a.reduce((s,v)=>s+v*v,0)*b.reduce((s,v)=>s+v*v,0));
  const near=cosine(vectors[0]!,vectors[1]!),far=cosine(vectors[0]!,vectors[2]!);
  return {ok:vectors.every(v=>v.length===1024&&v.every(Number.isFinite))&&near>far,
    dimensions:vectors.map(v=>v.length),relatedCosine:near,unrelatedCosine:far};
});
