// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NoteDetailV1 } from "@astella/shared/note-projection-contracts";
import { useNotebookMindMap } from "../use-notebook-mind-map";
const state=vi.hoisted(()=>({scope:1}));
vi.mock("../../../../app/room-store",()=>({useRoomStore:Object.assign((select:(value:{workspaceScopeRevision:number})=>unknown)=>select({workspaceScopeRevision:state.scope}),{getState:()=>({workspaceScopeRevision:state.scope})})}));
vi.mock("../../../../app/desktop-client",()=>({createRequestMeta:()=>({}),unwrapGatewayResult:(value:unknown)=>value,gatewayErrorMessage:(error:Error)=>error.message}));
vi.mock("../notebook-task-notifications",()=>({prepareNotebookTaskNotification:()=>()=>{}}));
const list=vi.fn(),latestTask=vi.fn(),startTask=vi.fn(),getTask=vi.fn();
const note={noteId:"note",title:"笔记",currentVersionId:"version"} as NoteDetailV1;
const old={mindMapId:"old",noteId:"note",noteVersionId:"old-version",versionState:"older"};
const task=(status:string)=>({taskId:"job",noteId:"note",noteVersionId:"version",status,mindMap:null,failureReason:status==="failed"?"unknown":null});
const deferred=()=>{let resolve!:(value:unknown)=>void;const promise=new Promise(yes=>{resolve=yes});return{resolve,promise};};
beforeEach(()=>{state.scope=1;vi.clearAllMocks();list.mockResolvedValue({items:[],nextCursor:null});latestTask.mockResolvedValue({task:null});Object.defineProperty(window,"astella",{configurable:true,value:{noteMindMap:{list,latestTask,startTask,getTask}}});});
afterEach(cleanup);
it("opening a note only reads records; a direct brain request needs no overview and guards rapid duplicate clicks",async()=>{
 const result=renderHook(()=>useNotebookMindMap({note,epochRef:{current:1}}));
 await waitFor(()=>expect(list).toHaveBeenCalledTimes(1));expect(startTask).not.toHaveBeenCalled();
 const pending=deferred();startTask.mockReturnValue(pending.promise);
 let first!:Promise<unknown>;act(()=>{first=result.result.current.startNoteMindMapTask(false);void result.result.current.startNoteMindMapTask(false);});
 expect(startTask).toHaveBeenCalledTimes(1);expect(startTask.mock.calls[0]![0].request.noteVersionId).toBe("version");
 await act(async()=>{pending.resolve(task("queued"));await first;});expect(result.result.current.taskForCurrentVersion?.status).toBe("queued");
});
it("a failed regeneration preserves the selected earlier map",async()=>{
 list.mockResolvedValue({items:[old],nextCursor:null});startTask.mockResolvedValue(task("failed"));
 const result=renderHook(()=>useNotebookMindMap({note,epochRef:{current:1}}));
 await waitFor(()=>expect(result.result.current.latestNoteMindMap?.mindMapId).toBe("old"));
 await act(async()=>{await result.result.current.startNoteMindMapTask(false);});
 expect(result.result.current.taskForCurrentVersion?.status).toBe("failed");expect(result.result.current.latestNoteMindMap?.mindMapId).toBe("old");
});
it("a delayed record from the previous workspace never appears after switching",async()=>{
 const pending=deferred();list.mockReturnValueOnce(pending.promise);
 const result=renderHook(()=>useNotebookMindMap({note,epochRef:{current:1}}));
 state.scope=2;result.rerender();await waitFor(()=>expect(list).toHaveBeenCalledTimes(2));
 await act(async()=>pending.resolve({items:[old],nextCursor:null}));expect(result.result.current.noteMindMaps).toEqual([]);expect(result.result.current.latestNoteMindMap).toBeNull();
});
