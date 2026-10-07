import assert from "node:assert/strict";
import {test} from "node:test";
import {applyCompanionDialogueReview,shouldReviewCompanionDialogue} from "../companion-dialogue-review.ts";
import {CompanionDialogueReviewError,isNonRetryableError} from "../../lib/non-retryable-errors.ts";
import {companionDraftSpans} from "../companion-knowledge-review.ts";

const plan=(draft:string,dropIds:number[]=[])=>JSON.stringify({verdicts:companionDraftSpans(draft)
 .filter(span=>span.text.trim()).map(span=>({spanId:span.id,action:dropIds.includes(span.id)?"drop":"keep",
 ...(dropIds.includes(span.id)?{issue:"unasked_guidance"}:{}),reason:"当前原话的范围"}))});

test("范围核对只删除引用的原段，保留长正文、Unicode与换行，不允许新增替换句",()=>{
 const body="有用原文🫧\r\n".repeat(1800)+"尾部仍保留。\n";
 const draft=body+"明早记得先检查三遍。";
 const lastId=body.split(/(?<=\n)/u).filter(Boolean).length+1;
 const out=applyCompanionDialogueReview(plan(draft,[lastId]),draft);
 assert.equal(out.answer,body);
 assert.throws(()=>applyCompanionDialogueReview(JSON.stringify({...JSON.parse(plan(draft)),answer:"伪造替换全文"}),draft),CompanionDialogueReviewError);
});

test("错误索引、重复索引、删除空段或删除全部正文不能发布，且不无限重试",()=>{
 const draft="原文\n\n未经请求的安排。";
 for(const ids of [[99],[1,1],[2],[1,3]])
  assert.throws(()=>applyCompanionDialogueReview(JSON.stringify({verdicts:ids.map(spanId=>({spanId,action:"drop",issue:"scope",reason:"错误"}))}),draft),CompanionDialogueReviewError);
 assert.throws(()=>applyCompanionDialogueReview(JSON.stringify({verdicts:[]}),draft),CompanionDialogueReviewError);
 assert.throws(()=>applyCompanionDialogueReview(JSON.stringify({verdicts:[{spanId:1,action:"keep",reason:"漏检另一段"}]}),draft),CompanionDialogueReviewError);
 assert.equal(applyCompanionDialogueReview(plan(draft),draft).answer,draft);
 assert.equal(isNonRetryableError(new CompanionDialogueReviewError()),true);
});

test("知识、任务、角色创作与关闭开关不增加对话范围核对调用",()=>{
 const old=process.env.COMPANION_DIALOGUE_REVIEW_V1;
 const frame={purpose:"sharing" as const,evidence:{messageIndex:0,quote:"我先玩",sourceSha256:"a".repeat(64)},userState:[]};
 try{
  delete process.env.COMPANION_DIALOGUE_REVIEW_V1;
  assert.equal(shouldReviewCompanionDialogue(frame,"conversation","none"),false);
  process.env.COMPANION_DIALOGUE_REVIEW_V1="true";
  assert.equal(shouldReviewCompanionDialogue(frame,"conversation","none"),true);
  assert.equal(shouldReviewCompanionDialogue(frame,"question","none"),false);
  assert.equal(shouldReviewCompanionDialogue(frame,"task","act"),false);
  assert.equal(shouldReviewCompanionDialogue({...frame,purpose:"other"},"conversation","none"),false);
 }finally{if(old===undefined)delete process.env.COMPANION_DIALOGUE_REVIEW_V1;else process.env.COMPANION_DIALOGUE_REVIEW_V1=old;}
});
