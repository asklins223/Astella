import { loadEnvFile } from "node:process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ResolvedPlatform } from "@astella/shared/platform-config";
import type { Capability } from "@astella/shared";
import { postJsonToPublicEndpoint, postSseToPublicEndpoint, type PublicJsonRequester,
  type PublicStreamingRequester } from "@astella/shared/public-json-http";
import { OpenCodeGoProvider } from "../lib/providers/opencode-go.ts";
import { OpenAICompatibleProvider } from "../lib/providers/openai-compatible.ts";
import type { AIProvider } from "../lib/ai-provider.ts";
import { ProviderRequestError, ProviderStreamError } from "../lib/provider-request-error.ts";
import { AgentOutputError } from "../lib/non-retryable-errors.ts";

export const root = fileURLToPath(new URL("../../../../", import.meta.url));
loadEnvFile(`${root}.env`);
process.env.AI_PLATFORMS_CONFIG ??= `${root}config/ai-platforms.json`;
process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS ??= "true";
if (process.env.REAL_MODEL_BATCH !== "1") throw new Error("Live acceptance requires REAL_MODEL_BATCH=1");
export const outputDir = `${root}outputs/audits/2026-10-07-live`;
mkdirSync(outputDir, { recursive:true });
export const { resolveSystemPlatform, loadPlatformConfig } = await import("@astella/shared/platform-config-node");

const obj = (v:unknown):Record<string,unknown> => v && typeof v==="object" && !Array.isArray(v) ? v as Record<string,unknown> : {};
const num = (v:unknown):number|null => typeof v==="number" && Number.isFinite(v) ? v : null;
export type WireReceipt = {model:unknown;effort:unknown;enableThinking:unknown;outputLimit:unknown;temperature:number|null;instructionHash:string;
  inputTokens:number|null;outputTokens:number|null;reasoningTokens:number|null;elapsedMs:number;transport:string;errorKind?:string;
  completedTextHash?:string;streamedTextHash?:string;completedTextMatchesDeltas?:boolean;outputMessageCount?:number;
  messagePhases?:Array<string|null>};

export function platform(capability:Capability, declaredModelOverride?: string):ResolvedPlatform {
  const resolved=resolveSystemPlatform(capability);
  if(!resolved?.apiKey || resolved.type==="mock") throw new Error(`Real ${capability} route is missing`);
  if(declaredModelOverride) {
    const profile=loadPlatformConfig()?.platforms[resolved.platformId]?.models?.[declaredModelOverride];
    if(!profile)throw new Error("Only a declared model on the same configured platform can be compared");
    return {...resolved,model:declaredModelOverride,modelProfile:profile};
  }
  return resolved;
}

export function observedProvider(p:ResolvedPlatform, sessionId:string, receipts:WireReceipt[],
  onInstructions?: (instructions:string)=>void,
  mapInstructions?: (instructions:string)=>string,
  experiment?: { casualEffort?: "low" },
  onSyntheticRequestBody?: (body:unknown)=>void):AIProvider {
  // Explicit experiment control only. Capture the exact body actually sent.
  const experimentalBody = (body: unknown): unknown => {
    if (!mapInstructions && !experiment?.casualEffort) return body;
    const b = obj(body);
    return { ...b,
      ...(mapInstructions && typeof b.instructions === "string" ? { instructions: mapInstructions(b.instructions) } : {}),
      ...(mapInstructions && Array.isArray(b.messages) ? { messages: b.messages.map(m => obj(m).role === "system"
        && typeof obj(m).content === "string" ? { ...obj(m), content: mapInstructions(String(obj(m).content)) } : m) } : {}),
      ...(experiment?.casualEffort && b.temperature === 0.9 && obj(b.reasoning).effort === "none"
        ? { reasoning: { ...obj(b.reasoning), effort: experiment.casualEffort } } : {}),
    };
  };
  const capture=(body:unknown,transport:string):WireReceipt=>{
    onSyntheticRequestBody?.(body);
    const b=obj(body);
    const instructions=typeof b.instructions==="string"?b.instructions:
      Array.isArray(b.messages)?b.messages.filter(m=>obj(m).role==="system").map(m=>String(obj(m).content??"")).join("\n\n"):"";
    onInstructions?.(instructions);
    const receipt={model:b.model,effort:obj(b.reasoning).effort??b.reasoning_effort??null,
      instructionHash:createHash("sha256").update(instructions).digest("hex"),
      enableThinking:b.enable_thinking??obj(b.thinking).type??null,
      outputLimit:b.max_output_tokens??b.max_tokens??null,temperature:num(b.temperature),inputTokens:null,outputTokens:null,reasoningTokens:null,
      elapsedMs:0,transport} as WireReceipt;
    receipts.push(receipt);return receipt;
  };
  const request:PublicJsonRequester=async(url,headers,body,signal)=>{
    body = experimentalBody(body);
    const receipt=capture(body,"json"), started=Date.now();
    try {
      const response=await postJsonToPublicEndpoint(url,headers,body,signal);
      if(response.status>=400){
        const error=obj(obj(response.body).error);
        const message=String(error.message??obj(response.body).message??"").toLowerCase();
        receipt.errorKind=/context|input.*token|token.*limit/.test(message)?"context_limit":/body|payload|entity|size/.test(message)?"request_size":"other";
      }
      const usage=obj(obj(response.body).usage);
      receipt.inputTokens=num(usage.input_tokens??usage.prompt_tokens);
      receipt.outputTokens=num(usage.output_tokens??usage.completion_tokens);
      receipt.reasoningTokens=num(obj(usage.output_tokens_details??usage.completion_tokens_details).reasoning_tokens);
      return response;
    } finally {receipt.elapsedMs=Date.now()-started;}
  };
  const streamRequest:PublicStreamingRequester=async(url,headers,body,signal)=>{
    body = experimentalBody(body);
    const receipt=capture(body,"sse"), started=Date.now();
    let response: Awaited<ReturnType<typeof postSseToPublicEndpoint>>;
    try {
      response=await postSseToPublicEndpoint(url,headers,body,signal);
    } catch (error) {
      receipt.elapsedMs=Date.now()-started;
      throw error;
    }
    return {...response,body:(async function*(){
      const decoder=new TextDecoder();let buffer="",streamedText="";
      const inspect=(line:string)=>{
        if(!line.startsWith("data:"))return;
        try {
          const event=obj(JSON.parse(line.slice(5).trim()));
          if(event.type==="response.output_text.delta"&&typeof event.delta==="string")streamedText+=event.delta;
          if(event.type==="response.completed"&&Array.isArray(obj(event.response).output)){
            const messages=(obj(event.response).output as unknown[]).filter(item=>obj(item).type==="message");
            const completedText=messages.flatMap(item=>Array.isArray(obj(item).content)?obj(item).content as unknown[]:[])
              .filter(item=>obj(item).type==="output_text"&&typeof obj(item).text==="string").map(item=>String(obj(item).text)).join("");
            receipt.outputMessageCount=messages.length;
            receipt.messagePhases=messages.map(item=>['commentary','final_answer','analysis','final'].includes(String(obj(item).phase))?String(obj(item).phase):null);
            receipt.completedTextHash=createHash("sha256").update(completedText).digest("hex");
            receipt.streamedTextHash=createHash("sha256").update(streamedText).digest("hex");
            receipt.completedTextMatchesDeltas=completedText===streamedText;
          }
          const usage=obj(obj(event.response).usage??event.usage);
          if(Object.keys(usage).length){
            receipt.inputTokens=num(usage.input_tokens??usage.prompt_tokens);
            receipt.outputTokens=num(usage.output_tokens??usage.completion_tokens);
            receipt.reasoningTokens=num(obj(usage.output_tokens_details??usage.completion_tokens_details).reasoning_tokens);
          }
        } catch { /* no private reasoning retained; visible terminal text is hashed only */ }
      };
      try{for await(const chunk of response.body){
        buffer+=decoder.decode(chunk,{stream:true});
        let newline:number;while((newline=buffer.indexOf("\n"))>=0){inspect(buffer.slice(0,newline));buffer=buffer.slice(newline+1);}
        yield chunk;
      } inspect(buffer+decoder.decode());}
      finally{receipt.elapsedMs=Date.now()-started;}})()};
  };
  const config={apiKey:p.apiKey!,baseUrl:p.baseUrl!,model:p.model,modelProfile:p.modelProfile,request,streamRequest};
  if(p.type==="opencode_go")return new OpenCodeGoProvider({...config,sessionId,platformOptions:p.options});
  return new OpenAICompatibleProvider({...config,platformOptions:p.options});
}

export function safeFailure(error:unknown) {
  // Never persist arbitrary HTTP error bodies, request headers or credentials.
  if (error instanceof ProviderStreamError || error instanceof AgentOutputError)
    return { name:error.name, code:error.code };
  return error instanceof ProviderRequestError ? {name:error.name,status:error.status,
    providerCode:error.providerCode??null} : {name:error instanceof Error?error.name:"unknown"};
}
export function save(name:string,value:unknown):void {
  writeFileSync(`${outputDir}/${name}.json`,JSON.stringify(value,null,2));
}
