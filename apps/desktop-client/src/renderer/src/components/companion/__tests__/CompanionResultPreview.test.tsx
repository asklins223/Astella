// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanionResultPreview } from "../journal/CompanionResultPreview";
import { closeCompanionPreview, previewCompanionNote, previewCompanionSource, useCompanionResultPreview } from "../journal/companion-result-preview";
import { hasForeignModal } from "../content/companion-modal-ownership";

const state = vi.hoisted(() => ({ scope: 1, reducedMotion: false }));
const mocks = vi.hoisted(() => ({ get: vi.fn(), source: vi.fn(), go: vi.fn(), mode: vi.fn(), openArtifact: vi.fn(), goal: vi.fn() }));
vi.mock("../../../app/home/room-store", () => ({ useRoomStore: Object.assign(
  (selector: (value: unknown) => unknown) => selector({ workspaceScopeRevision: state.scope, reducedMotion: state.reducedMotion }),
  { getState: () => ({ workspaceScopeRevision: state.scope }), subscribe: () => () => {} },
) }));
vi.mock("../../../app/companion-session/companion-chat-session", () => ({ useCompanionChat: () => ({ goToRoute: mocks.go, setMode: mocks.mode }) }));
vi.mock("../../../app/client/desktop-client", () => ({ requireWorkspaceEpoch: async () => 4, createRequestMeta: (epoch: number) => ({ workspaceEpoch: epoch }),
  unwrapGatewayResult: (value: unknown) => value, gatewayErrorMessage: (error: Error) => error.message }));
vi.mock("../journal/CompanionArtifactPreview", () => ({ CompanionArtifactPreview: ({ artifact, onReady }: { artifact: { id: string }; onReady?: () => void }) => <div ref={element => { if (element) onReady?.(); }}>saved artifact {artifact.id}<button type="button" onClick={event => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "成果引用的原文", blockOrdinal: 5 }, event.currentTarget)}>查看成果原文</button></div> }));
vi.mock("../goals/agent-goal-presentation", () => ({ openAgentArtifact: mocks.openArtifact }));
vi.mock("../content/companion-events", () => ({ openCompanionGoalJournal: mocks.goal }));

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function note(id = "n1", version = "v1", text = "保存当时的原文") { return { noteId: id, title: id, currentVersionId: "current",
  currentVersion: { versionId: "current", versionNo: 2, blocks: [{ ordinal: 0, type: "paragraph", content: "当前正文" }] },
  requestedVersion: { versionId: version, versionNo: 1, blocks: [{ ordinal: 5, type: "paragraph", content: text }] } }; }
beforeEach(() => {
  state.scope = 1; state.reducedMotion = false; vi.clearAllMocks();
  useCompanionResultPreview.setState({ target: null, parentPreview: null, returnTo: null, journalTarget: null, positions: new Map(), galleries: new Map(), disclosures: new Map(), sourceTarget: null, sourceReturnTo: null, sourceLocation: null });
  mocks.get.mockResolvedValue(note()); mocks.go.mockResolvedValue(undefined); mocks.openArtifact.mockReturnValue(true);
  Object.defineProperty(window, "astella", { configurable: true, value: { note: { get: mocks.get }, source: { get: mocks.source } } });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

it("locates the stored block ordinal and explains when the original anchor is unavailable", async () => {
  render(<CompanionResultPreview motionMode="off" />);
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "原文", blockOrdinal: 5 }));
  await screen.findByText("保存当时的原文");
  expect(document.querySelector('[data-block-ordinal="5"]')).toBeTruthy();
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "原文", blockOrdinal: 1 }));
  await screen.findByText("原段落已不在这份版本中，以下保留完整正文。");
  expect(screen.getByText("保存当时的原文")).toBeTruthy();
});

it("previews actual source text, keeps a missing segment honest, and returns from the source page to the same reading position", async () => {
  mocks.source.mockResolvedValue({ source: { id: "source", title: "真实来源" }, segments: [{ id: "segment", ordinal: 2, text: "这是已读取的来源段落。" }] });
  render(<CompanionResultPreview motionMode="off" />);
  act(() => previewCompanionSource({ sourceId: "source", title: "来源", segmentOrdinal: 99, runId: "source-run" }));
  await screen.findByText("这是已读取的来源段落。");
  expect(hasForeignModal(document)).toBe(false);
  expect(screen.getByText(/原段落位置暂时不可用/)).toBeTruthy();
  expect(mocks.source).toHaveBeenCalledWith({ meta: { workspaceEpoch: 4 }, sourceId: "source" });
  const body = screen.getByRole("dialog", { name: "来源预览：来源" }).querySelector(".companion-result-preview__body")!;
  body.scrollTop = 170; fireEvent.scroll(body);
  fireEvent.click(screen.getByRole("button", { name: "进入来源页面" }));
  await screen.findByRole("button", { name: /返回手记与来源预览/ });
  expect(mocks.go.mock.calls[0][0]).toEqual({ kind: "source.detail", sourceId: "source" });
  expect(useCompanionResultPreview.getState().sourceLocation?.segmentOrdinal).toBe(99);
  fireEvent.click(screen.getByRole("button", { name: /返回手记与来源预览/ }));
  await screen.findByText("这是已读取的来源段落。"); expect(body.scrollTop).toBe(170);
  expect(useCompanionResultPreview.getState().journalTarget?.runId).toBe("source-run");
});

it("switches from source to note preview without a late source response reopening a reader", async () => {
  const late = deferred<unknown>(); mocks.source.mockReturnValue(late.promise);
  render(<CompanionResultPreview motionMode="off" />);
  act(() => previewCompanionSource({ sourceId: "source", title: "旧来源" }));
  await waitFor(() => expect(mocks.source).toHaveBeenCalledTimes(1));
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "秦朝" }));
  await screen.findByText("保存当时的原文");
  await act(async () => late.resolve({ source: { title: "迟到来源" }, segments: [] }));
  expect(screen.queryByRole("dialog", { name: /旧来源/ })).toBeNull();
  expect(screen.getByRole("dialog", { name: "预览：秦朝" })).toBeTruthy();
});
afterEach(cleanup);

it("reads the exact saved version, keeps it open as results arrive, and restores its scroll and origin focus", async () => {
  const origin = document.createElement("button"); document.body.append(origin); origin.focus();
  render(<CompanionResultPreview motionMode="full" />);
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "秦朝", runId: "run" }, origin));
  await screen.findByText("保存当时的原文");
  expect(mocks.get).toHaveBeenCalledWith({ meta: { workspaceEpoch: 4 }, noteId: "n1", noteVersionId: "v1" });
  expect(hasForeignModal(document)).toBe(false);
  const outerEscape = vi.fn(); window.addEventListener("keydown", outerEscape);
  fireEvent.keyDown(screen.getByRole("dialog", { name: "预览：秦朝" }), { key: "Escape" });
  expect(outerEscape).not.toHaveBeenCalled(); window.removeEventListener("keydown", outerEscape);
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "秦朝", runId: "run" }, origin));
  await screen.findByText("保存当时的原文");
  expect(screen.getByText(/正在回看 v1/)).toBeTruthy();
  const body = document.querySelector(".companion-result-preview__body")!;
  body.scrollTop = 210; fireEvent.scroll(body);
  act(() => useCompanionResultPreview.setState({ journalTarget: { runId: "new-result", visit: 1 } }));
  expect(screen.getByText("保存当时的原文")).toBeTruthy(); expect(body.scrollTop).toBe(210);
  fireEvent.click(screen.getByRole("button", { name: "关闭预览，返回原位置" }));
  expect(document.activeElement).toBe(origin);
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "秦朝" }, origin));
  await screen.findByText("保存当时的原文"); expect(body.scrollTop).toBe(210); origin.remove();
});

it("shows the note title once: the preview header already prints it", async () => {
  mocks.get.mockResolvedValueOnce({
    noteId: "n1", title: "秦朝统一与中央集权制度", currentVersionId: "v1",
    currentVersion: { versionId: "v1", versionNo: 1, blocks: [] },
    requestedVersion: { versionId: "v1", versionNo: 1, blocks: [
      { ordinal: 0, type: "heading", content: "# 秦朝统一与中央集权制度" },
      { ordinal: 1, type: "paragraph", content: "一、统一六国" },
    ] },
  });
  render(<CompanionResultPreview motionMode="off" />);
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "秦朝统一与中央集权制度" }));
  await screen.findByText("一、统一六国");
  const body = document.querySelector(".companion-result-preview__body")!;
  expect(body.querySelector(".companion-md__heading")).toBeNull();
  expect(screen.getAllByText("秦朝统一与中央集权制度")).toHaveLength(1);
});

it("keeps a leading heading that is not the note title", async () => {
  mocks.get.mockResolvedValueOnce({
    noteId: "n1", title: "秦朝统一与中央集权制度", currentVersionId: "v1",
    currentVersion: { versionId: "v1", versionNo: 1, blocks: [] },
    requestedVersion: { versionId: "v1", versionNo: 1, blocks: [
      { ordinal: 0, type: "heading", content: "# 一、统一六国" },
      { ordinal: 1, type: "paragraph", content: "正文。" },
    ] },
  });
  render(<CompanionResultPreview motionMode="off" />);
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "秦朝统一与中央集权制度" }));
  await screen.findByText("正文。");
  expect(screen.getByText("一、统一六国", { selector: ".companion-md__heading" })).toBeTruthy();
});

it("does not replace a selected result with a late response or an unavailable version with current content", async () => {
  const late = deferred<unknown>(); mocks.get.mockReturnValueOnce(late.promise).mockResolvedValueOnce(note("n2", "v2", "第二份原文"));
  render(<CompanionResultPreview motionMode="off" />);
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "第一份" }));
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
  act(() => previewCompanionNote({ noteId: "n2", noteVersionId: "v2", title: "第二份" }));
  await screen.findByText("第二份原文"); await act(async () => late.resolve(note()));
  expect(screen.queryByText("保存当时的原文")).toBeNull();
  mocks.get.mockResolvedValueOnce({ ...note("n3"), requestedVersion: undefined });
  act(() => previewCompanionNote({ noteId: "n3", noteVersionId: "missing", title: "已不可读" }));
  await screen.findByText(/这份保存版本暂时读不到/); expect(screen.queryByText("当前正文")).toBeNull();
  expect(screen.getByRole("button", { name: "打开当前笔记" })).toHaveProperty("disabled", true);
});

it("retries only the read, opens the current document explicitly, and returns to the exact run and saved preview", async () => {
  mocks.get.mockRejectedValueOnce(new Error("连接中断")).mockResolvedValueOnce(note());
  render(<CompanionResultPreview motionMode="lite" />);
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "秦朝", runId: "run" }));
  await screen.findByText("连接中断"); fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await screen.findByText("保存当时的原文"); expect(mocks.get).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "打开当前笔记" }));
  await screen.findByRole("button", { name: /返回手记与预览/ });
  expect(mocks.go.mock.calls[0][0]).toEqual({ kind: "note.detail", noteId: "n1" });
  fireEvent.click(screen.getByRole("button", { name: /返回手记与预览/ }));
  expect(useCompanionResultPreview.getState().journalTarget?.runId).toBe("run");
  await screen.findByText("保存当时的原文"); expect(mocks.mode).toHaveBeenLastCalledWith("history");
});

it("returns to an already open journal's reading position without issuing a new jump to the run's beginning", async () => {
  const journal = document.createElement("aside"); journal.className = "companion-history";
  const origin = document.createElement("button"); journal.append(origin); document.body.append(journal);
  render(<CompanionResultPreview motionMode="off" />);
  act(() => {
    useCompanionResultPreview.setState({ journalTarget: { runId: "run", visit: 8 } });
    previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "秦朝", runId: "run" }, origin);
  });
  await screen.findByText("保存当时的原文");
  fireEvent.click(screen.getByRole("button", { name: "打开当前笔记" }));
  fireEvent.click(await screen.findByRole("button", { name: /返回手记与预览/ }));
  expect(useCompanionResultPreview.getState().journalTarget).toEqual({ runId: "run", visit: 8 });
  expect(mocks.mode).toHaveBeenLastCalledWith("history"); journal.remove();
});
it("restores the same message control when the journal has remounted after opening a note", async () => {
  const journal = document.createElement("aside"); journal.className = "companion-history";
  journal.innerHTML = '<article data-message-id="message-1"><button>复制</button><button>预览</button></article>';
  document.body.append(journal);
  const oldOrigin = journal.querySelectorAll("button")[1]!;
  render(<CompanionResultPreview motionMode="off" />);
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "秦朝", runId: "run" }, oldOrigin));
  await screen.findByText("保存当时的原文");
  fireEvent.click(screen.getByRole("button", { name: "打开当前笔记" }));
  await screen.findByRole("button", { name: /返回手记与预览/ });
  journal.innerHTML = '<article data-message-id="message-1"><button>复制</button><button>预览</button></article>';
  const newOrigin = journal.querySelectorAll("button")[1]!;
  fireEvent.click(screen.getByRole("button", { name: /返回手记与预览/ }));
  await screen.findByText("保存当时的原文");
  screen.getByRole("button", { name: "关闭预览，返回原位置" }).focus();
  act(closeCompanionPreview);
  expect(oldOrigin.isConnected).toBe(false);
  expect(document.activeElement).toBe(newOrigin);
  journal.remove();
});
it("returns from an artifact reference to the saved artifact and its reading position", async () => {
  const origin = document.createElement("button"); document.body.append(origin);
  render(<CompanionResultPreview motionMode="off" />);
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "速看", artifact: { kind: "note_overview", id: "artifact", jobId: "job", noteId: "n1", noteVersionId: "v1" } }, origin));
  await screen.findByText("saved artifact artifact");
  const parent = useCompanionResultPreview.getState().target!;
  const body = document.querySelector<HTMLElement>(".companion-result-preview__body")!;
  body.scrollTop = 240; fireEvent.scroll(body);
  fireEvent.click(screen.getByRole("button", { name: "查看成果原文" }));
  await screen.findByText("保存当时的原文");
  expect(document.activeElement).toBe(screen.getAllByRole("button", { name: "返回成果预览" })[0]);
  const delayed = deferred<unknown>(); mocks.get.mockReturnValueOnce(delayed.promise);
  fireEvent.keyDown(screen.getByRole("dialog", { name: "预览：成果引用的原文" }), { key: "Escape" });
  body.scrollTop = 0; fireEvent.scroll(body);
  expect(useCompanionResultPreview.getState().positions.get(parent.identity)).toBe(240);
  await act(async () => delayed.resolve(note()));
  await screen.findByText("saved artifact artifact");
  expect(body.scrollTop).toBe(240);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭预览，返回原位置" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭预览，返回原位置" }));
  expect(document.activeElement).toBe(origin); origin.remove();
});

it("closing or switching the reader cancels a pending navigation intent and never closes the newer preview", async () => {
  const navigation = deferred<void>(); mocks.go.mockReturnValueOnce(navigation.promise);
  render(<CompanionResultPreview motionMode="off" />);
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "第一份" }));
  await screen.findByText("保存当时的原文"); fireEvent.click(screen.getByRole("button", { name: "打开当前笔记" }));
  const current = mocks.go.mock.calls[0][1]; expect(current()).toBe(true);
  mocks.get.mockResolvedValueOnce(note("n2", "v2", "第二份原文"));
  act(() => previewCompanionNote({ noteId: "n2", noteVersionId: "v2", title: "第二份" }));
  expect(current()).toBe(false); await screen.findByText("第二份原文");
  await act(async () => navigation.resolve()); expect(useCompanionResultPreview.getState().target?.noteId).toBe("n2");
  act(closeCompanionPreview); expect(useCompanionResultPreview.getState().returnTo).toBeNull();
});

it("keeps an artifact receipt and its goal selected through formal navigation and return", async () => {
  const artifact = { kind: "note_overview" as const, id: "artifact", jobId: "job", noteId: "n1", noteVersionId: "v1" };
  render(<CompanionResultPreview motionMode="off" />);
  act(() => previewCompanionNote({ noteId: "n1", noteVersionId: "v1", title: "速看", artifact, goalRunId: "goal" }));
  await screen.findByText("saved artifact artifact"); fireEvent.click(screen.getByRole("button", { name: "进入成果页面" }));
  expect(mocks.openArtifact).toHaveBeenCalledWith(artifact, 1); expect(mocks.go).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: /返回手记与预览/ }));
  expect(mocks.goal).toHaveBeenCalledWith("goal", 1); await screen.findByText("saved artifact artifact");
});
