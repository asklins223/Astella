import test from "node:test";
import assert from "node:assert/strict";
import { resolveDiagnosticCompanionTurn as resolveAgentTurnInterpretation } from "../diagnostics/companion-dialogue-source-binding.ts";
const input = { requestHash: "a".repeat(64), objects: [{ kind: "agent_run" as const, id: "11111111-1111-1111-1111-111111111111", revision: 2 }],
  capabilities: ["agent_control_goal", "agent_list_goals"] };
const task = { intent: "task_control", toolUse: "act", subjects: [{ description: "刚才那件事", objectIndex: 0 }],
  goalRelation: "control", goalObjectIndex: 0, candidateOperations: ["agent_control_goal"], ambiguities: [] };
const sourceRecords = [
  {index:0,role:"user",content:"报告写完了，明天交。"},
  {index:1,role:"assistant",content:"已经交了，接下来休息。"},
  {index:2,role:"user",content:"还没交呢，写完而已。我先玩会儿。"},
];
const dialogueInput = {...input,dialogueSources:sourceRecords,currentMessageIndex:2};
const dialogueProposal = {intent:"conversation",toolUse:"none",subjects:[],goalRelation:"unrelated",
  candidateOperations:[],ambiguities:[],dialogueFrame:{purpose:"correction",evidence:{messageIndex:2,quote:"还没交呢"},userState:[
    {topic:"报告",aspect:"progress",relation:"statement",messageIndex:0,quote:"报告写完了"},
    {topic:"报告",aspect:"timing",relation:"statement",messageIndex:0,quote:"明天交"},
    {topic:"报告",aspect:"progress",relation:"correction",messageIndex:2,quote:"还没交呢，写完而已"},
  ]}};

test("用户纠正替换旧进展，截止时间独立保留；所有状态绑定完整来源指纹", () => {
  const result=resolveAgentTurnInterpretation(dialogueProposal,dialogueInput);
  assert.equal(result.dialogueFrame?.purpose,"correction");
  assert.equal(result.dialogueFrame?.userState.length,2);
  assert.equal(result.dialogueFrame?.userState.find(x=>x.aspect==="progress")?.quote,"还没交呢，写完而已");
  assert.equal(result.dialogueFrame?.userState.find(x=>x.aspect==="timing")?.quote,"明天交");
  assert.match(result.dialogueFrame!.evidence.sourceSha256,/^[a-f0-9]{64}$/);
  const changed=resolveAgentTurnInterpretation(dialogueProposal,{...dialogueInput,dialogueSources:
    sourceRecords.map(x=>x.index===2?{...x,content:x.content+"（补充）"}:x)});
  assert.notEqual(changed.dialogueFrame!.evidence.sourceSha256,result.dialogueFrame!.evidence.sourceSha256);
  assert.deepEqual(result.candidateOperations,[]);
});

test("助手推断、发明索引、拼接或改写的引文不能写进用户状态", () => {
  const additions=[
    {topic:"报告",aspect:"progress",relation:"statement",messageIndex:1,quote:"已经交了"},
    {topic:"报告",aspect:"progress",relation:"statement",messageIndex:99,quote:"已经交了"},
    {topic:"报告",aspect:"progress",relation:"statement",messageIndex:2,quote:"报告已经交完"},
    {topic:"报告",aspect:"progress",relation:"statement",messageIndex:2,quote:"还没交呢。我先玩会儿"},
  ];
  for(const item of additions){
    const result=resolveAgentTurnInterpretation({...dialogueProposal,dialogueFrame:{...dialogueProposal.dialogueFrame,userState:[item]}},dialogueInput);
    assert.deepEqual(result.dialogueFrame?.userState,[]);
  }
});

test("对话用途必须引用当前用户原话，旧话与助手台词不能解释新一轮", () => {
  for(const evidence of [{messageIndex:0,quote:"明天交"},{messageIndex:1,quote:"已经交了"},{messageIndex:2,quote:"帮我删改报告"}]) {
    const result=resolveAgentTurnInterpretation({...dialogueProposal,dialogueFrame:{...dialogueProposal.dialogueFrame,evidence}},dialogueInput);
    assert.equal(result.dialogueFrame,undefined);
    assert.equal(result.intent,"conversation");
    assert.equal(result.toolUse,"none");
  }
});

test("有效对话来源不授予旧目标或不可用操作的执行权限", () => {
  const result=resolveAgentTurnInterpretation({...task,subjects:[],goalObjectIndex:99,
    dialogueFrame:dialogueProposal.dialogueFrame},dialogueInput);
  assert.equal(result.toolUse,"uncertain");
  assert.equal(result.goalReference,null);
  assert.equal(result.dialogueFrame?.purpose,"correction");
});

test("做完与交付保持两个方面，阶段解读也必须有用户原话来源",()=>{
  const item={topic:"报告",aspect:"progress",relation:"statement",messageIndex:0,quote:"报告写完了",
    progress:{work:"completed",handoff:"unknown"}};
  const result=resolveAgentTurnInterpretation({...dialogueProposal,dialogueFrame:{...dialogueProposal.dialogueFrame,
    userState:[item]}},dialogueInput);
  assert.deepEqual(result.dialogueFrame?.userState[0]?.progress,{work:"completed",handoff:"unknown"});
  const fake=resolveAgentTurnInterpretation({...dialogueProposal,dialogueFrame:{...dialogueProposal.dialogueFrame,
    userState:[{...item,messageIndex:1,quote:"已经交了",progress:{work:"completed",handoff:"handed_off"}}]}},dialogueInput);
  assert.deepEqual(fake.dialogueFrame?.userState,[]);
});

test("交付方面的新状态不抹掉仍成立的做完状态，各自保留原话来源",()=>{
  const result=resolveAgentTurnInterpretation({...dialogueProposal,dialogueFrame:{...dialogueProposal.dialogueFrame,userState:[
    {topic:"报告",aspect:"progress",relation:"statement",messageIndex:0,quote:"报告写完了",progress:{work:"completed",handoff:"unknown"}},
    {topic:"报告",aspect:"progress",relation:"correction",messageIndex:2,quote:"还没交呢",progress:{work:"unknown",handoff:"not_handed_off"}},
  ]}},dialogueInput);
  assert.equal(result.dialogueFrame?.userState.length,2);
  assert.ok(result.dialogueFrame?.userState.some(x=>x.quote==="报告写完了"&&x.progress?.work==="completed"));
  assert.ok(result.dialogueFrame?.userState.some(x=>x.quote==="还没交呢"&&x.progress?.handoff==="not_handed_off"));
});

test("一条原话支持的两个阶段中仅交付被更新时，旧来源不再携带旧交付状态",()=>{
  const records=[{index:0,role:"user",content:"报告写完了，还没交。"},
    {index:2,role:"user",content:"刚交上去了。"}];
  const result=resolveAgentTurnInterpretation({...dialogueProposal,dialogueFrame:{purpose:"sharing",
    evidence:{messageIndex:2,quote:"刚交上去了"},userState:[
      {topic:"报告",aspect:"progress",relation:"statement",messageIndex:0,quote:"报告写完了，还没交",
        progress:{work:"completed",handoff:"not_handed_off"}},
      {topic:"报告",aspect:"progress",relation:"correction",messageIndex:2,quote:"刚交上去了",
        progress:{work:"unknown",handoff:"handed_off"}},
    ]}},{...dialogueInput,dialogueSources:records});
  assert.deepEqual(result.dialogueFrame?.userState.map(item=>({quote:item.quote,progress:item.progress})),[
    {quote:"报告写完了，还没交",progress:{work:"completed",handoff:"unknown"}},
    {quote:"刚交上去了",progress:{work:"unknown",handoff:"handed_off"}},
  ]);
});
