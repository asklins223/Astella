import assert from "node:assert/strict";
import { test } from "node:test";
import { AIConsentRequiredError, AIDataPolicyDeniedError } from "@ailearn/agent-host";
import { createGovernedApiRequester, type ApiAIGovernanceDependencies } from "../ai-governance.ts";

const scope={workspaceId:"11111111-1111-4111-8111-111111111111",userId:"22222222-2222-4222-8222-222222222222"};
const consent={requiresConsent:true,consentAt:new Date(),consentVersion:"v1",dataPolicy:{sendToExternal:true,sendImageContent:false,piiDetection:true,auditLogging:true}};

test("API uses the initiating account policy and never calls the transport when consent or image permission is absent",async()=>{
  let calls=0;
  const transport:ApiAIGovernanceDependencies["requester"]=async()=>{calls++;throw new Error("Unexpected transport");};
  const audit=async()=>undefined;
  const denied=createGovernedApiRequester(scope,"teaching",["note_content"],{requester:transport,settings:async()=>null,audit});
  await assert.rejects(()=>denied("https://model.example/chat",{},{}),AIConsentRequiredError);
  const noImages=createGovernedApiRequester(scope,"vision",["image_content"],{requester:transport,settings:async()=>consent,audit});
  await assert.rejects(()=>noImages("https://model.example/chat",{},{messages:[{type:"image",image_url:"https://images.example/a.png"}]}),AIDataPolicyDeniedError);
  assert.equal(calls,0);
});

test("治理依赖没装配时不外发：fail closed，而不是「没有门也照发」",async()=>{
  let calls=0;
  // 端口在类型上是必填的；真绕过去（as any / JS 调用方）也只能得到"这一次不发"。
  const unassembled=createGovernedApiRequester(scope,"teaching",["note_content"],{
    requester:async()=>{calls++;return{status:200,statusText:"OK",body:{}};},
  } as unknown as ApiAIGovernanceDependencies);
  await assert.rejects(()=>unassembled("https://model.example/chat",{},{model:"m"}),/not assembled/);
  assert.equal(calls,0);
});

test("PII is sanitized at the shared boundary and one real response has scoped usage without content or credentials",async()=>{
  const audited:Parameters<NonNullable<ApiAIGovernanceDependencies["audit"]>>[0][]=[];
  let sent:unknown;
  const request=createGovernedApiRequester(scope,"assessment_critic",["user_answer"],{
    reserveCall:async()=>{},
    settings:async(workspaceId,userId)=>{assert.deepEqual({workspaceId,userId},scope);return consent;},
    requester:async(_url,_headers,body)=>{sent=body;return{status:200,statusText:"OK",body:{usage:{prompt_tokens:12,completion_tokens:7}}};},
    audit:async row=>{audited.push(row);},
  });
  await request("https://model.example/chat?private=value",{authorization:"Bearer never-log-this"},{model:"actual-model",messages:[{content:"联系 learner@example.com"}]});
  assert.doesNotMatch(JSON.stringify(sent),/learner@example.com/);
  assert.equal(audited.length,1);assert.equal(audited[0].actorUserId,scope.userId);
  assert.equal(audited[0].provider,"model.example");assert.equal(audited[0].costTokens,19);
  assert.equal(audited[0].status,"success");assert.doesNotMatch(JSON.stringify(audited),/never-log|learner@|private=value/);
});

test("provider errors preserve cancellation and do not invent token usage",async()=>{
  const aborted=new AbortController();
  const rows:Parameters<NonNullable<ApiAIGovernanceDependencies["audit"]>>[0][]=[];
  const request=createGovernedApiRequester(scope,"teaching",["note_content"],{settings:async()=>consent,reserveCall:async()=>{},
    requester:async()=>{aborted.abort();throw new Error("stopped");},audit:async row=>{rows.push(row);}});
  await assert.rejects(()=>request("https://model.example/chat",{},{model:"actual-model"},aborted.signal),/stopped/);
  assert.equal(rows.length,1);assert.equal(rows[0].status,"cancelled");assert.equal(rows[0].costTokens,null);
});

test("a depleted persistent quota rejects before transport and records no invented usage",async()=>{
  let calls=0,reservations=0;
  const rows:Parameters<NonNullable<ApiAIGovernanceDependencies["audit"]>>[0][]=[];
  const request=createGovernedApiRequester(scope,"note_dynamic_artifact",["note_content"],{
    settings:async()=>consent,audit:async row=>{rows.push(row);},
    reserveCall:async actor=>{assert.deepEqual(actor,scope);reservations++;throw Object.assign(new Error("quota exhausted"),{code:"AI_CALL_RATE_LIMITED"});},
    requester:async()=>{calls++;throw new Error("must not send");},
  });
  await assert.rejects(()=>request("https://model.example/chat",{},{model:"actual-model"}),/quota exhausted/);
  assert.equal(reservations,1);assert.equal(calls,0);
  assert.equal(rows.length,1);assert.equal(rows[0].costTokens,null);assert.equal(rows[0].errorMessage,"AI_CALL_RATE_LIMITED");
});
