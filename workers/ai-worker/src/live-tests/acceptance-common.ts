import { loadEnvFile } from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ResolvedPlatform } from "@astella/shared/platform-config";
import { postJsonToPublicEndpoint, postSseToPublicEndpoint, type PublicJsonRequester,
  type PublicStreamingRequester } from "@astella/shared/public-json-http";
import { OpenCodeGoProvider } from "../lib/providers/opencode-go.ts";
import { OpenAICompatibleProvider } from "../lib/providers/openai-compatible.ts";
import type { AIProvider } from "../lib/ai-provider.ts";
import { ProviderRequestError } from "../lib/provider-request-error.ts";

export const root = fileURLToPath(new URL("../../../../", import.meta.url));
loadEnvFile(`${root}.env`);
process.env.AI_PLATFORMS_CONFIG ??= `${root}config/ai-platforms.json`;
process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS ??= "true";
if (process.env.REAL_MODEL_BATCH !== "1") throw new Error("Live acceptance requires REAL_MODEL_BATCH=1");
export const outputDir = `${root}outputs/audits/2026-10-07-live`;
mkdirSync(outputDir, { recursive:true });
export const { resolveSystemPlatform } = await import("@astella/shared/platform-config-node");

const obj = (v:unknown):Record<string,unknown> => v && typeof v==="object" && !Array.isArray(v) ? v as Record<string,unknown> : {};
const num = (v:unknown):number|null => typeof v==="number" && Number.isFinite(v) ? v : null;
export type WireReceipt = {model:unknown;effort:unknown;enableThinking:unknown;outputLimit:unknown;
  inputTokens:number|null;outputTokens:number|null;reasoningTokens:number|null;elapsedMs:number;transport:string};

export function platform(capability:string):ResolvedPlatform {
  const resolved=resolveSystemPlatform(capability);
  if(!resolved?.apiKey || resolved.type==="mock") throw new Error(`Real ${capability} route is missing`);
  return resolved;
}

export function observedProvider(p:ResolvedPlatform, sessionId:string, receipts:WireReceipt[]):AIProvider {
  const capture=(body:unknown,transport:string):WireReceipt=>{
    const b=obj(body);
    const receipt={model:b.model,effort:obj(b.reasoning).effort??b.reasoning_effort??null,
      enableThinking:b.enable_thinking??obj(b.thinking).type??null,
      outputLimit:b.max_output_tokens??b.max_tokens??null,inputTokens:null,outputTokens:null,reasoningTokens:null,
      elapsedMs:0,transport} as WireReceipt;
    receipts.push(receipt);return receipt;
  };
  const request:PublicJsonRequester=async(url,headers,body,signal)=>{
    const receipt=capture(body,"json"), started=Date.now();
    try {
      const response=await postJsonToPublicEndpoint(url,headers,body,signal);
      const usage=obj(obj(response.body).usage);
      receipt.inputTokens=num(usage.input_tokens??usage.prompt_tokens);
      receipt.outputTokens=num(usage.output_tokens??usage.completion_tokens);
      receipt.reasoningTokens=num(obj(usage.output_tokens_details??usage.completion_tokens_details).reasoning_tokens);
      return response;
    } finally {receipt.elapsedMs=Date.now()-started;}
  };
  const streamRequest:PublicStreamingRequester=async(url,headers,body,signal)=>{
    const receipt=capture(body,"sse"), started=Date.now();
    const response=await postSseToPublicEndpoint(url,headers,body,signal);
    return {...response,body:(async function*(){try{for await(const chunk of response.body)yield chunk;}
      finally{receipt.elapsedMs=Date.now()-started;}})()};
  };
  const config={apiKey:p.apiKey!,baseUrl:p.baseUrl!,model:p.model,modelProfile:p.modelProfile,request,streamRequest};
  if(p.type==="opencode_go")return new OpenCodeGoProvider({...config,sessionId,platformOptions:p.options});
  return new OpenAICompatibleProvider({...config,platformOptions:p.options});
}

export function safeFailure(error:unknown) {
  // Never persist arbitrary HTTP error bodies, request headers or credentials.
  return error instanceof ProviderRequestError ? {name:error.name,status:error.status,
    providerCode:error.providerCode??null} : {name:error instanceof Error?error.name:"unknown"};
}
export function save(name:string,value:unknown):void {
  writeFileSync(`${outputDir}/${name}.json`,JSON.stringify(value,null,2));
}
