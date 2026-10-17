// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentMethodV1 } from "@astella/shared/agent-growth-contracts";
import { useRoomStore } from "../../../app/home/room-store";
import { CompanionGoalsAndMethodsPage } from "../companion/companion-goals-and-methods-page";
import { COMPANION_GOAL_JOURNAL_OPEN } from "../../companion/content/companion-events";

const memoryId="11111111-1111-4111-8111-111111111111",noteId="22222222-2222-4222-8222-222222222222",noteVersionId="33333333-3333-4333-8333-333333333333",runId="44444444-4444-4444-8444-444444444444";
const goal={ref:{memoryId,revision:2},content:"**理解电路**，按自己的节奏慢慢学。",appliesWhen:null,updatedAt:"2026-10-04T12:00:00.000Z",taskCount:0,tasks:[]};
const method:AgentMethodV1={version:1,methodId:"55555555-5555-4555-8555-555555555555",revision:2,title:"先解释再练习",appliesWhen:"学习新材料时",steps:["**先看新材料**，不要复用旧答案。"],exceptions:["当下的要求优先"],evidence:[],evidenceIndependentCount:0,capabilities:[],state:"active",epistemicStatus:"tentative",userControlled:false,availability:"available",author:"user",changeReason:null,sourceRunId:null,sourceRunRevision:null,offeredCount:0,adoptedCount:0,consultedCount:0,helpfulCount:0,unhelpfulCount:0,lastConsultedAt:null,createdAt:"2026-10-04T10:00:00.000Z",updatedAt:"2026-10-04T10:00:00.000Z"};
const ok=<T,>(data:T)=>({version:1,ok:true,data,requestId:"goals-methods",correlationId:"goals-methods",schemaRevision:"desktop-ipc-v1"});
let goals:typeof goal[],methods:AgentMethodV1[],agent:Record<string,ReturnType<typeof vi.fn>>,note:{list:ReturnType<typeof vi.fn>;get:ReturnType<typeof vi.fn>},createMemory:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  useRoomStore.setState({workspaceScopeRevision:1}); goals=[goal]; methods=[{...method}];
  agent={listLongGoals:vi.fn(async()=>ok({version:1,items:goals,nextCursor:null})),listMethods:vi.fn(async()=>ok({version:1,items:methods})),
    createRun:vi.fn(async()=>ok({runId})),listRuns:vi.fn(async()=>ok({version:1,items:[],nextCursor:null})),
    controlMethod:vi.fn(async()=>{methods=[{...method,revision:3,state:"disabled",userControlled:true,availability:"disabled"}];return ok(methods[0]);}),
    getMethodHistory:vi.fn(async()=>ok({version:1,items:[]})),getMethodUses:vi.fn(async()=>ok({version:1,items:[]})),reviseMethod:vi.fn()};
  note={list:vi.fn(async()=>ok({items:[{id:noteId,title:"欧姆定律"}],nextCursor:null})),get:vi.fn(async()=>ok({noteId,currentVersionId:noteVersionId}))};
  createMemory=vi.fn(async()=>ok({memoryItemId:memoryId}));
  Object.defineProperty(window,"astella",{configurable:true,value:{workspace:{getAiSettings:vi.fn(async()=>ok({requiresConsent:false,consentVersion:null}))},
    auth:{getState:vi.fn(async()=>ok({version:1,status:"authenticated",workspace:{workspaceId:"55555555-5555-4555-8555-555555555555"},workspaceEpoch:1}))},
    agent,note,companion:{memory:{create:createMemory}}}});
});
afterEach(()=>cleanup());

const renderPage=()=>render(<CompanionGoalsAndMethodsPage refreshKey={0} onMemory={vi.fn()}/>);
async function selectGoal(){fireEvent.click(await screen.findByRole("button",{name:/理解电路/}));await screen.findByLabelText("这次想做什么");}

it("keeps goals and methods in one directory, each under its own heading",async()=>{
  renderPage();
  expect(await screen.findByRole("heading",{name:"一起慢慢做到的事"})).toBeTruthy();
  expect(screen.getByRole("heading",{name:/我们的方法/})).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:/先解释再练习/}));
  expect(screen.getByText("先看新材料").tagName).toBe("STRONG");
  expect(screen.queryByLabelText("这次想做什么")).toBeNull();
});

it("uses the canonical confirmed goal, renders its Markdown and starts only an explicit task with a frozen note version",async()=>{
  renderPage();await selectGoal();
  expect(screen.getByText("理解电路").tagName).toBe("STRONG");expect(agent.createRun).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("这次想做什么"),{target:{value:"计算 12 / 4，并核对笔记里的单位。"}});
  await waitFor(()=>expect((screen.getByRole("button",{name:"带上笔记（可选）"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button",{name:"带上笔记（可选）"}));
  fireEvent.click(screen.getByRole("option",{name:"欧姆定律"}));
  const opened=vi.fn();window.addEventListener(COMPANION_GOAL_JOURNAL_OPEN,opened);
  const button=screen.getByRole("button",{name:"这次交给伴星"});fireEvent.click(button);fireEvent.click(button);
  await waitFor(()=>expect(agent.createRun).toHaveBeenCalledOnce());
  expect(agent.createRun.mock.calls[0][0].request).toMatchObject({goal:"计算 12 / 4，并核对笔记里的单位。",longGoal:goal.ref,inputs:[{kind:"note_version",noteId,noteVersionId}]});
  await waitFor(()=>expect(opened).toHaveBeenCalledOnce());expect(opened.mock.calls[0][0].detail).toEqual({runId,scope:1});window.removeEventListener(COMPANION_GOAL_JOURNAL_OPEN,opened);
});

it("keeps the same submission identity and user's draft after an ambiguous failure",async()=>{
  agent.createRun.mockRejectedValueOnce(new Error("temporary transport failure"));
  renderPage();await selectGoal();
  fireEvent.change(screen.getByLabelText("这次想做什么"),{target:{value:"核对一次计算"}});
  fireEvent.click(screen.getByRole("button",{name:"这次交给伴星"}));
  await waitFor(()=>expect((screen.getByRole("button",{name:"这次交给伴星"}) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText("这次想做什么") as HTMLTextAreaElement).value).toBe("核对一次计算");
  fireEvent.click(screen.getByRole("button",{name:"这次交给伴星"}));
  await waitFor(()=>expect(agent.createRun).toHaveBeenCalledTimes(2));
  expect(agent.createRun.mock.calls[1][0].request).toEqual(agent.createRun.mock.calls[0][0].request);
});

it("ignores an old workspace's completed write and hides its goal immediately",async()=>{
  let finish!:(value:unknown)=>void;
  agent.createRun.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  renderPage();await selectGoal();
  fireEvent.change(screen.getByLabelText("这次想做什么"),{target:{value:"旧空间的要求"}});
  const opened=vi.fn();window.addEventListener(COMPANION_GOAL_JOURNAL_OPEN,opened);
  fireEvent.click(screen.getByRole("button",{name:"这次交给伴星"}));await waitFor(()=>expect(finish).toBeTypeOf("function"));
  agent.listLongGoals.mockResolvedValue(ok({version:1,items:[],nextCursor:null}));
  agent.listMethods.mockResolvedValue(ok({version:1,items:[]}));
  act(()=>useRoomStore.setState({workspaceScopeRevision:2}));expect(screen.queryByLabelText("这次想做什么")).toBeNull();
  await act(async()=>finish(ok({runId})));expect(opened).not.toHaveBeenCalled();window.removeEventListener(COMPANION_GOAL_JOURNAL_OPEN,opened);
  await screen.findByText("还没有留下目标或方法");
});

it("creates a goal as user-confirmed workspace intent without starting background work",async()=>{
  renderPage();
  fireEvent.click(await screen.findByRole("button",{name:"留下一个目标"}));
  fireEvent.change(screen.getByLabelText("想慢慢达到什么"),{target:{value:"学会解释电路的边界"}});
  fireEvent.click(screen.getByRole("button",{name:"确认留下"}));
  await waitFor(()=>expect(createMemory).toHaveBeenCalledOnce());
  await screen.findByText("目标已留下；每次想推进时，再交代这次要做的事。");
  expect(createMemory.mock.calls[0][0].request).toEqual({kind:"goal",scope:"workspace",content:"学会解释电路的边界",appliesWhen:null});expect(agent.createRun).not.toHaveBeenCalled();
});

it("returns to the same goal index and keeps an unsent task draft when reopening it",async()=>{
  renderPage();await selectGoal();
  fireEvent.change(screen.getByLabelText("这次想做什么"),{target:{value:"还没有提交的这次要求"}});
  // jsdom has no container queries, so dispatch the visible-in-narrow-layout control directly.
  fireEvent.click(document.querySelector(".cc-reading-back")!);
  expect(screen.queryByLabelText("这次想做什么")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button",{name:/理解电路/}));
  await selectGoal();
  expect((screen.getByLabelText("这次想做什么") as HTMLTextAreaElement).value).toBe("还没有提交的这次要求");
  expect(agent.createRun).not.toHaveBeenCalled();
});

it("allows post-hoc stopping of an autonomous method without an adoption approval",async()=>{
  renderPage();
  fireEvent.click(await screen.findByRole("button",{name:/先解释再练习/}));
  expect(agent.controlMethod).not.toHaveBeenCalled();
  expect(screen.queryByRole("button",{name:"确认采用"})).toBeNull();
  const stop=screen.getByRole("button",{name:"暂时不用"});fireEvent.click(stop);fireEvent.click(stop);
  await waitFor(()=>expect(agent.controlMethod).toHaveBeenCalledTimes(1));
  expect(agent.controlMethod.mock.calls[0][0]).toMatchObject({methodId:method.methodId,request:{expectedRevision:2,action:"disable"}});
});

it("preserves the user's correction draft when the server reports a newer revision",async()=>{
  renderPage();
  fireEvent.click(await screen.findByRole("button",{name:/先解释再练习/}));fireEvent.click(screen.getByRole("button",{name:"修订做法"}));
  fireEvent.change(screen.getByLabelText("方法名称"),{target:{value:"我修订的做法"}});
  fireEvent.change(screen.getByLabelText("为什么修订"),{target:{value:"根据这次合作调整"}});
  agent.reviseMethod.mockImplementation(async()=>{methods=[{...method,revision:3}];return {version:1,ok:false,error:{code:"revision_conflict",safeMessageKey:"error.conflict",retry:"user_action"}};});
  fireEvent.click(screen.getByRole("button",{name:"保存修订"}));
  await screen.findByText("方法已经有新版本；你的草稿保留着，保存时会核对版本。");
  expect((screen.getByLabelText("方法名称") as HTMLInputElement).value).toBe("我修订的做法");
  expect(agent.reviseMethod.mock.calls[0][0].request.expectedRevision).toBe(2);
});

it("names what a distilled method is based on as the user's own words, not a vague 'recorded event'",async()=>{
  methods=[{...method,evidence:[{eventId:"message:66666666-6666-4666-8666-666666666666"}],evidenceIndependentCount:1}];
  renderPage();
  fireEvent.click(await screen.findByRole("button",{name:/先解释再练习/}));
  expect(await screen.findByText(/那段相处里的原话/)).toBeTruthy();
  expect(screen.queryByText(/已记录的事件/)).toBeNull();
  expect(document.body.textContent).not.toContain("66666666-6666");
});
