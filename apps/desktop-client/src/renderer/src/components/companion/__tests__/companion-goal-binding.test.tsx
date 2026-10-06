// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentRunV1 } from "@astella/shared/agent-contracts";
import { CompanionGoalControls } from "../CompanionGoalControls";
import type { AgentGoalsController } from "../use-agent-goals";

const resource = vi.hoisted(() => ({ latest: {ref:{memoryId:"memory",revision:2},content:"当前目标"} }));
vi.mock("../../surfaces/companion/use-companion-resource", () => ({ useCompanionResource: () => ({
  section:{ok:true,value:{items:[resource.latest]}},loading:false,failure:null,reload:vi.fn(),
}) }));
afterEach(() => { cleanup(); resource.latest={ref:{memoryId:"memory",revision:2},content:"当前目标"}; });
const run: AgentRunV1={version:1,runId:"run",identityId:"identity",revision:1,goal:"继续复习索引",status:"paused",conversationId:null,
  inputs:[],longGoal:{memoryId:"memory",revision:1},operations:[],artifacts:[],summary:null,error:null,modelCalls:1,maxModelCalls:16,
  createdAt:"2026-10-04T00:00:00Z",updatedAt:"2026-10-04T00:00:00Z"};
function goals(): AgentGoalsController {return {items:[run],scope:1,error:null,loading:false,pending:null,nextCursor:null,moreLoading:false,moreError:null,
  change:vi.fn(async()=>false),refresh:vi.fn(async()=>{}),ensure:vi.fn(async()=>{}),loadMore:vi.fn(async()=>{})};}
it("rebinds only the version explicitly selected by the user, or explicitly removes the binding", async()=>{
  const controller=goals();render(<CompanionGoalControls run={run} goals={controller} onNewGoal={vi.fn()}/>);
  fireEvent.click(screen.getByRole("button",{name:"修改要求"}));
  fireEvent.click(screen.getByRole("button",{name:"按哪个目标继续"}));
  fireEvent.click(screen.getByRole("option",{name:"确认使用当前第 2 版"}));
  fireEvent.click(screen.getByRole("button",{name:"按新要求继续"}));
  await waitFor(()=>expect(controller.change).toHaveBeenCalledWith(run,{goal:run.goal,longGoal:{memoryId:"memory",revision:2}}));
  fireEvent.click(screen.getByRole("button",{name:"按哪个目标继续"}));
  fireEvent.click(screen.getByRole("option",{name:"解除关联，只按这次要求做"}));
  fireEvent.click(screen.getByRole("button",{name:"按新要求继续"}));
  await waitFor(()=>expect(controller.change).toHaveBeenLastCalledWith(run,{goal:run.goal,longGoal:null}));
});
it("a newer memory arriving after selection cannot silently replace the approved version", async()=>{
  const controller=goals();const view=render(<CompanionGoalControls run={run} goals={controller} onNewGoal={vi.fn()}/>);
  fireEvent.click(screen.getByRole("button",{name:"修改要求"}));
  fireEvent.click(screen.getByRole("button",{name:"按哪个目标继续"}));
  fireEvent.click(screen.getByRole("option",{name:"确认使用当前第 2 版"}));
  resource.latest={ref:{memoryId:"memory",revision:3},content:"后来改过的目标"};
  view.rerender(<CompanionGoalControls run={run} goals={controller} onNewGoal={vi.fn()}/>);
  expect((screen.getByRole("button",{name:"按新要求继续"}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("当前目标")).toBeTruthy();expect(controller.change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"核对并使用第 3 版"}));
  fireEvent.click(screen.getByRole("button",{name:"按新要求继续"}));
  await waitFor(()=>expect(controller.change).toHaveBeenCalledWith(run,{goal:run.goal,longGoal:{memoryId:"memory",revision:3}}));
});
