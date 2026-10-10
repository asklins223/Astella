// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentMethodV1 } from "@astella/shared/agent-growth-contracts";
import { useRoomStore } from "../../../app/room-store";
import { CompanionMethodsPage } from "../companion/companion-methods-page";

const method:AgentMethodV1={version:1,methodId:"11111111-1111-4111-8111-111111111111",revision:2,title:"先解释再练习",appliesWhen:"学习新材料时",steps:["**先看新材料**，不要复用旧答案。"],exceptions:["当下的要求优先"],evidence:[],evidenceIndependentCount:0,capabilities:[],state:"active",epistemicStatus:"tentative",userControlled:false,availability:"available",author:"user",changeReason:null,sourceRunId:null,sourceRunRevision:null,offeredCount:0,adoptedCount:0,consultedCount:0,helpfulCount:0,unhelpfulCount:0,lastConsultedAt:null,createdAt:"2026-10-04T10:00:00.000Z",updatedAt:"2026-10-04T10:00:00.000Z"};
const ok=<T,>(data:T)=>({version:1,ok:true,data,requestId:"methods",correlationId:"methods",schemaRevision:"desktop-ipc-v1"});
let items:AgentMethodV1[],agent:{listMethods:ReturnType<typeof vi.fn>;controlMethod:ReturnType<typeof vi.fn>;getMethodHistory:ReturnType<typeof vi.fn>;getMethodUses:ReturnType<typeof vi.fn>;reviseMethod:ReturnType<typeof vi.fn>};
beforeEach(()=>{
  useRoomStore.setState({workspaceScopeRevision:1});items=[{...method}];
  agent={listMethods:vi.fn(async()=>ok({version:1,items})),controlMethod:vi.fn(async()=>{items=[{...method,revision:3,state:"disabled",userControlled:true,availability:"disabled"}];return ok(items[0]);}),getMethodHistory:vi.fn(async()=>ok({version:1,items:[]})),getMethodUses:vi.fn(async()=>ok({version:1,items:[]})),reviseMethod:vi.fn()};
  Object.defineProperty(window,"astella",{configurable:true,value:{auth:{getState:vi.fn(async()=>ok({version:1,status:"authenticated",workspace:{workspaceId:"22222222-2222-4222-8222-222222222222"},workspaceEpoch:1}))},agent}});
});
afterEach(()=>cleanup());

it("shows autonomous tentative methods without an adoption approval and allows post-hoc stopping",async()=>{
  render(<CompanionMethodsPage refreshKey={0}/>);
  fireEvent.click(await screen.findByRole("button",{name:/先解释再练习/}));
  expect(screen.getByText("先看新材料").tagName).toBe("STRONG");
  expect(agent.controlMethod).not.toHaveBeenCalled();
  expect(screen.queryByRole("button",{name:"确认采用"})).toBeNull();
  const stop=screen.getByRole("button",{name:"暂时不用"});fireEvent.click(stop);fireEvent.click(stop);
  await waitFor(()=>expect(agent.controlMethod).toHaveBeenCalledTimes(1));
  expect(agent.controlMethod.mock.calls[0][0]).toMatchObject({methodId:method.methodId,request:{expectedRevision:2,action:"disable"}});
});

it("hides the previous workspace immediately and ignores a response arriving after the switch",async()=>{
  render(<CompanionMethodsPage refreshKey={0}/>);
  await screen.findByRole("button",{name:/先解释再练习/});
  let finish!:(value:unknown)=>void;
  agent.listMethods.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  act(()=>useRoomStore.setState({workspaceScopeRevision:2}));
  expect(screen.queryByRole("button",{name:/先解释再练习/})).toBeNull();
  await waitFor(()=>expect(agent.listMethods.mock.calls.length).toBeGreaterThan(1));
  agent.listMethods.mockResolvedValue(ok({version:1,items:[]}));
  act(()=>useRoomStore.setState({workspaceScopeRevision:3}));
  await screen.findByText("还没有保存合作方法");
  await act(async()=>finish(ok({version:1,items:[method]})));
  expect(screen.queryByRole("button",{name:/先解释再练习/})).toBeNull();
});

it("preserves the user's correction draft when the server reports a newer revision",async()=>{
  render(<CompanionMethodsPage refreshKey={0}/>);
  fireEvent.click(await screen.findByRole("button",{name:/先解释再练习/}));fireEvent.click(screen.getByRole("button",{name:"修订做法"}));
  fireEvent.change(screen.getByLabelText("方法名称"),{target:{value:"我修订的做法"}});
  fireEvent.change(screen.getByLabelText("为什么修订"),{target:{value:"根据这次合作调整"}});
  agent.reviseMethod.mockImplementation(async()=>{items=[{...method,revision:3}];return {version:1,ok:false,error:{code:"revision_conflict",safeMessageKey:"error.conflict",retry:"user_action"}};});
  fireEvent.click(screen.getByRole("button",{name:"保存修订"}));
  await screen.findByText("方法已经有新版本；你的草稿保留着，保存时会核对版本。");
  expect((screen.getByLabelText("方法名称") as HTMLInputElement).value).toBe("我修订的做法");
  expect(agent.reviseMethod.mock.calls[0][0].request.expectedRevision).toBe(2);
});

it("names what a distilled method is based on as the user's own words, not a vague 'recorded event'",async()=>{
  items=[{...method,evidence:[{eventId:"message:22222222-2222-4222-8222-222222222222"}],evidenceIndependentCount:1}];
  render(<CompanionMethodsPage refreshKey={0}/>);
  fireEvent.click(await screen.findByRole("button",{name:/先解释再练习/}));
  expect(await screen.findByText(/那段相处里的原话/)).toBeTruthy();
  expect(screen.queryByText(/已记录的事件/)).toBeNull();
  expect(document.body.textContent).not.toContain("22222222-2222");
});
