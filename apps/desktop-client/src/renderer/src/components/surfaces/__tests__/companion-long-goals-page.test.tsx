// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../app/room-store";
import { CompanionLongGoalsPage } from "../companion/companion-long-goals-page";
import { COMPANION_GOAL_JOURNAL_OPEN } from "../../companion/companion-events";

const memoryId="11111111-1111-4111-8111-111111111111",noteId="22222222-2222-4222-8222-222222222222",noteVersionId="33333333-3333-4333-8333-333333333333",runId="44444444-4444-4444-8444-444444444444";
const goal={ref:{memoryId,revision:2},content:"**理解电路**，按自己的节奏慢慢学。",appliesWhen:null,updatedAt:"2026-10-04T12:00:00.000Z",taskCount:0,tasks:[]};
const ok=<T,>(data:T)=>({version:1,ok:true,data,requestId:"long-goals",correlationId:"long-goals",schemaRevision:"desktop-ipc-v1"});
let agent:{listLongGoals:ReturnType<typeof vi.fn>;createRun:ReturnType<typeof vi.fn>;listRuns:ReturnType<typeof vi.fn>},note:{list:ReturnType<typeof vi.fn>;get:ReturnType<typeof vi.fn>},createMemory:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  useRoomStore.setState({workspaceScopeRevision:1});
  agent={listLongGoals:vi.fn(async()=>ok({version:1,items:[goal],nextCursor:null})),createRun:vi.fn(async()=>ok({runId})),listRuns:vi.fn(async()=>ok({version:1,items:[],nextCursor:null}))};
  note={list:vi.fn(async()=>ok({items:[{id:noteId,title:"欧姆定律"}],nextCursor:null})),get:vi.fn(async()=>ok({noteId,currentVersionId:noteVersionId}))};
  createMemory=vi.fn(async()=>ok({memoryItemId:memoryId}));
  Object.defineProperty(window,"astella",{configurable:true,value:{workspace:{getAiSettings:vi.fn(async()=>ok({requiresConsent:false,consentVersion:null}))},auth:{getState:vi.fn(async()=>ok({version:1,status:"authenticated",workspace:{workspaceId:"55555555-5555-4555-8555-555555555555"},workspaceEpoch:1}))},agent,note,companion:{memory:{create:createMemory}}}});
});
afterEach(()=>cleanup());

async function selectGoal(){fireEvent.click(await screen.findByRole("button",{name:/理解电路/}));await screen.findByLabelText("这次想做什么");}

it("uses the canonical confirmed goal, renders its Markdown and starts only an explicit task with a frozen note version",async()=>{
  render(<CompanionLongGoalsPage refreshKey={0} onMemory={vi.fn()}/>);await selectGoal();
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
  render(<CompanionLongGoalsPage refreshKey={0} onMemory={vi.fn()}/>);await selectGoal();
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
  render(<CompanionLongGoalsPage refreshKey={0} onMemory={vi.fn()}/>);await selectGoal();
  fireEvent.change(screen.getByLabelText("这次想做什么"),{target:{value:"旧空间的要求"}});
  const opened=vi.fn();window.addEventListener(COMPANION_GOAL_JOURNAL_OPEN,opened);
  fireEvent.click(screen.getByRole("button",{name:"这次交给伴星"}));await waitFor(()=>expect(finish).toBeTypeOf("function"));
  agent.listLongGoals.mockResolvedValue(ok({version:1,items:[],nextCursor:null}));
  act(()=>useRoomStore.setState({workspaceScopeRevision:2}));expect(screen.queryByLabelText("这次想做什么")).toBeNull();
  await act(async()=>finish(ok({runId})));expect(opened).not.toHaveBeenCalled();window.removeEventListener(COMPANION_GOAL_JOURNAL_OPEN,opened);
  await screen.findByText("给想做的事留一个位置");
});

it("creates a goal as user-confirmed workspace intent without starting background work",async()=>{
  render(<CompanionLongGoalsPage refreshKey={0} onMemory={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button",{name:"留下一个目标"}));
  fireEvent.change(screen.getByLabelText("想慢慢达到什么"),{target:{value:"学会解释电路的边界"}});
  fireEvent.click(screen.getByRole("button",{name:"确认留下"}));
  await waitFor(()=>expect(createMemory).toHaveBeenCalledOnce());
  await screen.findByText("目标已留下；每次想推进时，再交代这次要做的事。");
  expect(createMemory.mock.calls[0][0].request).toEqual({kind:"goal",scope:"workspace",content:"学会解释电路的边界",appliesWhen:null});expect(agent.createRun).not.toHaveBeenCalled();
});
